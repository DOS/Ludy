// SPDX-License-Identifier: AGPL-3.0-only
// The reseal pass for subject keys (#2643, ADR-0017 section 7) keeps its security properties on a real PostgreSQL 17: its three definers execute for the worker login alone (SECURITY
// DEFINER, search_path = pg_catalog, pg_temp, nothing for PUBLIC or any other role), no login role holds a privilege on crove_kernel.subject_key itself, the write is the system's in the
// system context of one org (a user, the API login and a call outside a context are refused), and it is a compare and swap on the key id and the bytes the worker read, in that org only,
// so a stale read, another org's id or a key already resealed changes nothing and a write under the key a row already has is refused.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, defineCommand, parseVaultKey, type CommandDef } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const PLACE = 'crove_hr.payroll_employee.national_id_sealed';
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
const DEFINERS = ['subject_key_reseal_due(text,text[],integer,uuid,uuid)', 'subject_key_key_counts()', 'subject_key_reseal(uuid,text,bytea,text,bytea)'];

suite('the reseal pass for subject keys keeps its guards on PostgreSQL (#2643)', () => {
  const dbName = `crove_test_reseal_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let appRt: Runtime;
  let workerRt: Runtime;
  const rootOld = parseVaultKey(randomBytes(32).toString('base64'));
  const rootNew = parseVaultKey(randomBytes(32).toString('base64'));
  const vaultOf = (...roots: (typeof rootOld)[]) => new SubjectVault(new CredentialVault(roots).deriveKeys(SUBJECT_WRAP_INFO));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'kernel.subject_key.reseal' };

  const SEAL = defineCommand({
    name: 't2643i.seal',
    input: z.object({ ref: z.string(), value: z.string() }),
    risk: 'R1',
    sideEffect: 'none',
    access: ['owner'],
    writes: [],
    handler: async (ctx, input) => ({ sealed: await ctx.seal(input.ref, PLACE, input.value) }),
  }) as CommandDef<unknown, unknown>;

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org() {
    const person = await upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@reseal.test`, name: null });
    const { orgId } = await createOrg(appRt, asUser(person), `Reseal ${randomUUID().slice(0, 6)}`);
    const ref = `employee:${randomUUID()}`;
    await appRt.execute('t2643i.seal', { ref, value: 'a plain phrase' }, { actor: asUser(person), orgId, idempotencyKey: randomUUID() });
    const row = await withAdmin(async (c) => (await c.query<{ id: string; key_id: string; wrapped_key: Buffer }>('SELECT id, key_id, wrapped_key FROM crove_kernel.subject_key WHERE org_id = $1 AND ref = $2', [orgId, ref])).rows[0]);
    if (!row) throw new Error('no subject key');
    const rowNow = async () => (await withAdmin((c) => c.query<{ key_id: string; wrapped_key: Buffer }>('SELECT key_id, wrapped_key FROM crove_kernel.subject_key WHERE org_id = $1 AND id = $2', [orgId, row.id]))).rows[0];
    const next = vaultOf(rootNew, rootOld).rewrap(orgId, row.id, row.key_id, row.wrapped_key);
    const item = { id: row.id, fromKeyId: row.key_id, fromWrapped: row.wrapped_key.toString('base64'), keyId: next.keyId, wrapped: next.wrapped.toString('base64') };
    return { orgId, person, row, rowNow, item };
  }

  const run = (orgId: string, items: unknown[]) => workerRt.execute<{ resealed: number; skipped: number }>('kernel.subject_key.reseal', { items }, { actor: system, orgId });

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 3 });
    appRt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, subjectVault: vaultOf(rootOld) }).register({ commands: [...kernelCommands, SEAL], queries: kernelQueries({ inboundDomain: null }) });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('executes the three definers for the worker login alone, as SECURITY DEFINER with a pinned search_path, and gives no login role the table', async () => {
    const rows = await withAdmin(async (c) =>
      (
        await c.query<{ sig: string; secdef: boolean; config: string[] | null; public_execute: boolean; roles: string[] }>(
          `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS secdef, p.proconfig AS config,
                  COALESCE(bool_or(a.grantee = 0), false) AS public_execute,
                  ARRAY(SELECT r FROM unnest($2::text[]) AS r WHERE has_function_privilege(r, p.oid, 'EXECUTE') ORDER BY r) AS roles
             FROM pg_proc p LEFT JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a ON true
            WHERE p.pronamespace = 'crove_kernel'::regnamespace AND p.proname = ANY($1::text[])
            GROUP BY p.oid ORDER BY 1`,
          [DEFINERS.map((d) => d.slice(0, d.indexOf('('))), ROLES],
        )
      ).rows,
    );
    expect(rows.map((r) => r.sig.replace('crove_kernel.', '')).sort()).toEqual([...DEFINERS].sort());
    for (const row of rows) {
      expect(row.secdef).toBe(true);
      expect(row.config).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(row.public_execute).toBe(false);
      expect(row.roles).toEqual(['crove_worker']);
    }
    const table = await withAdmin(async (c) =>
      (await c.query<{ role: string; priv: string }>(
        `SELECT r AS role, p AS priv FROM unnest($1::text[]) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p WHERE has_table_privilege(r, 'crove_kernel.subject_key', p)`,
        [ROLES],
      )).rows,
    );
    expect(table).toEqual([]);
  });

  it('refuses the write to the API login, to a call outside a context, and to a user running the command', async () => {
    const o = await org();
    const args = [o.row.id, o.row.key_id, o.row.wrapped_key, o.item.keyId, Buffer.from(o.item.wrapped, 'base64')];
    await expect(pool.query('SELECT crove_kernel.subject_key_reseal($1::uuid, $2, $3, $4, $5)', args)).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT crove_kernel.subject_key_reseal($1::uuid, $2, $3, $4, $5)', args)).rejects.toMatchObject({ message: 'SUBJECT_KEY_SYSTEM_CONTEXT' });
    await expect(appRt.execute('kernel.subject_key.reseal', { items: [o.item] }, { actor: asUser(o.person), orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toThrow();
    expect((await o.rowNow())?.key_id).toBe(o.row.key_id);
  });

  it('is a compare and swap in the org of the context: a stale key id or bytes, another org, or a write under the same key changes nothing, the right one changes the row once', async () => {
    const o = await org();
    const other = await org();
    // Another org's system context with this org's subject id: no row of that org matches.
    expect(await run(other.orgId, [o.item])).toEqual({ resealed: 0, skipped: 1 });
    // Bytes or key id other than the stored ones (a stale read): nothing changes.
    expect(await run(o.orgId, [{ ...o.item, fromWrapped: Buffer.alloc(60, 1).toString('base64') }])).toEqual({ resealed: 0, skipped: 1 });
    expect(await run(o.orgId, [{ ...o.item, fromKeyId: 'k1-ffffffffffffffff' }])).toEqual({ resealed: 0, skipped: 1 });
    expect((await o.rowNow())?.key_id).toBe(o.row.key_id);
    expect((await o.rowNow())?.wrapped_key.equals(o.row.wrapped_key)).toBe(true);
    // A write under the key the row already has is refused by the definer, whatever the bytes.
    await expect(run(o.orgId, [{ ...o.item, keyId: o.row.key_id }])).rejects.toThrow();
    expect((await o.rowNow())?.key_id).toBe(o.row.key_id);
    // The right read changes the row, once.
    expect(await run(o.orgId, [o.item])).toEqual({ resealed: 1, skipped: 0 });
    expect((await o.rowNow())?.key_id).toBe(o.item.keyId);
    expect((await o.rowNow())?.wrapped_key.toString('base64')).toBe(o.item.wrapped);
    expect(await run(o.orgId, [o.item])).toEqual({ resealed: 0, skipped: 1 });
    // The other org's row was never touched.
    expect((await other.rowNow())?.key_id).toBe(other.row.key_id);
  });
});
