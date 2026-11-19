// SPDX-License-Identifier: AGPL-3.0-only
// Every account of the shipped marketplace posting maps exists in the chart of its books regime (#3711 slice 4), on PostgreSQL 17: the TT133 map in crove_finance.account (the TT133 2026.1 chart every org
// shares) and the TT99 map in crove_finance.chart_account (regime tt99, version 2026.1). A code that is not in its chart would be refused by the database when a posting names it
// (crove_finance.check_account_ref), at the day the accountant confirms the map; this pins it before then. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from '@ludy/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const ROWS = ['receivable', 'revenue', 'salesReturn', 'cash', 'feePayable', 'feeAwaitingInvoice', 'taxWithheld', 'vatPayable', 'pitPayable', 'pitOwnerEquity', 'feeExpense', 'accruedExpense'] as const;

suite('the marketplace posting maps against their charts on PostgreSQL (#3711)', () => {
  const dbName = `crove_test_mkt_map_chart_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const rows = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return (await client.query<T>(sql, params)).rows;
    } finally {
      await client.end();
    }
  };

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

  const codesOf = (map: MarketplacePostingMap) => ROWS.map((key) => [key, map[key].code] as const);

  it('has every account of the TT133 map in the TT133 chart', async () => {
    const chart = new Set((await rows<{ code: string }>('SELECT code FROM crove_finance.account')).map((r) => r.code));
    const map = MARKETPLACE_POSTING_MAPS.tt133 as MarketplacePostingMap;
    for (const [key, code] of codesOf(map)) expect(chart.has(code), `${key} ${code}`).toBe(true);
  });

  it('has every account of the TT99 map in the TT99 2026.1 chart, and the fee expense is 641 / 6417, not the staff cost 6421', async () => {
    const chart = new Map((await rows<{ code: string; name: string }>("SELECT code, name FROM crove_finance.chart_account WHERE regime = 'tt99' AND version = '2026.1'")).map((r) => [r.code, r.name]));
    const map = MARKETPLACE_POSTING_MAPS.tt99 as MarketplacePostingMap;
    for (const [key, code] of codesOf(map)) expect(chart.has(code), `${key} ${code}`).toBe(true);
    expect(map.feeExpense.code).toBe('6417');
    expect(chart.get('6417')).toBe('Chi phí dịch vụ mua ngoài');
    // 6421 is a different expense in this chart (staff cost): the map must not use it for platform fees.
    expect(chart.get('6421')).toBe('Chi phí nhân viên quản lý');
  });
});
