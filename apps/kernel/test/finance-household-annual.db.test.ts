// SPDX-License-Identifier: AGPL-3.0-only
// The yearly rule of the household tax (#3710 slice 3, research 2026-11-18 B1 and B2) on PostgreSQL 17, on the REAL seeded law rows (the other household files set the threshold and the PIT cut to 0 to test their
// own subjects with small revenues): nothing is owed up to the threshold of 1 billion VND; above it VAT on all the revenue and PIT only on the part above; the VAT cut of Decree 174 only on the household's yes; the PIT
// cut of Decree 398 up to its ceiling; the household's pick of the trade that takes the deduction (asked, never defaulted); a period is the year-to-date tax at its last day less the year-to-date tax before it; the
// threshold counts the whole year's revenue, entries before the household's first profile included. Covers S2a, S2b and the 01/CNKD. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HouseholdCnkd, HouseholdProfileView, HouseholdS2a, HouseholdS2b } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the yearly rule of the household tax (#3710 slice 3)', () => {
  const dbName = `ludy_test_household_s2a_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  type Org = { orgId: string; owner: string; viewer: string; company: string; household: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Hộ Kinh Doanh ${randomUUID().slice(0, 6)}`);
    const viewer = await identity('viewer');
    await admin((c) => c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]));
    const company = (await admin((c) => c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id as string;
    const household = randomUUID();
    await admin((c) =>
      c.query("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Hộ kinh doanh Nguyễn Văn A', 'household', $3)", [orgId, household, owner]),
    );
    return { orgId, owner, viewer, company, household };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const setProfile = (o: Org, over: Record<string, unknown> = {}) =>
    execute<HouseholdProfileView>(o, 'finance.household.profile_set', {
      legalEntityId: o.household,
      effectiveFrom: '2026-01-01',
      taxGroup: 2,
      pitMethod: 'percentage',
      trades: ['goods', 'services'],
      einvoiceRegistered: false,
      representativeName: 'Nguyễn Văn A',
      ...over,
    });
  const s2a = (o: Org, period: string, entity = o.household, user = o.owner) => query<HouseholdS2a>(o, 'finance.household.s2a', { legalEntityId: entity, period }, user);

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
    // The real law rows, as seeded: the threshold of 1 billion VND, the VAT cut of 20% and the PIT cut of 30% up to 10 billion, the rates and the layouts, all `confirmed`.
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

  // A stock item of the household with a trade, written by the database owner.
  async function item(o: Org, code: string, trade: string): Promise<string> {
    return admin(async (a) => (await a.query<{ id: string }>("INSERT INTO ludy_finance.stock_item (org_id, legal_entity_id, code, name, unit, stock_account, trade) VALUES ($1, $2, $3, $3, 'cái', '156', $4) RETURNING id", [o.orgId, o.household, code, trade])).rows[0]?.id as string);
  }
  // An entry of the household's ledger written by the database owner (the triggers fire as for any writer). A reversal mirrors its original line by line (same line number and account, debit and credit swapped). With `sale`, the entry is the posting of a sale document of the entity whose lines (net amount, stock item
  // or none) each make a live stock move; `reverses` makes it the reversal of another entry.
  async function entry(
    o: Org,
    date: string,
    description: string,
    lines: Array<[string, number, number]>,
    over: { sale?: Array<{ amount: number; item: string | null }>; reverses?: string; entity?: string } = {},
  ): Promise<string> {
    const entity = over.entity ?? o.household;
    return admin(async (a) => {
      await a.query('BEGIN');
      try {
        let document: string | null = null;
        if (over.sale) {
          const party = (await a.query<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name) VALUES ($1, 'Khách lẻ') RETURNING id", [o.orgId])).rows[0]?.id;
          const total = over.sale.reduce((acc, l) => acc + l.amount, 0);
          document = (
            await a.query<{ id: string }>(
              "INSERT INTO ludy_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id) VALUES ($1, $2, '1C26TAA', $3, $4, $5, 0, $5, 'sale', $6) RETURNING id",
              [o.orgId, party, `S${randomUUID().slice(0, 8)}`, date, total, entity],
            )
          ).rows[0]?.id as string;
          // A sale line names its credit account alone (purchase_line_one_account).
          let no = 1;
          for (const l of over.sale) {
            await a.query("INSERT INTO ludy_finance.purchase_line (org_id, document_id, line_no, description, amount, credit_account) VALUES ($1, $2, $3, $4, $5, '511')", [o.orgId, document, no, `Dòng ${no}`, l.amount]);
            if (l.item) {
              await a.query(
                "INSERT INTO ludy_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type, document_id, line_no, line_attempt) VALUES ($1, $2, $3, $4, -1, 'document_line', $5, $6, 1)",
                [o.orgId, entity, l.item, date, document, no],
              );
            }
            no += 1;
          }
        }
        const id = (
          await a.query<{ id: string }>(
            'INSERT INTO ludy_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id, reverses_entry_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [o.orgId, date, description, document ? 'finance.purchase_document' : 'finance.journal_voucher', document ?? randomUUID(), entity, over.reverses ?? null],
          )
        ).rows[0]?.id as string;
        let no = 1;
        for (const [account, debit, credit] of lines) await a.query('INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, id, no++, account, debit, credit]);
        // The only way to reverse the entry of a sale document is a void, written in the same transaction (a deferred trigger demands it), and a void takes the stock of every line back: the
        // document's stock moves are reversed, as finance.journal.reverse does. The reversed moves stay, so the book still sees which item each line was sold as.
        if (over.reverses) {
          const original = (await a.query<{ source_type: string; source_id: string }>('SELECT source_type, source_id FROM ludy_finance.journal_entry WHERE org_id = $1 AND id = $2', [o.orgId, over.reverses])).rows[0];
          if (original?.source_type === 'finance.purchase_document') {
            const moves = await a.query<{ id: string; item_id: string; quantity: string }>("SELECT id, item_id, quantity FROM ludy_finance.stock_move WHERE org_id = $1 AND document_id = $2 AND source_type = 'document_line'", [o.orgId, original.source_id]);
            for (const m of moves.rows) {
              await a.query("INSERT INTO ludy_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type, reverses_move_id) VALUES ($1, $2, $3, $4, $5, 'reversal', $6)", [o.orgId, entity, m.item_id, date, -Number(m.quantity), m.id]);
            }
            await a.query("INSERT INTO ludy_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'Hủy hóa đơn')", [o.orgId, original.source_id, id]);
          }
        }
        await a.query('COMMIT');
        return id;
      } catch (error) {
        await a.query('ROLLBACK');
        throw error;
      }
    });
  }

  const BILLION = 1_000_000_000;
  const s2b = (o: Org, period: string) => query<HouseholdS2b>(o, 'finance.household.s2b', { legalEntityId: o.household, period });
  const cnkd = (o: Org, quarter: 1 | 2 | 3 | 4, over: Record<string, unknown> = {}) => query<HouseholdCnkd>(o, 'finance.household.cnkd', { legalEntityId: o.household, year: 2026, quarter, ...over });
  // A household of one trade that pays by percentage (S2a and the 01/CNKD).
  const goodsOnly = (o: Org, over: Record<string, unknown> = {}) => setProfile(o, { trades: ['goods'], ...over });
  // A revenue entry with no sale document behind it (a voucher): with one trade it all lands on that trade.
  const revenue = (o: Org, date: string, amount: number) => entry(o, date, 'Doanh thu', [['111', amount, 0], ['511', 0, amount]]);
  // The acceptance example: goods 1.2 billion in the year, the household answered yes. VAT 1.2bn x 1% = 12 000 000 less the 20% cut (2 400 000); PIT (1.2bn - 1bn) x 0.5% = 1 000 000 less the 30% cut (300 000).
  const EXAMPLE = { vatBefore: '12000000', vatCut: '2400000', vat: '9600000', pitBefore: '1000000', pitCut: '300000', pit: '700000' };

  describe('S2a', () => {
    it('the acceptance example: goods 1.2 billion owes VAT on all of it less 20% and PIT on the 0.2 billion above less 30%', async () => {
      const o = await org();
      await goodsOnly(o, { vatCutEligible: 'yes' });
      await revenue(o, '2026-09-05', 1.2 * BILLION);
      const book = await s2a(o, '2026-09');
      expect(book.yearToDate).toMatchObject({
        year: 2026,
        revenueToDate: '1200000000',
        revenueBefore: '0',
        threshold: { amount: '1000000000', effectiveFrom: '2026-01-01', status: 'confirmed' },
        crossed: true,
        deductionTrade: 'goods',
        deductionNeeded: false,
        payable: EXAMPLE,
        pitCut: { percent: '30', ceiling: '10000000000', applied: true },
      });
      // The columns of the book stay revenue times the percentage, as the fixed reference.
      expect(book.totals).toMatchObject({ vat: '12000000', pit: '6000000' });
      // The law rows are confirmed, so nothing about the yearly rule makes the book provisional beyond the rows the test restores nothing of.
      expect(book.unconfirmed.filter((u) => u.kind === 'threshold' || (u.kind === 'reduction' && u.key === 'pit'))).toEqual([]);
    });

    it('owes nothing up to the threshold, whatever the answer', async () => {
      const o = await org();
      await goodsOnly(o, { vatCutEligible: 'yes' });
      await revenue(o, '2026-09-05', 0.9 * BILLION);
      const book = await s2a(o, '2026-09');
      expect(book.yearToDate).toMatchObject({ revenueToDate: '900000000', crossed: false, payable: { vat: '0', pit: '0', vatCut: '0', pitCut: '0' } });
      const exactly = await org();
      await goodsOnly(exactly);
      await revenue(exactly, '2026-09-05', BILLION);
      expect((await s2a(exactly, '2026-09')).yearToDate).toMatchObject({ crossed: false, payable: { vat: '0', pit: '0' } });
    });

    it('computes without the VAT cut when the household has not answered, and the PIT cut still applies (it needs no answer)', async () => {
      const o = await org();
      await goodsOnly(o);
      await revenue(o, '2026-09-05', 1.2 * BILLION);
      const book = await s2a(o, '2026-09');
      expect(book.yearToDate.payable).toEqual({ vatBefore: '12000000', vatCut: '0', vat: '12000000', pitBefore: '1000000', pitCut: '300000', pit: '700000' });
    });

    it('a period is the year-to-date tax at its last day less the year-to-date tax before it, so the months add up to the year', async () => {
      const o = await org();
      await goodsOnly(o, { vatCutEligible: 'yes' });
      await revenue(o, '2026-08-10', 0.6 * BILLION);
      await revenue(o, '2026-09-10', 0.6 * BILLION);
      await revenue(o, '2026-10-10', 0.1 * BILLION);
      // August is under the threshold; September crosses it and carries the catch-up of the whole year so far.
      expect((await s2a(o, '2026-08')).yearToDate.payable).toMatchObject({ vat: '0', pit: '0' });
      expect((await s2a(o, '2026-09')).yearToDate.payable).toEqual(EXAMPLE);
      // October: 1.3 billion to date, VAT 13 000 000 less 2 600 000, PIT 1 500 000 less 450 000; less the 1.2 billion figures.
      const october = await s2a(o, '2026-10');
      expect(october.yearToDate).toMatchObject({ revenueToDate: '1300000000', revenueBefore: '1200000000' });
      expect(october.yearToDate.payable).toEqual({ vatBefore: '1000000', vatCut: '200000', vat: '800000', pitBefore: '500000', pitCut: '150000', pit: '350000' });
      const year = await s2a(o, '2026');
      expect(year.yearToDate.payable).toEqual({ vatBefore: '13000000', vatCut: '2600000', vat: '10400000', pitBefore: '1500000', pitCut: '450000', pit: '1050000' });
    });

    it('counts the entries before the first profile towards the threshold, though the book does not list them', async () => {
      const o = await org();
      await goodsOnly(o, { effectiveFrom: '2026-09-01', vatCutEligible: 'yes' });
      await revenue(o, '2026-03-10', 0.9 * BILLION);
      await revenue(o, '2026-09-20', 0.3 * BILLION);
      const book = await s2a(o, '2026-09');
      expect(book.rows).toHaveLength(1);
      expect(book.total).toBe('300000000');
      expect(book.yearToDate).toMatchObject({ revenueToDate: '1200000000', revenueBefore: '900000000', crossed: true, payable: EXAMPLE });
    });

    it('gives no PIT cut above its ceiling, and the PIT is still owed on the part above the threshold', async () => {
      const o = await org();
      await goodsOnly(o);
      await revenue(o, '2026-09-05', 10 * BILLION + 1);
      const book = await s2a(o, '2026-09');
      expect(book.yearToDate.pitCut).toMatchObject({ applied: false });
      // PIT (10 000 000 001 - 1 000 000 000) x 0.5% = 45 000 000.005, to a whole dong; no cut.
      expect(book.yearToDate.payable).toMatchObject({ pitBefore: '45000000', pitCut: '0', pit: '45000000' });
    });

    it('asks a household of several trades which trade takes the deduction, holds the PIT back until it is given, and never picks one', async () => {
      const o = await org();
      await setProfile(o, { vatCutEligible: 'yes' });
      const shirt = await item(o, 'AO', 'goods');
      const repair = await item(o, 'SUA', 'services');
      await entry(o, '2026-09-05', 'Bán hàng và sửa chữa', [['111', 2 * BILLION, 0], ['511', 0, 2 * BILLION]], { sale: [{ amount: 0.8 * BILLION, item: shirt }, { amount: 1.2 * BILLION, item: repair }] });
      const asked = await s2a(o, '2026-09');
      expect(asked.yearToDate).toMatchObject({ crossed: true, deductionNeeded: true, deductionTrade: null, payable: null });
      // Goods have less than the threshold in the year, so they cannot take it: still asked.
      expect((await query<HouseholdS2a>(o, 'finance.household.s2a', { legalEntityId: o.household, period: '2026-09', deductionTrade: 'goods' })).yearToDate).toMatchObject({ deductionNeeded: true, payable: null });
      // Services take it: VAT goods 8 000 000 and services 60 000 000, less the cut (1 600 000 and 12 000 000); PIT goods 4 000 000 and services (1.2bn - 1bn) x 2% = 4 000 000, less 30%.
      const picked = await query<HouseholdS2a>(o, 'finance.household.s2a', { legalEntityId: o.household, period: '2026-09', deductionTrade: 'services' });
      expect(picked.yearToDate).toMatchObject({ deductionNeeded: false, deductionTrade: 'services' });
      expect(picked.yearToDate.payable).toEqual({ vatBefore: '68000000', vatCut: '13600000', vat: '54400000', pitBefore: '8000000', pitCut: '2400000', pit: '5600000' });
    });

    it('does not ask for a pick when no single trade reaches the threshold: the PIT is held back for the accountant, the research giving no rule for the rest of the deduction', async () => {
      const o = await org();
      await setProfile(o);
      const shirt = await item(o, 'AO', 'goods');
      const repair = await item(o, 'SUA', 'services');
      // Goods 600 million and services 700 million: 1.3 billion in all, but neither trade has the 1 billion the deduction takes.
      await entry(o, '2026-09-05', 'Bán hàng và sửa chữa', [['111', 1.3 * BILLION, 0], ['511', 0, 1.3 * BILLION]], { sale: [{ amount: 0.6 * BILLION, item: shirt }, { amount: 0.7 * BILLION, item: repair }] });
      const book = await s2a(o, '2026-09');
      expect(book.yearToDate).toMatchObject({ crossed: true, deductionNeeded: false, deductionShort: true, deductionTrade: null, payable: null });
      // A pick changes nothing.
      const picked = await query<HouseholdS2a>(o, 'finance.household.s2a', { legalEntityId: o.household, period: '2026-09', deductionTrade: 'services' });
      expect(picked.yearToDate).toMatchObject({ deductionNeeded: false, deductionShort: true, payable: null });
    });

    it('holds the period back as short when the side before it could not be worked out, though the pick is usable at its end', async () => {
      const o = await org();
      await setProfile(o);
      const shirt = await item(o, 'AO', 'goods');
      const repair = await item(o, 'SUA', 'services');
      // By the end of June: goods 500 million and services 600 million (1.1 billion, no trade reaching the threshold). In September services reach 1.5 billion.
      await entry(o, '2026-02-10', 'Quý một', [['111', 1.1 * BILLION, 0], ['511', 0, 1.1 * BILLION]], { sale: [{ amount: 0.5 * BILLION, item: shirt }, { amount: 0.6 * BILLION, item: repair }] });
      await entry(o, '2026-09-10', 'Quý ba', [['111', 0.9 * BILLION, 0], ['511', 0, 0.9 * BILLION]], { sale: [{ amount: 0.9 * BILLION, item: repair }] });
      const book = await query<HouseholdS2a>(o, 'finance.household.s2a', { legalEntityId: o.household, period: '2026-09', deductionTrade: 'services' });
      expect(book.yearToDate).toMatchObject({ revenueToDate: '2000000000', revenueBefore: '1100000000', deductionNeeded: false, deductionShort: true, payable: null });
    });

    it('holds the tax back while revenue has no trade yet, but still says the threshold is crossed', async () => {
      const o = await org();
      await setProfile(o);
      await revenue(o, '2026-09-05', 1.5 * BILLION);
      const book = await s2a(o, '2026-09');
      expect(book.yearToDate).toMatchObject({ revenueToDate: '1500000000', crossed: true, payable: null });
    });
  });

  describe('S2b', () => {
    it('works the VAT on all the revenue above the threshold, no PIT, and asks for no pick', async () => {
      const o = await org();
      await setProfile(o, { taxGroup: 3, pitMethod: 'income', vatCutEligible: 'yes' });
      const shirt = await item(o, 'AO', 'goods');
      const repair = await item(o, 'SUA', 'services');
      await entry(o, '2026-09-05', 'Bán hàng và sửa chữa', [['111', 2 * BILLION, 0], ['511', 0, 2 * BILLION]], { sale: [{ amount: 0.8 * BILLION, item: shirt }, { amount: 1.2 * BILLION, item: repair }] });
      const book = await s2b(o, '2026-09');
      expect(book.yearToDate).toMatchObject({ crossed: true, deductionNeeded: false, deductionTrade: null, pitCut: null });
      expect(book.yearToDate.payable).toEqual({ vatBefore: '68000000', vatCut: '13600000', vat: '54400000', pitBefore: '0', pitCut: '0', pit: '0' });
    });

    it('owes no VAT up to the threshold', async () => {
      const o = await org();
      await setProfile(o, { taxGroup: 3, pitMethod: 'income', trades: ['goods'] });
      await revenue(o, '2026-09-05', 0.5 * BILLION);
      expect((await s2b(o, '2026-09')).yearToDate).toMatchObject({ crossed: false, payable: { vat: '0' } });
    });
  });

  describe('01/CNKD', () => {
    it('the acceptance example: what is owed for the quarter is the VAT and the PIT of the year so far, less what the platforms withheld', async () => {
      const o = await org();
      await goodsOnly(o, { vatCutEligible: 'yes', taxGroup: 2, pitMethod: 'percentage' });
      await revenue(o, '2026-08-12', 1.2 * BILLION);
      const w = await cnkd(o, 3);
      expect(w.yearToDate).toMatchObject({ crossed: true, payable: EXAMPLE, deductionTrade: 'goods' });
      // VAT payable 9 600 000 plus PIT payable 700 000.
      expect(w.due).toBe('10300000');
      expect(w.overpaid).toBe('0');
    });

    it('never holds a household of one trade back for revenue with no sale document: vouchers before and in the quarter all land on its trade, with no split asked', async () => {
      const o = await org();
      await goodsOnly(o, { vatCutEligible: 'yes', taxGroup: 2, pitMethod: 'percentage' });
      await revenue(o, '2026-02-10', 0.7 * BILLION);
      await revenue(o, '2026-08-12', 0.5 * BILLION);
      const w = await cnkd(o, 3);
      expect(w.yearToDate).toMatchObject({ revenueToDate: '1200000000', revenueBefore: '700000000', crossed: true, deductionNeeded: false, deductionTrade: 'goods', payable: EXAMPLE });
      const book = await s2a(o, '2026-08');
      expect(book.yearToDate.payable).toEqual(EXAMPLE);
    });

    it('owes nothing in a quarter under the threshold, and the quarter that crosses it carries the catch-up of the year', async () => {
      const o = await org();
      await goodsOnly(o, { vatCutEligible: 'yes' });
      await revenue(o, '2026-02-10', 0.9 * BILLION);
      await revenue(o, '2026-08-12', 0.3 * BILLION);
      const q1 = await cnkd(o, 1);
      expect(q1.yearToDate).toMatchObject({ revenueToDate: '900000000', crossed: false });
      expect(q1.due).toBe('0');
      const q3 = await cnkd(o, 3);
      expect(q3.yearToDate).toMatchObject({ revenueToDate: '1200000000', revenueBefore: '900000000', crossed: true, payable: EXAMPLE });
      expect(q3.due).toBe('10300000');
    });

    it('asks a household of several trades for the split of the year before the quarter and for the deduction trade, and holds the tax back until they are given', async () => {
      const o = await org();
      await setProfile(o, { vatCutEligible: 'yes' });
      await revenue(o, '2026-02-10', 0.6 * BILLION);
      await revenue(o, '2026-08-12', 1.4 * BILLION);
      const quarter = [{ trade: 'services', revenue: String(1.4 * BILLION) }];
      const before = [{ trade: 'goods', revenue: String(0.6 * BILLION) }];
      // Everything given: goods 600m and services 1.4bn. VAT goods 6 000 000 and services 70 000 000, less the cut (1 200 000 and 14 000 000); PIT goods 3 000 000 and services (1.4bn - 1bn) x 2% = 8 000 000, less 30%.
      const full = await cnkd(o, 3, { split: quarter, splitBefore: before, deductionTrade: 'services' });
      expect(full.yearToDate.payable).toEqual({ vatBefore: '76000000', vatCut: '15200000', vat: '60800000', pitBefore: '11000000', pitCut: '3300000', pit: '7700000' });
      expect(full.due).toBe('68500000');
      // No pick: the PIT is held back, and so is the amount due; the Excel ask is refused.
      const asked = await cnkd(o, 3, { split: quarter, splitBefore: before });
      expect(asked.yearToDate).toMatchObject({ deductionNeeded: true, payable: null });
      expect(asked.due).toBeNull();
      await expect(cnkd(o, 3, { split: quarter, splitBefore: before, forExport: true })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
      // The revenue before the quarter not given a trade holds the tax back.
      const missing = await cnkd(o, 3, { split: quarter, deductionTrade: 'services' });
      expect(missing.yearToDate.payable).toBeNull();
      expect(missing.due).toBeNull();
      // The year's totals are the ledger's whatever the household has split: the revenue before the quarter shows even with no split (the screen needs it to ask for one), and the threshold is judged on it.
      expect(missing.yearToDate).toMatchObject({ revenueBefore: '600000000', revenueToDate: '2000000000', crossed: true });
      expect((await cnkd(o, 3, { split: quarter })).yearToDate).toMatchObject({ revenueBefore: '600000000', revenueToDate: '2000000000', crossed: true, payable: null });
    });

    it('holds the tax back, and says so, when net returns or an earlier profile with other trades leave revenue that no split can place', async () => {
      // Two trades; 1.2 billion before, then 300 million of returns in Q2 that no trade takes: the year is 900 million, but the returns have no trade, so nothing is exported on 1.2 billion.
      const returns = await org();
      await setProfile(returns, {});
      await revenue(returns, '2026-02-10', 1.2 * BILLION);
      await entry(returns, '2026-05-10', 'Hàng trả lại', [['511', 0.3 * BILLION, 0], ['111', 0, 0.3 * BILLION]]);
      const q2 = await cnkd(returns, 2, { splitBefore: [{ trade: 'goods', revenue: String(1.2 * BILLION) }], deductionTrade: 'goods' });
      expect(q2.yearToDate).toMatchObject({ revenueToDate: '900000000', revenueBefore: '1200000000', payable: null });
      await expect(cnkd(returns, 2, { splitBefore: [{ trade: 'goods', revenue: String(1.2 * BILLION) }], deductionTrade: 'goods', forExport: true })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
      // Net returns before the quarter with the quarter fully split: asking for the deduction trade would not release the hold, so the refusal sends the household to the accountant.
      const before = await org();
      await setProfile(before, {});
      await entry(before, '2026-02-10', 'Hàng trả lại', [['511', 0.1 * BILLION, 0], ['111', 0, 0.1 * BILLION]]);
      await revenue(before, '2026-08-12', 2 * BILLION);
      const full = [{ trade: 'goods', revenue: String(1.4 * BILLION) }, { trade: 'services', revenue: String(0.6 * BILLION) }];
      await expect(cnkd(before, 3, { split: full, forExport: true })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID', message: expect.stringContaining('nhờ kế toán') });
      // One trade now, two before: the sales before the quarter were made under the old profile, so they are not put on the new sole trade.
      const changed = await org();
      await setProfile(changed, { effectiveFrom: '2026-01-01' });
      await goodsOnly(changed, { effectiveFrom: '2026-07-01' });
      await revenue(changed, '2026-02-10', 1.2 * BILLION);
      await revenue(changed, '2026-08-12', 0.1 * BILLION);
      expect((await cnkd(changed, 3)).yearToDate).toMatchObject({ revenueToDate: '1300000000', crossed: true, payable: null });
      // A profile that takes effect on 1 January replaces the one before it: services was the sole trade for the whole year, so nothing is held.
      const newYear = await org();
      await setProfile(newYear, { effectiveFrom: '2025-06-01' });
      await setProfile(newYear, { trades: ['services'], effectiveFrom: '2026-01-01' });
      await revenue(newYear, '2026-02-10', 1.2 * BILLION);
      await revenue(newYear, '2026-08-12', 0.1 * BILLION);
      expect((await cnkd(newYear, 3)).yearToDate).toMatchObject({ revenueToDate: '1300000000', crossed: true, deductionNeeded: false });
      expect((await cnkd(newYear, 3)).yearToDate.payable).not.toBeNull();
      // The same single-trade household that never changed trades is not held (the test above).
    });

    it('refuses a split of the revenue before the quarter that no household of one trade needs, or that is not valid', async () => {
      const one = await org();
      await goodsOnly(one);
      await revenue(one, '2026-02-10', 0.6 * BILLION);
      await revenue(one, '2026-08-12', 0.1 * BILLION);
      await expect(cnkd(one, 3, { splitBefore: [{ trade: 'goods', revenue: '1' }] })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
      const many = await org();
      await setProfile(many);
      await revenue(many, '2026-02-10', 0.6 * BILLION);
      await revenue(many, '2026-08-12', 0.1 * BILLION);
      const quarter = [{ trade: 'goods', revenue: String(0.1 * BILLION) }];
      await expect(cnkd(many, 3, { split: quarter, splitBefore: [{ trade: 'goods', revenue: String(0.7 * BILLION) }] })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
      await expect(cnkd(many, 3, { split: quarter, splitBefore: [{ trade: 'goods', revenue: '1' }, { trade: 'goods', revenue: '2' }] })).rejects.toMatchObject({ code: 'HOUSEHOLD_SPLIT_INVALID' });
    });
  });
});
