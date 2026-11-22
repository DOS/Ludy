// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): the two definers that let the edge apply AUTH_ALLOWED_EMAILS to a Ludy extension token and an MCP grant (issue #3223,
// ADR-0028 section 1): crove_kernel.extension_token_account_email(bytea) and crove_kernel.mcp_grant_account_email(uuid). They return one text, the email of
// the account that owns the token or gave the grant, or NULL for an unknown hash or id; they are STABLE (so they can write nothing, and the edge asks them
// before the verify definers that stamp last_used_at), pin search_path, are owned with the identity table, and only the API login role may call them
// (PUBLIC, the worker, the tenant roles and every other login role get nothing). Keep this directory self-contained: import package code under test,
// never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FUNCTIONS = ['crove_kernel.extension_token_account_email(bytea)', 'crove_kernel.mcp_grant_account_email(uuid)'];
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];

const suite = ADMIN ? describe : describe.skip;

suite('token and grant account email definer invariants on PostgreSQL', () => {
  const dbName = `crove_test_tokemail_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  const email = 'token-owner@example.com';
  let userId = '';
  let orgId = '';
  const tokenHash = createHash('sha256').update(`crx_${randomBytes(32).toString('base64url')}`).digest();
  const grantId = randomUUID();

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: url }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const withAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(adminUrl, fn);

  // As the API calls it: crove_app, in a READ ONLY transaction, so a function that wrote anything would fail here.
  const readOnly = <T>(fn: (c: pg.Client) => Promise<T>) =>
    withClient(appUrl, async (c) => {
      await c.query('BEGIN READ ONLY');
      try {
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  const tokenEmail = (hash: Buffer | null) =>
    readOnly(async (c) => (await c.query<{ email: string | null }>('SELECT crove_kernel.extension_token_account_email($1::bytea) AS email', [hash])).rows[0]?.email ?? null);
  const grantEmail = (id: string | null) =>
    readOnly(async (c) => (await c.query<{ email: string | null }>('SELECT crove_kernel.mcp_grant_account_email($1::uuid) AS email', [id])).rows[0]?.email ?? null);

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
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(username) : username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    pool = createDbPool({ connectionString: appUrl, max: 2 }, dbIds);
    db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'token-owner', email, name: 'Token Owner' });
    orgId = (await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Token Email Org')).orgId;
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.extension_token (org_id, user_id, token_hash, device_name, scopes, expires_at, created_by)
         VALUES ($1, $2, $3, 'Chrome', ARRAY['meetings'], now() + interval '30 days', $2)`,
        [orgId, userId, tokenHash],
      );
      await c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, expires_at, created_by)
         VALUES ($1, $2, $3, 'client-1', 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now() + interval '30 days', $3)`,
        [orgId, grantId, userId, `oauth-${grantId}`],
      );
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers the owner\'s email for a known token hash and grant id, and NULL for anything else, in a READ ONLY transaction', async () => {
    expect(await tokenEmail(tokenHash)).toBe(email);
    expect(await grantEmail(grantId)).toBe(email);
    expect(await tokenEmail(randomBytes(32))).toBeNull();
    expect(await tokenEmail(randomBytes(31))).toBeNull();
    expect(await tokenEmail(null)).toBeNull();
    expect(await grantEmail(randomUUID())).toBeNull();
    expect(await grantEmail(null)).toBeNull();
  });

  it('looks at no standing: a revoked token and a revoked grant still answer, so only the verify definers decide whether a credential is in good standing', async () => {
    await withAdmin(async (c) => {
      await c.query('UPDATE crove_kernel.extension_token SET revoked_at = now() WHERE token_hash = $1', [tokenHash]);
      await c.query('UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE id = $1', [grantId]);
    });
    expect(await tokenEmail(tokenHash)).toBe(email);
    expect(await grantEmail(grantId)).toBe(email);
    // And the verify definers still refuse them: the list can only ever refuse more.
    const verified = await withAdmin(async (c) => (await c.query('SELECT * FROM crove_kernel.verify_extension_token($1::bytea, NULL::text)', [tokenHash])).rowCount);
    expect(verified).toBe(0);
    const grantVerified = await withAdmin(async (c) => (await c.query('SELECT * FROM crove_kernel.mcp_grant_verify($1::uuid, $2::text)', [grantId, 'client-1'])).rowCount);
    expect(grantVerified).toBe(0);
  });

  it('lets only the API login role call them, as pinned STABLE definers returning text, owned with the identity table (EXECUTE matrix)', async () => {
    const { matrix, shape } = await withAdmin(async (c) => {
      const matrix: Record<string, string[]> = {};
      const shape: Record<string, unknown[]> = {};
      for (const fn of FUNCTIONS) {
        matrix[fn] = (
          await c.query<{ role: string }>(`SELECT r AS role FROM unnest($1::text[]) r WHERE has_function_privilege(r, $2::regprocedure, 'EXECUTE') ORDER BY 1`, [ROLES, fn])
        ).rows.map((r) => r.role);
        shape[fn] = (
          await c.query(
            `SELECT p.prosecdef AS definer, p.proconfig AS config, p.provolatile::text AS volatility, pg_get_function_result(p.oid) AS result,
                    EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public,
                    p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'crove_kernel.user_account'::regclass) AS owns_table
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
            [fn],
          )
        ).rows;
      }
      return { matrix, shape };
    });
    for (const fn of FUNCTIONS) {
      expect(matrix[fn], fn).toEqual(['crove_app']);
      expect(shape[fn], fn).toEqual([{ definer: true, config: ['search_path=pg_catalog, pg_temp'], volatility: 's', result: 'text', public: false, owns_table: true }]);
    }
    await expect(withClient(workerUrl, (c) => c.query('SELECT crove_kernel.extension_token_account_email($1::bytea)', [tokenHash]))).rejects.toThrow(/permission denied for function/);
    await expect(withClient(workerUrl, (c) => c.query('SELECT crove_kernel.mcp_grant_account_email($1::uuid)', [grantId]))).rejects.toThrow(/permission denied for function/);
  });
});
