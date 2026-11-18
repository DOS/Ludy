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
import type { MeetingPlatformConnectionView, MeetingPlatformRecordingView } from '@crove/kernel-contract';
import { DomainError, Runtime, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'meeting-platform-test' };
const MIN = 60_000;

// The click that starts an import and the recording of its media belong to the meetings module's commands; the test stands in for them with the same definer calls.
const asDomain = (error: unknown): never => {
  const message = (error as { message?: string } | null)?.message ?? 'ERR';
  throw new DomainError(message, 409, message);
};
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

suite('meeting platforms on PostgreSQL (meetings integrations C1, #3173)', () => {
  const dbName = `crove_test_meeting_platform_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let api: Runtime;
  let worker: Runtime;
  let personDb: ReturnType<typeof createDb>;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
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

  const envelopeOf = (text: string) => Buffer.from(text).toString('base64');
  async function connect(o: Org, user: string, account = `${randomUUID().slice(0, 8)}@sandbox.test`, provider: 'sandbox' | 'zoom' = 'sandbox', secret = 'sealed-bytes-1') {
    const done = await o.exec<{ connectionId: string; reconnected: boolean }>(user, 'kernel.meeting_platform.connect', {
      provider,
      externalAccount: account,
      displayName: `Tài khoản ${account}`,
      scopes: ['recordings.read'],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      credential: { keyId: 'k1', envelope: envelopeOf(secret) },
    });
    return { ...done, account, secret };
  }

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
  const claimed = async (o: Org, user: string, connectionId: string, externalId: string) => {
    const r = await staged(o, user, connectionId, externalId);
    await o.exec(user, 'kernel.meeting_platform.import.claim', { recordingId: r.recordingId, meetingId: r.meetingId });
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
    const defs = { commands: [...kernelCommands, begin, imported, rawReplace], queries: [...kernelQueries({ inboundDomain: null }), recordingRows] };
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

  it('lets a member connect, shows the connection and its recordings to that member alone, and refuses a viewer', async () => {
    const o = await org();
    const c = await connect(o, o.lan);
    expect(c.reconnected).toBe(false);
    await replace(o, c.connectionId, [listed('r1')]);
    const view = await o.query<MeetingPlatformConnectionView[]>(o.lan, 'kernel.meeting_platform.connections');
    expect(view).toMatchObject([{ id: c.connectionId, provider: 'sandbox', status: 'active', statusReason: null }]);
    expect(Object.keys(view[0] as object).sort()).toEqual(['connectedAt', 'displayName', 'id', 'lastSyncedAt', 'provider', 'status', 'statusReason']);
    expect(await mine(o, o.lan)).toMatchObject([{ connectionId: c.connectionId, provider: 'sandbox', title: 'Họp r1', status: 'suggested', hasAudio: true, sizeBytes: 123_456, lengthSeconds: 1800, meetingId: null, errorCode: null }]);
    // Another member, an owner and a viewer read none of it.
    for (const who of [o.nam, o.owner, o.viewer]) {
      expect(await o.query(who, 'kernel.meeting_platform.connections')).toEqual([]);
      expect(await mine(o, who)).toEqual([]);
    }
    // The system context reads no recording through the tenant role: the row policy is the member's alone.
    expect(await o.sysQuery<number>('test.mp.recording_rows')).toBe(0);
    // Connecting the same account again is a reconnect of the same row.
    expect(await connect(o, o.lan, c.account)).toMatchObject({ connectionId: c.connectionId, reconnected: true });
    expect(await o.query<unknown[]>(o.lan, 'kernel.meeting_platform.connections')).toHaveLength(1);
    await expect(connect(o, o.viewer)).rejects.toMatchObject({ status: 403 });
    // The audit row holds the ids and provider, never the sealed bytes or the account.
    const audit = await sqlAdmin<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.meeting_platform.connect' AND outcome = 'ok'", [o.orgId]);
    expect(audit.rows.length).toBe(2);
    const text = JSON.stringify(audit.rows);
    expect(text).not.toContain(envelopeOf(c.secret));
    expect(text).not.toContain(c.account);
    expect(text).toContain(c.connectionId);
  });

  it('a connection that is expired comes back active, to be listed again, when the member connects again', async () => {
    const o = await org();
    const c = await connect(o, o.lan);
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_connection SET status = 'expired', status_reason = 'grant revoked', last_synced_at = now() WHERE id = $1", [c.connectionId]);
    expect(await o.query<MeetingPlatformConnectionView[]>(o.lan, 'kernel.meeting_platform.connections')).toMatchObject([{ status: 'expired', statusReason: 'grant revoked' }]);
    await connect(o, o.lan, c.account, 'sandbox', 'sealed-bytes-2');
    expect(await o.query<MeetingPlatformConnectionView[]>(o.lan, 'kernel.meeting_platform.connections')).toMatchObject([{ status: 'active', statusReason: null, lastSyncedAt: null }]);
  });

  it('starts and finishes a Zoom connect attempt once, for the same member only, wipes the verifier, keeps hash and verifier out of the audit, and refuses a viewer', async () => {
    const o = await org();
    const hash = `sha256:${randomBytes(32).toString('hex')}`;
    const verifier = randomBytes(48).toString('base64url');
    const begun = await o.exec<{ attemptId: string; expiresAt: string }>(o.lan, 'kernel.meeting_platform.oauth_begin', { provider: 'zoom', stateHash: hash, codeVerifier: verifier });
    expect(new Date(begun.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The attempt is stored under the recording provider's own name, never the calendar's.
    const stored = await sqlAdmin<{ provider: string }>('SELECT provider FROM crove_kernel.oauth_state WHERE state_hash = $1', [hash]);
    expect(stored.rows.map((r) => r.provider)).toEqual(['zoom_recordings']);
    // Another member cannot finish it, and an unknown state says the same thing.
    await expect(o.exec(o.nam, 'kernel.meeting_platform.oauth_consume', { provider: 'zoom', stateHash: hash })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    await expect(o.exec(o.lan, 'kernel.meeting_platform.oauth_consume', { provider: 'zoom', stateHash: `sha256:${randomBytes(32).toString('hex')}` })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect(await o.exec(o.lan, 'kernel.meeting_platform.oauth_consume', { provider: 'zoom', stateHash: hash })).toEqual({ codeVerifier: verifier });
    await expect(o.exec(o.lan, 'kernel.meeting_platform.oauth_consume', { provider: 'zoom', stateHash: hash })).rejects.toMatchObject({ code: 'OAUTH_STATE_USED' });
    // The verifier is wiped with the consume.
    const row = await sqlAdmin<{ code_verifier: string | null }>('SELECT code_verifier FROM crove_kernel.oauth_state WHERE state_hash = $1', [hash]);
    expect(row.rows[0]?.code_verifier).toBeNull();
    // An attempt that ran out is refused as expired.
    const late = `sha256:${randomBytes(32).toString('hex')}`;
    await o.exec(o.lan, 'kernel.meeting_platform.oauth_begin', { provider: 'zoom', stateHash: late, codeVerifier: verifier });
    await sqlAdmin("UPDATE crove_kernel.oauth_state SET expires_at = now() - interval '1 minute' WHERE state_hash = $1", [late]);
    await expect(o.exec(o.lan, 'kernel.meeting_platform.oauth_consume', { provider: 'zoom', stateHash: late })).rejects.toMatchObject({ code: 'OAUTH_STATE_EXPIRED' });
    // A viewer starts none; a platform that has no connect dialog (the sandbox) is not a provider of the command.
    await expect(o.exec(o.viewer, 'kernel.meeting_platform.oauth_begin', { provider: 'zoom', stateHash: `sha256:${randomBytes(32).toString('hex')}`, codeVerifier: null })).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.lan, 'kernel.meeting_platform.oauth_begin', { provider: 'sandbox', stateHash: `sha256:${randomBytes(32).toString('hex')}`, codeVerifier: null })).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION|INVALID/) });
    // The audit rows name the attempt and the provider, never the hash or the verifier.
    const audit = await sqlAdmin<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.meeting_platform.oauth_%' AND outcome = 'ok'", [o.orgId]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(audit.rows);
    expect(text).not.toContain(hash);
    expect(text).not.toContain(verifier);
    expect(text).toContain(begun.attemptId);
  });

  it('refresh clears the last sync of the member own active connections, one or all, and no other', async () => {
    const o = await org();
    const a = await connect(o, o.lan);
    const b = await connect(o, o.lan);
    const expired = await connect(o, o.lan);
    const theirs = await connect(o, o.nam);
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_connection SET last_synced_at = now() WHERE org_id = $1", [o.orgId]);
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_connection SET status = 'expired' WHERE id = $1", [expired.connectionId]);
    const synced = async () => Object.fromEntries((await sqlAdmin<{ id: string; s: boolean }>('SELECT id, last_synced_at IS NOT NULL AS s FROM crove_kernel.meeting_platform_connection WHERE org_id = $1', [o.orgId])).rows.map((r) => [r.id, r.s]));
    expect(await o.exec(o.lan, 'kernel.meeting_platform.refresh', { connectionId: a.connectionId })).toEqual({ refreshed: 1 });
    expect(await synced()).toMatchObject({ [a.connectionId]: false, [b.connectionId]: true, [expired.connectionId]: true, [theirs.connectionId]: true });
    // Another member's id is not theirs to refresh: nothing changes, nothing is revealed.
    expect(await o.exec(o.nam, 'kernel.meeting_platform.refresh', { connectionId: b.connectionId })).toEqual({ refreshed: 0 });
    expect(await o.exec(o.lan, 'kernel.meeting_platform.refresh', {})).toEqual({ refreshed: 2 });
    expect(await synced()).toMatchObject({ [a.connectionId]: false, [b.connectionId]: false, [expired.connectionId]: true, [theirs.connectionId]: true });
    await expect(o.exec(o.viewer, 'kernel.meeting_platform.refresh', {})).rejects.toMatchObject({ status: 403 });
  });

  it('recording_replace inserts, updates the facts of a suggestion, deletes the ones the platform no longer lists and keeps every other row', async () => {
    const o = await org();
    const c = await connect(o, o.lan);
    expect(await replace(o, c.connectionId, [listed('a'), listed('b'), listed('c')])).toEqual({ count: 3 });
    expect((await mine(o, o.lan)).map((r) => r.title).sort()).toEqual(['Họp a', 'Họp b', 'Họp c']);
    expect((await sqlAdmin<{ l: boolean }>('SELECT last_synced_at IS NOT NULL AS l FROM crove_kernel.meeting_platform_connection WHERE id = $1', [c.connectionId])).rows[0]?.l).toBe(true);
    // a changes, b and c vanish, d is new; a repeated id counts once.
    expect(await replace(o, c.connectionId, [listed('a', { title: 'Đã đổi', hasVideo: true, sizeBytes: null, lengthSeconds: null }), listed('d'), listed('d')])).toEqual({ count: 2 });
    expect((await rowOf('a', c.connectionId))?.title).toBe('Đã đổi');
    expect(await rowOf('b', c.connectionId)).toBeUndefined();
    expect(await rowOf('c', c.connectionId)).toBeUndefined();
    expect(await mine(o, o.lan)).toHaveLength(2);
    expect((await mine(o, o.lan)).find((r) => r.title === 'Đã đổi')).toMatchObject({ hasVideo: true, sizeBytes: null, lengthSeconds: null });
    // A dismissed row, an importing row and a failed row keep their state and their title, and the platform's list does not bring them back as suggestions.
    const dismissed = await idOf('d', c.connectionId);
    await o.exec(o.lan, 'kernel.meeting_platform.recording.dismiss', { recordingId: dismissed });
    const running = await importing(o, o.lan, c.connectionId, 'run');
    const failed = await importing(o, o.lan, c.connectionId, 'fail');
    await o.sys('kernel.meeting_platform.import_failed', { recordingId: failed.recordingId, code: 'download_failed', stagingKey: failed.key });
    expect(await replace(o, c.connectionId, [listed('d', { title: 'Mới' }), listed('run', { title: 'Mới' }), listed('fail', { title: 'Mới' })])).toEqual({ count: 0 });
    expect(await rowOf('d', c.connectionId)).toMatchObject({ status: 'dismissed', title: 'Họp d' });
    expect(await rowOf('run', c.connectionId)).toMatchObject({ status: 'importing', title: 'Họp run' });
    expect(await rowOf('fail', c.connectionId)).toMatchObject({ status: 'failed', title: 'Họp fail', error_code: 'download_failed' });
    // An empty list deletes the suggestions only ('a' went; the three rows above stay).
    expect(await replace(o, c.connectionId, [])).toEqual({ count: 0 });
    expect(await rowOf('a', c.connectionId)).toBeUndefined();
    expect(await sqlAdmin('SELECT 1 FROM crove_kernel.meeting_platform_recording WHERE connection_id = $1', [c.connectionId]).then((r) => r.rowCount)).toBe(3);
    expect(running.recordingId).toBeTruthy();
  });

  it('recording_replace rejects bad rows and does nothing for a connection that is gone, not active or not in the org', async () => {
    const o = await org();
    const c = await connect(o, o.lan);
    // The command's own schema.
    for (const rows of [Array.from({ length: 101 }, (_, i) => listed(`x${i}`)), [listed('a', { startedAt: 'yesterday' })], [listed('')], [listed('a', { title: 'x'.repeat(201) })], [{ ...listed('a'), extra: 1 }]]) {
      expect(await refuses(replace(o, c.connectionId, rows))).toBe('VALIDATION');
    }
    // The definer's, behind it.
    const raw = (rows: unknown) => o.sys('test.mp.raw_replace', { connectionId: c.connectionId, rows });
    expect(await refuses(raw({ id: 'a' }))).toBe('MEETING_PLATFORM_INVALID');
    expect(await refuses(raw([{ startedAt: new Date().toISOString() }]))).toBe('MEETING_PLATFORM_INVALID');
    expect(await refuses(raw([{ id: '', startedAt: new Date().toISOString() }]))).toBe('MEETING_PLATFORM_INVALID');
    expect(await refuses(raw([{ id: 'a' }]))).toBe('MEETING_PLATFORM_INVALID');
    expect(await refuses(raw(Array.from({ length: 101 }, (_, i) => ({ id: `x${i}`, startedAt: new Date().toISOString() }))))).toBe('MEETING_PLATFORM_INVALID');
    expect(await rowOf('a', c.connectionId)).toBeUndefined();
    // Only the worker writes suggestions: the API's login is refused by the definer, whatever the actor says.
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.recording_replace', { connectionId: c.connectionId, rows: [] }))).not.toBeNull();
    expect(await refuses(api.execute('kernel.meeting_platform.recording_replace', { connectionId: c.connectionId, rows: [] }, { actor: SYSTEM, orgId: o.orgId }))).toBe('FORBIDDEN');
    // A connection that is expired, unknown, or another org's is left as it is.
    await replace(o, c.connectionId, [listed('keep')]);
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_connection SET status = 'expired' WHERE id = $1", [c.connectionId]);
    expect(await replace(o, c.connectionId, [listed('new')])).toEqual({ count: 0 });
    expect(await replace(o, c.connectionId, [])).toEqual({ count: 0 });
    expect(await rowOf('keep', c.connectionId)).toBeDefined();
    expect(await rowOf('new', c.connectionId)).toBeUndefined();
    expect(await replace(o, randomUUID(), [listed('z')])).toEqual({ count: 0 });
    const other = await org();
    const there = await connect(other, other.lan);
    expect(await replace(o, there.connectionId, [listed('z')])).toEqual({ count: 0 });
    expect(await rowOf('z', there.connectionId)).toBeUndefined();
  });

  it('walks suggested, importing, staged, claimed and imported, and refuses every other step', async () => {
    const o = await org();
    const c = await connect(o, o.lan);
    await replace(o, c.connectionId, [listed('v', { sizeBytes: 5000 }), listed('none', { hasAudio: false, hasVideo: false, hasTranscript: true })]);
    const recordingId = await idOf('v', c.connectionId);
    const meetingId = await meetingFor(o, o.lan);
    const key = stagingKey();
    const as = (user: string, name: string, input: unknown) => o.exec(user, name, input);
    // Nothing moves a suggestion but the member's click: the worker's and the claim's steps are not allowed on it.
    expect(await o.sys('kernel.meeting_platform.import_staged', { recordingId, stagingKey: key })).toMatchObject({ applied: 0 });
    // A suggestion was begun for no meeting, so a claim for any meeting finds nothing to take.
    expect(await refuses(as(o.lan, 'kernel.meeting_platform.import.claim', { recordingId, meetingId }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    // The click needs a meeting that exists and is the member's own: a stranger's, or none, is refused and the row stays a suggestion.
    expect(await refuses(as(o.lan, 'test.mp.begin', { recordingId, meetingId: randomUUID(), stagingKey: key }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    expect(await refuses(as(o.lan, 'test.mp.begin', { recordingId, meetingId: await meetingFor(o, o.nam), stagingKey: key }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    // A recording with a transcript alone is not imported; a malformed key is refused.
    expect(await refuses(as(o.lan, 'test.mp.begin', { recordingId: await idOf('none', c.connectionId), meetingId, stagingKey: key }))).toBe('MEETING_PLATFORM_NO_AUDIO');
    expect(await refuses(as(o.lan, 'test.mp.begin', { recordingId, meetingId, stagingKey: 'staging/short' }))).toBe('MEETING_PLATFORM_INVALID');
    // Another member, an owner and a viewer cannot begin, claim or dismiss it: for them it does not exist.
    for (const who of [o.nam, o.owner]) {
      expect(await refuses(as(who, 'test.mp.begin', { recordingId, meetingId, stagingKey: key })), who).toBe('MEETING_PLATFORM_NOT_FOUND');
      expect(await refuses(as(who, 'kernel.meeting_platform.import.claim', { recordingId, meetingId })), who).toBe('MEETING_PLATFORM_NOT_FOUND');
      expect(await refuses(as(who, 'kernel.meeting_platform.recording.dismiss', { recordingId })), who).toBe('MEETING_PLATFORM_NOT_FOUND');
    }
    expect((await rowOf('v', c.connectionId))?.status).toBe('suggested');
    // The click.
    await as(o.lan, 'test.mp.begin', { recordingId, meetingId, stagingKey: key });
    expect(await rowOf('v', c.connectionId)).toMatchObject({ status: 'importing', meeting_id: meetingId, staging_key: key });
    expect(await refuses(as(o.lan, 'test.mp.begin', { recordingId, meetingId, stagingKey: stagingKey() }))).toBe('MEETING_PLATFORM_STATE');
    expect(await refuses(as(o.lan, 'kernel.meeting_platform.import.claim', { recordingId, meetingId }))).toBe('MEETING_PLATFORM_STATE');
    expect(await refuses(as(o.lan, 'kernel.meeting_platform.recording.dismiss', { recordingId }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    // The worker is told which rows are importing, without a title.
    const open = await o.sysQuery<Array<Record<string, unknown>>>('kernel.meeting_platform.import_open', { limit: 200 });
    expect(open.find((r) => r.recordingId === recordingId)).toEqual({ orgId: o.orgId, recordingId, connectionId: c.connectionId, provider: 'sandbox', externalId: 'v', hasAudio: true, hasVideo: false, sizeBytes: 5000, stagingKey: key });
    // The worker's bytes arrive.
    expect(await o.sysQuery('kernel.meeting_platform.import_holds', { recordingId, stagingKey: key })).toBe('importing');
    expect(await o.sys('kernel.meeting_platform.import_staged', { recordingId, stagingKey: stagingKey() })).toMatchObject({ applied: 0 });
    expect(await o.sys('kernel.meeting_platform.import_staged', { recordingId, stagingKey: key })).toMatchObject({ applied: 1 });
    expect(await o.sysQuery('kernel.meeting_platform.import_holds', { recordingId, stagingKey: key })).toBe('staged');
    expect(await o.sysQuery('kernel.meeting_platform.import_holds', { recordingId, stagingKey: stagingKey() })).toBe('none');
    expect(await rowOf('v', c.connectionId)).toMatchObject({ status: 'staged', staging_key: key });
    expect((await sqlAdmin<{ s: boolean }>('SELECT staged_at IS NOT NULL AS s FROM crove_kernel.meeting_platform_recording WHERE id = $1', [recordingId])).rows[0]?.s).toBe(true);
    expect(await o.sys('kernel.meeting_platform.import_staged', { recordingId, stagingKey: key })).toMatchObject({ applied: 0 });
    // A duplicate or stale job cannot fail a row that is staged, whatever it was handed.
    expect(await o.sys('kernel.meeting_platform.import_failed', { recordingId, code: 'timeout', stagingKey: key })).toMatchObject({ applied: 0 });
    expect((await rowOf('v', c.connectionId))?.status).toBe('staged');
    expect((await o.sysQuery<Array<{ recordingId: string }>>('kernel.meeting_platform.import_open', { limit: 200 })).some((r) => r.recordingId === recordingId)).toBe(false);
    // The member's own request takes them: only theirs, once.
    // A request for another meeting is refused before the row moves: it stays staged for the right one.
    expect(await refuses(as(o.lan, 'kernel.meeting_platform.import.claim', { recordingId, meetingId: await meetingFor(o, o.lan) }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    expect((await rowOf('v', c.connectionId))?.status).toBe('staged');
    expect(await refuses(as(o.nam, 'kernel.meeting_platform.import.claim', { recordingId, meetingId }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    expect(await refuses(as(o.lan, 'test.mp.begin', { recordingId, meetingId, stagingKey: stagingKey() }))).toBe('MEETING_PLATFORM_STATE');
    expect(await as(o.lan, 'kernel.meeting_platform.import.claim', { recordingId, meetingId })).toEqual({ stagingKey: key, meetingId, sizeBytes: 5000 });
    expect((await rowOf('v', c.connectionId))?.status).toBe('claimed');
    expect(await refuses(as(o.lan, 'kernel.meeting_platform.import.claim', { recordingId, meetingId }))).toBe('MEETING_PLATFORM_STATE');
    // The audit row of the claim names the recording, never the staging key.
    const audit = await sqlAdmin<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.meeting_platform.import.claim'", [o.orgId]);
    expect(JSON.stringify(audit.rows)).not.toContain(key);
    // Recording the media of another meeting or by another member changes nothing; the owner's own does.
    await as(o.lan, 'test.mp.imported', { meetingId: randomUUID() });
    await as(o.nam, 'test.mp.imported', { meetingId });
    expect((await rowOf('v', c.connectionId))?.status).toBe('claimed');
    await as(o.lan, 'test.mp.imported', { meetingId });
    expect(await rowOf('v', c.connectionId)).toMatchObject({ status: 'imported', staging_key: null, error_code: null, meeting_id: meetingId });
    // Done is done.
    expect(await refuses(as(o.lan, 'test.mp.begin', { recordingId, meetingId, stagingKey: stagingKey() }))).toBe('MEETING_PLATFORM_STATE');
    expect(await refuses(as(o.lan, 'kernel.meeting_platform.import.claim', { recordingId, meetingId }))).toBe('MEETING_PLATFORM_STATE');
    expect(await refuses(as(o.lan, 'kernel.meeting_platform.recording.dismiss', { recordingId }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    expect(await o.sys('kernel.meeting_platform.import_failed', { recordingId, code: 'timeout', stagingKey: key })).toMatchObject({ applied: 0 });
    await as(o.lan, 'kernel.meeting_platform.import.claim_failed', { recordingId, code: 'claim_failed' });
    expect((await rowOf('v', c.connectionId))?.status).toBe('imported');
    expect(await mine(o, o.lan)).toContainEqual(expect.objectContaining({ id: recordingId, status: 'imported', meetingId }));
  });

  it('a failed import can be tried again, a dismissed or failed suggestion can be dismissed, and the codes are the known ones', async () => {
    const o = await org();
    const c = await connect(o, o.lan);
    // The worker's download fails.
    const a = await importing(o, o.lan, c.connectionId, 'a');
    expect(await o.sys('kernel.meeting_platform.import_failed', { recordingId: a.recordingId, code: 'recording_gone', stagingKey: stagingKey() })).toMatchObject({ applied: 0 });
    expect((await rowOf('a', c.connectionId))?.status).toBe('importing');
    await o.sys('kernel.meeting_platform.import_failed', { recordingId: a.recordingId, code: 'recording_gone', stagingKey: a.key });
    expect(await rowOf('a', c.connectionId)).toMatchObject({ status: 'failed', error_code: 'recording_gone', staging_key: null });
    expect(await mine(o, o.lan)).toContainEqual(expect.objectContaining({ id: a.recordingId, status: 'failed', errorCode: 'recording_gone' }));
    expect(await refuses(o.sys('kernel.meeting_platform.import_failed', { recordingId: a.recordingId, code: 'because', stagingKey: stagingKey() }))).toBe('VALIDATION');
    // Again from the failed row.
    await o.exec(o.lan, 'test.mp.begin', { recordingId: a.recordingId, meetingId: await meetingFor(o, o.lan), stagingKey: stagingKey() });
    expect(await rowOf('a', c.connectionId)).toMatchObject({ status: 'importing', error_code: null });
    // The route fails after the claim.
    const b = await claimed(o, o.lan, c.connectionId, 'b');
    expect(await refuses(o.exec(o.nam, 'kernel.meeting_platform.import.claim_failed', { recordingId: b.recordingId, code: 'invalid_media' }))).toBeNull();
    expect((await rowOf('b', c.connectionId))?.status).toBe('claimed');
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.import.claim_failed', { recordingId: b.recordingId, code: 'nonsense' }))).toBe('VALIDATION');
    await o.exec(o.lan, 'kernel.meeting_platform.import.claim_failed', { recordingId: b.recordingId, code: 'invalid_media' });
    expect(await rowOf('b', c.connectionId)).toMatchObject({ status: 'failed', error_code: 'invalid_media', staging_key: null });
    // A failed row is dismissed, and a dismissed one is hidden from the list and cannot be dismissed twice.
    await o.exec(o.lan, 'kernel.meeting_platform.recording.dismiss', { recordingId: b.recordingId });
    expect((await mine(o, o.lan)).some((r) => r.id === b.recordingId)).toBe(false);
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.recording.dismiss', { recordingId: b.recordingId }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    // The worker's steps are the worker's: the API login is refused whatever the actor says.
    expect(await refuses(api.execute('kernel.meeting_platform.import_failed', { recordingId: a.recordingId, code: 'timeout', stagingKey: stagingKey() }, { actor: SYSTEM, orgId: o.orgId }))).toBe('FORBIDDEN');
    expect(await refuses(api.execute('kernel.meeting_platform.import_staged', { recordingId: a.recordingId, stagingKey: stagingKey() }, { actor: SYSTEM, orgId: o.orgId }))).toBe('FORBIDDEN');
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.import_staged', { recordingId: a.recordingId, stagingKey: stagingKey() }))).not.toBeNull();
  });

  it('lists a member own recordings newest first, at most 50, with the provider of their connection', async () => {
    const o = await org();
    const zoom = await connect(o, o.lan, undefined, 'zoom');
    const sandbox = await connect(o, o.lan);
    const day = 86_400_000;
    await replace(o, zoom.connectionId, Array.from({ length: 55 }, (_, i) => listed(`z${i}`, { startedAt: new Date(Date.now() - (i + 2) * 60_000).toISOString() })));
    await replace(o, sandbox.connectionId, [listed('newest', { startedAt: new Date(Date.now() - 1000).toISOString() }), listed('oldest', { startedAt: new Date(Date.now() - 10 * day).toISOString() })]);
    const list = await mine(o, o.lan);
    expect(list).toHaveLength(50);
    expect(list[0]).toMatchObject({ title: 'Họp newest', provider: 'sandbox', connectionId: sandbox.connectionId });
    expect(list[1]).toMatchObject({ title: 'Họp z0', provider: 'zoom', connectionId: zoom.connectionId });
    expect(list.map((r) => r.startedAt)).toEqual(list.map((r) => r.startedAt).sort().reverse());
    expect(list.some((r) => r.title === 'Họp oldest')).toBe(false);
  });

  it('the sweep expires what nobody claimed: staged at 55 minutes, claimed at 60, importing at 2 hours, suggestions at 14 days', async () => {
    const o = await org();
    const c = await connect(o, o.lan);
    const back = (id: string, column: 'updated_at' | 'staged_at' | 'started_at', ms: number) =>
      sqlAdmin(`UPDATE crove_kernel.meeting_platform_recording SET ${column} = now() - ($2 || ' milliseconds')::interval WHERE id = $1`, [id, String(ms)]);
    // staged: 56 minutes (expired) and 54 (kept)
    const staleStaged = await staged(o, o.lan, c.connectionId, 'staged-old');
    const freshStaged = await staged(o, o.lan, c.connectionId, 'staged-new');
    await back(staleStaged.recordingId, 'staged_at', 56 * MIN);
    await back(freshStaged.recordingId, 'staged_at', 54 * MIN);
    // claimed: 61 minutes and 59 (longer than the upload request's own 45-minute limit)
    const staleClaim = await claimed(o, o.lan, c.connectionId, 'claim-old');
    const freshClaim = await claimed(o, o.lan, c.connectionId, 'claim-new');
    await back(staleClaim.recordingId, 'updated_at', 61 * MIN);
    await back(freshClaim.recordingId, 'updated_at', 59 * MIN);
    // importing: 2 hours and a minute, and 1 hour 59
    const staleImport = await importing(o, o.lan, c.connectionId, 'import-old');
    const freshImport = await importing(o, o.lan, c.connectionId, 'import-new');
    await back(staleImport.recordingId, 'updated_at', 121 * MIN);
    await back(freshImport.recordingId, 'updated_at', 119 * MIN);
    // suggestions and dismissed rows: 15 days and 13
    await replace(o, c.connectionId, [listed('sug-old', { startedAt: new Date(Date.now() - 15 * 86_400_000).toISOString() }), listed('sug-new', { startedAt: new Date(Date.now() - 13 * 86_400_000).toISOString() }), listed('dis-old'), listed('imp')]);
    await o.exec(o.lan, 'kernel.meeting_platform.recording.dismiss', { recordingId: await idOf('dis-old', c.connectionId) });
    await back(await idOf('dis-old', c.connectionId), 'started_at', 15 * 86_400_000);
    // The sweep is the worker's alone.
    expect(await refuses(api.execute('kernel.meeting_platform.sweep', {}, { actor: SYSTEM, orgId: o.orgId }))).toBe('FORBIDDEN');
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.sweep', {}))).not.toBeNull();
    const { keys } = await o.sys<{ keys: string[] }>('kernel.meeting_platform.sweep');
    // The keys of the bytes to delete: the staged, the stalled claim and the stalled download (a failed row forgets its key).
    expect(keys).toEqual(expect.arrayContaining([staleStaged.key, staleClaim.key, staleImport.key]));
    expect(keys).not.toContain(freshStaged.key);
    expect(keys).not.toContain(freshClaim.key);
    expect(keys).not.toContain(freshImport.key);
    expect(await rowOf('staged-old', c.connectionId)).toMatchObject({ status: 'failed', error_code: 'not_claimed', staging_key: null });
    expect(await rowOf('claim-old', c.connectionId)).toMatchObject({ status: 'failed', error_code: 'claim_failed', staging_key: null });
    expect(await rowOf('import-old', c.connectionId)).toMatchObject({ status: 'failed', error_code: 'timeout', staging_key: null });
    expect(await rowOf('staged-new', c.connectionId)).toMatchObject({ status: 'staged', staging_key: freshStaged.key });
    expect(await rowOf('claim-new', c.connectionId)).toMatchObject({ status: 'claimed', staging_key: freshClaim.key });
    expect(await rowOf('import-new', c.connectionId)).toMatchObject({ status: 'importing', staging_key: freshImport.key });
    expect(await rowOf('sug-old', c.connectionId)).toBeUndefined();
    expect(await rowOf('dis-old', c.connectionId)).toBeUndefined();
    expect(await rowOf('sug-new', c.connectionId)).toMatchObject({ status: 'suggested' });
    expect(await rowOf('imp', c.connectionId)).toMatchObject({ status: 'suggested' });
    // A second pass has nothing left to expire.
    expect((await o.sys<{ keys: string[] }>('kernel.meeting_platform.sweep')).keys).not.toEqual(expect.arrayContaining([staleStaged.key]));
  });

  it('a disconnect waits for an import in flight, then deletes the connection, its credential and its recordings', async () => {
    const o = await org();
    const c = await connect(o, o.lan);
    const keep = await connect(o, o.lan);
    await replace(o, keep.connectionId, [listed('other')]);
    // Importing, staged and claimed each hold it.
    const r = await importing(o, o.lan, c.connectionId, 'one');
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.disconnect', { connectionId: c.connectionId }))).toBe('MEETING_PLATFORM_BUSY');
    await o.sys('kernel.meeting_platform.import_staged', { recordingId: r.recordingId, stagingKey: r.key });
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.disconnect', { connectionId: c.connectionId }))).toBe('MEETING_PLATFORM_BUSY');
    await o.exec(o.lan, 'kernel.meeting_platform.import.claim', { recordingId: r.recordingId, meetingId: r.meetingId });
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.disconnect', { connectionId: c.connectionId }))).toBe('MEETING_PLATFORM_BUSY');
    expect((await o.query<unknown[]>(o.lan, 'kernel.meeting_platform.connections')).length).toBe(2);
    // Another member cannot take it away, an unknown id is not found, and the failed import frees it.
    expect(await refuses(o.exec(o.nam, 'kernel.meeting_platform.disconnect', { connectionId: c.connectionId }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.disconnect', { connectionId: randomUUID() }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    await o.exec(o.lan, 'kernel.meeting_platform.import.claim_failed', { recordingId: r.recordingId, code: 'claim_failed' });
    await replace(o, c.connectionId, [listed('two')]);
    expect(await o.exec(o.lan, 'kernel.meeting_platform.disconnect', { connectionId: c.connectionId })).toEqual({ connectionId: c.connectionId, disconnected: true });
    const left = async (table: string, column: string, id: string) => Number((await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.${table} WHERE ${column} = $1`, [id])).rows[0]?.n);
    expect(await left('meeting_platform_connection', 'id', c.connectionId)).toBe(0);
    expect(await left('meeting_platform_credential', 'id', c.connectionId)).toBe(0);
    expect(await left('meeting_platform_recording', 'connection_id', c.connectionId)).toBe(0);
    // The other connection of the member is as it was.
    expect(await left('meeting_platform_connection', 'id', keep.connectionId)).toBe(1);
    expect(await left('meeting_platform_credential', 'id', keep.connectionId)).toBe(1);
    expect(await left('meeting_platform_recording', 'connection_id', keep.connectionId)).toBe(1);
    // A viewer (demoted after connecting) can still take their own away.
    await sqlAdmin("UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.lan]);
    expect(await o.exec(o.lan, 'kernel.meeting_platform.disconnect', { connectionId: keep.connectionId })).toMatchObject({ disconnected: true });
  });

  it('hands the sealed credential to the worker alone, for an active connection of a member still in the org', async () => {
    const o = await org();
    const c = await connect(o, o.lan, 'lan@zoom.test', 'zoom', 'sealed-bytes-zoom');
    // Nobody but the worker's system context reads it: not the member, not an owner, not the API's login in a system context.
    for (const who of [o.lan, o.owner]) expect(await refuses(o.query(who, 'kernel.meeting_platform.credential', { connectionId: c.connectionId })), who).not.toBeNull();
    expect(await refuses(api.query('kernel.meeting_platform.credential', { connectionId: c.connectionId }, { actor: SYSTEM, orgId: o.orgId }))).not.toBeNull();
    const got = await o.sysQuery<{ keyId: string; envelope: string; provider: string; externalAccount: string }>('kernel.meeting_platform.credential', { connectionId: c.connectionId });
    expect(got).toEqual({ keyId: 'k1', envelope: envelopeOf('sealed-bytes-zoom'), provider: 'zoom', externalAccount: 'lan@zoom.test' });
    // Another org's worker context does not find it.
    const other = await org();
    expect(await refuses(other.sysQuery('kernel.meeting_platform.credential', { connectionId: c.connectionId }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    // A reconnect seals the new bytes in place.
    await connect(o, o.lan, 'lan@zoom.test', 'zoom', 'sealed-bytes-two');
    expect((await o.sysQuery<{ envelope: string }>('kernel.meeting_platform.credential', { connectionId: c.connectionId })).envelope).toBe(envelopeOf('sealed-bytes-two'));
    // Expired: no credential goes out.
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_connection SET status = 'expired' WHERE id = $1", [c.connectionId]);
    expect(await refuses(o.sysQuery('kernel.meeting_platform.credential', { connectionId: c.connectionId }))).toBe('MEETING_PLATFORM_NOT_ACTIVE');
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_connection SET status = 'active' WHERE id = $1", [c.connectionId]);
    expect((await o.sysQuery<{ keyId: string }>('kernel.meeting_platform.credential', { connectionId: c.connectionId })).keyId).toBe('k1');
    // The member left the org, no longer edits in it, or is disabled: nothing goes out.
    await sqlAdmin("UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.lan]);
    expect(await refuses(o.sysQuery('kernel.meeting_platform.credential', { connectionId: c.connectionId }))).toBe('MEETING_PLATFORM_OWNER_LEFT');
    await sqlAdmin("UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.lan]);
    await sqlAdmin('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [o.lan]);
    expect(await refuses(o.sysQuery('kernel.meeting_platform.credential', { connectionId: c.connectionId }))).toBe('MEETING_PLATFORM_OWNER_LEFT');
    await sqlAdmin('UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1', [o.lan]);
    await sqlAdmin('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.lan]);
    expect(await refuses(o.sysQuery('kernel.meeting_platform.credential', { connectionId: c.connectionId }))).toBe('MEETING_PLATFORM_OWNER_LEFT');
  });

  it('pages the active connections of active orgs for the sweep, leaving out expired ones and members who left', async () => {
    const o = await org();
    const a = await connect(o, o.lan);
    const b = await connect(o, o.nam);
    const expired = await connect(o, o.lan);
    const gone = await connect(o, o.nam);
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_connection SET status = 'expired' WHERE id = $1", [expired.connectionId]);
    const all: Array<{ orgId: string; connectionId: string; provider: string }> = [];
    let after: { orgId: string; connectionId: string } | null = null;
    for (let page = 0; page < 200; page++) {
      const rows: Array<{ orgId: string; connectionId: string; provider: string }> = await o.sysQuery('kernel.meeting_platform.sync_due', { afterOrg: after?.orgId ?? null, afterId: after?.connectionId ?? null, limit: 2 });
      all.push(...rows);
      if (rows.length < 2) break;
      after = rows[rows.length - 1] as { orgId: string; connectionId: string };
    }
    const mineDue = all.filter((r) => r.orgId === o.orgId);
    expect(mineDue.map((r) => r.connectionId).sort()).toEqual([a.connectionId, b.connectionId, gone.connectionId].sort());
    expect(mineDue.every((r) => r.provider === 'sandbox')).toBe(true);
    // The order is the key's: the cursor never skips or repeats a row.
    expect(new Set(all.map((r) => r.connectionId)).size).toBe(all.length);
    expect([...all].map((r) => `${r.orgId}/${r.connectionId}`)).toEqual([...all].map((r) => `${r.orgId}/${r.connectionId}`).sort());
    await sqlAdmin('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.nam]);
    const again = await o.sysQuery<Array<{ orgId: string; connectionId: string }>>('kernel.meeting_platform.sync_due', { afterOrg: null, afterId: null, limit: 1000 });
    expect(again.filter((r) => r.orgId === o.orgId).map((r) => r.connectionId)).toEqual([a.connectionId]);
    // Only the worker's system context pages them.
    expect(await refuses(o.query(o.lan, 'kernel.meeting_platform.sync_due', { afterOrg: null, afterId: null, limit: 10 }))).not.toBeNull();
    expect(await refuses(api.query('kernel.meeting_platform.sync_due', { afterOrg: null, afterId: null, limit: 10 }, { actor: SYSTEM, orgId: o.orgId }))).not.toBeNull();
    expect(await refuses(o.sysQuery('kernel.meeting_platform.import_open', { limit: 0 }))).toBe('VALIDATION');
  });

  it('a failed listing moves the last sync so the connection waits 10 minutes (a refresh brings it back), and an expired grant stops the credential', async () => {
    const o = await org();
    const a = await connect(o, o.lan);
    const b = await connect(o, o.nam);
    const due = async () => (await o.sysQuery<Array<{ orgId: string; connectionId: string }>>('kernel.meeting_platform.sync_due', { afterOrg: null, afterId: null, limit: 1000 })).filter((r) => r.orgId === o.orgId).map((r) => r.connectionId);
    expect((await due()).sort()).toEqual([a.connectionId, b.connectionId].sort());
    // A failed list that leaves the connection active: the code is the reason, the connection is skipped for 10 minutes.
    expect(await o.sys('kernel.meeting_platform.sync_failed', { connectionId: a.connectionId, code: 'platform_unavailable', expired: false })).toMatchObject({ connectionId: a.connectionId });
    expect(await due()).toEqual([b.connectionId]);
    expect(await o.query<MeetingPlatformConnectionView[]>(o.lan, 'kernel.meeting_platform.connections')).toMatchObject([{ status: 'active', statusReason: 'platform_unavailable' }]);
    expect((await o.sysQuery<{ keyId: string }>('kernel.meeting_platform.credential', { connectionId: a.connectionId })).keyId).toBe('k1');
    // 11 minutes later it is due again; a refresh brings it back at once.
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_connection SET last_synced_at = now() - interval '11 minutes' WHERE id = $1", [a.connectionId]);
    expect((await due()).sort()).toEqual([a.connectionId, b.connectionId].sort());
    await o.sys('kernel.meeting_platform.sync_failed', { connectionId: a.connectionId, code: 'download_failed', expired: false });
    expect(await due()).toEqual([b.connectionId]);
    await o.exec(o.lan, 'kernel.meeting_platform.refresh', {});
    expect((await due()).sort()).toEqual([a.connectionId, b.connectionId].sort());
    // The grant is refused: expired, out of the due list for good, and no credential goes out.
    await o.sys('kernel.meeting_platform.sync_failed', { connectionId: b.connectionId, code: 'connection_expired', expired: true });
    expect(await due()).toEqual([a.connectionId]);
    expect(await o.query<MeetingPlatformConnectionView[]>(o.nam, 'kernel.meeting_platform.connections')).toMatchObject([{ status: 'expired', statusReason: 'connection_expired' }]);
    expect(await refuses(o.sysQuery('kernel.meeting_platform.credential', { connectionId: b.connectionId }))).toBe('MEETING_PLATFORM_NOT_ACTIVE');
    await o.exec(o.nam, 'kernel.meeting_platform.refresh', {});
    expect(await due()).toEqual([a.connectionId]);
    // The code is a known one; the worker's alone; an unknown connection is left as it is.
    expect(await refuses(o.sys('kernel.meeting_platform.sync_failed', { connectionId: a.connectionId, code: 'whatever', expired: false }))).toBe('VALIDATION');
    expect(await refuses(api.execute('kernel.meeting_platform.sync_failed', { connectionId: a.connectionId, code: 'timeout', expired: false }, { actor: SYSTEM, orgId: o.orgId }))).toBe('FORBIDDEN');
    expect(await refuses(o.exec(o.lan, 'kernel.meeting_platform.sync_failed', { connectionId: a.connectionId, code: 'timeout', expired: false }))).not.toBeNull();
    expect(await refuses(o.sys('kernel.meeting_platform.sync_failed', { connectionId: randomUUID(), code: 'timeout', expired: true }))).toBeNull();
    // Connecting again makes it active and due.
    await connect(o, o.nam, b.account);
    expect((await due()).sort()).toEqual([a.connectionId, b.connectionId].sort());
  });
});
