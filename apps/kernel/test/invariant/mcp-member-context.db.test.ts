// SPDX-License-Identifier: AGPL-3.0-only
// The sealed context of a member-bound MCP grant and its fail-closed catalog, pinned before they exist (ADR-0051 decision 2, ADR-0049; design note on #2975, slice 3, step 3b).
// Every case holds now and keeps holding when the feature lands, so this file passes today and bites the moment the migration does:
// - the catalog `crove_kernel.mcp_member_table` (once it exists) is read-only data a migration fills: mode 'read' only, no login role can write it, every row names a table that
//   exists and carries a policy that reads `ctx_acting_user_id()`, and every policy that reads that helper is listed in this catalog or in `member_vy_table` (never in neither);
// - the entry `crove_kernel.enter_mcp_member_context(org, grant)` (once it exists) is executable by the API's login alone, pins its search path, and refuses an org and a grant that
//   are not a live member grant (nothing is entered for a made-up id);
// - until then no policy outside the Vy catalog reads the helper, which is what keeps every private table closed to anything but a user's own context.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the sealed context of a member-bound MCP grant and its catalog (#2975, slice 3, step 3b)', () => {
  const dbName = `crove_test_mcp_member_context_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const asLogin = async (login: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = login;
    url.password = password;
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    return c;
  };

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
  }, 120_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const POLICY_TEXT = `coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')`;

  it('reads the helper ctx_acting_user_id() only in policies of a listed table: the Vy catalog now, the Vy or the MCP catalog once there is one', async () => {
    await admin(async (c) => {
      const used = (
        await c.query(
          `SELECT DISTINCT format('%I.%I', n.nspname, r.relname) AS t
           FROM pg_policy p JOIN pg_class r ON r.oid = p.polrelid JOIN pg_namespace n ON n.oid = r.relnamespace
           WHERE ${POLICY_TEXT} ~* 'ctx_acting_user_id'`,
        )
      ).rows.map((r: { t: string }) => r.t);
      const vy = (await c.query(`SELECT table_name FROM crove_kernel.member_vy_table`)).rows.map((r: { table_name: string }) => r.table_name);
      const mcpExists = (await c.query(`SELECT to_regclass('crove_kernel.mcp_member_table') IS NOT NULL AS ok`)).rows[0].ok as boolean;
      const mcp = mcpExists ? (await c.query(`SELECT table_name FROM crove_kernel.mcp_member_table`)).rows.map((r: { table_name: string }) => r.table_name) : [];
      expect(used.filter((t: string) => !vy.includes(t) && !mcp.includes(t)), 'a table that reads the helper and is in no catalog').toEqual([]);
      // No catalog row without a policy that uses the helper: a listed table is one that really opted in.
      expect(mcp.filter((t: string) => !used.includes(t)), 'an MCP catalog row with no policy that reads the helper').toEqual([]);
    });
  });

  it('holds the MCP catalog, once it exists, as read-only data: mode read, a real table, written by no login role', async () => {
    await admin(async (c) => {
      if (!(await c.query(`SELECT to_regclass('crove_kernel.mcp_member_table') IS NOT NULL AS ok`)).rows[0].ok) return;
      const rows = (await c.query(`SELECT table_name, mode FROM crove_kernel.mcp_member_table`)).rows as Array<{ table_name: string; mode: string }>;
      for (const r of rows) {
        expect(r.mode, r.table_name).toBe('read');
        expect((await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [r.table_name])).rows[0].ok, r.table_name).toBe(true);
      }
      const logins = (await c.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'crove\\_%' AND NOT rolsuper`)).rows as Array<{ rolname: string }>;
      for (const { rolname } of logins) {
        for (const right of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          const ok = (await c.query(`SELECT has_table_privilege($1, 'crove_kernel.mcp_member_table', $2) AS ok`, [rolname, right])).rows[0].ok as boolean;
          expect(ok, `${rolname} ${right} on mcp_member_table`).toBe(false);
        }
      }
    });
  });

  it('gives the entry of the member context, once it exists, to the API login alone, with a pinned search path, and refuses an id that is not a live member grant', async () => {
    const exists = await admin((c) => c.query(`SELECT to_regprocedure('crove_kernel.enter_mcp_member_context(uuid, uuid)') IS NOT NULL AS ok`).then((r) => r.rows[0].ok as boolean));
    if (!exists) return;
    await admin(async (c) => {
      const logins = (await c.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'crove\\_%' AND NOT rolsuper`)).rows as Array<{ rolname: string }>;
      for (const { rolname } of logins) {
        const ok = (await c.query(`SELECT has_function_privilege($1, 'crove_kernel.enter_mcp_member_context(uuid, uuid)', 'EXECUTE') AS ok`, [rolname])).rows[0].ok as boolean;
        expect(ok, `${rolname} execute enter_mcp_member_context`).toBe(rolname === 'crove_app');
      }
      expect((await c.query(`SELECT has_function_privilege('public', 'crove_kernel.enter_mcp_member_context(uuid, uuid)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
      const cfg = (await c.query(`SELECT proconfig FROM pg_proc WHERE oid = 'crove_kernel.enter_mcp_member_context(uuid, uuid)'::regprocedure`)).rows[0].proconfig as string[] | null;
      expect(JSON.stringify(cfg)).toContain('search_path=pg_catalog, pg_temp');
    });
    const app = await asLogin('crove_app', 'test-app-pw');
    try {
      await app.query('BEGIN');
      await expect(app.query(`SELECT crove_kernel.enter_mcp_member_context($1::uuid, $2::uuid)`, [randomUUID(), randomUUID()])).rejects.toThrow();
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });
});
