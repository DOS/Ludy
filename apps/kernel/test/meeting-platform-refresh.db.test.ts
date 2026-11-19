// SPDX-License-Identifier: AGPL-3.0-only
// The renewal of a meeting platform access token on a real database (issue #3878): `kernel.meeting_platform.credential_refresh` takes the connection's lock, looks at the expiry again under it, calls the
// provider once, and stores the rotated pair, sealed, in the same transaction. The provider here is a fake that behaves like Zoom: every refresh gives a new refresh token and kills the old one, so a refresh
// token used twice is refused. The cases: a credential near its end is renewed and the pair stored; one that is not due is left alone; TWO RENEWALS AT ONCE call the provider once and both end with the
// same valid pair (the new token is not lost); a refused grant expires the connection and keeps the stored pair; an unreachable provider changes nothing and the next try works; a crash after the provider
// rotated the token (the seal fails) rolls everything back and the next try is refused (the documented window); and nothing but the system runs it. No token reaches the audit log.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeetingPlatformError, type MeetingPlatformAdapter, type MeetingPlatformCredential } from '@ludy/channel';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { meetingPlatformBinding } from '@ludy/kernel-contract';
import { Runtime, type CredentialBroker } from '@ludy/kernel-runtime';
import { meetingPlatformRefreshCommand, parseCredential, type RefreshOutcome } from '../src/meeting-platform-credential.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'meeting-platform-refresh-test' };
const HOUR = 3_600_000;
const COMMAND = 'kernel.meeting_platform.credential_refresh';

// A broker that keeps the binding beside the secret and refuses to open a secret under another binding (as the real one does); `failSeals` makes the next seal(s) throw.
function testBroker(): CredentialBroker & { failSeals: number } {
  const broker = {
    id: 'test',
    failSeals: 0,
    seal(secret: string, binding: unknown) {
      if (broker.failSeals > 0) {
        broker.failSeals -= 1;
        throw new Error('the seal failed');
      }
      return { keyId: 'k1', envelope: Buffer.from(JSON.stringify({ binding, secret })) };
    },
    open(sealed: { envelope: Buffer }, binding: unknown) {
      const parsed = JSON.parse(sealed.envelope.toString()) as { binding: unknown; secret: string };
      expect(parsed.binding).toEqual(binding);
      return parsed.secret;
    },
  };
  return broker as never;
}

// A provider that rotates its refresh token on every use, and takes a moment to answer (so two renewals at once overlap if nothing holds one of them back).
function fakeZoom() {
  const state = { calls: 0, valid: 'refresh-0', mode: 'ok' as 'ok' | 'down' | 'refuse' | 'throw_expired' | 'no_expiry', delayMs: 300, accessIssued: 0 };
  const adapter: MeetingPlatformAdapter = {
    provider: 'zoom',
    hosts: [],
    list: async () => [],
    prepareDownload: async () => Promise.reject(new Error('not reached')),
    refresh: async (credential: MeetingPlatformCredential) => {
      state.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.mode === 'down') throw new MeetingPlatformError('platform_unavailable');
      if (state.mode === 'throw_expired') throw new MeetingPlatformError('connection_expired');
      if (state.mode === 'refuse' || credential.refreshToken !== state.valid) return { refused: true as const };
      state.accessIssued += 1;
      state.valid = `refresh-${state.accessIssued}`;
      return { accessToken: `access-${state.accessIssued}`, refreshToken: state.valid, ...(state.mode === 'no_expiry' ? {} : { expiresAt: new Date(Date.now() + HOUR) }) };
    },
  };
  return { state, adapter };
}

