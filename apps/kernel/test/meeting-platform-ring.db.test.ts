// SPDX-License-Identifier: AGPL-3.0-only
// The doorbell definer of Zoom's webhook on a real database (meetings integrations C3, #3175): ludy_kernel.meeting_platform_ring(provider, account) clears the last listing time of the ACTIVE Zoom
// connections of one Zoom user, so the sweep lists them again at its next pass, and nothing else. It rings only 'zoom', only an account of the shape of a Zoom user id, only active connections of an
// active org whose Meetings app is on and whose member is still in the org, in any case of the id; it returns a count and never an id; the API login runs it and no other login can. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database. The route that calls it is tested without a database in zoom-webhook.test.ts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('meeting_platform_ring, the doorbell of Zoom\'s webhook (meetings integrations C3, #3175)', () => {
  const dbName = `crove_test_mp_ring_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let api: Runtime;
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
  const person = (name: string) => upsertIdentity(personDb, { issuer: 'ring', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@ring.test`, name: null });
  // The API login runs the definer with no org and no user in the context, as the webhook route does.
  const ring = (provider: string, account: string) => api.orgless(async (db) => (await sql<{ n: number }>`SELECT ludy_kernel.meeting_platform_ring(${provider}, ${account}) AS n`.execute(db)).rows[0]?.n);

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const lan = await person('lan');
    const viewer = await person('viewer');
    await sqlAdmin("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, lan, viewer]);
    const exec = <T = unknown>(user: string, command: string, input: unknown = {}) => api.execute<T>(command, input, { actor: asUser(user), orgId });
    return { orgId, owner, lan, viewer, exec };
  }
  type Org = Awaited<ReturnType<typeof org>>;
  async function connect(o: Org, user: string, account: string, provider = 'zoom') {
    const done = await o.exec<{ connectionId: string }>(user, 'kernel.meeting_platform.connect', {
      provider,
      externalAccount: account,
      displayName: `Tài khoản ${account}`,
      scopes: [],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      credential: { keyId: 'k1', envelope: Buffer.from('sealed').toString('base64') },
    });
    // The sweep listed it a minute ago.
    await sqlAdmin("UPDATE ludy_kernel.meeting_platform_connection SET last_synced_at = now() - interval '1 minute' WHERE id = $1", [done.connectionId]);
    return done.connectionId;
  }
  const syncedAt = async (id: string) => (await sqlAdmin<{ last_synced_at: Date | null }>('SELECT last_synced_at FROM ludy_kernel.meeting_platform_connection WHERE id = $1', [id])).rows[0]?.last_synced_at ?? null;

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
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    workerUrl = login('ludy_worker', 'test-worker-pw');
    const appPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    pools.push(appPool);
    personDb = createDb(appPool);
    api = new Runtime(personDb, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] });
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('clears the last listing of the active connections of that Zoom user, whatever the case of the id, and returns how many, once', async () => {
    const o = await org();
    const id = await connect(o, o.lan, 'kdykjnimt4kpd8ffgqt9fq');
    const other = await connect(o, o.owner, 'someone-else-0001');
    const before = (await sqlAdmin<{ status: string; display_name: string; expires_at: Date }>('SELECT status, display_name, expires_at FROM ludy_kernel.meeting_platform_connection WHERE id = $1', [id])).rows[0];
    expect(await ring('zoom', 'KdYKjnimT4KPd8FFgQt9FQ')).toBe(1);
    expect(await syncedAt(id)).toBeNull();
    // Nothing else of the connection changed, and another account of the same org was not touched.
    expect((await sqlAdmin('SELECT status, display_name, expires_at FROM ludy_kernel.meeting_platform_connection WHERE id = $1', [id])).rows[0]).toEqual(before);
    expect(await syncedAt(other)).not.toBeNull();
    // Ringing again finds the column already empty and clears nothing; the exact lower case id works too.
    expect(await ring('zoom', 'KdYKjnimT4KPd8FFgQt9FQ')).toBe(0);
    expect(await ring('zoom', 'kdykjnimt4kpd8ffgqt9fq')).toBe(0);
  });

  it('rings the same Zoom user in every org they are connected in, and returns a count only', async () => {
    const a = await org();
    const b = await org();
    const ida = await connect(a, a.lan, 'shared-zoom-user-01');
    const idb = await connect(b, b.lan, 'shared-zoom-user-01');
    expect(await ring('zoom', 'SHARED-zoom-user-01')).toBe(2);
    expect(await syncedAt(ida)).toBeNull();
    expect(await syncedAt(idb)).toBeNull();
    const type = await sqlAdmin<{ result: string }>("SELECT pg_get_function_result('ludy_kernel.meeting_platform_ring(text,text)'::regprocedure) AS result");
    expect(type.rows[0]?.result).toBe('integer');
  });

  it('rings nothing for another provider, another or look-alike account, or an id that is not the shape of a Zoom user id', async () => {
    const o = await org();
    const id = await connect(o, o.lan, 'exact-user-id-01');
    const sandbox = await connect(o, o.owner, 'exact-user-id-01', 'sandbox');
    const wrong: Array<[string, string]> = [
      ['sandbox', 'exact-user-id-01'],
      ['google_meet', 'exact-user-id-01'],
      ['ZOOM', 'exact-user-id-01'],
      ['zoom ', 'exact-user-id-01'],
      ['', 'exact-user-id-01'],
      ['zoom', 'exact-user-id-0'],
      ['zoom', 'exact-user-id-011'],
      ['zoom', 'exact-user-id-%'],
      ['zoom', '%'],
      ['zoom', '_xact-user-id-01'],
      ['zoom', ''],
      ['zoom', ' exact-user-id-01'],
      ['zoom', 'exact-user-id-01\n'],
      ['zoom', "exact-user-id-01'; UPDATE ludy_kernel.meeting_platform_connection SET last_synced_at = NULL; --"],
      ['zoom', 'a'.repeat(201)],
    ];
    for (const [provider, account] of wrong) expect(await ring(provider, account), `${provider} ${JSON.stringify(account)}`).toBe(0);
    // The shape check stands on its own: a connection whose stored account is the very string asked for, but is no Zoom user id (an address), is not rung, so the regex is what refuses it.
    const address = await connect(o, o.lan, 'someone@example.test');
    expect(await ring('zoom', 'someone@example.test')).toBe(0);
    expect(await syncedAt(address)).not.toBeNull();
    expect(await syncedAt(id)).not.toBeNull();
    expect(await syncedAt(sandbox)).not.toBeNull();
  });

  it('rings nothing for an expired connection, a member who left, a viewer, a disabled user, a closed org or an org whose Meetings app is off, and rings again once it is back', async () => {
    const o = await org();
    // One connection per case, each of its own member state, so no case hides another.
    const expired = await connect(o, o.lan, 'ring-expired-01');
    await sqlAdmin("UPDATE ludy_kernel.meeting_platform_connection SET status = 'expired' WHERE id = $1", [expired]);
    expect(await ring('zoom', 'ring-expired-01')).toBe(0);
    expect(await syncedAt(expired)).not.toBeNull();

    // A member who left the org: the connection row stays (user_id is not a foreign key) but its member is no longer one.
    const leaver = await person('leaver');
    await sqlAdmin("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, leaver]);
    const left = await connect(o, leaver, 'ring-left-01');
    await sqlAdmin('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, leaver]);
    expect(await ring('zoom', 'ring-left-01')).toBe(0);
    expect(await syncedAt(left)).not.toBeNull();

    // A member demoted to viewer after connecting.
    const demoter = await person('demoter');
    await sqlAdmin("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, demoter]);
    const demoted = await connect(o, demoter, 'ring-demoted-01');
    await sqlAdmin("UPDATE ludy_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2", [o.orgId, demoter]);
    expect(await ring('zoom', 'ring-demoted-01')).toBe(0);
    expect(await syncedAt(demoted)).not.toBeNull();

    // A user an administrator disabled.
    const blocked = await person('blocked');
    await sqlAdmin("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, blocked]);
    const disabled = await connect(o, blocked, 'ring-disabled-01');
    await sqlAdmin('UPDATE ludy_kernel.user_account SET disabled_at = now() WHERE id = $1', [blocked]);
    expect(await ring('zoom', 'ring-disabled-01')).toBe(0);
    expect(await syncedAt(disabled)).not.toBeNull();
    await sqlAdmin('UPDATE ludy_kernel.user_account SET disabled_at = NULL WHERE id = $1', [blocked]);

    // The same connection, now rung once the member is fine again, under a closed org and then with Meetings off.
    await sqlAdmin("UPDATE ludy_kernel.tenant SET status = 'closed' WHERE org_id = $1", [o.orgId]);
    expect(await ring('zoom', 'ring-disabled-01')).toBe(0);
    await sqlAdmin("UPDATE ludy_kernel.tenant SET status = 'active' WHERE org_id = $1", [o.orgId]);
    // Meetings switched off by the owner: dropped like a notice that matches nothing; back on, the same notice rings.
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'meetings', enabled: false });
    expect(await ring('zoom', 'ring-disabled-01')).toBe(0);
    expect(await syncedAt(disabled)).not.toBeNull();
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'meetings', enabled: true });
    expect(await ring('zoom', 'ring-disabled-01')).toBe(1);
    expect(await syncedAt(disabled)).toBeNull();
  });

  it('is executable by the API login alone: the worker login is refused, and the sweep\'s due list sees a rung connection at once', async () => {
    const o = await org();
    const id = await connect(o, o.lan, 'ring-grants-01');
    const client = new pg.Client({ connectionString: workerUrl });
    await client.connect();
    try {
      await expect(client.query("SELECT ludy_kernel.meeting_platform_ring('zoom', 'ring-grants-01')")).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
    expect(await syncedAt(id)).not.toBeNull();
    // The connection was listed a minute ago, so it is not due; after the ring it is (the worker's sweep reads this list).
    const due = async () => (await sqlAdmin<{ connection_id: string }>('SELECT connection_id FROM ludy_kernel.meeting_platform_sync_due(NULL, NULL, 1000)')).rows.map((r) => r.connection_id);
    expect(await due()).not.toContain(id);
    expect(await ring('zoom', 'ring-grants-01')).toBe(1);
    expect(await due()).toContain(id);
  });
});
