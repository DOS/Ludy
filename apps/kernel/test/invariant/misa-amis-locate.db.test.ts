// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): the orgless function the MISA AMIS callback finds an organisation with (#3903, S4 of #3854). The route is public and the HMAC key is one per deployment, so a good signature proves
// only that MISA sent the message: the organisation comes from our own stored push row through crove_finance.misa_amis_push_locate, which therefore must stay read-only, granted to the API login alone, pinned to
// pg_catalog and pg_temp, and answer nothing but the seven columns the route needs (no name, amount, reason, digest, parameter or source id). Pinned here so main's copy guards a later restatement of it.
// Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@crove/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const FN = 'crove_finance.misa_amis_push_locate(uuid[])';

suite('the MISA AMIS callback locate function (#3903)', () => {
  const dbName = `crove_test_misa_locate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
  }, 120_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  async function one<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T | undefined> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return (await client.query<T>(text, values)).rows[0];
    } finally {
      await client.end();
    }
  }

  it('is a stable SECURITY DEFINER pinned to pg_catalog and pg_temp, with no grant to PUBLIC', async () => {
    const fn = await one<{ secdef: boolean; config: string[] | null; acl: string | null; volatility: string }>(
      'SELECT prosecdef AS secdef, proconfig AS config, proacl::text AS acl, provolatile AS volatility FROM pg_proc WHERE oid = $1::regprocedure',
      [FN],
    );
    expect(fn?.secdef).toBe(true);
    expect(fn?.config).toEqual(['search_path=pg_catalog, pg_temp']);
    expect(fn?.volatility).toBe('s');
    expect(fn?.acl ?? '').not.toMatch(/(^|[{,])=X\//);
  });

  it('is executable by the API login alone', async () => {
    for (const [role, allowed] of [['crove_app', true], ['crove_worker', false], ['crove_tenant', false], ['crove_definer_tenant', false], ['crove_auth_reader', false]] as const) {
      const row = await one<{ ok: boolean }>('SELECT has_function_privilege($1, $2::regprocedure, \'EXECUTE\') AS ok', [role, FN]);
      expect(row?.ok, role).toBe(allowed);
    }
  });

  it('answers nothing but the organisation, the connection, the state, the attempt, the voucher type and the connection code of a refid', async () => {
    const row = await one<{ result: string }>('SELECT pg_get_function_result($1::regprocedure) AS result', [FN]);
    expect(row?.result).toBe('TABLE(org_refid uuid, org_id uuid, connection_id uuid, state text, attempts integer, voucher_type integer, org_company_code text)');
  });

  it('writes nothing: its body holds no INSERT, UPDATE, DELETE or other write', async () => {
    const row = await one<{ src: string }>('SELECT prosrc AS src FROM pg_proc WHERE oid = $1::regprocedure', [FN]);
    expect(row?.src).not.toMatch(/\b(insert|update|delete|truncate|merge|alter|drop|create)\b/i);
  });
});
