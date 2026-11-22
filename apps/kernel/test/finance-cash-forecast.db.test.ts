// SPDX-License-Identifier: AGPL-3.0-only
// The 30/60/90-day cash forecast (#4391) on PostgreSQL 17, read from a real ledger: the booked cash as of day 0, the open sales invoices dated by their terms (an overdue one apart, not counted), the 331 balance laid
// over the purchase invoices (a payment made by hand leaves it once, a debt no invoice covers is counted on day 0), an approved supplier payment counted once and capped by what is owed, one legal entity at a time, every
// role able to read it, nothing written. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CASH_FORECAST_PARTIES_MAX, vietnamToday, type CashForecast, type FinanceOverview } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { addDays, financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = vietnamToday();
const day = (n: number) => addDays(TODAY, n);

suite('the cash-flow forecast (#4391)', () => {
  const dbName = `crove_test_cash_forecast_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@forecast.test`, name: null });
  type Org = { orgId: string; owner: string; viewer: string; entity: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Dự báo ${randomUUID().slice(0, 6)}`);
    const viewer = await identity('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]));
    const entity = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string);
    return { orgId, owner, viewer, entity };
  }
  const forecast = (o: Org, input: Record<string, unknown> = {}, user = o.owner) => rt.query<CashForecast>('finance.cash_forecast', input, { actor: asUser(user), orgId: o.orgId });
  const party = async (o: Org, name: string) => {
    const id = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', $3)", [o.orgId, id, name]));
    return id;
  };
  const secondEntity = (o: Org) => admin(async (c) => (await c.query<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [o.orgId, o.owner])).rows[0]?.id as string);

  // One journal entry of two or more lines, as the commands write one (a document without its entry is refused at commit, an entry must balance).
  async function entry(o: Org, date: string, lines: Array<{ account: string; debit?: string; credit?: string; party?: string | null }>, entity: string = o.entity, document: { number: string; direction: 'sale' | 'purchase'; party: string; total: string; invoiceDate?: string } | null = null): Promise<string | null> {
    return admin(async (c) => {
      await c.query('BEGIN');
      let doc: string | null = null;
      if (document) {
        doc = randomUUID();
        await c.query(
          `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
           VALUES ($1, $2, $3, 'C26TAA', $4, $5, 'VND', $6, 0, $6, $7, $8)`,
          [o.orgId, doc, document.party, document.number, document.invoiceDate ?? date, document.total, document.direction, entity],
        );
      }
      const id = randomUUID();
      await c.query(`INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'forecast test', $4, $5, $6)`, [o.orgId, id, date, doc ? 'finance.purchase_document' : 'finance.journal_voucher', doc ?? randomUUID(), entity]);
      let n = 1;
      for (const l of lines) await c.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [o.orgId, id, n++, l.account, l.debit ?? '0', l.credit ?? '0', l.party ?? null, entity]);
      await c.query('COMMIT');
      return doc;
    });
  }
  const cash = (o: Org, date: string, amount: string, entity?: string) => entry(o, date, [{ account: '112', debit: amount }, { account: '411', credit: amount }], entity);
  const sale = (o: Org, p: string, number: string, date: string, total: string, entity?: string) =>
    entry(o, date, [{ account: '131', debit: total, party: p }, { account: '511', credit: total }], entity, { number, direction: 'sale', party: p, total });
  const purchase = (o: Org, p: string, number: string, date: string, total: string, entity?: string) =>
    entry(o, date, [{ account: '6422', debit: total }, { account: '331', credit: total, party: p }], entity, { number, direction: 'purchase', party: p, total });
  // An approved supplier payment, written with the table's triggers set aside (no command could write it here without a vault, a bank account and an approved proposal; those are tested in finance-supplier-payment).
  async function approvedPayment(o: Org, p: string, doc: string, amount: string, over: { payableAfter?: string | null; currency?: string } = {}): Promise<void> {
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `INSERT INTO crove_finance.supplier_payment (org_id, legal_entity_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approver_step_up_at, payable_after, hold_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'k-test', $9, now(), $10, $11)`,
        [o.orgId, o.entity, p, doc, amount, over.currency ?? 'VND', randomUUID(), 'a'.repeat(64), randomUUID(), over.payableAfter ?? null, over.payableAfter ? 'new_account' : null],
      );
      await c.query('COMMIT');
    });
  }
  const at = (f: CashForecast, date: string) => f.series.find((d) => d.date === date)?.balance;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is flat and empty for an org with no entry, and every role can read it', async () => {
    const o = await org();
    const f = await forecast(o);
    expect(f).toMatchObject({ asOf: TODAY, openingCash: '0', empty: true, legalEntityId: o.entity, truncated: false, overdueReceiptsNotCounted: '0', payableTermsDays: 30 });
    expect(f.series).toHaveLength(91);
    expect(f.series.every((d) => d.balance === '0')).toBe(true);
    expect(f.low).toEqual({ date: TODAY, balance: '0' });
    expect(f.taxMarkers).toEqual([]);
    expect((await forecast(o, {}, o.viewer)).openingCash).toBe('0');
  });

  it('starts from the booked cash of the day (111 + 112) and ignores an entry dated after it', async () => {
    const o = await org();
    await cash(o, day(-30), '1000000.5');
    await cash(o, TODAY, '250000');
    await cash(o, day(5), '9999999');
    const f = await forecast(o);
    expect(f.openingCash).toBe('1250000.5');
    expect(f.empty).toBe(false);
    // As of another day: the entry of day 5 is then in, the one of today is not yet.
    const later = await forecast(o, { asOf: day(5) });
    expect(later.asOf).toBe(day(5));
    expect(later.openingCash).toBe('11249999.5');
    const earlier = await forecast(o, { asOf: day(-1) });
    expect(earlier.openingCash).toBe('1000000.5');
  });

  it('counts a customer invoice on its due date, a partial payment against the oldest, and keeps an overdue one apart', async () => {
    const o = await org();
    const p = await party(o, 'Khách An Phát');
    await cash(o, day(-60), '1000000');
    // Due in 20 days (dated 10 days ago, 30-day terms), and 700,000 not due for 5 days. An overdue one (due 15 days ago) of 400,000.
    await sale(o, p, '1', day(-10), '300000');
    await sale(o, p, '2', day(-25), '700000');
    await sale(o, p, '3', day(-45), '400000');
    const f = await forecast(o);
    expect(f.overdueReceiptsNotCounted).toBe('400000');
    expect(at(f, day(4))).toBe('1000000');
    expect(at(f, day(5))).toBe('1700000');
    expect(at(f, day(20))).toBe('2000000');
    expect(f.checkpoints[0]).toMatchObject({ days: 30, receipts: '1000000', payments: '0', balance: '2000000' });
    // 1,000,000 arrives today: the 131 balance falls to 400,000, laid over the newest invoices first (300,000 of the first, 100,000 of the second), so the overdue one is settled and drops out.
    await entry(o, TODAY, [{ account: '112', debit: '1000000' }, { account: '131', credit: '1000000', party: p }]);
    const paid = await forecast(o);
    expect(paid.overdueReceiptsNotCounted).toBe('0');
    expect(paid.openingCash).toBe('2000000');
    expect(at(paid, day(5))).toBe('2100000');
    expect(at(paid, day(90))).toBe('2400000');
  });

  it('reads as of a day: an invoice dated by then but posted after it is not in that day\'s receivables', async () => {
    const o = await org();
    const p = await party(o, 'Khách Bình Minh');
    await cash(o, day(-60), '1000000');
    // Booked: 400,000 invoiced and posted 30 days ago (due today). Invoiced 20 days ago for 600,000 but posted only 2 days ago.
    await sale(o, p, '1', day(-30), '400000');
    await entry(o, day(-2), [{ account: '131', debit: '600000', party: p }, { account: '511', credit: '600000' }], o.entity, { number: '2', direction: 'sale', party: p, total: '600000', invoiceDate: day(-20) });
    // As of 5 days ago the 131 balance is 400,000, so only the first invoice may take it: it is due on day(0), not on day(10) (the late-posted one's date).
    const f = await forecast(o, { asOf: day(-5) });
    expect(at(f, day(-1))).toBe('1000000');
    expect(at(f, day(0))).toBe('1400000');
  });

  it('lays the 331 balance over the purchase invoices, dates each 30 days after its own date and counts an overdue one today', async () => {
    const o = await org();
    const s = await party(o, 'Nhà cung cấp Bình Minh');
    await cash(o, day(-60), '5000000');
    await purchase(o, s, 'M1', day(-50), '1000000');
    await purchase(o, s, 'M2', day(-10), '2000000');
    const f = await forecast(o);
    // M1 was due 20 days ago: today. M2 is due in 20 days.
    expect(at(f, TODAY)).toBe('4000000');
    expect(at(f, day(19))).toBe('4000000');
    expect(at(f, day(20))).toBe('2000000');
    expect(f.low).toEqual({ date: day(20), balance: '2000000' });
    expect(f.topItems.map((i) => [i.kind, i.amount])).toEqual([['payable', '2000000'], ['payable', '1000000']]);
    expect(f.checkpoints[0]).toMatchObject({ payments: '3000000', receipts: '0', balance: '2000000' });
  });

  it('counts a payment made by hand once: it lowers the cash and the 331 together', async () => {
    const o = await org();
    const s = await party(o, 'Nhà cung cấp Cát Tường');
    await cash(o, day(-60), '5000000');
    await purchase(o, s, 'H1', day(-20), '1000000');
    await entry(o, day(-1), [{ account: '331', debit: '1000000', party: s }, { account: '112', credit: '1000000' }]);
    const f = await forecast(o);
    expect(f.openingCash).toBe('4000000');
    expect(f.series.every((d) => d.balance === '4000000')).toBe(true);
    expect(f.topItems).toEqual([]);
  });

  it('counts a debt no purchase invoice covers on day 0, with or without a party, and nothing for an overpaid supplier', async () => {
    const o = await org();
    const s = await party(o, 'Nhà cung cấp Đông Dương');
    const over = await party(o, 'Nhà cung cấp Giang Sơn');
    await cash(o, day(-60), '5000000');
    await entry(o, day(-30), [{ account: '6422', debit: '300000' }, { account: '331', credit: '300000', party: s }]);
    await entry(o, day(-30), [{ account: '6422', debit: '200000' }, { account: '331', credit: '200000' }]);
    await entry(o, day(-30), [{ account: '331', debit: '900000', party: over }, { account: '112', credit: '900000' }]);
    const f = await forecast(o);
    expect(f.openingCash).toBe('4100000');
    expect(at(f, TODAY)).toBe('3600000');
    expect(f.topItems.map((i) => [i.kind, i.amount])).toEqual([['unlinked_payable', '500000']]);
  });

  it('counts an approved supplier payment once, on the day its hold ends, and never more than is owed', async () => {
    const o = await org();
    const s = await party(o, 'Nhà cung cấp Hồng Hà');
    await cash(o, day(-60), '10000000');
    const m1 = await purchase(o, s, 'A1', day(-5), '1000000');
    await purchase(o, s, 'A2', day(-2), '500000');
    // A1 is approved for payment with a hold that ends in 3 days: counted on day 3, and A1 leaves the 331 pool, so the total out is 1,500,000, never 2,500,000.
    await approvedPayment(o, s, m1 as string, '1000000', { payableAfter: new Date(Date.parse(`${day(3)}T05:00:00Z`)).toISOString() });
    const f = await forecast(o);
    expect(at(f, day(2))).toBe('10000000');
    expect(at(f, day(3))).toBe('9000000');
    expect(at(f, day(27))).toBe('9000000');
    // A2 (500,000) is due 28 days from today (dated 2 days ago, 30-day terms).
    expect(at(f, day(28))).toBe('8500000');
    expect(f.checkpoints[2]).toMatchObject({ payments: '1500000', balance: '8500000' });
    // An approved payment in another currency is not added to the books' cash: its invoice stays in the 331 pool.
    const o2 = await org();
    const s2 = await party(o2, 'Nhà cung cấp ngoại tệ');
    await cash(o2, day(-60), '1000000');
    const d2 = await purchase(o2, s2, 'F1', day(-5), '400000');
    await approvedPayment(o2, s2, d2 as string, '400', { currency: 'USD' });
    const g = await forecast(o2);
    expect(g.topItems.map((i) => [i.kind, i.amount])).toEqual([['payable', '400000']]);
    expect(at(g, day(90))).toBe('600000');
  });

  it('reads one legal entity at a time: the entries of another entity are not in it', async () => {
    const o = await org();
    const branch = await secondEntity(o);
    await cash(o, day(-10), '1000000');
    await cash(o, day(-10), '7000000', branch);
    // Each entity is asked for by its id and answers from its own entries only.
    const main = await forecast(o, { legalEntityId: o.entity });
    const other = await forecast(o, { legalEntityId: branch });
    expect(main.openingCash).toBe('1000000');
    expect(other.openingCash).toBe('7000000');
    expect(other.legalEntityId).toBe(branch);
  });

  it('opens with the same cash as the overview card: an account of 111 or 112 overdrawn on its own adds nothing, as B01 line 110 reads it', async () => {
    const o = await org();
    await entry(o, day(-30), [{ account: '1121', debit: '700000' }, { account: '411', credit: '700000' }]);
    // 1122 is overdrawn by 300,000 (a credit balance): the card does not subtract it from the cash, so neither does the forecast.
    await entry(o, day(-20), [{ account: '6422', debit: '300000' }, { account: '1122', credit: '300000' }]);
    await entry(o, day(-10), [{ account: '111', debit: '50000' }, { account: '411', credit: '50000' }]);
    const card = await rt.query<FinanceOverview>('finance.overview', { range: 'last_30_days', asOf: TODAY }, { actor: asUser(o.owner), orgId: o.orgId });
    const f = await forecast(o);
    expect(card.cash.amount).toBe('750000');
    expect(f.openingCash).toBe(card.cash.amount);
    // The same on an earlier day.
    const before = await rt.query<FinanceOverview>('finance.overview', { range: 'last_30_days', asOf: day(-15) }, { actor: asUser(o.owner), orgId: o.orgId });
    expect((await forecast(o, { asOf: day(-15) })).openingCash).toBe(before.cash.amount);
  });

  it('takes from what an approved payment pays off its invoice only that part, and lays the rest of the invoice over the balance', async () => {
    const o = await org();
    const s = await party(o, 'Nhà cung cấp Kim Long');
    await cash(o, day(-60), '10000000');
    const doc = await purchase(o, s, 'P1', day(-5), '1000000');
    await approvedPayment(o, s, doc as string, '400000', { payableAfter: new Date(Date.parse(`${day(3)}T05:00:00Z`)).toISOString() });
    const f = await forecast(o);
    expect(at(f, day(2))).toBe('10000000');
    expect(at(f, day(3))).toBe('9600000');
    expect(at(f, day(24))).toBe('9600000');
    // The 600,000 left of the invoice falls due 25 days from today (dated 5 days ago, 30-day terms).
    expect(at(f, day(25))).toBe('9000000');
    expect(f.checkpoints[2]).toMatchObject({ payments: '1000000', balance: '9000000' });
  });

  it('counts an approved payment of a supplier with nothing left to pay for nothing', async () => {
    const o = await org();
    const s = await party(o, 'Nhà cung cấp Lạc Hồng');
    await cash(o, day(-60), '3000000');
    const doc = await purchase(o, s, 'Q1', day(-5), '800000');
    await entry(o, day(-1), [{ account: '331', debit: '800000', party: s }, { account: '112', credit: '800000' }]);
    await approvedPayment(o, s, doc as string, '800000');
    const f = await forecast(o);
    expect(f.openingCash).toBe('2200000');
    expect(f.series.every((d) => d.balance === '2200000')).toBe(true);
    expect(f.topItems).toEqual([]);
  });

  it('lowers what is owed by a 331 payment that names no supplier, so the cash that left is not counted twice', async () => {
    const o = await org();
    const s = await party(o, 'Nhà cung cấp Mai Linh');
    await cash(o, day(-60), '5000000');
    await purchase(o, s, 'N1', day(-10), '2000000');
    await entry(o, day(-1), [{ account: '331', debit: '500000' }, { account: '112', credit: '500000' }]);
    const f = await forecast(o);
    expect(f.openingCash).toBe('4500000');
    // The supplier is owed 1,500,000 after the unnamed payment, due 20 days from today (dated 10 days ago, 30-day terms).
    expect(at(f, day(19))).toBe('4500000');
    expect(at(f, day(20))).toBe('3000000');
    expect(f.topItems.map((i) => [i.kind, i.amount])).toEqual([['payable', '1500000']]);
  });

  it('lists the tax due dates of the entity as markers with no amount once the org has set its VAT filing period', async () => {
    const o = await org();
    expect((await forecast(o)).taxMarkers).toEqual([]);
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET vat_filing_period = 'month' WHERE org_id = $1", [o.orgId]));
    const f = await forecast(o);
    expect(f.taxMarkers.length).toBeGreaterThan(0);
    expect(f.taxMarkers[0]).toMatchObject({ obligation: 'vat_return' });
    for (const m of f.taxMarkers) {
      expect(m.dueDate >= TODAY && m.dueDate <= day(90)).toBe(true);
      expect(Object.keys(m).sort()).toEqual(['dueDate', 'obligation', 'period']);
    }
    expect((await forecast(o, {}, o.viewer)).taxMarkers).toEqual(f.taxMarkers);
  });

  it('refuses an entity a member may not see (403) and answers a limited member for the one entity they see', async () => {
    const o = await org();
    const branch = await secondEntity(o);
    const limited = await identity('limited');
    await admin(async (c) => {
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, limited]);
      await c.query("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [o.orgId, limited, branch, o.owner]);
    });
    await cash(o, day(-10), '1000000');
    await cash(o, day(-10), '7000000', branch);
    await expect(forecast(o, { legalEntityId: o.entity }, limited)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    // Without a choice, the one entity the member sees answers, and it holds only its own entries.
    const mine = await forecast(o, {}, limited);
    expect(mine).toMatchObject({ legalEntityId: branch, openingCash: '7000000' });
  });

  it('says the forecast is partial when the books hold more customers than one forecast reads', async () => {
    const o = await org();
    await cash(o, day(-60), '1000000');
    await admin(async (c) => {
      await c.query('BEGIN');
      for (let i = 0; i <= CASH_FORECAST_PARTIES_MAX; i++) {
        const p = randomUUID();
        const e = randomUUID();
        await c.query("INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', $3)", [o.orgId, p, `Khách ${i}`]);
        await c.query("INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'bulk', 'finance.journal_voucher', $4, $5)", [o.orgId, e, day(-5), randomUUID(), o.entity]);
        await c.query(
          "INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '131', $3, 0, $4, $5), ($1, $2, 2, '511', 0, $3, NULL, $5)",
          [o.orgId, e, 1000 + i, p, o.entity],
        );
      }
      await c.query('COMMIT');
    });
    const f = await forecast(o);
    expect(f.truncated).toBe(true);
    // The others stay whole: the cash and the series are still there, and the forecast is not an error.
    expect(f.openingCash).toBe('1000000');
    expect(f.series).toHaveLength(91);
    // Few customers: not partial.
    expect((await forecast(await org())).truncated).toBe(false);
  }, 120_000);

  it('writes nothing: a forecast leaves no journal entry, document or audit row behind', async () => {
    const o = await org();
    await cash(o, day(-10), '1000000');
    const count = () =>
      admin(async (c) => {
        const r = await c.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM crove_finance.journal_entry WHERE org_id = $1) + (SELECT count(*) FROM crove_finance.purchase_document WHERE org_id = $1) + (SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1) AS n`,
          [o.orgId],
        );
        return Number(r.rows[0]?.n);
      });
    const before = await count();
    await forecast(o);
    await forecast(o, { asOf: day(3) });
    expect(await count()).toBe(before);
  });
});
