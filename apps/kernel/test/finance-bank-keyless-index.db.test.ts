// SPDX-License-Identifier: AGPL-3.0-only
// The index of the keyless conflict lookup (#2199, follow-up of #2191), on PostgreSQL 17: bank_line_keyless_ref_idx is a partial index on exactly what the lookup in modules/finance/src/bank.ts
// filters (org, legal entity, bank account, bank reference, for the keyless lines flagged ambiguous), and the planner chooses it for that lookup, so the lookup is bounded by the conflicts and not
// by the account's history. The lookup is the one `storedAround` runs; its keyless branch is written here as plain SQL.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the keyless bank line reference index', () => {
  const dbName = `ludy_test_bank_keyless_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

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
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is a partial btree index on the four columns of the lookup, for the keyless lines flagged ambiguous', async () => {
    const row = await admin(async (c) =>
      (
        await c.query<{ def: string; partial: boolean; unique: boolean; valid: boolean }>(
          `SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS def, i.indpred IS NOT NULL AS partial, i.indisunique AS "unique", i.indisvalid AS valid
           FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'ludy_finance' AND c.relname = 'bank_line_keyless_ref_idx'`,
        )
      ).rows[0],
    );
    expect(row).toBeDefined();
    expect(row?.valid).toBe(true);
    expect(row?.partial).toBe(true);
    expect(row?.unique).toBe(false);
    expect(row?.def).toContain('USING btree (org_id, legal_entity_id, bank_account, bank_ref)');
    expect(row?.def).toMatch(/WHERE .*dedupe_key IS NULL.*ambiguous/);
  });

  it('is the index the planner takes for the keyless branch of the conflict lookup', async () => {
    const plan = await admin(async (c) => {
      // The table is empty here, so the sequential scan is switched off: the question is which index fits the lookup, not what a tiny table costs.
      await c.query('SET enable_seqscan = off');
      const { rows } = await c.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT dedupe_key, bank_ref, value_date, amount FROM ludy_finance.bank_line
         WHERE org_id = '00000000-0000-7000-8000-000000000001' AND legal_entity_id = '00000000-0000-7000-8000-000000000002' AND bank_account = '1121'
           AND dedupe_key IS NULL AND ambiguous = true AND bank_ref IN ('REF-A', 'REF-B')`,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('bank_line_keyless_ref_idx');
  });
});
