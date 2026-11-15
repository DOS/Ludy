// SPDX-License-Identifier: AGPL-3.0-only
// Meeting platforms and the recordings they offer (meetings integrations C1, #3173) on a real database: a member connects (the offline sandbox) and sees only their own connection and
// recordings, the worker's sweep replaces the suggestions through one definer, the import walks suggested -> importing -> staged -> claimed -> imported and refuses every other step, another member
// cannot touch the row, the sweep expires what nobody claimed (a faked clock: the test moves the timestamps as the table owner), a disconnect waits for an import in flight and deletes everything it
// listed, and the sealed credential reaches the worker alone, only while the member is still in the org. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { MeetingPlatformRecordingView } from '@crove/kernel-contract';
import { MeetingPlatformError, SandboxMeetingPlatform, type MeetingPlatformAdapter } from '@crove/channel';
import { meetingPlatformBinding } from '@crove/kernel-contract';
import { CredentialVault, DomainError, Runtime, defineCommand, defineQuery, parseVaultKey } from '@crove/kernel-runtime';
import { runMeetingsImport, type MeetingsImportJob } from '../src/meetings-import.ts';
import { runMeetingsImportSweep } from '../src/meetings-import-sweep.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'meeting-platform-test' };

// The click that starts an import and the recording of its media belong to the meetings module's commands; the test stands in for them with the same definer calls.
const asDomain = (error: unknown): never => {
  const message = (error as { message?: string } | null)?.message ?? 'ERR';
  throw new DomainError(message, 409, message);
};
// The Meetings app is installed here (a definition of its module), so the worker's per-org check (ADR-0053) finds it on for every org.
const meetingsInstalled = defineQuery({ name: 'meetings.test_installed', input: z.object({}), access: ['owner'], handler: async () => 'on' });
const begin = defineCommand({
  name: 'test.mp.begin',
  input: z.strictObject({ recordingId: z.string(), meetingId: z.string(), stagingKey: z.string() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin', 'member'],
  handler: async (ctx, input) => {
    await sql`SELECT crove_kernel.meeting_platform_recording_begin(${input.recordingId}::uuid, ${input.meetingId}::uuid, ${input.stagingKey})`.execute(ctx.trx).catch(asDomain);
    return { ok: true };
  },
});
const imported = defineCommand({
  name: 'test.mp.imported',
  input: z.strictObject({ meetingId: z.string() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin', 'member'],
  handler: async (ctx, input) => {
    await sql`SELECT crove_kernel.meeting_platform_recording_imported(${input.meetingId}::uuid)`.execute(ctx.trx).catch(asDomain);
    return { ok: true };
  },
});
// Hands the definer a body the command's own schema would have refused.
const rawReplace = defineCommand({
  name: 'test.mp.raw_replace',
  input: z.strictObject({ connectionId: z.string(), rows: z.unknown() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    const { rows } = await sql<{ n: number }>`SELECT crove_kernel.meeting_platform_recording_replace(${input.connectionId}::uuid, ${JSON.stringify(input.rows)}::jsonb) AS n`.execute(ctx.trx).catch(asDomain);
    return { count: rows[0]?.n };
  },
});
const recordingRows = defineQuery({
  name: 'test.mp.recording_rows',
  input: z.strictObject({}),
  access: 'system',
  handler: async (ctx): Promise<number> => (await ctx.trx.selectFrom('crove_kernel.meeting_platform_recording').select('id').where('org_id', '=', ctx.orgId).execute()).length,
});

suite('the meetings import sweep and job on PostgreSQL (meetings integrations C1, #3173)', () => {
  const dbName = `crove_test_meetings_import_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let api: Runtime;
  let worker: Runtime;
  let personDb: ReturnType<typeof createDb>;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));
  // The meeting a click made: begin checks that it exists and is the member's to record, so the test makes a real one (as the command does) with the platform-notice consent.
  const meetingFor = async (o: { orgId: string }, user: string): Promise<string> =>
    (await sqlAdmin<{ id: string }>(
      `INSERT INTO crove_meetings.meeting (org_id, recorder_user_id, title, consent_method, consent_confirmed_by, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp thử', 'platform_notice', $2, '2026-11-imp-v1', current_date + 7, current_date + 30) RETURNING id`,
      [o.orgId, user],
    )).rows[0]?.id as string;
  const person = (name: string) => upsertIdentity(personDb, { issuer: 'mp', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@mp.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const lan = await person('lan');
    const nam = await person('nam');
    const viewer = await person('viewer');
    await sqlAdmin("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, lan, nam, viewer]);
    const exec = <T = unknown>(user: string, command: string, input: unknown = {}) => api.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T = unknown>(user: string, name: string, input: unknown = {}) => api.query<T>(name, input, { actor: asUser(user), orgId });
    const sys = <T = unknown>(command: string, input: unknown = {}) => worker.execute<T>(command, input, { actor: SYSTEM, orgId });
    const sysQuery = <T = unknown>(name: string, input: unknown = {}) => worker.query<T>(name, input, { actor: SYSTEM, orgId });
    return { orgId, owner, lan, nam, viewer, exec, query, sys, sysQuery };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  const listed = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `Họp ${id}`,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lengthSeconds: 1800,
    sizeBytes: 123_456,
    hasAudio: true,
    hasVideo: false,
    hasTranscript: false,
    ...over,
  });
  const replace = (o: Org, connectionId: string, rows: unknown[]) => o.sys<{ count: number }>('kernel.meeting_platform.recording_replace', { connectionId, rows });
  const mine = (o: Org, user: string) => o.query<MeetingPlatformRecordingView[]>(user, 'kernel.meeting_platform.recordings');
  const rowOf = async (externalId: string, connectionId: string) =>
    (await sqlAdmin<{ id: string; status: string; title: string; staging_key: string | null; error_code: string | null; meeting_id: string | null; size_bytes: string | null }>(
      'SELECT id, status, title, staging_key, error_code, meeting_id, size_bytes FROM crove_kernel.meeting_platform_recording WHERE connection_id = $1 AND external_id = $2',
      [connectionId, externalId],
    )).rows[0];
  const idOf = async (externalId: string, connectionId: string) => (await rowOf(externalId, connectionId))?.id as string;
  const stagingKey = () => `staging/${randomBytes(32).toString('hex')}`;
  // Walks one listed recording to `importing` as its member, returning the ids the later steps need.
  async function importing(o: Org, user: string, connectionId: string, externalId: string) {
    await replace(o, connectionId, [listed(externalId)]);
    const recordingId = await idOf(externalId, connectionId);
    const meetingId = await meetingFor(o, user);
    const key = stagingKey();
    await o.exec(user, 'test.mp.begin', { recordingId, meetingId, stagingKey: key });
    return { recordingId, meetingId, key };
  }
  const staged = async (o: Org, user: string, connectionId: string, externalId: string) => {
    const r = await importing(o, user, connectionId, externalId);
    await o.sys('kernel.meeting_platform.import_staged', { recordingId: r.recordingId, stagingKey: r.key });
    return r;
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    personDb = createDb(appPool);
    workerDbHandle = createDb(workerPool);
    const defs = { commands: [...kernelCommands, begin, imported, rawReplace], queries: [...kernelQueries({ inboundDomain: null }), recordingRows, meetingsInstalled] };
    api = new Runtime(personDb, { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(defs);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });


  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  let workerDbHandle: ReturnType<typeof createDb>;
  const SECRET = JSON.stringify({ accessToken: 'sandbox-access-token' });

  // Connects the sandbox account with a REAL sealed token (the vault the job opens it with).
  async function connectSealed(o: Org, user: string, account = `${randomUUID().slice(0, 8)}@sandbox.test`) {
    const sealed = vault.seal(SECRET, meetingPlatformBinding(o.orgId, 'sandbox', account));
    const done = await o.exec<{ connectionId: string }>(user, 'kernel.meeting_platform.connect', {
      provider: 'sandbox',
      externalAccount: account,
      displayName: account,
      scopes: [],
      expiresAt: null,
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    });
    return done.connectionId;
  }

  const store = () => {
    const stored = new Map<string, Uint8Array>();
    const deleted: string[] = [];
    return {
      stored,
      deleted,
      put: async (key: string, bytes: Uint8Array) => {
        stored.set(key, bytes);
        return 'content:1';
      },
      delete: async (key: string) => {
        deleted.push(key);
        stored.delete(key);
      },
    };
  };
  const sweepDeps = (o: Org, over: Record<string, unknown> = {}) => {
    const sent: MeetingsImportJob[] = [];
    const blobs = store();
    return {
      sent,
      blobs,
      deps: {
        runtime: worker,
        workerDb: workerDbHandle,
        broker: vault,
        store: blobs,
        adapters: { sandbox: new SandboxMeetingPlatform() },
        send: async (job: MeetingsImportJob) => {
          sent.push(job);
        },
        ...over,
      } as unknown as Parameters<typeof runMeetingsImportSweep>[0],
    };
  };
  const only = <T extends { orgId: string }>(o: Org, jobs: T[]) => jobs.filter((j) => j.orgId === o.orgId);

  it('lists a due connection into suggestions, not again until it is due, and again when the member refreshes', async () => {
    const o = await org();
    const connectionId = await connectSealed(o, o.lan);
    const first = sweepDeps(o);
    expect((await runMeetingsImportSweep(first.deps)).listed).toBeGreaterThanOrEqual(1);
    const rows = await o.query<MeetingPlatformRecordingView[]>(o.lan, 'kernel.meeting_platform.recordings');
    expect(rows.map((r) => r.status)).toEqual(['suggested', 'suggested']);
    // Listed just now: the next pass leaves it alone ...
    const second = await runMeetingsImportSweep(sweepDeps(o).deps);
    expect(await sqlAdmin<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.meeting_platform_recording WHERE connection_id = $1', [connectionId])).toMatchObject({ rows: [{ n: '2' }] });
    expect(second.failures).toBe(0);
    // ... until the member asks to refresh, which only clears the time of the last listing.
    await o.exec(o.lan, 'kernel.meeting_platform.refresh', {});
    const due = await sqlAdmin<{ connection_id: string }>('SELECT connection_id FROM crove_kernel.meeting_platform_sync_due(NULL, NULL, 1000)');
    expect(due.rows.map((r) => r.connection_id)).toContain(connectionId);
    // Nothing was downloaded: no job, no bytes.
    expect(first.sent).toEqual([]);
    expect(first.blobs.stored.size).toBe(0);
  });

  it('hands an importing recording to the queue, downloads it to staging with the job, and the member sees it staged', async () => {
    const o = await org();
    const connectionId = await connectSealed(o, o.lan);
    await runMeetingsImportSweep(sweepDeps(o).deps);
    const audio = await sqlAdmin<{ id: string }>("SELECT id FROM crove_kernel.meeting_platform_recording WHERE connection_id = $1 AND external_id = 'sandbox-rec-audio'", [connectionId]);
    const recordingId = audio.rows[0]?.id as string;
    const key = stagingKey();
    await o.exec(o.lan, 'test.mp.begin', { recordingId, meetingId: await meetingFor(o, o.lan), stagingKey: key });
    const run = sweepDeps(o);
    const done = await runMeetingsImportSweep(run.deps);
    expect(done.handedOver).toBeGreaterThanOrEqual(1);
    const job = only(o, run.sent)[0];
    expect(job).toMatchObject({ id: recordingId, connectionId, provider: 'sandbox', externalId: 'sandbox-rec-audio', hasAudio: true, stagingKey: key });
    // The job opens the sealed token, fetches the sandbox file and stages it under the row's key.
    expect(await runMeetingsImport({ runtime: worker, broker: vault, store: run.blobs, adapters: { sandbox: new SandboxMeetingPlatform() }, media: null } as never, job as MeetingsImportJob, { retryCount: 0, retryLimit: 3 })).toBe('staged');
    expect(run.blobs.stored.get(key)?.byteLength).toBeGreaterThan(44);
    expect((await mine(o, o.lan)).find((r) => r.id === recordingId)?.status).toBe('staged');
  });

  it('fails what was staged and not claimed after 55 minutes, deletes its bytes and forgets the key', async () => {
    const o = await org();
    const connectionId = await connectSealed(o, o.lan);
    const r = await staged(o, o.lan, connectionId, 'late');
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_recording SET staged_at = now() - interval '56 minutes' WHERE id = $1", [r.recordingId]);
    const run = sweepDeps(o);
    await runMeetingsImportSweep(run.deps);
    expect(run.blobs.deleted).toContain(r.key);
    expect(await rowOf('late', connectionId)).toMatchObject({ status: 'failed', error_code: 'not_claimed', staging_key: null });
  });

  it('notes a platform that cannot be listed with a short code and leaves it for ten minutes; a refused token expires the connection', async () => {
    const o = await org();
    const down = await connectSealed(o, o.lan);
    const failing = (code: 'platform_unavailable' | 'connection_expired'): MeetingPlatformAdapter => ({ provider: 'sandbox', hosts: [], prepareDownload: async () => Promise.reject(new Error('x')), list: async () => Promise.reject(new MeetingPlatformError(code, 'platform words that must not be kept')) });
    const first = await runMeetingsImportSweep(sweepDeps(o, { adapters: { sandbox: failing('platform_unavailable') } }).deps);
    expect(first.failures).toBeGreaterThanOrEqual(1);
    const noted = await sqlAdmin<{ status: string; status_reason: string | null }>('SELECT status, status_reason FROM crove_kernel.meeting_platform_connection WHERE id = $1', [down]);
    expect(noted.rows[0]).toEqual({ status: 'active', status_reason: 'platform_unavailable' });
    // Not due again for ten minutes: another pass does not even call the adapter.
    let calls = 0;
    const counting: MeetingPlatformAdapter = { ...failing('platform_unavailable'), list: async () => { calls += 1; return []; } };
    await runMeetingsImportSweep(sweepDeps(o, { adapters: { sandbox: counting } }).deps);
    expect(calls).toBe(0);
    // A refused token expires the connection.
    const refused = await connectSealed(o, o.nam);
    await runMeetingsImportSweep(sweepDeps(o, { adapters: { sandbox: failing('connection_expired') } }).deps);
    expect((await sqlAdmin<{ status: string }>('SELECT status FROM crove_kernel.meeting_platform_connection WHERE id = $1', [refused])).rows[0]?.status).toBe('expired');
    expect(JSON.stringify((await sqlAdmin('SELECT status_reason FROM crove_kernel.meeting_platform_connection')).rows)).not.toContain('platform words');
  });

  it('expires the connection of a member who left the org, since no token can be opened for them any more', async () => {
    const o = await org();
    const connectionId = await connectSealed(o, o.nam);
    await sqlAdmin('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.nam]);
    const run = sweepDeps(o);
    await runMeetingsImportSweep(run.deps);
    // A member who left is not due at all (the sweep's page skips them): nothing is listed or opened for them.
    expect((await sqlAdmin<{ status: string }>('SELECT status FROM crove_kernel.meeting_platform_connection WHERE id = $1', [connectionId])).rows[0]?.status).toBe('active');
    expect(await sqlAdmin<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.meeting_platform_recording WHERE connection_id = $1', [connectionId])).toMatchObject({ rows: [{ n: '0' }] });
  });

  it('a duplicate job and a stale job after a re-click do nothing: the row is staged once and the bytes are never deleted by the wrong job', async () => {
    const o = await org();
    const connectionId = await connectSealed(o, o.lan);
    await runMeetingsImportSweep(sweepDeps(o).deps);
    const audio = await sqlAdmin<{ id: string }>("SELECT id FROM crove_kernel.meeting_platform_recording WHERE connection_id = $1 AND external_id = 'sandbox-rec-audio'", [connectionId]);
    const recordingId = audio.rows[0]?.id as string;
    const key = stagingKey();
    await o.exec(o.lan, 'test.mp.begin', { recordingId, meetingId: await meetingFor(o, o.lan), stagingKey: key });
    const job: MeetingsImportJob = { orgId: o.orgId, id: recordingId, connectionId, provider: 'sandbox', externalId: 'sandbox-rec-audio', hasAudio: true, hasVideo: false, sizeBytes: null, stagingKey: key };
    const blobs = store();
    const deps = { runtime: worker, broker: vault, store: blobs, adapters: { sandbox: new SandboxMeetingPlatform() }, media: null } as never;
    // The first job stages the row; a duplicate job of the same recording and key finds it staged and touches nothing (the bytes stay).
    expect(await runMeetingsImport(deps, job, { retryCount: 0, retryLimit: 3 })).toBe('staged');
    expect(await runMeetingsImport(deps, job, { retryCount: 0, retryLimit: 3 })).toBe('skipped');
    expect(blobs.deleted).toEqual([]);
    expect(blobs.stored.has(key)).toBe(true);
    expect((await rowOf('sandbox-rec-audio', connectionId))?.status).toBe('staged');
    // The row fails (the member did not claim in time), is begun again with a NEW key, and the old job comes back: it does nothing to the new attempt.
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_recording SET staged_at = now() - interval '56 minutes' WHERE id = $1", [recordingId]);
    await runMeetingsImportSweep(sweepDeps(o).deps);
    const fresh = stagingKey();
    await o.exec(o.lan, 'test.mp.begin', { recordingId, meetingId: await meetingFor(o, o.lan), stagingKey: fresh });
    expect(await runMeetingsImport(deps, job, { retryCount: 0, retryLimit: 3 })).toBe('skipped');
    expect(await rowOf('sandbox-rec-audio', connectionId)).toMatchObject({ status: 'importing', staging_key: fresh });
  });
});