suite('the renewal of a meeting platform token on PostgreSQL (issue #3878)', () => {
  const dbName = `crove_test_mp_refresh_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let api: Runtime;
  let worker: Runtime;
  let personDb: ReturnType<typeof createDb>;
  const broker = testBroker();
  const zoom = fakeZoom();

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
  const person = (name: string) => upsertIdentity(personDb, { issuer: 'mpr', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@mpr.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const lan = await person('lan');
    await sqlAdmin("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, lan]);
    return { orgId, lan };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  // A Zoom connection of the member whose credential expires `expiresInMs` from now, as a connect writes it: the pair, sealed under the connection's binding.
  async function connect(o: Org, expiresInMs: number, refreshToken = zoom.state.valid) {
    const account = `${randomUUID().slice(0, 8)}@zoom.test`;
    const expiresAt = new Date(Date.now() + expiresInMs);
    const sealed = broker.seal(JSON.stringify({ accessToken: 'access-0', refreshToken, expiresAt: expiresAt.toISOString() }), meetingPlatformBinding(o.orgId, 'zoom', account));
    const done = await api.execute<{ connectionId: string }>(
      'kernel.meeting_platform.connect',
      { provider: 'zoom', externalAccount: account, displayName: `Zoom ${account}`, scopes: ['cloud_recording:read'], expiresAt: expiresAt.toISOString(), credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(o.lan), orgId: o.orgId },
    );
    return { connectionId: done.connectionId, account, expiresAt };
  }
  const refresh = (o: Org, connectionId: string) => worker.execute<RefreshOutcome>(COMMAND, { connectionId }, { actor: SYSTEM, orgId: o.orgId });
  // What the worker would open now for the connection.
  async function stored(o: Org, connectionId: string) {
    const sealed = await worker.query<{ keyId: string; envelope: string; provider: string; externalAccount: string }>('kernel.meeting_platform.credential', { connectionId }, { actor: SYSTEM, orgId: o.orgId });
    return parseCredential(broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, meetingPlatformBinding(o.orgId, 'zoom', sealed.externalAccount)));
  }
  const envelopeOf = async (connectionId: string) => (await sqlAdmin<{ e: string }>("SELECT encode(envelope, 'base64') AS e FROM crove_kernel.meeting_platform_credential WHERE id = $1", [connectionId])).rows[0]?.e as string;
  const rowOf = async (connectionId: string) => (await sqlAdmin<{ status: string; status_reason: string | null; expires_at: Date | null }>('SELECT status, status_reason, expires_at FROM crove_kernel.meeting_platform_connection WHERE id = $1', [connectionId])).rows[0];
  const reset = (mode: 'ok' | 'down' | 'refuse' | 'throw_expired' | 'no_expiry' = 'ok') => {
    zoom.state.calls = 0;
    zoom.state.valid = 'refresh-0';
    zoom.state.accessIssued = 0;
    zoom.state.mode = mode;
    zoom.state.delayMs = 300;
    broker.failSeals = 0;
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
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 8 });
    pools.push(appPool, workerPool);
    personDb = createDb(appPool);
    // The API's runtime registers the command too (as a deployment never would), so the test can show that the command's own gate, `access: 'system'`, refuses a person.
    api = new Runtime(personDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, meetingPlatformRefreshCommand({ broker, adapters: { zoom: zoom.adapter }, callTimeoutMs: 5_000 })],
      queries: [...kernelQueries({ inboundDomain: null })],
    });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, meetingPlatformRefreshCommand({ broker, adapters: { zoom: zoom.adapter }, callTimeoutMs: 5_000 })],
      queries: [...kernelQueries({ inboundDomain: null })],
    });
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('renews a credential that is about to expire and stores the rotated pair, sealed, with the new expiry', async () => {
    reset();
    const o = await org();
    const c = await connect(o, 60_000);
    const done = await refresh(o, c.connectionId);
    expect(done.outcome).toBe('refreshed');
    expect(zoom.state.calls).toBe(1);
    const now = await stored(o, c.connectionId);
    expect(now).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect((now.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(HOUR - 60_000);
    const row = await rowOf(c.connectionId);
    expect(row).toMatchObject({ status: 'active', status_reason: null });
    expect((row?.expires_at?.getTime() ?? 0) - Date.now()).toBeGreaterThan(HOUR - 60_000);
    // The audit row names the connection and the provider; no token, no account, no envelope.
    const audit = await sqlAdmin<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok'", [o.orgId, COMMAND]);
    expect(audit.rowCount).toBe(1);
    const text = JSON.stringify(audit.rows[0]?.detail);
    for (const secret of ['access-0', 'access-1', 'refresh-0', 'refresh-1', c.account]) expect(text).not.toContain(secret);
    expect(text).toContain(c.connectionId);
  });

  it('leaves a credential that is not due alone: no provider call, nothing stored', async () => {
    reset();
    const o = await org();
    const c = await connect(o, 2 * HOUR);
    expect(await refresh(o, c.connectionId)).toEqual({ outcome: 'fresh' });
    expect(zoom.state.calls).toBe(0);
    expect(await stored(o, c.connectionId)).toMatchObject({ accessToken: 'access-0', refreshToken: 'refresh-0' });
  });

  it('TWO RENEWALS AT ONCE use the refresh token once: the second waits for the lock, finds the credential renewed, and the new token is not lost', async () => {
    reset();
    const o = await org();
    const c = await connect(o, 60_000);
    const results = await Promise.all([refresh(o, c.connectionId), refresh(o, c.connectionId)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['fresh', 'refreshed']);
    expect(zoom.state.calls).toBe(1);
    // The pair stored is the one the provider now honours: the next refresh could still be made with it.
    const now = await stored(o, c.connectionId);
    expect(now.refreshToken).toBe(zoom.state.valid);
    expect(now.accessToken).toBe('access-1');
    expect(await rowOf(c.connectionId)).toMatchObject({ status: 'active' });
  });

  it('five renewals at once still call the provider once', async () => {
    reset();
    const o = await org();
    const c = await connect(o, 30_000);
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(o, c.connectionId)));
    expect(results.filter((r) => r.outcome === 'refreshed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'fresh')).toHaveLength(4);
    expect(zoom.state.calls).toBe(1);
    expect((await stored(o, c.connectionId)).refreshToken).toBe(zoom.state.valid);
  });

  it('expires the connection when the provider refuses the grant, and keeps the stored pair', async () => {
    reset('refuse');
    const o = await org();
    const c = await connect(o, 60_000);
    const envelopeBefore = await envelopeOf(c.connectionId);
    expect(await refresh(o, c.connectionId)).toEqual({ outcome: 'expired' });
    expect(await rowOf(c.connectionId)).toMatchObject({ status: 'expired', status_reason: 'connection_expired' });
    // The stored pair is untouched (the member's reconnect replaces it).
    expect(await envelopeOf(c.connectionId)).toBe(envelopeBefore);
    // A connection that is no longer active is not refreshed again.
    expect(await refresh(o, c.connectionId)).toEqual({ outcome: 'not_active' });
    expect(zoom.state.calls).toBe(1);
    // The audit row says so, and holds no token.
    const audit = await sqlAdmin<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' AND detail ->> 'expired' = 'true'", [o.orgId, COMMAND]);
    expect(audit.rowCount).toBe(1);
    for (const secret of ['access-0', 'refresh-0', c.account]) expect(JSON.stringify(audit.rows[0]?.detail)).not.toContain(secret);
  });

  it('reads a provider that throws connection_expired as a refusal too, and a refresh answer with no expiry as a token that lives half an hour (renewals go on)', async () => {
    reset('throw_expired');
    const o = await org();
    const gone = await connect(o, 60_000);
    expect(await refresh(o, gone.connectionId)).toEqual({ outcome: 'expired' });
    expect(await rowOf(gone.connectionId)).toMatchObject({ status: 'expired' });
    reset('no_expiry');
    const c = await connect(o, 60_000);
    expect((await refresh(o, c.connectionId)).outcome).toBe('refreshed');
    const now = await stored(o, c.connectionId);
    expect(now).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    const life = (now.expiresAt?.getTime() ?? 0) - Date.now();
    expect(life).toBeGreaterThan(25 * 60_000);
    expect(life).toBeLessThan(31 * 60_000);
  });

  it('changes nothing when the provider cannot be reached, and the next try renews', async () => {
    reset('down');
    const o = await org();
    const c = await connect(o, 60_000);
    const before = await rowOf(c.connectionId);
    expect(await refresh(o, c.connectionId)).toEqual({ outcome: 'unavailable' });
    expect(await stored(o, c.connectionId)).toMatchObject({ accessToken: 'access-0', refreshToken: 'refresh-0' });
    expect(await rowOf(c.connectionId)).toEqual(before);
    zoom.state.mode = 'ok';
    expect((await refresh(o, c.connectionId)).outcome).toBe('refreshed');
    expect(await stored(o, c.connectionId)).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  it('rolls everything back when the new pair cannot be stored after the provider rotated the token; the next try is refused and the connection expires (the documented window)', async () => {
    reset();
    const o = await org();
    const c = await connect(o, 60_000);
    broker.failSeals = 1;
    // The provider rotated the refresh token, then the seal failed: the command fails, and the database holds what it held before (nothing half done).
    expect(await refuses(refresh(o, c.connectionId))).not.toBeNull();
    expect(zoom.state.valid).toBe('refresh-1');
    expect(await stored(o, c.connectionId)).toMatchObject({ accessToken: 'access-0', refreshToken: 'refresh-0' });
    expect(await rowOf(c.connectionId)).toMatchObject({ status: 'active' });
    // The stored refresh token is dead at the provider: the next renewal is refused and the member connects again.
    expect(await refresh(o, c.connectionId)).toEqual({ outcome: 'expired' });
    expect(await rowOf(c.connectionId)).toMatchObject({ status: 'expired' });
  });

  it('does nothing for a connection that is not active, is refused for an unknown one and for another org\'s, and runs for no one but the system', async () => {
    reset();
    const o = await org();
    const other = await org();
    const c = await connect(o, 60_000);
    // A member of the org cannot run it, whoever they are: the command's own gate (access: 'system'), on a runtime that registers it.
    expect(await refuses(api.execute(COMMAND, { connectionId: c.connectionId }, { actor: asUser(o.lan), orgId: o.orgId }))).toBe('FORBIDDEN');
    // An unknown connection, and this connection through another org, are not found.
    expect(await refuses(refresh(o, randomUUID()))).toBe('MEETING_PLATFORM_NOT_FOUND');
    expect(await refuses(refresh(other, c.connectionId))).toBe('MEETING_PLATFORM_NOT_FOUND');
    // A member who left: the credential is not read for them.
    await sqlAdmin('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.lan]);
    expect(await refresh(o, c.connectionId)).toEqual({ outcome: 'not_active' });
    expect(zoom.state.calls).toBe(0);
  });

  it('is not run for a connection whose provider cannot refresh', async () => {
    reset();
    const o = await org();
    const c = await connect(o, 60_000);
    await sqlAdmin("UPDATE crove_kernel.meeting_platform_connection SET provider = 'sandbox' WHERE id = $1", [c.connectionId]);
    expect(await refresh(o, c.connectionId)).toEqual({ outcome: 'unsupported' });
    expect(zoom.state.calls).toBe(0);
  });
});
