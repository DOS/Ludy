// SPDX-License-Identifier: AGPL-3.0-only
// A Zoom cloud recording from the connect to the staged bytes, in one go (meetings integrations C3, #3175): the member connects through the HTTP rpc, Zoom's signed webhook rings the doorbell, the worker's
// sweep lists the member's recordings through the REAL Zoom adapter (recorded fixtures behind a stub transport), the member's click begins one, the sweep hands it over and the download job opens the SAME sealed
// token the connect sealed and asks the guarded transfer for the file Zoom's API named. Every piece has its own test (zoom-webhook, meeting-platform-ring, meeting-platform-zoom-connect, the adapter's
// and the job's); this one crosses their seams, so the first live run with a real Zoom app (#3178) has one known path to compare with. Nothing calls a real Zoom host. Set LUDY_TEST_ADMIN_URL (or
// CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { ZoomMeetingPlatform, type Fetch } from '@ludy/channel';
import { CredentialVault, DomainError, Runtime, defineCommand, defineQuery, parseVaultKey, type BlobStore, type EgressStream } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runMeetingsImport, type MeetingsImportJob } from '../src/meetings-import.ts';
import { runMeetingsImportSweep } from '../src/meetings-import-sweep.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { ZOOM_WEBHOOK_PATH } from '../src/zoom-webhook.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURES = new URL('../../../packages/channel/test/fixtures/zoom/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');
const SECRET = 'test-only-jwt-secret-for-meeting-zoom-flow-0123456789';
const ISSUER = 'ludy-auth';
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'meeting-platform-zoom-flow-test' };
const APP_URL = 'https://app.example.test';
const ZOOM_APP = { clientId: 'zoom-client-id-0001', clientSecret: 'zoom-client-secret-not-real' };
const WEBHOOK_SECRET = 'zoom-webhook-secret-not-real-0001';
// The host id the profile below answers with, and the one the notices name.
const HOST = 'synthetic-user-id-0001';
const ACCESS = 'zoom-access-not-real-0001';
// The fixture's recordings are of 2026-11-04 to 2026-11-17: the sweep and the adapter both ask "what is the last 14 days" of this day.
const FIXTURE_NOW = new Date('2026-11-18T12:00:00Z');
const AUDIO_UUID = 'AAAAAAAAAAAAAAAAAAAAAA==';
const VIDEO_UUID = '/BBBB//BBBBBBBBBBBBBBB==';
const TRANSCRIPT_UUID = 'CCCCCCCCCCCCCCCCCCCCCC==';

// The member's click ("Nhập") belongs to the meetings module's command; the test stands in for it with the same definer call, as the sandbox test does.
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
const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@mp-zoom-flow.test`, session: randomUUID(), userId: '' });

// Zoom, as a script: the token endpoint and the profile (for the connect), the recordings list and the one meeting's files (fixtures), and a log of every call with the bearer it carried.
function zoom() {
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  const fetchImpl: Fetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, authorization: headers.authorization });
    if (url === 'https://zoom.us/oauth/token') {
      return new Response(JSON.stringify({ access_token: ACCESS, refresh_token: 'zoom-refresh-not-real-0001', expires_in: 3599, scope: 'cloud_recording:read:list_user_recordings user:read:user' }), { status: 200 });
    }
    if (url === 'https://api.zoom.us/v2/users/me') return new Response(JSON.stringify({ id: HOST, display_name: 'Linh Nguyen', email: 'linh.zoom@example.test' }), { status: 200 });
    if (url.startsWith('https://api.zoom.us/v2/users/me/recordings?')) return new Response(fixture('recordings-list.json'), { status: 200 });
    if (url === `https://api.zoom.us/v2/meetings/${encodeURIComponent(AUDIO_UUID)}/recordings`) return new Response(fixture('meeting-recordings.json'), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const listCalls = () => calls.filter((c) => c.url.startsWith('https://api.zoom.us/v2/users/me/recordings?'));
  return { fetchImpl, calls, listCalls };
}

