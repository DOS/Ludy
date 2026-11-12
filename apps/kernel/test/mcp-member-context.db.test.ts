// SPDX-License-Identifier: AGPL-3.0-only
// The sealed context of a member-bound MCP grant against a real database (ADR-0051 decision 2, ADR-0049; design note on #2975, slice 3, step 3b-1): who may enter it and what it refuses with
// which code, what the entered context is (a null user, the member sealed, the member's live rights, read only) and, with three canary tables, that it is fail closed: it reads a table only
// through the policy written for it, never one written for a user or for Vy in member mode, and it writes nothing guarded.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type UserActor } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the sealed context of a member-bound MCP grant (#2975, slice 3, step 3b-1)', () => {
  const dbName = `crove_test_mcp_member_ctx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgA = '';
  let orgB = '';
  const users = { ownerA: '', adminA: '', memberA: '', viewerA: '', ownerB: '' };
  const user = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  // One transaction as a login role, always rolled back.
  async function asLogin<T>(login: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const url = new URL(adminUrl);
    url.username = login;
    url.password = login === 'crove_app' ? 'test-app-pw' : 'test-worker-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }
  const enter = (orgId: string, grantId: string) =>
    asLogin('crove_app', async (c) => c.query(`SELECT crove_kernel.enter_mcp_member_context($1::uuid, $2::uuid) AS got`, [orgId, grantId]).then((r) => r.rows[0].got as { role: string; member: string; maxRisk: string }));
  const refusedWith = async (orgId: string, grantId: string) => {
    try {
      await enter(orgId, grantId);
    } catch (error) {
      return (error as { message: string }).message;
    }
    throw new Error('expected a refusal');
  };

  let counter = 0;
  async function grant(orgId: string, userId: string, over: { kind?: 'company' | 'member'; revoked?: boolean; expired?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const kind = over.kind ?? 'member';
    counter += 1;
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, revoked_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $4, 'Test client', 'client.example.com', ARRAY['ludy.read'], $5, ${over.expired ? "now() - interval '2 days'" : 'clock_timestamp()'}, ${over.expired ? "now() - interval '1 day'" : "now() + interval '30 days'"},
                 ${over.revoked ? 'now()' : 'NULL'}, $3, $6, ${kind === 'member' ? '$3' : 'NULL'})`,
        [orgId, id, userId, `client-${counter}-${id}`, `oauth-${id}`, kind],
      ),
    );
    return id;
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
    const pool = createPool({ connectionString: url.toString(), max: 3 });
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-member-ctx', subject: key, email: `${key}@mcp-member-ctx.test`, name: null });
    }
    orgA = (await createOrg(runtime, user(users.ownerA), 'Org A')).orgId;
    orgB = (await createOrg(runtime, user(users.ownerB), 'Org B')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgA, users.adminA, users.memberA, users.viewerA]);
      // Three canary tables, each with the policy written for one kind of context: a user's own rows, Vy in member mode's, a member grant's.
      for (const t of ['zz_canary_user', 'zz_canary_vy', 'zz_canary_mcp']) {
        await c.query(`CREATE TABLE crove_kernel.${t} (org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), member_user_id uuid NOT NULL, PRIMARY KEY (org_id, id))`);
        await c.query(`SELECT crove_kernel.apply_tenant_rls('crove_kernel.${t}')`);
        await c.query(`GRANT SELECT, INSERT ON crove_kernel.${t} TO crove_tenant`);
        await c.query(`SELECT crove_kernel.agent_write_guard_install('crove_kernel.${t}')`);
      }
      const policy = (t: string, expr: string) => c.query(`CREATE POLICY member_read ON crove_kernel.${t} AS RESTRICTIVE FOR SELECT TO crove_tenant USING (member_user_id = (SELECT ${expr}))`);
      await policy('zz_canary_user', 'crove_kernel.ctx_user_id()');
      await policy('zz_canary_vy', 'crove_kernel.ctx_acting_user_id()');
      await policy('zz_canary_mcp', 'crove_kernel.ctx_mcp_member_id()');
      for (const t of ['zz_canary_user', 'zz_canary_vy', 'zz_canary_mcp']) {
        await c.query(`INSERT INTO crove_kernel.${t} (org_id, member_user_id) VALUES ($1, $2), ($1, $3)`, [orgA, users.memberA, users.viewerA]);
      }
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses, with a code each, a company grant, a revoked one, an expired one, another org\'s, an unknown id, and a non-admin\'s while the org\'s switch is off', async () => {
    await setSwitch(true);
    expect(await refusedWith(orgA, await grant(orgA, users.ownerA, { kind: 'company' }))).toMatch(/MCP_GRANT_NOT_MEMBER/);
    expect(await refusedWith(orgA, await grant(orgA, users.memberA, { revoked: true }))).toMatch(/MCP_GRANT_REVOKED/);
    expect(await refusedWith(orgA, await grant(orgA, users.memberA, { expired: true }))).toMatch(/MCP_GRANT_EXPIRED/);
    const mine = await grant(orgA, users.memberA);
    expect(await refusedWith(orgB, mine)).toMatch(/MCP_GRANT_INVALID/);
    expect(await refusedWith(orgA, randomUUID())).toMatch(/MCP_GRANT_INVALID/);
    const viewer = await grant(orgA, users.viewerA);
    await setSwitch(false);
    expect(await refusedWith(orgA, viewer)).toMatch(/MCP_MEMBER_GRANTS_OFF/);
    expect(await refusedWith(orgA, mine)).toMatch(/MCP_MEMBER_GRANTS_OFF/);
    // An admin's member grant stands with the switch off.
    expect((await enter(orgA, await grant(orgA, users.adminA))).member).toBe(users.adminA);
    // A removed member's grant: the database ends it when the member is deleted (mcp_grant_member_trigger, with its tokens), so it reads as revoked, and it never enters.
    await setSwitch(true);
    const gone = await grant(orgA, users.viewerA);
    await admin((c) => c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgA, users.viewerA]));
    expect(await refusedWith(orgA, gone)).toMatch(/MCP_GRANT_REVOKED/);
    expect((await admin((c) => c.query(`SELECT revoked_at FROM crove_kernel.agent_grant WHERE id = $1`, [gone]))).rows[0].revoked_at).not.toBeNull();
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')`, [orgA, users.viewerA]));
  });

  it('can be entered by the API\'s login alone', async () => {
    await setSwitch(true);
    const g = await grant(orgA, users.memberA);
    await expect(asLogin('crove_worker', (c) => c.query(`SELECT crove_kernel.enter_mcp_member_context($1::uuid, $2::uuid)`, [orgA, g]))).rejects.toThrow(/permission denied/);
  });

  it('enters a context of the member\'s live role with no user, read only, and answers the member to its own helper alone', async () => {
    await setSwitch(true);
    const g = await grant(orgA, users.memberA);
    await asLogin('crove_app', async (c) => {
      const got = (await c.query(`SELECT crove_kernel.enter_mcp_member_context($1::uuid, $2::uuid) AS got`, [orgA, g])).rows[0].got;
      expect(got).toMatchObject({ role: 'member', member: users.memberA, maxRisk: 'R0' });
      const ids = (await c.query(`SELECT crove_kernel.ctx_user_id() AS u, crove_kernel.ctx_acting_user_id() AS a, crove_kernel.ctx_mcp_member_id() AS m, crove_kernel.ctx_agent_id() AS g, crove_kernel.ctx_org_id() AS o`)).rows[0];
      expect(ids).toEqual({ u: null, a: null, m: users.memberA, g, o: orgA });
    });
    // A user's own context, and no context at all, answer nothing to the helper.
    await asLogin('crove_app', async (c) => {
      await c.query(`SELECT crove_kernel.enter_context($1::uuid, $2::uuid)`, [users.memberA, orgA]);
      expect((await c.query(`SELECT crove_kernel.ctx_mcp_member_id() AS m`)).rows[0].m).toBeNull();
    });
  });

  it('is fail closed: it reads a table only through the policy written for it, never a user\'s or Vy\'s, and a user\'s own context does not read its table', async () => {
    await setSwitch(true);
    const g = await grant(orgA, users.memberA);
    const count = async (c: pg.Client, t: string) => (await c.query(`SELECT member_user_id FROM crove_kernel.${t} ORDER BY 1`)).rows.map((r: { member_user_id: string }) => r.member_user_id);
    await asLogin('crove_app', async (c) => {
      await c.query(`SELECT crove_kernel.enter_mcp_member_context($1::uuid, $2::uuid)`, [orgA, g]);
      expect(await count(c, 'zz_canary_user')).toEqual([]);
      expect(await count(c, 'zz_canary_vy')).toEqual([]);
      // Its own member's rows, and not the other member's.
      expect(await count(c, 'zz_canary_mcp')).toEqual([users.memberA]);
    });
    await asLogin('crove_app', async (c) => {
      await c.query(`SELECT crove_kernel.enter_context($1::uuid, $2::uuid)`, [users.memberA, orgA]);
      expect(await count(c, 'zz_canary_user')).toEqual([users.memberA]);
      expect(await count(c, 'zz_canary_mcp')).toEqual([]);
    });
  });

  it('writes nothing a guarded table holds, not even a row of its own member', async () => {
    await setSwitch(true);
    const g = await grant(orgA, users.memberA);
    await asLogin('crove_app', async (c) => {
      await c.query(`SELECT crove_kernel.enter_mcp_member_context($1::uuid, $2::uuid)`, [orgA, g]);
      await expect(c.query(`INSERT INTO crove_kernel.zz_canary_mcp (org_id, member_user_id) VALUES ($1, $2)`, [orgA, users.memberA])).rejects.toThrow(/AGENT_FORBIDDEN|permission denied|violates/);
    });
  });

  it('puts nothing in the catalog: the private scope ships dark', async () => {
    const rows = await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.mcp_member_table`).then((r) => r.rows[0].n as number));
    expect(rows).toBe(0);
  });
});
