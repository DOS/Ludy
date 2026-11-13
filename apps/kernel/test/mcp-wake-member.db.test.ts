// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up of a member-bound MCP grant against a real database (ADR-0051 decisions 2 and 4, issue #2975, slice 3, step 3c-2): a member sets, reads, rotates, clears and
// tests the wake-up of their own grant and of nothing else; an owner or admin sees only the receiver's host of another member's grant and cannot touch it; the receiver's address
// follows the same rules as any other; a secret is in no audit row and no answer; the rates hold; a member-bound grant gets no signal; and delivery stops with the grant's standing.
// The rules that must hold before this one existed are in test/invariant/mcp-wake-member.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, DomainError, Runtime, parseVaultKey, type UserActor } from '@crove/kernel-runtime';
import { makeWakeSecret } from '../src/mcp-wake-setup.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the wake-up of a member-bound MCP grant (#2975, slice 3, step 3c-2)', () => {
  const dbName = `crove_test_mcp_wake_member_db_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let orgA = '';
  const users = { ownerA: '', adminA: '', memberA: '', viewerA: '' };
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const TOKEN = `tok_${randomBytes(9).toString('hex')}`;
  const URL_OK = `https://hooks.example.com/ludy/${TOKEN}`;
  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const as = (userId: string) => ({ actor: browser(userId), orgId: orgA });
  const system = { actor: { type: 'system' as const, component: 'kernel.mcp.wake' }, orgId: '' };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  async function memberGrant(userId: string): Promise<string> {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $4, 'Test client', 'client.example.com', ARRAY['ludy.read'], $5, clock_timestamp(), now() + interval '30 days', $3, 'member', $3)`,
        [orgA, id, userId, `client-${id}`, `oauth-${id}`],
      ),
    );
    return id;
  }
  const set = (userId: string, grantId: string, over: Record<string, unknown> = {}) => {
    const made = makeWakeSecret(vault, orgA, grantId);
    return runtime
      .execute<Record<string, unknown>>('kernel.mcp.wake.set', { grantId, url: URL_OK, credential: made.credential, ...over }, as(userId))
      .then((result) => ({ result, made }));
  };
  const rotate = (userId: string, grantId: string) => runtime.execute('kernel.mcp.wake.rotate_secret', { grantId, credential: makeWakeSecret(vault, orgA, grantId).credential }, as(userId));
  const get = (userId: string, grantId?: string) => runtime.query<Array<Record<string, unknown>>>('kernel.mcp.wake.get', grantId ? { grantId } : {}, as(userId));
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }
  const setSwitch = (on: boolean) => admin((c) => c.query(`UPDATE crove_kernel.tenant SET mcp_member_grants = $2 WHERE org_id = $1`, [orgA, on]));

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 6 });
    pools.push(pool);
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    workerUrl = url.toString();
    const workerPool = createPool({ connectionString: workerUrl, max: 2 });
    pools.push(workerPool);
    const db = createDb(pool);
    const defs = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) };
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register(defs);
    // The system actor enters only from the worker's login.
    workerRuntime = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(defs);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-wake-member-db', subject: key, email: `${key}@mcp-wake-member-db.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    system.orgId = orgA;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgA, users.adminA, users.memberA, users.viewerA]);
      await c.query(`UPDATE crove_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1`, [orgA]);
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('lets a member and a viewer set, read, rotate, test and clear the wake-up of their own grant, and see only their own', async () => {
    for (const userId of [users.memberA, users.viewerA]) {
      const grant = await memberGrant(userId);
      await set(userId, grant, { schedule: 'daily', minute: 540 });
      const views = await get(userId);
      expect(views.map((v) => v.grantId)).toEqual([grant]);
      expect(views[0]).toMatchObject({ url: URL_OK, enabled: true, schedule: 'daily' });
      await rotate(userId, grant);
      await runtime.execute('kernel.mcp.wake.test', { grantId: grant }, as(userId));
      await runtime.execute('kernel.mcp.wake.clear', { grantId: grant }, as(userId));
      expect(await get(userId)).toEqual([]);
    }
  });

  it('shows an owner or admin only the host of another member\'s wake-up, and lets them touch none of it', async () => {
    const grant = await memberGrant(users.memberA);
    await set(users.memberA, grant);
    for (const userId of [users.ownerA, users.adminA]) {
      const [view] = await get(userId, grant);
      expect(view?.url).toBe('https://hooks.example.com');
      expect(JSON.stringify(await get(userId))).not.toContain(TOKEN);
      for (const call of [
        () => set(userId, grant),
        () => rotate(userId, grant),
        () => runtime.execute('kernel.mcp.wake.clear', { grantId: grant }, as(userId)),
        () => runtime.execute('kernel.mcp.wake.test', { grantId: grant }, as(userId)),
      ]) {
        expect((await refusal(call())).code).toBe('MCP_WAKE_GRANT_NOT_FOUND');
      }
    }
    // The member's own view is whole, and the owner's own member-bound grant reads whole to the owner.
    expect((await get(users.memberA, grant))[0]?.url).toBe(URL_OK);
    const owners = await memberGrant(users.ownerA);
    await set(users.ownerA, owners);
    expect((await get(users.ownerA, owners))[0]?.url).toBe(URL_OK);
    expect((await get(users.adminA, owners))[0]?.url).toBe('https://hooks.example.com');
    // Revoking the grant is what cuts it off: delivery has no target after it.
    const worker = new pg.Client({ connectionString: workerUrl });
    await worker.connect();
    try {
      expect((await worker.query(`SELECT * FROM crove_kernel.mcp_wake_target($1, $2)`, [orgA, grant])).rowCount).toBe(1);
      await admin((c) => c.query(`UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE org_id = $1 AND id = $2`, [orgA, grant]));
      expect((await worker.query(`SELECT * FROM crove_kernel.mcp_wake_target($1, $2)`, [orgA, grant])).rowCount).toBe(0);
    } finally {
      await worker.end();
    }
  });

  it('refuses on the member\'s path every receiver the rules refuse: not https, an address, another port, credentials, a fragment, a private name', async () => {
    const grant = await memberGrant(users.memberA);
    for (const url of ['http://hooks.example.com/x', 'https://hooks.example.com:8443/x', 'https://user:pw@hooks.example.com/x', 'https://hooks.example.com/x#frag', 'https://10.0.0.5/x', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/x', 'https://169.254.169.254/latest']) {
      const error = await refusal(set(users.memberA, grant, { url }));
      expect([400, 422], url).toContain(error.status);
    }
    expect(await get(users.memberA, grant)).toEqual([]);
  });

  it('keeps a secret out of every audit row and every answer, after a set and after a rotation', async () => {
    const grant = await memberGrant(users.viewerA);
    const first = await set(users.viewerA, grant);
    const rotated = makeWakeSecret(vault, orgA, grant);
    const answer = await runtime.execute('kernel.mcp.wake.rotate_secret', { grantId: grant, credential: rotated.credential }, as(users.viewerA));
    const everything = JSON.stringify([first.result, answer, await get(users.viewerA, grant)]);
    const audit = await admin((c) => c.query(`SELECT row_to_json(a)::text AS row FROM crove_kernel.audit_event a WHERE a.org_id = $1 AND a.command LIKE 'kernel.mcp.wake.%'`, [orgA]));
    const stored = JSON.stringify(audit.rows);
    for (const secret of [first.made.secret, rotated.secret, first.made.credential.envelope, rotated.credential.envelope]) {
      expect(everything).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
    expect(stored).not.toContain(TOKEN);
  });

  it('rotates a secret once a minute and sends at most ten pings an hour per grant', async () => {
    const grant = await memberGrant(users.memberA);
    await set(users.memberA, grant);
    await rotate(users.memberA, grant);
    expect((await refusal(rotate(users.memberA, grant))).code).toBe('MCP_WAKE_TOO_SOON');
    await runtime.execute('kernel.mcp.wake.test', { grantId: grant }, as(users.memberA));
    expect((await refusal(runtime.execute('kernel.mcp.wake.test', { grantId: grant }, as(users.memberA)))).code).toBe('MCP_WAKE_TOO_SOON');
    // Nine earlier pings in the hour, then the next minute's ping is the tenth in the hour and the one after is refused.
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body, created_at)
         SELECT $1, i, $2, 'ping', jsonb_build_object('id', i, 'type', 'ping', 'created_at', '2026-11-12T03:00:00.000Z', 'org', $1::uuid, 'grant', $2::uuid, 'data', '{}'::jsonb),
                now() - interval '5 minutes'
         FROM (SELECT gen_random_uuid() AS i FROM generate_series(1, 9)) s`,
        [orgA, grant],
      ),
    );
    expect((await refusal(runtime.execute('kernel.mcp.wake.test', { grantId: grant }, as(users.memberA)))).code).toBe('MCP_WAKE_TOO_SOON');
  });

  it('gives a member-bound grant no signal: it is never asked for them, and a signal event for it is refused', async () => {
    const grant = await memberGrant(users.memberA);
    await set(users.memberA, grant, { schedule: 'daily', minute: 540 });
    const worker = new pg.Client({ connectionString: workerUrl });
    await worker.connect();
    try {
      const due = await worker.query<{ grant_id: string; signals_due: boolean }>(`SELECT grant_id, signals_due FROM crove_kernel.mcp_wake_due(100)`);
      expect(due.rows.filter((r) => r.grant_id === grant).every((r) => r.signals_due === false)).toBe(true);
    } finally {
      await worker.end();
    }
    const id = randomUUID();
    const body = {
      id,
      type: 'signal.fired',
      created_at: '2026-11-12T03:00:00.000Z',
      org: orgA,
      grant,
      data: { items: [{ rule: 'kernel.signals.deal_without_invoice', key: `deal_without_invoice:${randomUUID()}`, severity: 'warn', deal_id: randomUUID() }] },
    };
    const refused = await refusal(workerRuntime.execute('kernel.mcp.wake.enqueue', { id, grantId: grant, type: 'signal.fired', body, keys: [body.data.items[0]?.key as string] }, system));
    expect(refused.status).toBe(422);
    const stored = await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.agent_wake_delivery WHERE org_id = $1 AND grant_id = $2 AND type = 'signal.fired'`, [orgA, grant]));
    expect(stored.rows[0].n).toBe(0);
  });

  it('stops delivering when the org turns member grants off, and when the member leaves', async () => {
    const grant = await memberGrant(users.memberA);
    await set(users.memberA, grant);
    const worker = new pg.Client({ connectionString: workerUrl });
    await worker.connect();
    const target = async () => (await worker.query(`SELECT * FROM crove_kernel.mcp_wake_target($1, $2)`, [orgA, grant])).rowCount;
    try {
      expect(await target()).toBe(1);
      await setSwitch(false);
      expect(await target()).toBe(0);
      expect((await refusal(set(users.memberA, grant))).status).toBeGreaterThanOrEqual(400);
      await setSwitch(true);
      expect(await target()).toBe(1);
      await admin((c) => c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgA, users.memberA]));
      expect(await target()).toBe(0);
    } finally {
      await worker.end();
      await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [orgA, users.memberA]));
    }
  });
});