suite('a Zoom cloud recording from the connect to the staged bytes (meetings integrations C3, #3175)', () => {
  const dbName = `ludy_test_mp_zoom_flow_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let http: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  let clicker: Runtime;
  let workerDb: ReturnType<typeof createDb>;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const stub = zoom();
  // No `now` on the adapter: the token the connect seals must expire an hour after the REAL clock, which the download job reads (it renews a token that is about to expire, and this test registers no refresh command).
  // The sweep's `now` alone fixes the 14 day window the recorded fixtures fit in (the adapter filters on the `since` it is given).
  const adapter = new ZoomMeetingPlatform(ZOOM_APP, { fetch: stub.fetchImpl });
  const owner = account('owner');
  const member = account('member');
  let org = { slug: '', orgId: '' };
  let connectionId = '';

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
  async function rpc(path: string, who: Account, input: unknown, options: { slug?: string | null; mfa?: boolean } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await http.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who, options.mfa)}`, 'content-type': 'application/json', ...(slug ? { 'x-ludy-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }
  // Zoom's notice, signed as Zoom signs it. Every notice carries its own event time, so none is taken for a replay of another.
  let eventTs = Date.now();
  async function notice(host: string, event = 'recording.completed') {
    eventTs += 1;
    const body = JSON.stringify({ event, event_ts: eventTs, payload: { account_id: 'acct-test-0001', object: { uuid: AUDIO_UUID, host_id: host } } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', WEBHOOK_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    return http.request(ZOOM_WEBHOOK_PATH, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zm-signature': signature, 'x-zm-request-timestamp': timestamp }, body });
  }
  const blobs = () => {
    const stored = new Map<string, Uint8Array>();
    return { stored, put: async (key: string, bytes: Uint8Array) => (stored.set(key, bytes), 'content:1'), delete: async (key: string) => void stored.delete(key) };
  };
  const store = blobs();
  const sent: MeetingsImportJob[] = [];
  const sweep = () => runMeetingsImportSweep({ runtime: worker, workerDb, broker: vault, store, adapters: { zoom: adapter }, send: async (job: MeetingsImportJob) => void sent.push(job), now: () => FIXTURE_NOW } as never);
  const recordings = async () => (await rpc('meetingPlatform/recordings', member, {})).body as MeetingPlatformRecordingView[];
  const syncedAt = async () => (await sqlAdmin<{ last_synced_at: Date | null }>('SELECT last_synced_at FROM ludy_kernel.meeting_platform_connection WHERE id = $1', [connectionId])).rows[0]?.last_synced_at ?? null;
  const idOf = async (externalId: string) => (await sqlAdmin<{ id: string }>('SELECT id FROM ludy_kernel.meeting_platform_recording WHERE connection_id = $1 AND external_id = $2', [connectionId, externalId])).rows[0]?.id as string;
  const meetingFor = async () =>
    (await sqlAdmin<{ id: string }>(
      `INSERT INTO ludy_meetings.meeting (org_id, recorder_user_id, title, consent_method, consent_confirmed_by, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp Zoom thử', 'platform_notice', $2, '2026-11-imp-v1', current_date + 7, current_date + 30) RETURNING id`,
      [org.orgId, member.userId],
    )).rows[0]?.id as string;

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
    const api = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
    clicker = new Runtime(db, { manifests: TEST_MANIFESTS }).register(defs);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    http = createHttpApp({
      config,
      runtime: api,
      store: {} as BlobStore,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      channels: { broker: vault, publicUrl: APP_URL, meetingPlatforms: { zoom: adapter } } as never,
      zoomWebhook: { secretToken: WEBHOOK_SECRET },
    });

    for (const who of [owner, member]) who.userId = String((await rpc('me/get', who, undefined, { slug: null })).body?.userId);
    const created = await rpc('org/create', owner, { name: 'Công ty Zoom Họp', idempotencyKey: randomUUID() }, { slug: null });
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', owner, { email: member.email, role: 'member' }, { mfa: true });
    expect((await rpc('invites/accept', member, { token: String(invite.body?.acceptPath).split('#')[1] }, { slug: null })).status).toBe(200);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('connects Zoom through the rpc and seals a token the worker opens, bound to the Zoom user id', async () => {
    const started = await rpc('meetingPlatform/connectStart', member, { provider: 'zoom' });
    expect(started.status).toBe(200);
    const finished = await rpc('meetingPlatform/connectFinish', member, { provider: 'zoom', state: started.body.state, code: 'code-not-real-0001' });
    expect(finished.status).toBe(200);
    connectionId = String(finished.body?.connectionId);
    const sealed = await worker.query<{ keyId: string; envelope: string; externalAccount: string }>('kernel.meeting_platform.credential', { connectionId }, { actor: SYSTEM, orgId: org.orgId });
    expect(sealed.externalAccount).toBe(HOST);
    const secret = JSON.parse(vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, meetingPlatformBinding(org.orgId, 'zoom', HOST))) as { accessToken?: unknown; refreshToken?: unknown };
    expect(secret).toMatchObject({ accessToken: ACCESS, refreshToken: 'zoom-refresh-not-real-0001' });
  });

  // The database's own sweep step deletes a suggestion older than 14 days by the real clock, and the fixtures are dated 2026-11-15 to 2026-11-17: from about 2026-11-29 a sweep that is not due would drop them, so every
  // step below that needs the rows follows a ring (which makes the next sweep list again) or finds them already importing.
  it('lists the recordings Zoom has finished in the last 14 days, through the member\'s own sealed token, and nothing it has not finished', async () => {
    expect(await sweep()).toMatchObject({ failures: 0 });
    expect(stub.listCalls()).toHaveLength(1);
    // The token the connect sealed, opened by the sweep, is the bearer of the list.
    expect(stub.listCalls()[0]?.authorization).toBe(`Bearer ${ACCESS}`);
    const rows = await recordings();
    const byId = new Map((await sqlAdmin<{ id: string; external_id: string }>('SELECT id, external_id FROM ludy_kernel.meeting_platform_recording WHERE connection_id = $1', [connectionId])).rows.map((r) => [r.id, r.external_id]));
    const shown = rows.map((r) => [byId.get(r.id), r.status, r.hasAudio, r.hasVideo, r.hasTranscript]);
    // Newest first. The one still processing (DDDD), the one with only chat and timeline files (EEEE) and the one older than 14 days (FFFF) are not offered.
    expect(shown).toEqual([
      [AUDIO_UUID, 'suggested', true, true, true],
      [VIDEO_UUID, 'suggested', false, true, false],
      [TRANSCRIPT_UUID, 'suggested', false, false, true],
    ]);
    expect(rows.every((r) => r.provider === 'zoom')).toBe(true);
    // Nothing is downloaded before a click: only the API of Zoom was asked, and no job was queued.
    expect(stub.calls.every((c) => c.url.startsWith('https://zoom.us/oauth/') || c.url.startsWith('https://api.zoom.us/'))).toBe(true);
    expect(sent).toEqual([]);
  });

  it('answers a signed notice with the same 200 for a known and an unknown host, and lists again only for the known one', async () => {
    // The connection was listed a moment ago, so the sweep leaves it alone until its 10 minutes are up.
    expect(await syncedAt()).not.toBeNull();
    expect(await sweep()).toMatchObject({ failures: 0 });
    expect(stub.listCalls()).toHaveLength(1);
    const stranger = await notice('someone-elses-host-id');
    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toEqual({ ok: true });
    expect(await syncedAt()).not.toBeNull();
    const ours = await notice(HOST);
    expect(ours.status).toBe(200);
    expect(await ours.json()).toEqual({ ok: true });
    // The doorbell only clears the last listing time; the sweep then lists the same connection again with the same token.
    expect(await syncedAt()).toBeNull();
    expect(await sweep()).toMatchObject({ failures: 0 });
    expect(stub.listCalls()).toHaveLength(2);
    expect(stub.listCalls()[1]?.authorization).toBe(`Bearer ${ACCESS}`);
    // The transcript notice rings the same way; a forged one (wrong secret) rings nothing and creates nothing.
    const forged = await http.request(ZOOM_WEBHOOK_PATH, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zm-signature': 'v0=00', 'x-zm-request-timestamp': String(Math.floor(Date.now() / 1000)) }, body: JSON.stringify({ event: 'recording.completed', event_ts: 1, payload: { object: { uuid: 'u', host_id: HOST } } }) });
    expect(forged.status).toBe(401);
    expect(await syncedAt()).not.toBeNull();
    expect((await notice(HOST, 'recording.transcript_completed')).status).toBe(200);
    expect(await syncedAt()).toBeNull();
    // The listing is idempotent: the same three suggestions, not six.
    await sweep();
    expect(await recordings()).toHaveLength(3);
  });

  it('begins a recording, hands it to the job, and stages the audio Zoom\'s API named, fetched with the member\'s sealed token from the first host only', async () => {
    const key = `staging/${randomBytes(32).toString('hex')}`;
    const begins = async (recordingId: string, stagingKey: string) => clicker.execute('test.mp.begin', { recordingId, meetingId: await meetingFor(), stagingKey }, { actor: { type: 'user', userId: member.userId, aal: 'aal1' }, orgId: org.orgId });
    const audioId = await idOf(AUDIO_UUID);
    const videoId = await idOf(VIDEO_UUID);
    await begins(audioId, key);
    await begins(videoId, `staging/${randomBytes(32).toString('hex')}`);
    await sweep();
    const job = sent.find((j) => j.orgId === org.orgId && j.externalId === AUDIO_UUID);
    expect(job).toMatchObject({ id: audioId, connectionId, provider: 'zoom', externalId: AUDIO_UUID, hasAudio: true, stagingKey: key });
    const opened: Array<{ url: string; headers: unknown; firstHosts: readonly string[] | undefined }> = [];
    const audio = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const stream = (async (url: string, init: { headers?: unknown }, options: { firstHosts?: readonly string[] }) => {
      opened.push({ url, headers: init.headers, firstHosts: options.firstHosts });
      return { url, status: 200, headers: {}, body: (async function* () { yield audio.slice(0, 5); yield audio.slice(5); })(), destroy: () => undefined } as EgressStream;
    }) as never;
    const deps = { runtime: worker, broker: vault, store, adapters: { zoom: adapter }, extractor: null, stream } as never;
    expect(await runMeetingsImport(deps, job as MeetingsImportJob, { retryCount: 0, retryLimit: 3 })).toBe('staged');
    // The address Zoom's API gave at click time (the fresh one, not the webhook-style one of the list), the member's token, and the exact first host.
    expect(opened).toEqual([{ url: 'https://us02web.zoom.us/rec/download/f-audio-fresh', headers: { authorization: `Bearer ${ACCESS}` }, firstHosts: ['us02web.zoom.us'] }]);
    expect([...(store.stored.get(key) ?? [])]).toEqual([...audio]);
    expect((await recordings()).find((r) => r.id === audioId)?.status).toBe('staged');
    // A recording with only a video file, on a deployment without the media sandbox, fails with a short code and no download is opened for it.
    const videoJob = sent.find((j) => j.orgId === org.orgId && j.externalId === VIDEO_UUID);
    expect(videoJob).toMatchObject({ id: videoId, hasAudio: false, hasVideo: true });
    expect(await runMeetingsImport(deps, videoJob as MeetingsImportJob, { retryCount: 0, retryLimit: 3 })).toBe('failed');
    expect(opened).toHaveLength(1);
    expect((await recordings()).find((r) => r.id === videoId)).toMatchObject({ status: 'failed', errorCode: 'no_audio' });
  });
});
