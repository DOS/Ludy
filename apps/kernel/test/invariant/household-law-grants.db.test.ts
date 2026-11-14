// SPDX-License-Identifier: AGPL-3.0-only
// The household business kind's tables and the tenant role (#2517, ADR-0045) on a real PostgreSQL 17: the four tables that hold the law (thresholds, percentages by trade, the expense groups and
// the forms) are read-only to every tenant login, edited only by a migration, so no request can change a rate or a threshold; and a household profile is append-only, so a row a book was made
// under never changes in place and none is deleted. Each statement is a valid one on a column the table has, so a refusal can only be the privilege check (42501), never a typo.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Each table with a column it really has, for the UPDATE.
const TABLES: ReadonlyArray<readonly [table: string, column: string]> = [
  ['household_threshold', 'source'],
  ['household_trade_rate', 'source'],
  ['household_expense_group_map', 'source'],
  ['household_form_version', 'source'],
  ['household_profile', 'tax_group'],
];

suite('household law and profile grants on PostgreSQL (#2517)', () => {
  const dbName = `crove_test_household_grants_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    client = new pg.Client({ connectionString: app.toString() });
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

  it.each(TABLES)('refuses the tenant role an UPDATE of %s', async (table, column) => {
    await expect(client.query(`UPDATE crove_finance.${table} SET ${column} = ${column}`)).rejects.toMatchObject({ code: '42501' });
  });

  it.each(TABLES)('refuses the tenant role a DELETE from %s', async (table) => {
    await expect(client.query(`DELETE FROM crove_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
  });

  it.each(TABLES)('refuses the tenant role a TRUNCATE of %s', async (table) => {
    await expect(client.query(`TRUNCATE crove_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
  });

  // The profile is written by the command, so the tenant role may insert there (under RLS); the law is not.
  it.each(TABLES.filter(([table]) => table !== 'household_profile'))('refuses the tenant role an INSERT into %s', async (table) => {
    await expect(client.query(`INSERT INTO crove_finance.${table} DEFAULT VALUES`)).rejects.toMatchObject({ code: '42501' });
  });
});
