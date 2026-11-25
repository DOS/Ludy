// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): the product a MISA callback result carries (#4113, S4 of #4103). MISA AMIS and MISA ASP post to one address, each signing with its own ClientID, and a result signed under one
// product's key must never settle a voucher of the other product's connection. The route hands the results to the enqueue of the product whose key verified the message; both enqueues are thin definers over one
// private function, and the claim finds the stored push row only through a connection of the same product. Pinned here so main's copy guards a later restatement: the private function is not a definer, is pinned
// to pg_catalog and pg_temp, is granted to nobody (PUBLIC included) and writes only the machinery table; the ASP enqueue is a definer only the API login may run; each wrapper passes its own product; the machinery
// row carries the product (a replay is one row per product); and the claim joins the connection on the result's product. The three shapes pinned in misa-amis-callback-definers.db.test.ts stay as they are.
// Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { createDbClient, resolveDbIdentifiers, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const PRIVATE = 'crove_finance.misa_callback_enqueue_for(text,text,uuid[],integer[],boolean[],text[],text[])';
const AMIS_ENQUEUE = 'crove_finance.misa_amis_callback_enqueue(text,uuid[],integer[],boolean[],text[],text[])';
const ASP_ENQUEUE = 'crove_finance.misa_asp_callback_enqueue(text,uuid[],integer[],boolean[],text[],text[])';
const CLAIM = 'crove_finance.misa_amis_callback_claim(integer)';
const TABLE = 'crove_finance.misa_amis_callback_pending';
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];

suite('the MISA callback product (#4113)', () => {
  const dbName = `crove_test_misa_callback_product_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const proc = (fn: string) => one<{ secdef: boolean; config: string[] | null; acl: string | null; src: string }>('SELECT prosecdef AS secdef, proconfig AS config, proacl::text AS acl, prosrc AS src FROM pg_proc WHERE oid = $1::regprocedure', [fn]);
  const canExecute = async (role: string, fn: string) => (await one<{ ok: boolean }>("SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok", [role, fn]))?.ok;

  it('keeps the private enqueue out of every role\'s reach: not a definer, pinned to pg_catalog and pg_temp, an ACL written out with no grant to PUBLIC, and EXECUTE for no login, tenant or definer role', async () => {
    const got = await proc(PRIVATE);
    expect(got?.secdef).toBe(false);
    expect(got?.config).toEqual(['search_path=pg_catalog, pg_temp']);
    // The revoke is explicit: an ACL exists and holds no `=X/` entry (a default would leave PUBLIC able to run it).
    expect(got?.acl).not.toBeNull();
    expect(got?.acl ?? '').not.toMatch(/(^|[{,])=X\//);
    for (const role of ROLES) expect(await canExecute(role, PRIVATE), `${PRIVATE} ${role}`).toBe(false);
  });

  it('writes only the machinery table from the private enqueue, and reads no tenant table', async () => {
    const got = await proc(PRIVATE);
    expect(got?.src).not.toMatch(/misa_amis_push|misa_amis_connection|crove_kernel\./);
    const writes = [...(got?.src.matchAll(/(?<!\bfor\s)\b(?:insert\s+into|update|delete\s+from)\s+([a-z_.]+)/gi) ?? [])];
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write[1], write[0]).toBe('crove_finance.misa_amis_callback_pending');
  });

  it('makes the ASP enqueue a definer pinned to pg_catalog and pg_temp that only the API login runs, with no grant to PUBLIC', async () => {
    const got = await proc(ASP_ENQUEUE);
    expect(got?.secdef).toBe(true);
    expect(got?.config).toEqual(['search_path=pg_catalog, pg_temp']);
    expect(got?.acl ?? '').not.toMatch(/(^|[{,])=X\//);
    for (const role of ROLES) expect(await canExecute(role, ASP_ENQUEUE), `${ASP_ENQUEUE} ${role}`).toBe(role === 'crove_app');
  });

  it('has each enqueue pass its own product to the private function and name nothing else, so a restatement cannot tag a result with the other product', async () => {
    const amis = await proc(AMIS_ENQUEUE);
    const asp = await proc(ASP_ENQUEUE);
    expect(amis?.src).toMatch(/misa_callback_enqueue_for\(\s*'amis'\s*,/);
    expect(asp?.src).toMatch(/misa_callback_enqueue_for\(\s*'asp'\s*,/);
    for (const src of [amis?.src, asp?.src]) expect(src, 'a wrapper names no table').not.toMatch(/misa_amis_push|misa_amis_connection|misa_amis_callback_pending|crove_kernel\./);
  });

  it('carries the product on the machinery row, limited to the two products, and keeps a replay to one row per product', async () => {
    const col = await one<{ nullable: string; type: string }>("SELECT is_nullable AS nullable, data_type AS type FROM information_schema.columns WHERE table_schema = 'crove_finance' AND table_name = 'misa_amis_callback_pending' AND column_name = 'product'");
    expect(col).toEqual({ nullable: 'NO', type: 'text' });
    const checks = await one<{ defs: string }>("SELECT string_agg(pg_get_constraintdef(oid), ' | ') AS defs FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'", [TABLE]);
    expect(checks?.defs).toMatch(/product = ANY \(ARRAY\['amis'::text, 'asp'::text\]\)/);
    const unique = await one<{ def: string }>("SELECT string_agg(pg_get_constraintdef(oid), ' | ') AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'u'", [TABLE]);
    expect(unique?.def).toMatch(/UNIQUE \(org_refid, voucher_type, success, product\)/);
  });

  it('finds the stored push row in the claim only through a connection of the product that signed the result', async () => {
    const got = await proc(CLAIM);
    expect(got?.src).toMatch(/c\.product\s*=\s*t\.product/);
    // The pinned shape: the claim still answers exactly the columns it did before the product existed.
    const result = await one<{ result: string }>('SELECT pg_get_function_result($1::regprocedure) AS result', [CLAIM]);
    expect(result?.result).toBe(
      'TABLE(seq bigint, org_refid uuid, voucher_type integer, org_company_code text, success boolean, error_code text, error_message text, m_org_id uuid, m_connection_id uuid, m_state text, m_attempts integer, m_voucher_type integer, m_org_company_code text)',
    );
  });
});
