// SPDX-License-Identifier: AGPL-3.0-only
// The income-method PIT rate table of a household business (#5285, #5292) and the tenant role on a real PostgreSQL 17: `household_income_rate` holds the law (the rate by band of the year's revenue), so it is
// read-only to every tenant login and edited only by a migration; no request can change a rate. The same checks household-law-grants.db.test.ts makes for the other household law tables, in a file of its own
// so that adding a table never edits a base invariant file. Each statement is a valid one on a column the table has, so a refusal can only be the privilege check (42501), never a typo.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { createDbClient, resolveDbIdentifiers, setActiveRolePasswords } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const TABLE = 'household_income_rate';
// A column the table really has, for the UPDATE.
const COLUMN = 'source';

suite('the household income rate table and the tenant role on PostgreSQL (#5285)', () => {
  const dbName = `crove_test_household_income_rate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let client: pg.Client;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    const adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    const dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const app = new URL(adminUrl);
    app.username = dbIds.roleName('crove_app');
    app.password = 'test-app-pw';
    client = createDbClient({ connectionString: app.toString() }, dbIds);
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // A positive control: the same login reads what it may, so the refusals below cannot pass only because the role lost every grant. The table is seeded by its migration.
  it('lets the tenant role read the seeded rates', async () => {
    const { rowCount } = await client.query(`SELECT 1 FROM crove_finance.${TABLE}`);
    expect(rowCount).toBeGreaterThan(0);
  });

  it('refuses the tenant role an UPDATE', async () => {
    await expect(client.query(`UPDATE crove_finance.${TABLE} SET ${COLUMN} = ${COLUMN}`)).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the tenant role a DELETE', async () => {
    await expect(client.query(`DELETE FROM crove_finance.${TABLE}`)).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the tenant role a TRUNCATE', async () => {
    await expect(client.query(`TRUNCATE crove_finance.${TABLE}`)).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the tenant role an INSERT', async () => {
    await expect(client.query(`INSERT INTO crove_finance.${TABLE} DEFAULT VALUES`)).rejects.toMatchObject({ code: '42501' });
  });
});
