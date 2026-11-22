// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): the three orgless definers MISA AMIS's callback travels through (#3903, S4 of #3854). The route is public and the HMAC key is one per deployment, so a good signature proves only that MISA sent
// the message: the API login hands the signed results to a machinery table through misa_amis_callback_enqueue (it may run nothing else, reads no tenant row and cannot enter a system context, gate T5), and the worker
// login alone takes them with misa_amis_callback_claim, which finds the organisation by org_refid in SQL, and marks them done. Pinned here so main's copy guards a later restatement: who may run each, that each is pinned
// to pg_catalog and pg_temp, that no login or tenant role touches the table (it holds MISA's capped text), the exact columns the claim answers, and the index the claim's lookup needs.
// Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { createDbClient, resolveDbIdentifiers, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ENQUEUE = 'crove_finance.misa_amis_callback_enqueue(text,uuid[],integer[],boolean[],text[],text[])';
const CLAIM = 'crove_finance.misa_amis_callback_claim(integer)';
const DONE = 'crove_finance.misa_amis_callback_done(bigint[])';
const TABLE = 'crove_finance.misa_amis_callback_pending';

suite('the MISA AMIS callback definers (#3903)', () => {
  const dbName = `crove_test_misa_callback_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;

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
  }, 120_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  async function one<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T | undefined> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return (await client.query<T>(text, values)).rows[0];
    } finally {
      await client.end();
    }
  }

  it('are SECURITY DEFINER pinned to pg_catalog and pg_temp, with no grant to PUBLIC', async () => {
    for (const fn of [ENQUEUE, CLAIM, DONE]) {
      const got = await one<{ secdef: boolean; config: string[] | null; acl: string | null }>('SELECT prosecdef AS secdef, proconfig AS config, proacl::text AS acl FROM pg_proc WHERE oid = $1::regprocedure', [fn]);
      expect(got?.secdef, fn).toBe(true);
      expect(got?.config, fn).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(got?.acl ?? '', fn).not.toMatch(/(^|[{,])=X\//);
    }
  });

  it('are executable as the design says: the API login runs the enqueue alone, the worker login the claim and done alone', async () => {
    const matrix: Array<[string, Record<string, boolean>]> = [
      [ENQUEUE, { crove_app: true, crove_worker: false, crove_tenant: false, crove_definer_tenant: false, crove_auth_reader: false }],
      [CLAIM, { crove_app: false, crove_worker: true, crove_tenant: false, crove_definer_tenant: false, crove_auth_reader: false }],
      [DONE, { crove_app: false, crove_worker: true, crove_tenant: false, crove_definer_tenant: false, crove_auth_reader: false }],
    ];
    for (const [fn, roles] of matrix) {
      for (const [role, allowed] of Object.entries(roles)) {
        const got = await one<{ ok: boolean }>("SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok", [role, fn]);
        expect(got?.ok, `${fn} ${role}`).toBe(allowed);
      }
    }
  });

  it('keeps the table to the definers: row level security on, and no login, tenant or definer role holds a privilege on it', async () => {
    const rls = await one<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE oid = $1::regclass", [TABLE]);
    expect(rls?.on).toBe(true);
    for (const role of ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const got = await one<{ ok: boolean }>('SELECT has_table_privilege($1, $2::regclass, $3) AS ok', [role, TABLE, privilege]);
        expect(got?.ok, `${role} ${privilege}`).toBe(false);
      }
    }
  });

  it('answers nothing from the claim but the result as it was waiting and the organisation, connection, state, attempt, voucher type and company code of the row that holds its refid', async () => {
    const got = await one<{ result: string }>('SELECT pg_get_function_result($1::regprocedure) AS result', [CLAIM]);
    expect(got?.result).toBe(
      'TABLE(seq bigint, org_refid uuid, voucher_type integer, org_company_code text, success boolean, error_code text, error_message text, m_org_id uuid, m_connection_id uuid, m_state text, m_attempts integer, m_voucher_type integer, m_org_company_code text)',
    );
  });

  it('does not write a tenant table or read one from the enqueue, and the claim writes only the machinery table', async () => {
    const enqueue = await one<{ src: string }>('SELECT prosrc AS src FROM pg_proc WHERE oid = $1::regprocedure', [ENQUEUE]);
    // The enqueue names the machinery table alone.
    expect(enqueue?.src).not.toMatch(/misa_amis_push|misa_amis_connection|crove_kernel\./);
    const claim = await one<{ src: string }>('SELECT prosrc AS src FROM pg_proc WHERE oid = $1::regprocedure', [CLAIM]);
    // The claim reads the push row, the connection and the tenant and checks the app switch; every write names the machinery table.
    expect(claim?.src).toMatch(/crove_kernel\.org_app_on\(x\.org_id, 'finance'\)/);
    // (`FOR UPDATE SKIP LOCKED` is a row lock, not a write: an UPDATE is a statement start, not preceded by FOR.)
    for (const write of claim?.src.matchAll(/(?<!\bfor\s)\b(?:insert\s+into|update|delete\s+from)\s+([a-z_.]+)/gi) ?? []) expect(write[1], write[0]).toBe('crove_finance.misa_amis_callback_pending');
  });

  it('has an index on the push table that leads with org_refid, so the claim does not scan every organisation (the unique key leads with org_id)', async () => {
    const got = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0] WHERE n.nspname = 'crove_finance' AND c.relname = 'misa_amis_push' AND a.attname = 'org_refid' AND i.indisvalid",
    );
    expect(got?.n).toBeGreaterThanOrEqual(1);
  });
});
