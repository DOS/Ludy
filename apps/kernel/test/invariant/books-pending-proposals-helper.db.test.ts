// SPDX-License-Identifier: AGPL-3.0-only
// The pending-proposal helper of the books regime functions (#1403 slice B1, #5320) on PostgreSQL 17: ludy_finance.books_pending_proposals is called by the two SECURITY DEFINER functions that write the books regime,
// so it must run as its caller (never be a definer of its own, which would be a second function with the owner's reach) and must pin its search_path, as every function of the schema does.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { createDbClient, resolveDbIdentifiers, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the books regime pending-proposal helper is no definer and pins its search_path (#5320)', () => {
  const dbName = `crove_test_books_helper_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  }, 300_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is one function, not SECURITY DEFINER, with the search_path pinned to pg_catalog and pg_temp', async () => {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      const rows = (
        await c.query<{ definer: boolean; config: string[] | null }>(
          `SELECT p.prosecdef AS definer, p.proconfig AS config
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'crove_finance' AND p.proname = 'books_pending_proposals'`,
        )
      ).rows;
      expect(rows).toEqual([{ definer: false, config: ['search_path=pg_catalog, pg_temp'] }]);
    } finally {
      await c.end();
    }
  });
});
