// SPDX-License-Identifier: AGPL-3.0-only
// The 01/CNKD return worksheet of a household business (#2518, plan stock-and-marketplaces.md sections 8.5 and 12 row 7), on PostgreSQL 17: one quarter of the ledger's account 511 split by trade, VAT and
// PIT by the percentages in force on the quarter's last day (each rounded to a whole dong), the tax the platforms already withheld from the stored settlements (a reversed one left out), the draft state
// while a row behind it is still `commentary` (the Excel ask is refused then), and the cases the worksheet refuses (no profile, group 1, the income method, a profile that changes inside the quarter, a
// split that does not fit). Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HouseholdCnkd, HouseholdProfileView } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { money } from '@ludy/l10n-vn';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the 01/CNKD return worksheet of a household business (#2518)', () => {
  const dbName = `ludy_test_household_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@household.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; company: string; household: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Hộ Kinh Doanh ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) =>
      c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    const company = (await admin((c) => c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id as string;
    const household = randomUUID();
    await admin((c) =>
      c.query("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Hộ kinh doanh Nguyễn Văn A', 'household', $3)", [orgId, household, owner]),
    );
    return { orgId, owner, admin: adminUser, member, viewer, company, household };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const setProfile = (o: Org, over: Record<string, unknown> = {}, user = o.owner) =>
    execute<HouseholdProfileView>(
      o,
      'finance.household.profile_set',
      { legalEntityId: o.household, effectiveFrom: '2026-01-01', taxGroup: 1, pitMethod: null, trades: ['goods'], einvoiceRegistered: false, representativeName: 'Nguyễn Văn A', ...over },
      user,
    );

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
    // The seeded law rows are `confirmed` from #3710 (finance-household.db.test.ts checks that). This file exercises the provisional label, so it starts from the rows as they were before:
    // `commentary`, restored here as the database owner (the law tables are read-only to every tenant login).
    // The yearly revenue threshold and the PIT cut are set to 0 here: these files test the books' rows, splits, labels and Excel with small revenues, so every revenue is above the threshold and the tax is the plain
    // percentage of it, as before the yearly rule (#3710 slice 3). That rule has its own file, finance-household-annual.db.test.ts, on the real rows (1 billion VND, PIT cut 30%).
    const restore = new pg.Client({ connectionString: adminUrl });
    await restore.connect();
    await restore.query(
      "UPDATE ludy_finance.household_threshold SET amount = 0 WHERE code = 'no_tax_revenue'; UPDATE ludy_finance.household_tax_reduction SET cut_percent = 0 WHERE kind = 'pit'; UPDATE ludy_finance.household_trade_rate SET status = 'commentary'; UPDATE ludy_finance.household_form_version SET status = 'commentary'; UPDATE ludy_finance.household_return_form_version SET status = 'commentary'",
    );
    await restore.end();
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
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

  // An entry of the household's ledger written by the database owner (the triggers fire as for any writer), with its lines; `reverses` makes it the reversal of another entry.
  async function entry(entity: string, orgId: string, date: string, description: string, lines: Array<[string, number, number]>, over: { invoice?: { series: string; number: string; total: number }; reverses?: string } = {}): Promise<string> {
    return admin(async (a) => {
      await a.query('BEGIN');
      try {
        // A sales document is posted in the same transaction as its entry.
        let document: string | null = null;
        if (over.invoice) {
          const party = (await a.query<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name) VALUES ($1, 'Khách lẻ') RETURNING id", [orgId])).rows[0]?.id;
          document = (
            await a.query<{ id: string }>(
              "INSERT INTO ludy_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, 0, $6, 'sale', $7) RETURNING id",
              [orgId, party, over.invoice.series, over.invoice.number, date, over.invoice.total, entity],
            )
          ).rows[0]?.id as string;
        }
        const id = (
          await a.query<{ id: string }>(
            `INSERT INTO ludy_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id, reverses_entry_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [orgId, date, description, document ? 'finance.purchase_document' : 'finance.journal_voucher', document ?? randomUUID(), entity, over.reverses ?? null],
          )
        ).rows[0]?.id as string;
        let no = 1;
        for (const [account, debit, credit] of lines) await a.query('INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, no++, account, debit, credit]);
        await a.query('COMMIT');
        return id;
      } catch (error) {
        await a.query('ROLLBACK');
        throw error;
      }
    });
  }

  const cnkd = (o: Org, quarter: 1 | 2 | 3 | 4, over: Record<string, unknown> = {}, entity = o.household, user = o.owner, year = 2026) =>
    query<HouseholdCnkd>(o, 'finance.household.cnkd', { legalEntityId: entity, year, quarter, ...over }, user);
  const percentage = (o: Org, over: Record<string, unknown> = {}) => setProfile(o, { taxGroup: 2, pitMethod: 'percentage', ...over });
  // The accountant's confirmation is a later dated row, never an edit: from 2026-10-01 the form and the four percentages are `confirmed`, so Q4 uses them and Q3 still sees `commentary`.
  async function confirmFromQ4() {
    await admin(async (a) => {
      await a.query("INSERT INTO ludy_finance.household_return_form_version (form, version, effective_from, name, pit_methods, source, status) VALUES ('01/CNKD', '2026.2', DATE '2026-10-01', 'Tờ khai 01/CNKD', ARRAY['percentage'], 'test', 'confirmed') ON CONFLICT DO NOTHING");
      for (const [trade, vat, pit] of [['goods', 1, 0.5], ['services', 5, 2], ['catering', 3, 1.5], ['other', 2, 1]] as const) {
        await a.query("INSERT INTO ludy_finance.household_trade_rate (trade, effective_from, vat_percent, pit_percent, source, status) VALUES ($1, DATE '2026-10-01', $2, $3, 'test', 'confirmed') ON CONFLICT DO NOTHING", [trade, vat, pit]);
      }
    });
  }
  // A settlement of the household written by the database owner, with one line that withheld `tax`; `reversalOf` makes it the reversal of another one (it states the negative net and its line
  // repeats the original's, marked as an adjustment, as the guard demands).
  async function settlement(o: Org, platform: string, start: string, end: string, tax: number, reversalOf: string | null = null, entity = o.household): Promise<string> {
    return admin(async (a) => {
      // One transaction: the guard that a reversal mirrors its original is checked at commit, when the settlement and its line are both there.
      await a.query('BEGIN');
      const id = randomUUID();
      const net = 10000 - tax;
      let order: string = randomUUID();
      if (reversalOf) order = (await a.query<{ order_id: string }>('SELECT order_id FROM ludy_finance.channel_settlement_line WHERE org_id = $1 AND settlement_id = $2', [o.orgId, reversalOf])).rows[0]?.order_id as string;
      else await a.query('INSERT INTO ludy_finance.channel_order (org_id, id, legal_entity_id, platform, order_no) VALUES ($1, $2, $3, $4, $5)', [o.orgId, order, entity, platform, `ST${randomUUID().slice(0, 12)}`]);
      await a.query('INSERT INTO ludy_finance.channel_settlement (org_id, id, legal_entity_id, platform, period_start, period_end, report_net, reversal_of) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [o.orgId, id, entity, platform, start, end, reversalOf ? -net : net, reversalOf]);
      await a.query('INSERT INTO ludy_finance.channel_settlement_line (org_id, id, legal_entity_id, settlement_id, order_id, line_key, sales, tax_withheld, net, adjustment) VALUES ($1, $2, $3, $4, $5, $6, 10000, $7, $8, $9)', [o.orgId, randomUUID(), entity, id, order, 'L1', tax, net, reversalOf !== null]);
      await a.query('COMMIT');
      return id;
    });
  }

  it('computes a quarter of one trade from the ledger and says it is a draft while the rows are commentary', async () => {
    const o = await org();
    await percentage(o);
    await entry(o.household, o.orgId, '2026-07-05', 'Bán hàng', [['111', 1000000, 0], ['511', 0, 1000000]]);
    await entry(o.household, o.orgId, '2026-08-12', 'Bán hàng', [['111', 600000, 0], ['511', 0, 600000]]);
    await entry(o.household, o.orgId, '2026-06-30', 'Bán quý trước', [['111', 777000, 0], ['511', 0, 777000]]);
    await entry(o.household, o.orgId, '2026-10-02', 'Bán quý sau', [['111', 555000, 0], ['511', 0, 555000]]);
    await entry(o.company, o.orgId, '2026-08-14', 'Bán của công ty', [['111', 999000, 0], ['511', 0, 999000]]);
    const w = await cnkd(o, 3);
    expect(w.period).toEqual({ year: 2026, quarter: 3, from: '2026-07-01', to: '2026-09-30' });
    expect(w.household).toEqual({ name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A' });
    expect(w.form).toMatchObject({ form: '01/CNKD', version: '2026.1', status: 'commentary' });
    // Revenue is the ledger's own movement of 511, so it ties to the account's credit less debit.
    const ledger = await query<{ debit: string; credit: string }>(o, 'finance.ledger.account', { period: '2026-Q3', legalEntityId: o.household, accountCode: '511' });
    expect(w.revenue).toBe(String(Number(ledger.credit) - Number(ledger.debit)));
    expect(w.revenue).toBe('1600000');
    expect(w.lines).toEqual([{ trade: 'goods', revenue: '1600000', vatPercent: '1', pitPercent: '0.5', vat: '16000', pit: '8000' }]);
    expect(w.unassigned).toBe('0');
    expect(w.totals).toEqual({ revenue: '1600000', vat: '16000', pit: '8000', tax: '24000' });
    expect(w.withheld).toEqual({ total: '0', settlements: [] });
    expect(w.due).toBe('24000');
    expect(w.overpaid).toBe('0');
    expect(w.commentary).toBe(true);
    expect(w.unconfirmed).toEqual([
      { kind: 'form', key: '01/CNKD 2026.1', effectiveFrom: '2026-01-01' },
      { kind: 'rate', key: 'goods', effectiveFrom: '2026-01-01' },
    ]);
    // Every role that reads the ledger reads it.
    for (const who of [o.admin, o.member, o.viewer]) expect((await cnkd(o, 3, {}, o.household, who)).revenue).toBe('1600000');
  });

  it('gives the Excel ask while a row behind the figures is commentary (the figures are labelled provisional), and drops the label once a later dated row confirms them (#2518)', async () => {
    const o = await org();
    await percentage(o);
    await entry(o.household, o.orgId, '2026-08-12', 'Bán hàng', [['111', 600000, 0], ['511', 0, 600000]]);
    await entry(o.household, o.orgId, '2026-11-12', 'Bán hàng', [['111', 400000, 0], ['511', 0, 400000]]);
    // Not refused: the answer says it is provisional and names the rows still waiting, and its totals are whole.
    const q3 = await cnkd(o, 3, { forExport: true });
    expect(q3.commentary).toBe(true);
    expect(q3.unconfirmed.length).toBeGreaterThan(0);
    expect(q3.totals).not.toBeNull();
    await confirmFromQ4();
    // Q3 keeps the rows it was made under (still provisional); Q4 sees the confirmed ones.
    expect((await cnkd(o, 3, { forExport: true })).commentary).toBe(true);
    const q4 = await cnkd(o, 4, { forExport: true });
    expect(q4).toMatchObject({ commentary: false, unconfirmed: [], form: { version: '2026.2', status: 'confirmed' } });
    expect(q4.totals).toEqual({ revenue: '400000', vat: '4000', pit: '2000', tax: '6000' });
    // The audit row of the download names the return like a book.
    await expect(execute(o, 'finance.household.export', { legalEntityId: o.household, book: '01/CNKD', period: '2026-Q4', rows: 1 })).resolves.toEqual({ ok: true });
    await expect(execute(o, 'finance.household.export', { legalEntityId: o.household, book: '01/XXX', period: '2026-Q4', rows: 1 })).rejects.toBeDefined();
  });

  it('rounds each tax to a whole dong and never lets a quarter of net returns owe a negative tax', async () => {
    const o = await org();
    await percentage(o);
    await entry(o.household, o.orgId, '2026-07-05', 'Bán hàng', [['111', 333333, 0], ['511', 0, 333333]]);
    const w = await cnkd(o, 3);
    // 333333 x 1% = 3333.33 and x 0.5% = 1666.665: whole dong, half up.
    expect(w.lines[0]).toMatchObject({ vat: '3333', pit: '1667' });
    expect(w.totals?.tax).toBe('5000');
    const r = await org();
    await percentage(r);
    await entry(r.household, r.orgId, '2026-07-05', 'Hoàn hàng quý sau bán quý trước', [['511', 50000, 0], ['111', 0, 50000]]);
    const net = await cnkd(r, 3);
    expect(net.revenue).toBe('-50000');
    expect(net.lines[0]).toMatchObject({ vat: '0', pit: '0' });
    expect(net.totals?.tax).toBe('0');
  });

  it('subtracts the tax the platforms withheld, from settlements that stand and end in the quarter', async () => {
    const o = await org();
    await percentage(o);
    await entry(o.household, o.orgId, '2026-08-12', 'Bán hàng', [['111', 1600000, 0], ['511', 0, 1600000]]);
    await settlement(o, 'shopee', '2026-07-01', '2026-07-15', 1200);
    await settlement(o, 'tiktok_shop', '2026-09-01', '2026-09-30', 3000);
    await settlement(o, 'shopee', '2026-10-01', '2026-10-15', 7000);
    const kept = await settlement(o, 'lazada', '2026-08-01', '2026-08-31', 5000);
    await settlement(o, 'lazada', '2026-08-01', '2026-08-31', 5000, kept);
    const w = await cnkd(o, 3);
    // The Lazada one was reversed (it and its reversal both drop out) and the October one ends in the next quarter.
    expect(w.withheld.settlements.map((s) => [s.platform, s.periodStart, s.periodEnd, s.taxWithheld])).toEqual([
      ['shopee', '2026-07-01', '2026-07-15', '1200'],
      ['tiktok_shop', '2026-09-01', '2026-09-30', '3000'],
    ]);
    expect(w.withheld.total).toBe('4200');
    expect(w.totals?.tax).toBe('24000');
    expect(w.due).toBe('19800');
    expect(w.overpaid).toBe('0');
    // More withheld than owed is shown as overpaid, never as a negative amount to pay.
    const small = await org();
    await percentage(small);
    await entry(small.household, small.orgId, '2026-08-12', 'Bán hàng', [['111', 100000, 0], ['511', 0, 100000]]);
    await settlement(small, 'shopee', '2026-07-01', '2026-07-15', 5000);
    const s = await cnkd(small, 3);
    expect(s.totals?.tax).toBe('1500');
    expect(s.due).toBe('0');
    expect(s.overpaid).toBe('3500');
  });

  it('asks the household for the split of a profile with several trades and never guesses it', async () => {
    const o = await org();
    await percentage(o, { trades: ['goods', 'services'] });
    await entry(o.household, o.orgId, '2026-08-12', 'Bán hàng và dịch vụ', [['111', 1600000, 0], ['511', 0, 1600000]]);
    const open = await cnkd(o, 3);
    expect(open.revenue).toBe('1600000');
    expect(open.unassigned).toBe('1600000');
    expect(open.totals).toBeNull();
    expect(open.due).toBeNull();
    expect(open.lines.map((l) => [l.trade, l.revenue])).toEqual([['goods', '0'], ['services', '0']]);
    const part = await cnkd(o, 3, { split: [{ trade: 'goods', revenue: '1000000' }] });
    expect(part.unassigned).toBe('600000');
    expect(part.totals).toBeNull();
    const whole = await cnkd(o, 3, { split: [{ trade: 'services', revenue: '600000' }, { trade: 'goods', revenue: '1000000' }] });
    expect(whole.unassigned).toBe('0');
    expect(whole.lines).toEqual([
      { trade: 'goods', revenue: '1000000', vatPercent: '1', pitPercent: '0.5', vat: '10000', pit: '5000' },
      { trade: 'services', revenue: '600000', vatPercent: '5', pitPercent: '2', vat: '30000', pit: '12000' },
    ]);
    expect(whole.totals).toEqual({ revenue: '1600000', vat: '40000', pit: '17000', tax: '57000' });
    // A split that does not fit is refused, never trimmed.
    for (const split of [
      [{ trade: 'goods', revenue: '1700000' }],
      [{ trade: 'goods', revenue: '1000000' }, { trade: 'goods', revenue: '1' }],
      [{ trade: 'catering', revenue: '1' }],
      [{ trade: 'goods', revenue: '-1' }],
    ]) {
      await expect(cnkd(o, 3, { split })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
    }
    // A household with one trade has nothing to split, and an incomplete split is not exported.
    const single = await org();
    await percentage(single);
    await expect(cnkd(single, 3, { split: [{ trade: 'goods', revenue: '0' }] })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
    await confirmFromQ4();
    await entry(o.household, o.orgId, '2026-11-12', 'Bán hàng và dịch vụ', [['111', 400000, 0], ['511', 0, 400000]]);
    await expect(cnkd(o, 4, { forExport: true })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
    // The August revenue is before this quarter in the same year, so the yearly rule (#3710 slice 3) also needs its split: all of it was goods.
    expect((await cnkd(o, 4, { forExport: true, split: [{ trade: 'goods', revenue: '400000' }], splitBefore: [{ trade: 'goods', revenue: '1600000' }] })).totals?.tax).toBe('6000');
  });

  it('refuses the entities and profiles that file no quarterly worksheet', async () => {
    const none = await org();
    await expect(cnkd(none, 3)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_NOT_REQUIRED' });
    await expect(cnkd(none, 3, {}, none.company)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_NOT_REQUIRED' });
    // Group 1 files no quarterly return (a yearly report, not built here).
    await setProfile(none);
    await expect(cnkd(none, 3)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_NOT_REQUIRED' });
    // A quarter before the household's books were opened.
    const late = await org();
    await percentage(late, { effectiveFrom: '2026-10-01' });
    await expect(cnkd(late, 3)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_NOT_REQUIRED' });
    // The income method is a later slice.
    const income = await org();
    await setProfile(income, { taxGroup: 3, pitMethod: 'income' });
    await expect(cnkd(income, 3)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_METHOD' });
    // A profile that changes inside the quarter cannot be asked for in parts.
    const changed = await org();
    await percentage(changed);
    await percentage(changed, { effectiveFrom: '2026-08-01', trades: ['goods', 'services'] });
    await expect(cnkd(changed, 3)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_PROFILE_CHANGED' });
    expect((await cnkd(changed, 4)).lines.map((l) => l.trade)).toEqual(['goods', 'services']);
    expect((await cnkd(changed, 2)).lines.map((l) => l.trade)).toEqual(['goods']);
  });

  it('starts a household that opened inside the quarter on its opening day', async () => {
    const o = await org();
    await percentage(o, { effectiveFrom: '2026-08-15' });
    await entry(o.household, o.orgId, '2026-08-01', 'Bán trước ngày mở sổ', [['111', 900000, 0], ['511', 0, 900000]]);
    await entry(o.household, o.orgId, '2026-08-20', 'Bán sau ngày mở sổ', [['111', 200000, 0], ['511', 0, 200000]]);
    const w = await cnkd(o, 3);
    expect(w.period.from).toBe('2026-08-15');
    expect(w.revenue).toBe('200000');
  });

  it('counts the sub-accounts of 511, leaves another entity\'s settlements out, and gives a multi-trade quarter of net returns nothing to split', async () => {
    const o = await org();
    await percentage(o);
    await entry(o.household, o.orgId, '2026-07-05', 'Bán dịch vụ', [['111', 250000, 0], ['5111', 0, 250000]]);
    await entry(o.household, o.orgId, '2026-07-06', 'Bán hàng', [['111', 750000, 0], ['511', 0, 750000]]);
    // A settlement of the org's other entity ends in the quarter too: it is not this household's tax.
    await settlement(o, 'shopee', '2026-07-01', '2026-07-15', 9000, null, o.company);
    await settlement(o, 'tiktok_shop', '2026-08-01', '2026-08-15', 1000);
    const w = await cnkd(o, 3);
    expect(w.revenue).toBe('1000000');
    expect(w.withheld.total).toBe('1000');
    expect(w.withheld.settlements.map((s) => s.platform)).toEqual(['tiktok_shop']);
    const returns = await org();
    await percentage(returns, { trades: ['goods', 'services'] });
    await entry(returns.household, returns.orgId, '2026-07-05', 'Hoàn hàng quý trước', [['511', 50000, 0], ['111', 0, 50000]]);
    const net = await cnkd(returns, 3);
    expect(net.revenue).toBe('-50000');
    expect(net.unassigned).toBe('0');
    expect(net.totals).toEqual({ revenue: '0', vat: '0', pit: '0', tax: '0' });
    // There is nothing to give a trade, so a positive split is still refused.
    await expect(cnkd(returns, 3, { split: [{ trade: 'goods', revenue: '1' }] })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
  });

  it('uses the percentages in force on the last day of the quarter, and a retired form files no worksheet', async () => {
    const o = await org();
    await percentage(o);
    await entry(o.household, o.orgId, '2027-01-10', 'Bán hàng', [['111', 1000000, 0], ['511', 0, 1000000]]);
    await entry(o.household, o.orgId, '2027-03-10', 'Bán hàng', [['111', 1000000, 0], ['511', 0, 1000000]]);
    // A rate that changes on 2027-02-01 applies to the whole of Q1 2027, whatever day a sale was on.
    await admin((a) => a.query("INSERT INTO ludy_finance.household_trade_rate (trade, effective_from, vat_percent, pit_percent, source, status) VALUES ('goods', DATE '2027-02-01', 2, 1, 'test', 'commentary') ON CONFLICT DO NOTHING"));
    const q1 = await cnkd(o, 1, {}, o.household, o.owner, 2027);
    expect(q1.lines[0]).toMatchObject({ vatPercent: '2', pitPercent: '1', vat: '40000', pit: '20000' });
    expect(q1.unconfirmed).toContainEqual({ kind: 'rate', key: 'goods', effectiveFrom: '2027-02-01' });
    // A later dated row with no method retires the form from its date; the quarters before it keep it.
    await admin((a) => a.query("INSERT INTO ludy_finance.household_return_form_version (form, version, effective_from, name, pit_methods, source, status) VALUES ('01/CNKD', '2027.1', DATE '2027-04-01', 'Tờ khai 01/CNKD', ARRAY[]::text[], 'test', 'commentary') ON CONFLICT DO NOTHING"));
    await expect(cnkd(o, 2, {}, o.household, o.owner, 2027)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_NOT_REQUIRED' });
    expect((await cnkd(o, 1, {}, o.household, o.owner, 2027)).form.version).toMatch(/^2026\.[12]$/);
  });

  describe('the Decree 174 VAT cut behind the profile answer (#3710 slice 2)', () => {
    // A quarter of goods revenue 1 600 000: VAT 1% = 16 000, PIT 0.5% = 8 000, and the cut of 20% takes 3 200 of the VAT.
    async function quarter(o: Org, over: Record<string, unknown> = {}) {
      await percentage(o, over);
      await entry(o.household, o.orgId, '2026-08-12', 'Bán hàng', [['111', 1600000, 0], ['511', 0, 1600000]]);
    }

    it('applies the cut when the profile answered yes: the VAT payable and what is left to pay follow it, and the VAT column stays the VAT before the cut', async () => {
      const o = await org();
      await quarter(o, { vatCutEligible: 'yes' });
      await settlement(o, 'shopee', '2026-07-01', '2026-07-15', 4200);
      const w = await cnkd(o, 3);
      expect(w.totals).toEqual({ revenue: '1600000', vat: '16000', pit: '8000', tax: '24000' });
      expect(w.vatCut).toEqual({
        answer: 'yes',
        percent: '20',
        applied: true,
        lines: [{ trade: 'goods', cut: '3200', vatPayable: '12800' }],
        total: { cut: '3200', vatPayable: '12800' },
        ifEligible: null,
      });
      // Owed: VAT payable 12 800 plus PIT 8 000 = 20 800; less the 4 200 the platform withheld.
      expect(w.due).toBe('16600');
      expect(w.overpaid).toBe('0');
    });

    it('applies no cut when the profile answered no', async () => {
      const o = await org();
      await quarter(o, { vatCutEligible: 'no' });
      const w = await cnkd(o, 3);
      expect(w.vatCut).toMatchObject({ answer: 'no', applied: false, total: { cut: '0', vatPayable: '16000' }, ifEligible: null });
      expect(w.due).toBe('24000');
    });

    it('computes without the cut when the profile has no answer, and shows what the VAT would be if eligible', async () => {
      const o = await org();
      await quarter(o);
      const w = await cnkd(o, 3);
      expect(w.vatCut).toMatchObject({ answer: null, applied: false, total: { cut: '0', vatPayable: '16000' }, ifEligible: { cut: '3200', vatPayable: '12800' } });
      expect(w.due).toBe('24000');
    });

    it('cuts nothing in a quarter after the cut ends, whatever the answer', async () => {
      const o = await org();
      await percentage(o, { vatCutEligible: 'yes' });
      await entry(o.household, o.orgId, '2027-02-12', 'Bán hàng', [['111', 1600000, 0], ['511', 0, 1600000]]);
      const w = await cnkd(o, 1, {}, o.household, o.owner, 2027);
      // The VAT percentage of 2027 is whatever the dated rows say (an earlier test of this file adds a row), so the figures are compared with the book's own, not with a number.
      expect(w.vatCut).toMatchObject({ answer: 'yes', percent: '0', applied: false, total: { cut: '0', vatPayable: w.totals?.vat }, ifEligible: null });
      expect(w.due).toBe(w.totals?.tax);
    });

    it('holds the cut totals back while revenue has no trade, like the tax totals', async () => {
      const o = await org();
      await percentage(o, { vatCutEligible: 'yes', trades: ['goods', 'services'] });
      await entry(o.household, o.orgId, '2026-08-12', 'Bán hàng', [['111', 1600000, 0], ['511', 0, 1600000]]);
      const w = await cnkd(o, 3, { split: [{ trade: 'goods', revenue: '1000000' }] });
      expect(w.totals).toBeNull();
      expect(w.vatCut).toMatchObject({ applied: true, total: null, ifEligible: null });
      expect(w.due).toBeNull();
    });
  });

  it('matches finance.ledger.account across 511 sub-accounts (active and inactive), reversals, returns, closing entries, non-511 accounts, and date boundaries (#3216)', async () => {
    const o = await org();
    await percentage(o);
    await execute(o, 'finance.account.create', { parentCode: '511', code: '511.SHOPEE', name: 'Doanh thu Shopee' });
    await execute(o, 'finance.account.create', { parentCode: '5111', code: '5111.LIVE', name: 'Doanh thu Livestream' });

    // Before Q3 (feeds year-to-date revenueBefore only).
    await entry(o.household, o.orgId, '2026-02-10', 'Bán Q1', [['111', 500000, 0], ['511', 0, 500000]]);
    await entry(o.household, o.orgId, '2026-06-30', 'Bán cuối Q2', [['111', 200000, 0], ['5111', 0, 200000]]);

    // Inside Q3: TT133 sub-accounts, active and later-deactivated org sub-accounts, reversal, debit return, non-511 accounts, and boundary days.
    await entry(o.household, o.orgId, '2026-07-01', 'Bán đầu Q3', [['111', 1000000, 0], ['511', 0, 1000000]]);
    await entry(o.household, o.orgId, '2026-07-15', 'Bán Shopee', [['112', 400000, 0], ['511.SHOPEE', 0, 400000]]);
    await entry(o.household, o.orgId, '2026-07-20', 'Bán Live', [['112', 300000, 0], ['5111.LIVE', 0, 300000]]);
    await execute(o, 'finance.account.update', { code: '5111.LIVE', active: false });
    const sale = await entry(o.household, o.orgId, '2026-08-05', 'Bán dịch vụ', [['131', 250000, 0], ['5113', 0, 250000]]);
    await entry(o.household, o.orgId, '2026-08-06', 'Đảo bán dịch vụ', [['5113', 250000, 0], ['131', 0, 250000]], { reverses: sale });
    await entry(o.household, o.orgId, '2026-08-10', 'Giảm trừ ghi nợ 5111', [['5111', 150000, 0], ['111', 0, 150000]]);
    await entry(o.household, o.orgId, '2026-08-15', 'Doanh thu tài chính 515', [['112', 80000, 0], ['515', 0, 80000]]);
    await entry(o.household, o.orgId, '2026-08-15', 'Thu nhập khác 711', [['111', 40000, 0], ['711', 0, 40000]]);
    await entry(o.household, o.orgId, '2026-08-15', 'Chi phí 642', [['642', 120000, 0], ['111', 0, 120000]]);
    await entry(o.household, o.orgId, '2026-09-30', 'Bán cuối Q3', [['111', 250000, 0], ['5118', 0, 250000]]);

    // Inside Q4, including a 911 closing-style entry touching 511.
    await entry(o.household, o.orgId, '2026-10-01', 'Bán đầu Q4', [['111', 900000, 0], ['511', 0, 900000]]);
    await entry(o.household, o.orgId, '2026-12-31', 'Kết chuyển cuối năm', [['511', 200000, 0], ['911', 0, 200000]]);

    // Another legal entity and another org must stay isolated.
    await entry(o.company, o.orgId, '2026-08-15', 'Bán của công ty', [['111', 888000, 0], ['511', 0, 888000]]);
    const other = await org();
    await percentage(other);
    await entry(other.household, other.orgId, '2026-08-15', 'Bán tổ chức khác', [['111', 777000, 0], ['511', 0, 777000]]);

    const q3 = await cnkd(o, 3);
    const ledgerQ3 = await query<{ debit: string; credit: string }>(o, 'finance.ledger.account', { period: '2026-Q3', legalEntityId: o.household, accountCode: '511' });
    expect(q3.revenue).toBe(money(ledgerQ3.credit).minus(money(ledgerQ3.debit)).toFixed());
    expect(q3.revenue).toBe('1800000');
    expect(q3.yearToDate.revenueBefore).toBe('700000');
    expect(q3.yearToDate.revenueToDate).toBe('2500000');

    const q4 = await cnkd(o, 4);
    const ledgerQ4 = await query<{ debit: string; credit: string }>(o, 'finance.ledger.account', { period: '2026-Q4', legalEntityId: o.household, accountCode: '511' });
    expect(q4.revenue).toBe(money(ledgerQ4.credit).minus(money(ledgerQ4.debit)).toFixed());
    expect(q4.revenue).toBe('700000');
    expect(q4.yearToDate.revenueBefore).toBe('2500000');
    expect(q4.yearToDate.revenueToDate).toBe('3200000');

    // Mid-quarter opening counts entries before `from` in revenueBefore and from `from` onwards in revenue.
    const mid = await org();
    await percentage(mid, { effectiveFrom: '2026-08-15' });
    await entry(mid.household, mid.orgId, '2026-02-10', 'Trước mở sổ Q1', [['111', 300000, 0], ['511', 0, 300000]]);
    await entry(mid.household, mid.orgId, '2026-08-14', 'Trước mở sổ Q3', [['111', 400000, 0], ['511', 0, 400000]]);
    await entry(mid.household, mid.orgId, '2026-08-15', 'Ngày mở sổ', [['111', 600000, 0], ['511', 0, 600000]]);
    const midQ3 = await cnkd(mid, 3);
    expect(midQ3.revenue).toBe('600000');
    expect(midQ3.yearToDate.revenueBefore).toBe('700000');
    expect(midQ3.yearToDate.revenueToDate).toBe('1300000');
  });

  it('computes 01/CNKD without PERIOD_TOO_LARGE when a quarter exceeds 50,000 ledger lines (#3216)', { timeout: 120_000 }, async () => {
    const o = await org();
    await percentage(o);
    await execute(o, 'finance.account.create', { parentCode: '511', code: '511.SHOPEE', name: 'Doanh thu Shopee' });

    // Q3 has > 50,000 non-511 lines (25,001 entries x 2 lines on 642/112) plus a few 511 entries; Q4 has > 50,000 lines directly on 511 entries.
    await admin(async (a) => {
      await a.query('BEGIN');
      await a.query('SET LOCAL session_replication_role = replica');
      await a.query(
        `CREATE TEMP TABLE bulk_entries ON COMMIT DROP AS
         SELECT g, ludy_kernel.uuid_v7() AS entry_id, ludy_kernel.uuid_v7() AS source_id,
                CASE WHEN g <= 25001 THEN DATE '2026-07-01' + (g % 90) ELSE DATE '2026-10-01' + (g % 90) END AS entry_date,
                (g > 25001) AS is_sales
         FROM pg_catalog.generate_series(1, 50002) g`,
      );
      await a.query(
        `INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id)
         SELECT $1, entry_id, entry_date, 'Bút toán lô ' || g, 'finance.journal_voucher', source_id, $2 FROM bulk_entries`,
        [o.orgId, o.household],
      );
      await a.query(
        `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, legal_entity_id)
         SELECT $1::uuid, entry_id, 1, CASE WHEN is_sales THEN '111' ELSE '642' END, CASE WHEN is_sales THEN 100 ELSE 1000 END, 0, $2::uuid FROM bulk_entries
         UNION ALL
         SELECT $1::uuid, entry_id, 2, CASE WHEN is_sales THEN '511' ELSE '112' END, 0, CASE WHEN is_sales THEN 100 ELSE 1000 END, $2::uuid FROM bulk_entries`,
        [o.orgId, o.household],
      );
      await a.query('COMMIT');
    });

    await entry(o.household, o.orgId, '2026-07-10', 'Bán lẻ Q3', [['111', 1000000, 0], ['511', 0, 1000000]]);
    await entry(o.household, o.orgId, '2026-08-12', 'Bán Shopee Q3', [['112', 500000, 0], ['511.SHOPEE', 0, 500000]]);
    const reversed = await entry(o.household, o.orgId, '2026-09-01', 'Bán nhầm Q3', [['131', 200000, 0], ['5111', 0, 200000]]);
    await entry(o.household, o.orgId, '2026-09-02', 'Đảo bán Q3', [['5111', 200000, 0], ['131', 0, 200000]], { reverses: reversed });

    // Confirm both quarters actually exceed LEDGER_LINE_LIMIT in the ledger report path.
    await expect(query(o, 'finance.ledger.account', { period: '2026-Q3', legalEntityId: o.household, accountCode: '511' })).rejects.toMatchObject({ code: 'PERIOD_TOO_LARGE' });
    await expect(query(o, 'finance.ledger.account', { period: '2026-Q4', legalEntityId: o.household, accountCode: '511' })).rejects.toMatchObject({ code: 'PERIOD_TOO_LARGE' });

    const q3 = await cnkd(o, 3);
    expect(q3.revenue).toBe('1500000');
    expect(q3.totals).toEqual({ revenue: '1500000', vat: '15000', pit: '7500', tax: '22500' });
    expect(q3.due).toBe('22500');

    const q4 = await cnkd(o, 4);
    expect(q4.revenue).toBe('2500100');
    expect(q4.yearToDate.revenueBefore).toBe('1500000');
    expect(q4.yearToDate.revenueToDate).toBe('4000100');
  });
});
