// SPDX-License-Identifier: AGPL-3.0-only
// The quarter in plain words on the Kế toán Tổng quan (#5183) on PostgreSQL 17: known entries are posted and finance.quarter_summary must give the figures the existing reads give for the same entity and dates
// (the income statement and its comparison columns, the overview's cash, receivables and payables, the VAT working, the 01/CNKD worksheet, the stock report, the reminders' overdue loader), on a TT133 company, a TT99
// company (whose 641 and 521 the income statement does not read, #5187), a household and an entity with no books; refuse a quarter that has not ended, give a member scoped to another entity the same refusal as the
// overview, show the period lock, and write nothing. The rules themselves are unit-tested in modules/finance/test/quarter-summary.test.ts.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database (CI only: a run without it is skipped, not passed).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { FinanceOverview, FinanceQuarterSummary, HouseholdCnkd, HouseholdProfileView, QuarterSummaryFigure, StockReportRow } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { money, sum } from '@ludy/l10n-vn';
import { financeCommands, financeQueries, type FinancialStatements } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

// The part of the VAT working this file reads (the contract exports its schema, not its type): the indicators of form 01/GTGT and the filed mark.
interface VatRead {
  indicators: Array<{ code: string; amount: string }>;
  filed: unknown;
}

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
// The quarter of the report, the one before it and the same one a year earlier: all long past, whatever day the suite runs.
const QUARTER = '2026-Q3';

