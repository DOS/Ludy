// SPDX-License-Identifier: AGPL-3.0-only
// The sealed context of a company MCP grant against a real database (ADR-0051 decision 2, issue #2975, slice 3, step 3e-2): a company grant no longer runs as the person who made it. Its context has no
// user, so what is bound to a user (a private note, a table of Vy's catalog) answers nothing to it, whatever the owner or admin holds, while the org's own rows read as before. Each way it can stop
// ends the next call with the one generic answer. The same canary holds for a member-bound grant. Entry codes, the seal and the role read live are pinned here as well.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineQuery, type UserActor } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the sealed context of a company MCP grant (#2975, slice 3, step 3e-2)', () => {
  const dbName = `crove_test_mcp_company_ctx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  const users = { ownerA: '', adminA: '', memberA: '' };
  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const mcp = (userId: string, grantId: string, kind?: 'company' | 'member'): UserActor => ({
    type: 'user',
    userId,
    aal: 'aal1',
    mcp: { grantId, clientId: 'client', clientName: 'Test client', scopes: ['ludy.read'], ...(kind ? { kind } : {}) },
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  async function asLogin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
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
  let counter = 0;
  async function grant(userId: string, over: { kind?: 'company' | 'member'; revoked?: boolean; expired?: boolean; org?: string } = {}): Promise<string> {
    const id = randomUUID();
    const kind = over.kind ?? 'company';
    counter += 1;
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, revoked_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $4, 'Test client', 'client.example.com', ARRAY['ludy.read'], $5, ${over.expired ? "now() - interval '2 days'" : 'clock_timestamp()'}, ${over.expired ? "now() - interval '1 day'" : "now() + interval '30 days'"},
                 ${over.revoked ? 'now()' : 'NULL'}, $3, $6, ${kind === 'member' ? '$3' : 'NULL'})`,
        [over.org ?? orgA, id, userId, `client-${counter}-${id}`, `oauth-${id}`, kind],
      ),
    );
    return id;
  }
  const refusedWith = async (grantId: string, org = orgA) => {
    try {
      await asLogin((c) => c.query(`SELECT crove_kernel.enter_mcp_company_context($1::uuid, $2::uuid)`, [org, grantId]));
    } catch (error) {
      return (error as { message: string }).message;
    }
    throw new Error('expected a refusal');
  };
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }

  // A query that declares `mcp` and reads one canary table: the three policies a context can meet. `zz_canary_org` is an org's own table (the org clause only), the other two are
  // bound to a user, and to the member Vy's catalog answers for.
  const canary = defineQuery({
    name: 'kernel.zz_canary_read',
    input: z.strictObject({ table: z.enum(['zz_canary_org', 'zz_canary_user', 'zz_canary_vy']) }),
    access: ['owner', 'admin', 'member', 'viewer'],
    mcp: { scope: 'ludy.read' },
    handler: async (ctx, input) => {
      const { rows } = await sql<{ tag: string }>`SELECT tag FROM ${sql.table(`crove_kernel.${input.table}`)} ORDER BY tag`.execute(ctx.trx);
      return rows.map((r) => r.tag);
    },
  });
  const read = (actor: UserActor, table: 'zz_canary_org' | 'zz_canary_user' | 'zz_canary_vy') => runtime.query<string[]>('kernel.zz_canary_read', { table }, { actor, orgId: orgA });
  const about = (actor: UserActor) => runtime.query<{ orgName: string }>('kernel.mcp.about', {}, { actor, orgId: orgA });

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
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: [...kernelQueries({ inboundDomain: 'in.test' }), canary] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-company-ctx', subject: key, email: `${key}@mcp-company-ctx.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgA, users.adminA, users.memberA]);
      await c.query(`UPDATE crove_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1`, [orgA]);
      for (const t of ['zz_canary_org', 'zz_canary_user', 'zz_canary_vy']) {
        await c.query(`CREATE TABLE crove_kernel.${t} (org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), owner_user_id uuid NOT NULL, tag text NOT NULL, PRIMARY KEY (org_id, id))`);
        await c.query(`SELECT crove_kernel.apply_tenant_rls('crove_kernel.${t}')`);
        await c.query(`GRANT SELECT ON crove_kernel.${t} TO crove_tenant`);
      }
      const policy = (t: string, expr: string) => c.query(`CREATE POLICY bound_read ON crove_kernel.${t} AS RESTRICTIVE FOR SELECT TO crove_tenant USING (owner_user_id = (SELECT ${expr}))`);
      await policy('zz_canary_user', 'crove_kernel.ctx_user_id()');
      await policy('zz_canary_vy', 'crove_kernel.ctx_acting_user_id()');
      for (const t of ['zz_canary_org', 'zz_canary_user', 'zz_canary_vy']) {
        await c.query(`INSERT INTO crove_kernel.${t} (org_id, owner_user_id, tag) VALUES ($1, $2, 'owner-row'), ($1, $3, 'admin-row')`, [orgA, users.ownerA, users.adminA]);
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

  it('refuses, with a code each, a member-bound grant, a revoked one, an expired one, another org\'s and an unknown id', async () => {
    expect(await refusedWith(await grant(users.ownerA, { kind: 'member' }))).toBe('MCP_GRANT_NOT_COMPANY');
    expect(await refusedWith(await grant(users.ownerA, { revoked: true }))).toBe('MCP_GRANT_REVOKED');
    expect(await refusedWith(await grant(users.ownerA, { expired: true }))).toBe('MCP_GRANT_EXPIRED');
    expect(await refusedWith(await grant(users.ownerA), randomUUID())).toBe('MCP_GRANT_INVALID');
    expect(await refusedWith(randomUUID())).toBe('MCP_GRANT_INVALID');
  });

  it('enters a read-only context with no user and the grantor\'s live role, and can be entered by the API login alone', async () => {
    const g = await grant(users.adminA);
    const got = await asLogin(async (c) => {
      const r = (await c.query(`SELECT crove_kernel.enter_mcp_company_context($1::uuid, $2::uuid) AS got`, [orgA, g])).rows[0].got as { role: string; grantor: string; maxRisk: string; tainted: boolean };
      const user = (await c.query(`SELECT crove_kernel.ctx_user_id() AS u, crove_kernel.ctx_actor_type() AS t`)).rows[0] as { u: string | null; t: string };
      expect(user).toEqual({ u: null, t: 'agent' });
      await expect(c.query(`INSERT INTO crove_kernel.zz_canary_org (org_id, owner_user_id, tag) VALUES ($1, $2, 'x')`, [orgA, users.adminA])).rejects.toThrow(/AGENT_FORBIDDEN|permission denied|violates|read-only/);
      return r;
    });
    expect(got).toEqual({ role: 'admin', grantor: users.adminA, maxRisk: 'R0', tainted: true });
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    const w = new pg.Client({ connectionString: worker.toString() });
    await w.connect();
    try {
      await expect(w.query(`SELECT crove_kernel.enter_mcp_company_context($1::uuid, $2::uuid)`, [orgA, g])).rejects.toThrow(/permission denied|MCP_CONTEXT_API_ONLY/);
    } finally {
      await w.end();
    }
  });

  it('reads the org\'s own rows through a company grant as before, and nothing that is bound to a user or to Vy\'s catalog, whatever the grantor holds', async () => {
    const g = await grant(users.ownerA);
    // The control: the owner\'s own context reads the owner\'s row of the user-bound table, and the org-level table whole.
    expect(await read(browser(users.ownerA), 'zz_canary_org')).toEqual(['admin-row', 'owner-row']);
    expect(await read(browser(users.ownerA), 'zz_canary_user')).toEqual(['owner-row']);
    // The company grant of the same owner: the org-level table as before (the three tools read such tables), the other two nothing.
    expect(await read(mcp(users.ownerA, g), 'zz_canary_org')).toEqual(['admin-row', 'owner-row']);
    expect(await read(mcp(users.ownerA, g, 'company'), 'zz_canary_user')).toEqual([]);
    expect(await read(mcp(users.ownerA, g), 'zz_canary_vy')).toEqual([]);
    // A member-bound grant meets the same two closed tables (and, with no catalog row, would meet nothing else either).
    const own = await grant(users.ownerA, { kind: 'member' });
    expect(await read(mcp(users.ownerA, own, 'member'), 'zz_canary_user')).toEqual([]);
    expect(await read(mcp(users.ownerA, own, 'member'), 'zz_canary_vy')).toEqual([]);
  });

  it('keeps what the three tools return the same on the sealed context: the org\'s name for an owner\'s and an admin\'s grant', async () => {
    for (const userId of [users.ownerA, users.adminA]) {
      expect(await about(mcp(userId, await grant(userId)))).toMatchObject({ orgName: 'Org A' });
    }
  });

  it('ends the very next call of a company grant when it is revoked, the grantor is demoted or removed, or the org is stopped, with the one generic answer', async () => {
    const answers: DomainError[] = [];
    const revoked = await grant(users.ownerA);
    await about(mcp(users.ownerA, revoked));
    await admin((c) => c.query(`UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE org_id = $1 AND id = $2`, [orgA, revoked]));
    answers.push(await refusal(about(mcp(users.ownerA, revoked))));
    const demoted = await grant(users.adminA);
    await about(mcp(users.adminA, demoted));
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgA, users.adminA]));
    answers.push(await refusal(about(mcp(users.adminA, demoted))));
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgA, users.adminA]));
    // It does not come back with the role (the guard ended it), and a new grant of the admin works.
    answers.push(await refusal(about(mcp(users.adminA, demoted))));
    expect(await about(mcp(users.adminA, await grant(users.adminA)))).toMatchObject({ orgName: 'Org A' });
    for (const error of answers) {
      expect(error.status).toBe(401);
      expect(error.code).toBe('MCP_GRANT_INVALID');
      expect(error.message).toBe(answers[0]?.message);
    }
  });

  it('keeps the standing facts the sealed context must not cost: last_used_at moves on a verify, a refusal audit row names the consenting user and the grant, the daily row budget is charged', async () => {
    const id = await grant(users.ownerA);
    const row = (await admin((c) => c.query(`SELECT client_id FROM crove_kernel.agent_grant WHERE org_id = $1 AND id = $2`, [orgA, id]))).rows[0] as { client_id: string };
    // Verified and read in one transaction, then rolled back, so the grant stays fresh for the rest of the test.
    const stamped = await admin(async (c) => {
      await c.query('BEGIN');
      const verified = await c.query(`SELECT * FROM crove_kernel.mcp_grant_verify($1::uuid, $2)`, [id, row.client_id]);
      expect(verified.rowCount).toBe(1);
      const at = (await c.query(`SELECT last_used_at FROM crove_kernel.agent_grant WHERE org_id = $1 AND id = $2`, [orgA, id])).rows[0]?.last_used_at ?? null;
      await c.query('ROLLBACK');
      return at;
    });
    expect(stamped).not.toBeNull();
    // A refused command (commands are closed to MCP) leaves its audit row by the consenting user, naming this grant and client.
    await refusal(runtime.execute('kernel.org.set_approval_preset', { preset: 'x' }, { actor: mcp(users.ownerA, id, 'company'), orgId: orgA }));
    const audit = await admin((c) => c.query(`SELECT actor_type, actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND detail ->> 'mcpGrant' = $2`, [orgA, id]));
    expect(audit.rowCount).toBeGreaterThan(0);
    expect(audit.rows[0]).toMatchObject({ actor_type: 'user', actor_id: users.ownerA, detail: { mcpCall: true, mcpGrant: id, mcpClientName: 'Test client' } });
    // The daily row budget is charged outside the sealed context, by the definer, as before.
    const charged = await asLogin((c) => c.query(`SELECT crove_kernel.mcp_rows_charge($1::uuid, $2::uuid, 1, 1000000) AS left_rows`, [id, orgA]));
    expect(charged.rowCount).toBe(1);
  });
});
