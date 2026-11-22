// SPDX-License-Identifier: AGPL-3.0-only
// The sandbox meeting platform end to end (meetings integrations C1, #3173): the HTTP rpc `meetingPlatform/connectSandbox` seals a token, the worker's sweep lists the sandbox recordings, the member's
// click begins one, the sweep hands it over and the download job opens the SAME sealed token and stages the sandbox audio. A reviewer found that the connection once sealed a non-JSON token the job could
// never open, a seam the unit tests (which seal their own JSON) did not cross. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { meetingPlatformBinding, type MeetingPlatformRecordingView } from '@ludy/kernel-contract';
import { SandboxMeetingPlatform } from '@ludy/channel';
import { CredentialVault, DomainError, Runtime, defineCommand, defineQuery, parseVaultKey, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runMeetingsImport, type MeetingsImportJob } from '../src/meetings-import.ts';
import { runMeetingsImportSweep } from '../src/meetings-import-sweep.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-meeting-sandbox-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'meeting-platform-sandbox-test' };

// The member's click ("Nhập") belongs to the meetings module's command; the test stands in for it with the same definer call.
// The Meetings app is installed here (a definition of its module), so the worker's per-org check (ADR-0053) finds it on for every org.
const meetingsInstalled = defineQuery({ name: 'meetings.test_installed', input: z.object({}), access: ['owner'], handler: async () => 'on' });
const begin = defineCommand({
  name: 'test.mp.begin',
  input: z.strictObject({ recordingId: z.string(), meetingId: z.string(), stagingKey: z.string() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin', 'member'],
  handler: async (ctx, input) => {
    await sql`SELECT ludy_kernel.meeting_platform_recording_begin(${input.recordingId}::uuid, ${input.meetingId}::uuid, ${input.stagingKey})`.execute(ctx.trx).catch((error) => {
      const message = (error as { message?: string } | null)?.message ?? 'ERR';
      throw new DomainError(message, 409, message);
    });
    return { ok: true };
  },
});

interface Account { subject: string; email: string; session: string; userId: string }
const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@mp-sandbox.test`, session: randomUUID(), userId: '' });

suite('the sandbox meeting platform from the HTTP rpc to the staged bytes (meetings integrations C1, #3173)', () => {
  const dbName = `crove_test_mp_sandbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let apps: Record<'on' | 'sandboxOff', ReturnType<typeof createHttpApp>>;
  let worker: Runtime;
  let api: Runtime;
  // The member's click runs on a plain runtime (no session source): the test has no browser session behind its user actor.
  let clicker: Runtime;
  let workerDb: ReturnType<typeof createDb>;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const owner = account('owner');
  const member = account('member');
  const viewer = account('viewer');
  let org = { slug: '', orgId: '' };

  const sqlAdmin = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await c.query<R>(text, params);
    } finally {
      await c.end();
    }
  };
  const tokenFor = (who: Account, mfa = false) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...(mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {}) })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(who.subject).setIssuer(ISSUER).setAudience('authenticated').setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(SECRET));
  };
  async function rpc(path: string, who: Account, input: unknown, options: { slug?: string | null; app?: keyof typeof apps; mfa?: boolean } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await apps[options.app ?? 'on'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who, options.mfa)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }
  const blobs = () => {
    const stored = new Map<string, Uint8Array>();
    return { stored, put: async (key: string, bytes: Uint8Array) => (stored.set(key, bytes), 'content:1'), delete: async (key: string) => void stored.delete(key) };
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('ludy_app', 'test-app-pw');
    const pool = createPool({ connectionString: appUrl, max: 4 });
    const workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    pools.push(pool, workerPool);
    const db = createDb(pool);
    workerDb = createDb(workerPool);
    const defs = { commands: [...kernelCommands, begin], queries: [...kernelQueries({ inboundDomain: null }), meetingsInstalled] };
    api = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
    clicker = new Runtime(db, { manifests: TEST_MANIFESTS }).register(defs);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const make = (sandbox: boolean) => createHttpApp({ config, runtime: api, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: { broker: vault, sandbox } });
    apps = { on: make(true), sandboxOff: make(false) };

    for (const who of [owner, member, viewer]) who.userId = String((await rpc('me/get', who, undefined, { slug: null })).body?.userId);
    const created = await rpc('org/create', owner, { name: 'Công ty Họp', idempotencyKey: randomUUID() }, { slug: null });
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    for (const [who, role] of [[member, 'member'], [viewer, 'viewer']] as const) {
      const invite = await rpc('org/invite', owner, { email: who.email, role }, { mfa: true });
      expect((await rpc('invites/accept', who, { token: String(invite.body?.acceptPath).split('#')[1] }, { slug: null })).status).toBe(200);
    }
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  let connectionId = '';
  const sent: MeetingsImportJob[] = [];
  const store = blobs();
  const sandbox = new SandboxMeetingPlatform();
  const sweep = () => runMeetingsImportSweep({ runtime: worker, workerDb, broker: vault, store, adapters: { sandbox }, send: async (job: MeetingsImportJob) => void sent.push(job) } as never);
  const recordings = async () => (await rpc('meetingPlatform/recordings', member, {})).body as MeetingPlatformRecordingView[];
  const meetingFor = async () =>
    (await sqlAdmin<{ id: string }>(
      `INSERT INTO crove_meetings.meeting (org_id, recorder_user_id, title, consent_method, consent_confirmed_by, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp thử', 'platform_notice', $2, '2026-11-imp-v1', current_date + 7, current_date + 30) RETURNING id`,
      [org.orgId, member.userId],
    )).rows[0]?.id as string;

  it('connects the sandbox as a member, reconnects the same row, refuses a viewer and answers 404 with the sandbox off', async () => {
    const connected = await rpc('meetingPlatform/connectSandbox', member, {});
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ reconnected: false });
    connectionId = String(connected.body?.connectionId);
    expect((await rpc('meetingPlatform/connectSandbox', member, {})).body).toEqual({ connectionId, reconnected: true });
    expect((await rpc('meetingPlatform/connectSandbox', viewer, {})).status).toBe(403);
    expect(await rpc('meetingPlatform/connectSandbox', member, {}, { app: 'sandboxOff' })).toMatchObject({ status: 404, body: { code: 'CHANNEL_PROVIDER_DISABLED' } });
  });

  it('seals a token the worker can open: JSON with a string accessToken, bound to the sandbox account', async () => {
    const sealed = await worker.query<{ keyId: string; envelope: string; provider: string; externalAccount: string }>('kernel.meeting_platform.credential', { connectionId }, { actor: SYSTEM, orgId: org.orgId });
    const secret = vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, meetingPlatformBinding(org.orgId, 'sandbox', 'sandbox@local'));
    const parsed = JSON.parse(secret) as { accessToken?: unknown };
    expect(parsed).toEqual(expect.objectContaining({ accessToken: expect.any(String) }));
    expect((parsed.accessToken as string).length).toBeGreaterThan(0);
  });

  it('lists the two sandbox recordings through the sweep, lets the video-only one begin (its job fails it without an extractor), and stages the audio one through the job', async () => {
    const first = await sweep();
    expect(first.failures).toBe(0);
    expect(first.listed).toBeGreaterThanOrEqual(1);
    const listed = await recordings();
    expect(listed.map((r) => [r.status, r.hasAudio, r.hasVideo]).sort()).toEqual([['suggested', false, true], ['suggested', true, false]]);
    const idOf = async (externalId: string) => (await sqlAdmin<{ id: string }>('SELECT id FROM ludy_kernel.meeting_platform_recording WHERE connection_id = $1 AND external_id = $2', [connectionId, externalId])).rows[0]?.id as string;
    const key = `staging/${randomBytes(32).toString('hex')}`;
    const stageKey = (recordingId: string, meetingId: string, stagingKey: string) => clicker.execute('test.mp.begin', { recordingId, meetingId, stagingKey }, { actor: { type: 'user', userId: member.userId, aal: 'aal1' }, orgId: org.orgId });
    // A video-only recording begins since C2a (the module's command refuses it where no sandbox can take its audio out; this test begins at the definer): it is queued like any other row.
    const videoId = await idOf('sandbox-rec-video');
    await stageKey(videoId, await meetingFor(), `staging/${randomBytes(32).toString('hex')}`);
    const audioId = await idOf('sandbox-rec-audio');
    await stageKey(audioId, await meetingFor(), key);
    await sweep();
    // Both rows are queued now, in no fixed order: each job is found by the platform's id.
    const job = sent.find((j) => j.orgId === org.orgId && j.externalId === 'sandbox-rec-audio');
    expect(job).toMatchObject({ id: audioId, connectionId, provider: 'sandbox', externalId: 'sandbox-rec-audio', hasAudio: true, stagingKey: key });
    expect(sent.find((j) => j.orgId === org.orgId && j.externalId === 'sandbox-rec-video')).toMatchObject({ id: videoId, hasAudio: false, hasVideo: true });
    // The job opens the token the rpc sealed (the step that failed with a non-JSON secret) and stages the sandbox file under the row's key.
    expect(await runMeetingsImport({ runtime: worker, broker: vault, store, adapters: { sandbox }, extractor: null } as never, job as MeetingsImportJob, { retryCount: 0, retryLimit: 3 })).toBe('staged');
    expect(store.stored.get(key)?.byteLength).toBeGreaterThan(44);
    const after = await recordings();
    expect(after.find((r) => r.id === audioId)?.status).toBe('staged');
    // Without an extractor (no MEDIA_URL) the job fails the video-only row with a short code, as C1 did at the click.
    const videoJob = sent.find((j) => j.orgId === org.orgId && j.externalId === 'sandbox-rec-video');
    expect(await runMeetingsImport({ runtime: worker, broker: vault, store, adapters: { sandbox }, extractor: null } as never, videoJob as MeetingsImportJob, { retryCount: 0, retryLimit: 3 })).toBe('failed');
    const failed = await recordings();
    expect(failed.find((r) => r.id === videoId)).toMatchObject({ status: 'failed', errorCode: 'no_audio' });
  });
});
