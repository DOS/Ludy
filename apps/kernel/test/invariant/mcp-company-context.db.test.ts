// SPDX-License-Identifier: AGPL-3.0-only
// The sealed context of a company MCP grant, pinned before it exists (ADR-0051 decision 2, design note on #2975, slice 3, step 3e-1). Every case holds now and keeps holding when the feature lands:
// - the entry `crove_kernel.enter_mcp_company_context(org, grant)` (once it exists) is executable by the API's login alone, pins its search path, and enters nothing for an org and a grant that
//   are not a live company grant (a made-up id, and any id of a member-bound grant, are refused);
// - the sealed kinds are the three known ones: a policy that reads a sealed key for a kind of its own (`mcp_company`) is not hidden among them (no function reads `'mcp_company'` but its entry).
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
const ENTRY = 'crove_kernel.enter_mcp_company_context(uuid, uuid)';

suite('the sealed context of a company MCP grant (#2975, slice 3, step 3e-1)', () => {
  const dbName = `crove_test_mcp_company_context_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  it('gives the entry of the company context, once it exists, to the API login alone, with a pinned search path, and refuses an id that is not a live company grant', async () => {
    const exists = await admin((c) => c.query(`SELECT to_regprocedure('${ENTRY}') IS NOT NULL AS ok`).then((r) => r.rows[0].ok as boolean));
    if (!exists) return;
    await admin(async (c) => {
      const logins = (await c.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'crove\\_%' AND NOT rolsuper`)).rows as Array<{ rolname: string }>;
      for (const { rolname } of logins) {
        const ok = (await c.query(`SELECT has_function_privilege($1, '${ENTRY}', 'EXECUTE') AS ok`, [rolname])).rows[0].ok as boolean;
        expect(ok, `${rolname} execute enter_mcp_company_context`).toBe(rolname === 'crove_app');
      }
      expect((await c.query(`SELECT has_function_privilege('public', '${ENTRY}', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
      const cfg = (await c.query(`SELECT proconfig FROM pg_proc WHERE oid = '${ENTRY}'::regprocedure`)).rows[0].proconfig as string[] | null;
      expect(JSON.stringify(cfg)).toContain('search_path=pg_catalog, pg_temp');
    });
    const app = await asLogin('crove_app', 'test-app-pw');
    try {
      await app.query('BEGIN');
      await expect(app.query(`SELECT crove_kernel.enter_mcp_company_context($1::uuid, $2::uuid)`, [randomUUID(), randomUUID()])).rejects.toThrow();
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  it('lets no function but the company entry write or read the `mcp_company` kind of the seal', async () => {
    const { rows } = await admin((c) =>
      c.query<{ n: string }>(
        `SELECT p.oid::regprocedure::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
         WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) ~ 'mcp_company'
         ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.n).filter((n) => n !== 'crove_kernel.enter_mcp_company_context(uuid,uuid)')).toEqual([]);
  });
});