suite('the quarter in plain words (#5183)', () => {
  const dbName = `ludy_test_quarter_summary_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let kyselyPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let orgId = '';
  let owner = '';
  let member = '';
  let viewer = '';
  let main = '';
  let tt99 = '';
  let empty = '';
  let home = '';
  let homeNoProfile = '';
  let stockEntity = '';
  let closed99 = '';
  let customer = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asStepUp = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

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

  // One transaction as ludy_app in the owner's context, committed.
  async function asApp<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  interface Line {
    account: string;
    debit?: string;
    credit?: string;
    party?: string;
  }
  // A balanced entry of one entity through the posting function.
  const post = (entity: string, date: string, lines: Line[], description = 'Bút toán thử') =>
    asApp(owner, (c) =>
      c
        .query<{ id: string }>(`SELECT ludy_finance.post_journal_entry($1::date, $2, 'test.quarter', $3::uuid, $4::jsonb, NULL, 1, $5::uuid) AS id`, [
          date,
          description,
          randomUUID(),
          JSON.stringify(lines.map((l, i) => ({ line_no: i + 1, account_code: l.account, debit: l.debit ?? '0', credit: l.credit ?? '0', ...(l.party ? { party_id: l.party } : {}) }))),
          entity,
        ])
        .then((r) => r.rows[0]?.id as string),
    );
  // An entry of the ledger written by the database owner (the triggers fire as for any writer); with `invoice` it is a sales document's entry, posted in the same transaction as the document.
  async function entry(entity: string, date: string, lines: Array<[string, number, number, string?]>, invoice?: { party: string; series: string; number: string; total: number }): Promise<string> {
    return admin(async (a) => {
      await a.query('BEGIN');
      try {
        let document: string | null = null;
        if (invoice) {
          document = (
            await a.query<{ id: string }>(
              "INSERT INTO ludy_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, 0, $6, 'sale', $7) RETURNING id",
              [orgId, invoice.party, invoice.series, invoice.number, date, invoice.total, entity],
            )
          ).rows[0]?.id as string;
        }
        const id = (
          await a.query<{ id: string }>(
            `INSERT INTO ludy_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, 'Bút toán thử', $3, $4, $5) RETURNING id`,
            [orgId, date, document ? 'finance.purchase_document' : 'finance.journal_voucher', document ?? randomUUID(), entity],
          )
        ).rows[0]?.id as string;
        let no = 1;
        for (const [account, debit, credit, party] of lines) {
          await a.query('INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [orgId, id, no++, account, debit, credit, party ?? null]);
        }
        await a.query('COMMIT');
        return id;
      } catch (error) {
        await a.query('ROLLBACK');
        throw error;
      }
    });
  }

  const summary = (input: { quarter?: string; legalEntityId?: string }, user = owner) =>
    rt.query<FinanceQuarterSummary>('finance.quarter_summary', { quarter: QUARTER, ...input }, { actor: asUser(user), orgId });
  const figure = (s: FinanceQuarterSummary, key: string): QuarterSummaryFigure => {
    const found = s.figures.find((f) => f.key === key);
    if (!found) throw new Error(`no figure ${key}`);
    return found;
  };
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; status?: number });
  const counts = () =>
    admin(async (a) => ({
      entries: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.journal_entry')).rows[0]?.n,
      lines: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_finance.journal_line')).rows[0]?.n,
      audit: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_kernel.audit_event')).rows[0]?.n,
      outbox: (await a.query<{ n: string }>('SELECT count(*) AS n FROM ludy_kernel.outbox_event')).rows[0]?.n,
    }));
  const statements = (period: string, legalEntityId: string) => rt.query<FinancialStatements>('finance.statements.period', { period, legalEntityId }, { actor: asUser(owner), orgId });
  const overviewAt = (asOf: string, legalEntityId: string) => rt.query<FinanceOverview>('finance.overview', { range: 'this_month', asOf, legalEntityId }, { actor: asUser(owner), orgId });
  const line = (s: FinancialStatements, code: string) => s.b02.lines.find((l) => l.code === code)?.amount;

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
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@quarter-summary.test`, name: null });
    owner = await person('owner');
    member = await person('member');
    viewer = await person('viewer');
    ({ orgId } = await createOrg(rt, asUser(owner), 'Tóm tắt quý'));
    await admin(async (a) => {
      main = (await a.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      const entity = async (name: string, kind = 'company') =>
        (await a.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [orgId, name, kind, owner])).rows[0]?.id as string;
      tt99 = await entity('Công ty TT99');
      empty = await entity('Pháp nhân chưa có sổ');
      home = await entity('Hộ kinh doanh có hồ sơ', 'household');
      homeNoProfile = await entity('Hộ kinh doanh chưa có hồ sơ', 'household');
      stockEntity = await entity('Công ty có kho');
      closed99 = await entity('Công ty TT99 đã kết chuyển');
      await a.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`, [orgId, member, viewer]);
      // The member reads the TT99 company only.
      await a.query(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, member, tt99, owner]);
      customer = String((await a.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, name, tax_code) VALUES ($1, 'Khách hàng nợ', '0101234564') RETURNING id`, [orgId])).rows[0]?.id);
      // The TT99 company keeps its books under TT99 for all of 2026, set before it has any entry.
      await a.query(`INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', '2026-01-01')`, [orgId, tt99]);
      await a.query(`INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', '2026-01-01')`, [orgId, closed99]);
    });

    // The TT133 company (no books row). Sales on account to one customer: 100,000,000 in Q3 of 2025, 50,000,000 in Q2 and 100,000,000 in Q3 (the last as a sales invoice, so it can be overdue), a receipt of 40,000,000
    // into the bank in August; costs: 6422 of 20,000,000 in Q2 and 30,000,000 in Q3, 632 of 10,000,000 in Q3.
    await post(main, '2025-08-10', [{ account: '131', debit: '100000000', party: customer }, { account: '5111', credit: '100000000' }]);
    await post(main, '2026-05-10', [{ account: '131', debit: '50000000', party: customer }, { account: '5111', credit: '50000000' }]);
    await post(main, '2026-05-20', [{ account: '6422', debit: '20000000' }, { account: '331', credit: '20000000' }]);
    await entry(main, '2026-07-10', [['131', 100000000, 0, customer], ['5111', 0, 100000000]], { party: customer, series: 'C26TAA', number: '0000001', total: 100000000 });
    await post(main, '2026-08-10', [{ account: '6422', debit: '30000000' }, { account: '331', credit: '30000000' }]);
    await post(main, '2026-08-20', [{ account: '1121', debit: '40000000' }, { account: '131', credit: '40000000', party: customer }]);
    await post(main, '2026-09-05', [{ account: '632', debit: '10000000' }, { account: '331', credit: '10000000' }]);

    // The TT99 company: 511 and 131 sales of 20,000,000 in Q2 and 50,000,000 in Q3, a revenue deduction on 521 of 5,000,000 and a selling cost on 6417 (a 641 account) of 12,000,000 and an administration cost on 6421
    // (a 642 account) of 4,000,000 in Q3, 6417 of 4,000,000 in Q2. The income statement reads 511 and 642 only: 521 and 641 are in its `unmapped` list (#5187).
    await post(tt99, '2026-05-10', [{ account: '131', debit: '20000000' }, { account: '511', credit: '20000000' }]);
    await post(tt99, '2026-05-12', [{ account: '6417', debit: '4000000' }, { account: '331', credit: '4000000' }]);
    await post(tt99, '2026-07-10', [{ account: '131', debit: '50000000' }, { account: '511', credit: '50000000' }]);
    await post(tt99, '2026-08-01', [{ account: '521', debit: '5000000' }, { account: '131', credit: '5000000' }]);
    await post(tt99, '2026-08-10', [{ account: '6417', debit: '12000000' }, { account: '331', credit: '12000000' }]);
    await post(tt99, '2026-08-11', [{ account: '6421', debit: '4000000' }, { account: '331', credit: '4000000' }]);

    // A TT99 company whose production cost was closed: 621 of 8,000,000 in August is closed to 154 and then to 632 on 30 September, so 632 carries it and 621 nets to 0. The card must count it once.
    await post(closed99, '2026-07-10', [{ account: '131', debit: '20000000' }, { account: '511', credit: '20000000' }]);
    await post(closed99, '2026-08-05', [{ account: '621', debit: '8000000' }, { account: '331', credit: '8000000' }]);
    await post(closed99, '2026-09-30', [{ account: '154', debit: '8000000' }, { account: '621', credit: '8000000' }]);
    await post(closed99, '2026-09-30', [{ account: '632', debit: '8000000' }, { account: '154', credit: '8000000' }]);

    // The household: a percentage-method profile from the start of 2026 for one trade, takings of 600,000 in Q2 and 1,000,000 in Q3, no cost.
    await rt.execute<HouseholdProfileView>(
      'finance.household.profile_set',
      { legalEntityId: home, effectiveFrom: '2026-01-01', taxGroup: 2, pitMethod: 'percentage', trades: ['goods'], einvoiceRegistered: false, representativeName: 'Nguyễn Văn A' },
      { actor: asStepUp(owner), orgId, idempotencyKey: randomUUID() },
    );
    await entry(home, '2026-04-10', [['111', 600000, 0], ['511', 0, 600000]]);
    await entry(home, '2026-07-05', [['111', 1000000, 0], ['511', 0, 1000000]]);

    // The entity that keeps stock: one item, a purchase of stock is not needed (the value of an item with no move is 0), so only the keeps-stock rule is exercised.
    await admin((a) => a.query(`INSERT INTO ludy_finance.stock_item (org_id, legal_entity_id, code, name, unit, stock_account) VALUES ($1, $2, 'SP1', 'Hàng thử', 'cái', '156')`, [orgId, stockEntity]));
    await post(stockEntity, '2026-07-10', [{ account: '131', debit: '1000000' }, { account: '5111', credit: '1000000' }]);
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await kyselyPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives a TT133 company its figures against the previous quarter and the same quarter last year', async () => {
    const s = await summary({ legalEntityId: main });
    expect(s).toMatchObject({ quarter: QUARTER, from: '2026-07-01', to: '2026-09-30', legalEntityId: main, kind: 'company', regime: 'tt133', booksStart: '2025-08-10', partialBasis: true, previousQuarter: '2026-Q2', lastYearQuarter: '2025-Q3', steadyPercent: '5', empty: false, includesUnmapped: false });
    expect(s.figures.map((f) => f.key)).toEqual(['revenue', 'other_income', 'costs', 'profit', 'cash', 'receivables', 'payables']);
    expect(figure(s, 'revenue')).toEqual({ key: 'revenue', amount: '100000000', previous: '50000000', lastYear: '100000000', vsPrevious: 'rose', vsLastYear: 'steady' });
    expect(figure(s, 'other_income')).toEqual({ key: 'other_income', amount: '0', previous: '0', lastYear: '0', vsPrevious: 'none', vsLastYear: 'none' });
    expect(figure(s, 'costs')).toEqual({ key: 'costs', amount: '40000000', previous: '20000000', lastYear: '0', vsPrevious: 'rose', vsLastYear: 'first_time' });
    expect(figure(s, 'profit')).toEqual({ key: 'profit', amount: '60000000', previous: '30000000', lastYear: '100000000', vsPrevious: 'rose', vsLastYear: 'fell' });
    expect(figure(s, 'cash')).toEqual({ key: 'cash', amount: '40000000', previous: '0', lastYear: '0', vsPrevious: 'first_time', vsLastYear: 'first_time' });
    expect(figure(s, 'receivables')).toEqual({ key: 'receivables', amount: '210000000', previous: '150000000', lastYear: '100000000', vsPrevious: 'rose', vsLastYear: 'rose' });
    expect(figure(s, 'payables')).toEqual({ key: 'payables', amount: '60000000', previous: '20000000', lastYear: '0', vsPrevious: 'rose', vsLastYear: 'first_time' });
    // No stock is kept here, so no stock row; a company has a VAT working and no household tax.
    expect(s.stockProvisional).toBeNull();
    expect(s.householdTax).toBeNull();
    expect(s.vat).not.toBeNull();
  });

  it('matches the income statement and its comparison columns line for line (revenue, profit)', async () => {
    const s = await summary({ legalEntityId: main });
    const q3 = await statements(QUARTER, main);
    expect(figure(s, 'revenue').amount).toBe(line(q3, '10'));
    expect(figure(s, 'profit').amount).toBe(line(q3, '50'));
    expect(figure(s, 'revenue').previous).toBe(q3.comparison.previous?.amounts['10']);
    expect(figure(s, 'profit').previous).toBe(q3.comparison.previous?.amounts['50']);
    expect(figure(s, 'revenue').lastYear).toBe(q3.comparison.lastYear?.amounts['10']);
    expect(figure(s, 'profit').lastYear).toBe(q3.comparison.lastYear?.amounts['50']);
    expect(q3.b02.unmapped).toEqual([]);
  });

  it('matches the overview for cash, receivables and payables at the last day of each quarter', async () => {
    const s = await summary({ legalEntityId: main });
    for (const [asOf, pick] of [
      ['2026-09-30', (f: QuarterSummaryFigure) => f.amount],
      ['2026-06-30', (f: QuarterSummaryFigure) => f.previous],
      ['2025-09-30', (f: QuarterSummaryFigure) => f.lastYear],
    ] as const) {
      const overview = await overviewAt(asOf, main);
      expect(pick(figure(s, 'cash')), `cash at ${asOf}`).toBe(overview.cash.amount);
      expect(pick(figure(s, 'receivables')), `receivables at ${asOf}`).toBe(overview.receivables.amount);
      expect(pick(figure(s, 'payables')), `payables at ${asOf}`).toBe(overview.payables.amount);
    }
  });

  it('matches the VAT working of the quarter and the reminders\' oldest overdue invoice', async () => {
    const s = await summary({ legalEntityId: main });
    const vat = await rt.query<VatRead>('finance.vat.period', { period: QUARTER, legalEntityId: main }, { actor: asUser(owner), orgId });
    const indicator = (code: string) => vat.indicators.find((i) => i.code === code)?.amount ?? '0';
    expect(s.vat).toEqual({ output: indicator('35'), input: indicator('24'), difference: money(indicator('35')).minus(indicator('24')).toFixed(), filed: vat.filed !== null });
    // The overdue read is the reminders' own: the same oldest due date as the signal that Vy reads for this customer.
    const signal = await rt.query<Array<{ partyId: string; oldestDueOn: string; amount: string; count: number }>>('finance.signals.overdue_receivables', { partyIds: [customer] }, { actor: asUser(owner), orgId });
    expect(signal).toHaveLength(1);
    expect(s.overdue).toEqual({ oldestDueOn: signal[0]?.oldestDueOn, amount: signal[0]?.amount, count: signal[0]?.count, truncated: false });
  });

  it('adds the TT99 costs and deduction the income statement does not read, and says so', async () => {
    const s = await summary({ legalEntityId: tt99 });
    expect(s).toMatchObject({ legalEntityId: tt99, kind: 'company', regime: 'tt99', booksStart: '2026-05-10', partialBasis: true, previousQuarter: '2026-Q2', lastYearQuarter: '2025-Q3', includesUnmapped: true });
    // 511 of 50,000,000 less the 521 deduction of 5,000,000; costs 6421 (642, a B02 line) 4,000,000 and 6417 (641, unmapped) 12,000,000; profit = 45 - 16.
    expect(figure(s, 'revenue')).toMatchObject({ amount: '45000000', previous: '20000000', lastYear: null, vsPrevious: 'rose', vsLastYear: 'none' });
    expect(figure(s, 'costs')).toMatchObject({ amount: '16000000', previous: '4000000', lastYear: null, vsPrevious: 'rose', vsLastYear: 'none' });
    expect(figure(s, 'profit')).toMatchObject({ amount: '29000000', previous: '16000000', lastYear: null, vsPrevious: 'rose', vsLastYear: 'none' });
    // The statements screen is TT133's map: it lists 521 and 6417 as unmapped and its profit (B02 line 50) leaves them out. The card's profit is that line less what it does not read.
    const q3 = await statements(QUARTER, tt99);
    expect(line(q3, '50')).toBe('46000000');
    expect(q3.b02.unmapped.map((u) => [u.accountCode, u.amount]).sort()).toEqual([['521', '5000000'], ['6417', '12000000']]);
  });

  it('counts production cost once when 621 was closed to 154 and 632', async () => {
    const s = await summary({ legalEntityId: closed99 });
    expect(s.includesUnmapped).toBe(false);
    expect(figure(s, 'costs').amount).toBe('8000000');
    expect(figure(s, 'profit').amount).toBe('12000000');
    // The income statement reads 632 and lists nothing as unmapped but the pair that nets to 0, so its profit is the card's.
    const q3 = await statements(QUARTER, closed99);
    expect(line(q3, '50')).toBe('12000000');
    expect(q3.b02.unmapped.every((u) => u.amount === '0')).toBe(true);
  });

  it('shows no stock row where no stock is kept, and the row where it is', async () => {
    const without = await summary({ legalEntityId: main });
    expect(without.figures.some((f) => f.key === 'stock')).toBe(false);
    const kept = await summary({ legalEntityId: stockEntity });
    const rows = await rt.query<StockReportRow[]>('finance.stock.report', { month: '2026-09', legalEntityId: stockEntity }, { actor: asUser(owner), orgId });
    const total = sum(rows.map((r) => r.closingValue)).toFixed();
    expect(figure(kept, 'stock')).toMatchObject({ amount: total, lastYear: null, vsLastYear: 'none' });
    // Provisional when the quarter's own value or the previous quarter's one it is compared with is.
    const before = await rt.query<StockReportRow[]>('finance.stock.report', { month: '2026-06', legalEntityId: stockEntity }, { actor: asUser(owner), orgId });
    expect(kept.stockProvisional).toBe(rows.some((r) => !r.closed) || before.some((r) => !r.closed));
  });

  it('gives a household its revenue and its tax from the 01/CNKD worksheet, with no VAT row and no costs row', async () => {
    const s = await summary({ legalEntityId: home });
    expect(s).toMatchObject({ kind: 'household', booksStart: '2026-04-10', vat: null, includesUnmapped: false });
    // Nothing booked as cost or other income: the profit would only repeat the revenue.
    expect(s.figures.map((f) => f.key)).toEqual(['revenue', 'cash', 'receivables', 'payables']);
    expect(figure(s, 'revenue')).toEqual({ key: 'revenue', amount: '1000000', previous: '600000', lastYear: null, vsPrevious: 'rose', vsLastYear: 'none' });
    const sheet = await rt.query<HouseholdCnkd>('finance.household.cnkd', { legalEntityId: home, year: 2026, quarter: 3 }, { actor: asUser(owner), orgId });
    expect(String(sheet.revenue)).toBe(figure(s, 'revenue').amount);
    expect(s.householdTax).toEqual({ state: 'ready', tax: sheet.totals?.tax ?? null, due: sheet.due, overpaid: sheet.overpaid, commentary: sheet.commentary });
  });

  it('says not_required for a household whose worksheet is refused', async () => {
    const s = await summary({ legalEntityId: homeNoProfile });
    expect(s).toMatchObject({ kind: 'household', householdTax: { state: 'not_required', tax: null, due: null, overpaid: null } });
  });

  it('reads an entity with no entry as empty, with every label none', async () => {
    const s = await summary({ legalEntityId: empty });
    expect(s).toMatchObject({ legalEntityId: empty, empty: true, booksStart: null, includesUnmapped: false, overdue: { oldestDueOn: null, amount: '0', count: 0, truncated: false } });
    for (const f of s.figures) expect(f, f.key).toMatchObject({ amount: '0', vsPrevious: 'none', vsLastYear: 'none' });
  });

  it('refuses a quarter that has not ended and a quarter that is not one', async () => {
    expect(await refusal(summary({ quarter: '2099-Q4' }))).toMatchObject({ code: 'QUARTER_NOT_ENDED', status: 422 });
    expect(await refusal(summary({ quarter: '2999-Q1' }))).toMatchObject({ code: 'VALIDATION', status: 422 });
    expect(await refusal(summary({ quarter: '1999-Q4' }))).toMatchObject({ code: 'VALIDATION', status: 422 });
    expect(await refusal(summary({ quarter: '2026-Q5' }))).toMatchObject({ code: 'VALIDATION', status: 422 });
  });

  it('gives a member scoped to another entity the same refusal as the overview, and reads what the member may', async () => {
    const asked = await refusal(summary({ legalEntityId: main }, member));
    const overview = await refusal(rt.query<FinanceOverview>('finance.overview', { range: 'last_month', legalEntityId: main }, { actor: asUser(member), orgId }));
    expect(asked).toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    expect(asked?.code).toBe(overview?.code);
    expect(asked?.status).toBe(overview?.status);
    expect(await refusal(summary({ legalEntityId: randomUUID() }, member))).toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    // The entity the member may see is the one they get when they name none, and its figures are that company's own.
    const own = await summary({}, member);
    expect(own.legalEntityId).toBe(tt99);
    expect(figure(own, 'revenue').amount).toBe('45000000');
  });

  it('lets a viewer read it and never counts another entity\'s postings', async () => {
    const asViewer = await summary({ legalEntityId: main }, viewer);
    const asOwner = await summary({ legalEntityId: main });
    expect(asViewer).toEqual(asOwner);
    expect(figure(await summary({ legalEntityId: tt99 }), 'revenue').amount).toBe('45000000');
  });

  it('shows the period lock of the quarter: open, partly and locked', async () => {
    expect((await summary({ legalEntityId: empty })).lock).toEqual({ state: 'open', lockedThrough: null });
    const lock = (month: string) => rt.execute('finance.period.lock', { month, legalEntityId: empty }, { actor: asStepUp(owner), orgId, idempotencyKey: randomUUID() });
    await lock('2026-07');
    expect((await summary({ legalEntityId: empty })).lock).toEqual({ state: 'partly', lockedThrough: '2026-07-31' });
    await lock('2026-08');
    await lock('2026-09');
    expect((await summary({ legalEntityId: empty })).lock).toEqual({ state: 'locked', lockedThrough: '2026-09-30' });
  });

  it('writes nothing: no entry, no line, no audit row, no outbox row', async () => {
    const before = await counts();
    await summary({ legalEntityId: main });
    await summary({ legalEntityId: tt99 });
    await summary({ legalEntityId: home });
    await refusal(summary({ quarter: '2099-Q4' }));
    expect(await counts()).toEqual(before);
  });
});
