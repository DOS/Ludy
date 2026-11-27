// SPDX-License-Identifier: AGPL-3.0-only
// The income statement under the chart of the entity's books (#5187), on PostgreSQL 17: a TT99 entity's B02 reads 521 as a deduction, 641 as selling expense, 642 as administration and 8212 as deferred tax, so its profit
// is not overstated and nothing lands in `unmapped`; a TT133 entity keeps the map it had; a statement that mixes the two charts says so; the overview's profit equals B02's line 50 under both; and the HTKK file, which exists
// for TT133 only, is refused for a TT99 year. The map and the rules are unit-tested in modules/finance/test/tt99-reports.test.ts.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database (CI only: a run without it is skipped, not passed).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { FinanceOverview } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries, type FinancialStatements } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the income statement under the entity\'s chart (#5187)', () => {
  const dbName = `ludy_test_statements_tt99_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let kyselyPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let orgId = '';
  let owner = '';
  let main = '';
  let tt99 = '';
  let supplier = '';
  let customer = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  // A balanced entry of one entity through the posting function, in the owner's context.
  async function post(entity: string, date: string, lines: Array<[account: string, debit: string, credit: string, party?: string]>): Promise<void> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner, orgId)]);
      await c.query(`SELECT ludy_finance.post_journal_entry($1::date, 'Bút toán thử', 'test.statements', $2::uuid, $3::jsonb, NULL, 1, $4::uuid)`, [
        date,
        randomUUID(),
        JSON.stringify(lines.map(([account, debit, credit, party], i) => ({ line_no: i + 1, account_code: account, debit, credit, ...(party ? { party_id: party } : {}) }))),
        entity,
      ]);
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }

  const statements = (period: string, legalEntityId: string) => rt.query<FinancialStatements>('finance.statements.period', { period, legalEntityId }, { actor: asUser(owner), orgId });
  const overviewAt = (asOf: string, legalEntityId: string) => rt.query<FinanceOverview>('finance.overview', { range: 'this_month', asOf, legalEntityId }, { actor: asUser(owner), orgId });
  const line = (s: FinancialStatements, code: string) => s.b02.lines.find((l) => l.code === code)?.amount;
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; status?: number });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    appPool = new pg.Pool({ connectionString: login('ludy_app', 'test-app-pw'), max: 3 });
    kyselyPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 3 });
    db = createDb(kyselyPool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@statements-tt99.test`, name: null });
    ({ orgId } = await createOrg(rt, asUser(owner), 'Báo cáo TT99'));
    await admin(async (a) => {
      main = (await a.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      tt99 = (await a.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Công ty TT99', 'company', $2) RETURNING id`, [orgId, owner])).rows[0]?.id as string;
      // The TT99 company keeps its books under TT99 for all of 2026, set before it has any entry.
      // The HTKK file needs the org's tax code before it reads anything else.
      await a.query(`UPDATE ludy_kernel.tenant SET tax_code = '0101234564' WHERE org_id = $1`, [orgId]);
      supplier = String((await a.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, name, tax_code) VALUES ($1, 'Nhà cung cấp ứng trước', '0101234564') RETURNING id`, [orgId])).rows[0]?.id);
      customer = String((await a.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, name, tax_code) VALUES ($1, 'Khách trả trước', '0309876543') RETURNING id`, [orgId])).rows[0]?.id);
      await a.query(`INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', '2026-01-01')`, [orgId, tt99]);
    });

    // The TT99 company, 2026: Q2 sales 20,000,000 and selling expense (6417) 4,000,000; Q3 sales 50,000,000, a deduction (521) 5,000,000, 6417 12,000,000, administration (6421) 4,000,000 and financial income (515) 1,000,000;
    // Q4 current tax (8211) 3,000,000. In 2025 it kept TT133 books (no row before 2026): sales 10,000,000 on 5111 in Q3.
    await post(tt99, '2025-08-10', [['131', '10000000', '0'], ['5111', '0', '10000000']]);
    await post(tt99, '2026-05-10', [['131', '20000000', '0'], ['511', '0', '20000000']]);
    await post(tt99, '2026-05-12', [['6417', '4000000', '0'], ['331', '0', '4000000']]);
    await post(tt99, '2026-07-10', [['131', '50000000', '0'], ['511', '0', '50000000']]);
    await post(tt99, '2026-08-01', [['521', '5000000', '0'], ['131', '0', '5000000']]);
    await post(tt99, '2026-08-10', [['6417', '12000000', '0'], ['331', '0', '12000000']]);
    await post(tt99, '2026-08-11', [['6421', '4000000', '0'], ['331', '0', '4000000']]);
    await post(tt99, '2026-09-15', [['112', '1000000', '0'], ['515', '0', '1000000']]);
    await post(tt99, '2026-12-31', [['8211', '3000000', '0'], ['3334', '0', '3000000']]);
    // Q4, for the balance sheet (#5204): an advance of 7,000,000 to a supplier (331 debit, line 132), a prepayment of 9,000,000 from a customer (131 credit, line 312) and 2,000,000 moved from the bank to money in transit (113).
    await post(tt99, '2026-10-05', [['331', '7000000', '0', supplier], ['112', '0', '7000000']]);
    await post(tt99, '2026-10-06', [['112', '9000000', '0'], ['131', '0', '9000000', customer]]);
    await post(tt99, '2026-10-07', [['113', '2000000', '0'], ['112', '0', '2000000']]);
    // The TT133 company (no row): the same quarter's sales and an administration cost.
    await post(main, '2026-07-10', [['131', '50000000', '0'], ['5111', '0', '50000000']]);
    await post(main, '2026-08-11', [['6422', '4000000', '0'], ['331', '0', '4000000']]);
  });

  afterAll(async () => {
    await appPool?.end();
    await kyselyPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reads a TT99 entity under the TT99 map: the deduction, selling and administration expense, and nothing unmapped', async () => {
    const s = await statements('2026-Q3', tt99);
    expect(s.regime).toBe('tt99');
    // 01 50M, 02 5M (521), 10 45M, 22 1M (515), 25 12M (6417), 26 4M (6421): 30 = 45 + 1 - 12 - 4 = 30M, no tax in the quarter.
    expect(['01', '02', '10', '22', '25', '26', '30', '50', '51', '60'].map((code) => line(s, code))).toEqual(['50000000', '5000000', '45000000', '1000000', '12000000', '4000000', '30000000', '30000000', '0', '30000000']);
    expect(s.b02.unmapped).toEqual([]);
    // The previous quarter is read under the same map: sales 20M less selling expense 4M.
    expect(s.comparison.previous?.amounts).toMatchObject({ '01': '20000000', '25': '4000000', '50': '16000000' });
  });

  it('keeps current and deferred tax apart on lines 51 and 52 and reads the whole year', async () => {
    const s = await statements('2026', tt99);
    // 01 70M, 02 5M, 10 65M, 22 1M, 25 16M, 26 4M: 30 = 65 + 1 - 16 - 4 = 46M; 51 3M (8211); 60 = 43M.
    expect(['10', '30', '51', '52', '60'].map((code) => line(s, code))).toEqual(['65000000', '46000000', '3000000', '0', '43000000']);
    expect(s.b02.unmapped).toEqual([]);
  });

  it('says so when a comparison column was booked under the other chart, and still reads it with the period end\'s map', async () => {
    const s = await statements('2026-Q3', tt99);
    expect(s.mixedCharts).toBe(true);
    // Q3 of 2025 was TT133 books (5111): the column reads it with the TT99 map, as the note says.
    expect(s.comparison.lastYear?.amounts).toMatchObject({ '01': '10000000' });
    // Every period of 2026 compares with 2025, so each is flagged; an entity with no books row never is.
    expect((await statements('2026-08', tt99)).mixedCharts).toBe(true);
    expect(await statements('2026-Q3', main)).toMatchObject({ regime: 'tt133', mixedCharts: false });
  });

  it('keeps a TT133 entity on the map it had', async () => {
    const s = await statements('2026-Q3', main);
    expect(s.regime).toBe('tt133');
    // 10 = 50M, 24 = 4M (6422), 21 = financial revenue (0 here): profit before tax 46M.
    expect(['10', '21', '24', '50'].map((code) => line(s, code))).toEqual(['50000000', '0', '4000000', '46000000']);
    expect(s.b02.unmapped).toEqual([]);
  });

  it('gives the overview the profit of line 50 under both charts', async () => {
    // August of the TT99 entity: 521 5M against no sales (10 = -5M), 6417 12M and 6421 4M: 50 = -21M.
    const august = await statements('2026-08', tt99);
    expect(line(august, '50')).toBe('-21000000');
    expect((await overviewAt('2026-08-31', tt99)).profit.amount).toBe('-21000000');
    expect((await overviewAt('2026-08-31', tt99)).unmapped).toBe(0);
    const augustMain = await statements('2026-08', main);
    expect((await overviewAt('2026-08-31', main)).profit.amount).toBe(line(augustMain, '50'));
  });

  it('reads the TT99 balance sheet and balances (280 = 440) with a supplier advance and a customer prepayment', async () => {
    const s = await statements('2026', tt99);
    const b01 = (code: string) => s.b01.lines.find((l) => l.code === code)?.amount;
    // 131 without a party 10 + 20 + 50 - 5 = 75M; the prepayment is C's own credit on 131 (line 312, 9M), the advance S's own debit on 331 (line 132, 7M); 331 without a party 4 + 12 + 4 = 20M credit (311).
    // Cash: 112 1 - 7 + 9 - 2 = 1M and 113 2M: 111 and 110 = 3M. Assets: 3 + 75 + 7 = 85M. Sources: 311 20M, 312 9M, 314 3M (3334), 420 53M (the unclosed result of 2025 and 2026): 85M.
    expect(['110', '111', '131', '132', '311', '312', '314', '420b', '280', '440'].map(b01)).toEqual(['3000000', '3000000', '75000000', '7000000', '20000000', '9000000', '3000000', '53000000', '85000000', '85000000']);
    expect(s.b01.balanced).toBe(true);
    expect(s.b01.unmapped).toEqual([]);
    // The statement is read under the TT99 form: its own codes, in the form's order (a total before its parts).
    expect(s.b01.lines[0]).toMatchObject({ code: '100', total: true });
    expect(s.b01.lines.at(-1)).toMatchObject({ code: '440', total: true });
    // The start-of-year column (31 December 2025) is a TT133 date, so the statement says the charts are mixed.
    expect(s.mixedCharts).toBe(true);
  });

  it('gives the overview the same cash as line 110 of the TT99 balance sheet, money in transit included', async () => {
    const statementsCash = (await statements('2026-10', tt99)).b01.lines.find((l) => l.code === '110')?.amount;
    expect(statementsCash).toBe('3000000');
    expect((await overviewAt('2026-10-31', tt99)).cash.amount).toBe('3000000');
  });

  it('refuses the HTKK file for a TT99 year and leaves a TT133 year alone', async () => {
    const check = await refusal(rt.query('finance.statements.htkk_check', { year: 2026, legalEntityId: tt99 }, { actor: asUser(owner), orgId }));
    expect(check).toMatchObject({ code: 'STATEMENTS_HTKK_REGIME', status: 422 });
    const filing = await refusal(rt.query('finance.statements.htkk', { year: 2026, legalEntityId: tt99 }, { actor: asUser(owner), orgId }));
    expect(filing).toMatchObject({ code: 'STATEMENTS_HTKK_REGIME', status: 422 });
    expect(await refusal(rt.query('finance.statements.htkk_check', { year: 2026, legalEntityId: main }, { actor: asUser(owner), orgId }))).toBeNull();
  });
});
