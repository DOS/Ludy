// SPDX-License-Identifier: AGPL-3.0-only
// The one write path to an entity's books regime (#1403, slice B1) on PostgreSQL 17: crove_finance.legal_entity_books is closed to every runtime role, and the only way to add or remove a row is the pair of SECURITY DEFINER
// functions set_books_regime and cancel_books_regime. They keep the owner of lock_period and unlock_period (not crove_definer_tenant, whose other functions would gain books writes), pin their search_path, and are
// executable by the tenant role alone. An owner is the only role that may choose (an owner or an admin may take a choice back); a member, a viewer, an actor that is not a person and a call with no org context are refused
// before anything is read.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the books regime has one write path, and only an owner opens it (#1403 slice B1)', () => {
  const dbName = `crove_test_books_write_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  const who = { owner: '', admin: '', member: '', viewer: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs fn as a login role after entering a context when one is given; always rolled back.
  async function inContext<T>(url: string, enter: ((c: pg.Client) => Promise<unknown>) | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: url }, dbIds);
    await c.connect();
    try {
      await c.query('BEGIN');
      if (enter) await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const asMember = <T>(userId: string, fn: (c: pg.Client) => Promise<T>) =>
    inContext(appUrl, (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]), fn);
  const asSystem = <T>(fn: (c: pg.Client) => Promise<T>) => inContext(workerUrl, (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]), fn);
  // The SQLSTATE and message of a refusal, or 'ok'.
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (error: { code?: string; message?: string }) => `${error.code ?? '?'} ${error.message ?? ''}`.trim(),
    );
  const set = (c: pg.Client) => c.query(`SELECT crove_finance.set_books_regime(NULL, '2040-01-01'::date)`);
  const cancel = (c: pg.Client) => c.query(`SELECT crove_finance.cancel_books_regime(NULL, '2040-01-01'::date)`);

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(username) : username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const pool = createDbPool({ connectionString: appUrl, max: 4 }, dbIds);
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(who) as Array<keyof typeof who>) {
      who[key] = await upsertIdentity(db, { issuer: 'books-write-path', subject: key, email: `${key}@books-write-path.test`, name: null });
    }
    ({ orgId } = await createOrg(runtime, asUser(who.owner), 'Công ty một đường ghi'));
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, who.admin, who.member, who.viewer]),
    );
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps the owner of lock_period and unlock_period, pins the search_path, and grants EXECUTE to the tenant role alone', async () => {
    const rows = await admin(async (c) =>
      (
        await c.query<{ name: string; definer: boolean; owner: string; config: string[] | null }>(
          `SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'crove_finance' AND p.proname IN ('set_books_regime', 'cancel_books_regime', 'unlock_period')
           ORDER BY p.proname, p.pronargs`,
        )
      ).rows,
    );
    const books = rows.filter((r) => r.name !== 'unlock_period');
    expect(books.map((r) => r.name)).toEqual(['cancel_books_regime', 'set_books_regime']);
    const lockOwner = rows.find((r) => r.name === 'unlock_period')?.owner;
    expect(lockOwner).toBeTruthy();
    for (const fn of books) {
      expect(fn.definer, fn.name).toBe(true);
      expect(fn.owner, fn.name).toBe(lockOwner);
      expect(fn.owner, fn.name).not.toMatch(/definer_tenant|_app$|_worker$|_tenant$/);
      expect(fn.config, fn.name).toEqual(['search_path=pg_catalog, pg_temp']);
    }
    // The grants on the function itself (its ACL), not has_function_privilege: crove_definer_tenant is a member of crove_tenant
    // (20261014090000), so it reaches every tenant grant by inheritance, as for lock_period and unlock_period.
    for (const signature of ['crove_finance.set_books_regime(uuid,date)', 'crove_finance.cancel_books_regime(uuid,date)']) {
      const grantees = await admin(async (c) =>
        (
          await c.query<{ grantee: string; privilege: string }>(
            `SELECT CASE WHEN a.grantee = 0 THEN 'public' ELSE pg_get_userbyid(a.grantee) END AS grantee, a.privilege_type AS privilege
             FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
             WHERE p.oid = $1::regprocedure AND a.grantee <> p.proowner
             ORDER BY 1, 2`,
            [signature],
          )
        ).rows,
      );
      expect(grantees.map((g) => [g.grantee, g.privilege]), signature).toEqual([['crove_tenant', 'EXECUTE']]);
    }
  });

  it('keeps the pending-proposal helper of the two functions out of every role\'s reach', async () => {
    const grants = await admin(async (c) =>
      (
        await c.query<{ role: string; can: boolean }>(
          `SELECT r.role, has_function_privilege(r.role, 'crove_finance.books_pending_proposals(uuid,uuid,date)', 'EXECUTE') AS can
           FROM (VALUES ('crove_app'), ('crove_worker'), ('crove_tenant'), ('crove_definer_tenant'), ('public')) AS r(role)`,
        )
      ).rows,
    );
    expect(grants.filter((g) => g.can).map((g) => g.role)).toEqual([]);
  });

  it('lets no runtime role insert, update or delete a books row, crove_definer_tenant included', async () => {
    const privileges = await admin(async (c) =>
      (
        await c.query<{ role: string; privilege: string; can: boolean }>(
          `SELECT r.role, p.privilege, has_table_privilege(r.role, 'crove_finance.legal_entity_books', p.privilege) AS can
           FROM (VALUES ('crove_app'), ('crove_worker'), ('crove_tenant'), ('crove_definer_tenant'), ('public')) AS r(role)
           CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) AS p(privilege)`,
        )
      ).rows,
    );
    expect(privileges.filter((p) => p.can).map((p) => `${p.role} ${p.privilege}`)).toEqual([]);
  });

  it('refuses a member, a viewer, an admin choosing, an actor that is not a person, and a call with no org context, before anything is read', async () => {
    const forbidden = /^42501 PERIOD_LOCK_FORBIDDEN$/;
    expect(await asMember(who.member, (c) => outcome(set(c)))).toMatch(forbidden);
    expect(await asMember(who.viewer, (c) => outcome(set(c)))).toMatch(forbidden);
    expect(await asMember(who.admin, (c) => outcome(set(c)))).toMatch(forbidden);
    expect(await asMember(who.member, (c) => outcome(cancel(c)))).toMatch(forbidden);
    expect(await asMember(who.viewer, (c) => outcome(cancel(c)))).toMatch(forbidden);
    // The system context of the worker is not a person, and a login with no context has no org: refused with 42501 either by the privilege check or by the function's own (PERIOD_LOCK_FORBIDDEN, NO_CONTEXT).
    const refused = /^42501 /;
    expect(await asSystem((c) => outcome(set(c)))).toMatch(refused);
    expect(await asSystem((c) => outcome(cancel(c)))).toMatch(refused);
    expect(await inContext(appUrl, null, (c) => outcome(set(c)))).toMatch(refused);
    expect(await inContext(appUrl, null, (c) => outcome(cancel(c)))).toMatch(refused);
  });

  it('lets an owner choose and an owner or an admin take back, each as far as the next rule: nothing was written by the refusals above', async () => {
    // An admin passes the role check of cancel and meets the next rule: there is nothing to take back.
    expect(await asMember(who.admin, (c) => outcome(cancel(c)))).toBe('P0001 BOOKS_NOT_FOUND');
    // An owner passes the role check of set and writes (rolled back here).
    expect(await asMember(who.owner, (c) => outcome(set(c)))).toBe('ok');
    expect((await admin(async (c) => (await c.query('SELECT 1 FROM crove_finance.legal_entity_books WHERE org_id = $1', [orgId])).rowCount)) ?? 0).toBe(0);
  });
});
