// SPDX-License-Identifier: AGPL-3.0-only
// The two reads behind the new "Hỏi đáp sổ sách" entries (#5338) on PostgreSQL 17, from a real ledger: finance.aging puts the open 131 or 331 in the buckets not due, 1-30, 31-60, 61-90 and over 90 days past due as of a day,
// with the due dates the reminders and the forecast use (customer or org terms; a purchase invoice's own due date, else the invoice date plus 30, said as an estimate), the balance no invoice covers as its own figure and the
// other side of the account as its own figure; finance.party_ranking ranks the customers by sales or the suppliers by purchases of invoiced documents, net of VAT, a voided document out, an adjustment netting down, a duplicate
// party counted with its kept party. Both: one legal entity at a time, every role can read them, nothing leaks across orgs, nothing is written. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes
// its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CASH_FORECAST_PARTIES_MAX, vietnamToday } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { addDays, financeCommands, financeQueries, type FinanceAging, type FinancePartyRanking } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = vietnamToday();
const day = (n: number) => addDays(TODAY, n);

suite('the aging and the ranking of parties (#5338)', () => {
  const dbName = `ludy_test_aging_ranking_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@aging.test`, name: null });
  type Org = { orgId: string; owner: string; viewer: string; entity: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Tuổi nợ ${randomUUID().slice(0, 6)}`);
    const viewer = await identity('viewer');
    await admin((c) => c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]));
    const entity = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string);
    return { orgId, owner, viewer, entity };
  }
  const aging = (o: Org, input: Record<string, unknown>, user = o.owner) => rt.query<FinanceAging>('finance.aging', input, { actor: asUser(user), orgId: o.orgId });
  const ranking = (o: Org, input: Record<string, unknown>, user = o.owner) => rt.query<FinancePartyRanking>('finance.party_ranking', input, { actor: asUser(user), orgId: o.orgId });
  const party = async (o: Org, name: string) => {
    const id = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', $3)", [o.orgId, id, name]));
    return id;
  };
  const secondEntity = (o: Org) => admin(async (c) => (await c.query<{ id: string }>("INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [o.orgId, o.owner])).rows[0]?.id as string);

  // One journal entry of two or more lines, as the commands write one; with a document, the document too (its net of VAT `subtotal` and its VAT, the total being their sum).
  async function entry(
    o: Org,
    date: string,
    lines: Array<{ account: string; debit?: string; credit?: string; party?: string | null }>,
    entity: string = o.entity,
    document: { number: string; direction: 'sale' | 'purchase'; party: string; subtotal: string; vat?: string; dueDate?: string | null } | null = null,
  ): Promise<string | null> {
    return admin(async (c) => {
      await c.query('BEGIN');
      let doc: string | null = null;
      if (document) {
        doc = randomUUID();
        const vat = document.vat ?? '0';
        // The total is the sum of the net and the VAT (a table check), worked out here so no parameter is used with two types.
        const total = String(Number(document.subtotal) + Number(vat));
        await c.query(
          `INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, due_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
           VALUES ($1, $2, $3, 'C26TAA', $4, $5, $6, 'VND', $7, $8, $9, $10, $11)`,
          [o.orgId, doc, document.party, document.number, date, document.dueDate ?? null, document.subtotal, vat, total, document.direction, entity],
        );
      }
      const id = randomUUID();
      await c.query(`INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'aging test', $4, $5, $6)`, [o.orgId, id, date, doc ? 'finance.purchase_document' : 'finance.journal_voucher', doc ?? randomUUID(), entity]);
      let n = 1;
      for (const l of lines) await c.query(`INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [o.orgId, id, n++, l.account, l.debit ?? '0', l.credit ?? '0', l.party ?? null, entity]);
      await c.query('COMMIT');
      return doc;
    });
  }
  // A sale posts Dr 131 (the customer) for the whole and Cr 511 for the net (no VAT here unless asked); a purchase Dr 6422 / Cr 331 (the supplier) for the whole.
  const sale = (o: Org, p: string, number: string, date: string, subtotal: string, over: { vat?: string; entity?: string } = {}) => {
    const total = String(Number(subtotal) + Number(over.vat ?? '0'));
    return entry(o, date, [{ account: '131', debit: total, party: p }, { account: '511', credit: subtotal }, ...(over.vat ? [{ account: '3331', credit: over.vat }] : [])], over.entity, { number, direction: 'sale', party: p, subtotal, ...(over.vat ? { vat: over.vat } : {}) });
  };
  const purchase = (o: Org, p: string, number: string, date: string, subtotal: string, over: { dueDate?: string | null; entity?: string } = {}) =>
    entry(o, date, [{ account: '6422', debit: subtotal }, { account: '331', credit: subtotal, party: p }], over.entity, { number, direction: 'purchase', party: p, subtotal, dueDate: over.dueDate ?? null });
  // A document voided as finance.journal.reverse does it: the entry of the document reversed (mirror lines, the same day) and the void row naming that reversal, in one transaction.
  async function voidDocument(o: Org, doc: string): Promise<void> {
    await admin(async (c) => {
      await c.query('BEGIN');
      const original = (await c.query<{ id: string; entry_date: string; legal_entity_id: string }>(`SELECT id, entry_date::text AS entry_date, legal_entity_id FROM ludy_finance.journal_entry WHERE org_id = $1 AND source_type = 'finance.purchase_document' AND source_id = $2`, [o.orgId, doc])).rows[0];
      if (!original) throw new Error('no entry for the document');
      const lines = (await c.query<{ account_code: string; debit: string; credit: string; party_id: string | null }>('SELECT account_code, debit::text AS debit, credit::text AS credit, party_id FROM ludy_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY line_no', [o.orgId, original.id])).rows;
      const reversal = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id, reverses_entry_id) VALUES ($1, $2, 'Hủy hóa đơn', 'finance.journal_voucher', $3, $4, $5) RETURNING id`,
          [o.orgId, original.entry_date, randomUUID(), original.legal_entity_id, original.id],
        )
      ).rows[0]?.id as string;
      let n = 1;
      for (const l of lines) await c.query('INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [o.orgId, reversal, n++, l.account_code, l.credit, l.debit, l.party_id, original.legal_entity_id]);
      await c.query("INSERT INTO ludy_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'Hủy hóa đơn')", [o.orgId, doc, reversal]);
      await c.query('COMMIT');
    });
  }
  const BUCKETS = ['not_due', 'overdue_1_30', 'overdue_31_60', 'overdue_61_90', 'overdue_over_90'] as const;
  const zeroBuckets = { not_due: '0', overdue_1_30: '0', overdue_31_60: '0', overdue_61_90: '0', overdue_over_90: '0' };

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

  describe('finance.aging, receivables', () => {
    it('is all zero for an org with no entry, and every role can read it', async () => {
      const o = await org();
      const a = await aging(o, { side: 'receivable' });
      expect(a).toEqual({ side: 'receivable', asOf: TODAY, legalEntityId: o.entity, buckets: zeroBuckets, undated: '0', advances: '0', overdue: { total: '0', partyCount: 0, parties: [] }, estimatedDueDates: false, truncated: false });
      expect((await aging(o, { side: 'receivable' }, o.viewer)).asOf).toBe(TODAY);
    });

    it('puts each open invoice in the bucket of its days past due (the org\'s 30-day terms), counts a party by what is overdue only, and ranks the overdue parties', async () => {
      const o = await org();
      const a = await party(o, 'Khách A');
      const b = await party(o, 'Khách B');
      const c = await party(o, 'Khách C');
      // Terms of 30 days: due on the invoice date + 30. Today is day 0.
      await sale(o, c, '1', day(-10), '100'); // due in 20 days: not due
      await sale(o, a, '2', day(-40), '200'); // due 10 days ago: 1-30
      await sale(o, a, '3', day(-75), '400'); // due 45 days ago: 31-60
      await sale(o, b, '4', day(-110), '800'); // due 80 days ago: 61-90
      await sale(o, b, '5', day(-200), '1600'); // due 170 days ago: over 90
      const r = await aging(o, { side: 'receivable' });
      expect(r.buckets).toEqual({ not_due: '100', overdue_1_30: '200', overdue_31_60: '400', overdue_61_90: '800', overdue_over_90: '1600' });
      expect(r.overdue).toEqual({
        total: '3000',
        partyCount: 2,
        parties: [
          { name: 'Khách B', amount: '2400' },
          { name: 'Khách A', amount: '600' },
        ],
      });
      expect(r.undated).toBe('0');
      expect(r.advances).toBe('0');
      expect(r.estimatedDueDates).toBe(false);
      expect(r.truncated).toBe(false);
      expect(BUCKETS.reduce((sum, key) => sum + Number(r.buckets[key]), 0)).toBe(3100);
    });

    it('lays a payment against the oldest invoice, so what is still open is the newest, and uses a customer\'s own terms when it set them', async () => {
      const o = await org();
      const a = await party(o, 'Khách A');
      await sale(o, a, '1', day(-100), '1000'); // paid below
      await sale(o, a, '2', day(-20), '500'); // due in 10 days with 30-day terms
      await entry(o, day(-5), [{ account: '112', debit: '1000' }, { account: '131', credit: '1000', party: a }]);
      const open = await aging(o, { side: 'receivable' });
      expect(open.buckets).toEqual({ ...zeroBuckets, not_due: '500' });
      expect(open.overdue.total).toBe('0');
      // The customer's own terms of 10 days: the same invoice is due 10 days ago.
      await admin((c) => c.query('INSERT INTO ludy_finance.customer_collection (org_id, party_id, terms_days) VALUES ($1, $2, 10)', [o.orgId, a]));
      const own = await aging(o, { side: 'receivable' });
      expect(own.buckets).toEqual({ ...zeroBuckets, overdue_1_30: '500' });
      expect(own.overdue.parties).toEqual([{ name: 'Khách A', amount: '500' }]);
    });

    it('keeps the part of a balance no invoice covers as its own undated figure, and what a customer paid ahead as the other side, never in a bucket', async () => {
      const o = await org();
      const a = await party(o, 'Khách A');
      const d = await party(o, 'Khách trả trước');
      await sale(o, a, '1', day(-40), '200');
      // 50 more on 131 with no invoice behind it (a journal voucher).
      await entry(o, day(-3), [{ account: '131', debit: '50', party: a }, { account: '511', credit: '50' }]);
      // A customer who paid 300 ahead: a credit balance.
      await entry(o, day(-3), [{ account: '112', debit: '300' }, { account: '131', credit: '300', party: d }]);
      const r = await aging(o, { side: 'receivable' });
      expect(r.buckets).toEqual({ ...zeroBuckets, overdue_1_30: '200' });
      expect(r.undated).toBe('50');
      expect(r.advances).toBe('300');
      expect(r.overdue.total).toBe('200');
    });

    it('reads the books as of a day: later entries and invoices are out, a day after today is today, and a voided invoice is gone', async () => {
      const o = await org();
      const a = await party(o, 'Khách A');
      await sale(o, a, '1', day(-75), '400'); // due 45 days ago today, 5 days from due on day -50
      await sale(o, a, '2', day(-10), '999'); // dated after the day asked
      const asOf = await aging(o, { side: 'receivable', asOf: day(-50) });
      expect(asOf.asOf).toBe(day(-50));
      expect(asOf.buckets).toEqual({ ...zeroBuckets, not_due: '400' });
      expect((await aging(o, { side: 'receivable', asOf: day(30) })).asOf).toBe(TODAY);
      // The voided invoice leaves the balance and the invoices: only the other one is open.
      const doc = await sale(o, a, '3', day(-45), '70');
      await voidDocument(o, doc as string);
      const voided = await aging(o, { side: 'receivable' });
      expect(voided.buckets).toEqual({ ...zeroBuckets, not_due: '999', overdue_31_60: '400' });
    });

    it('is one legal entity at a time, and leaves another org out', async () => {
      const o = await org();
      const other = await org();
      const second = await secondEntity(o);
      const a = await party(o, 'Khách A');
      await sale(o, a, '1', day(-40), '200');
      await sale(o, a, '2', day(-40), '700', { entity: second });
      expect((await aging(o, { side: 'receivable' })).buckets.overdue_1_30).toBe('200');
      const there = await aging(o, { side: 'receivable', legalEntityId: second });
      expect(there.legalEntityId).toBe(second);
      expect(there.buckets.overdue_1_30).toBe('700');
      expect((await aging(other, { side: 'receivable' })).buckets).toEqual(zeroBuckets);
    });

    it('says the read is partial when the books hold more customers than one read takes', async () => {
      const o = await org();
      await admin(async (c) => {
        await c.query('BEGIN');
        for (let i = 0; i <= CASH_FORECAST_PARTIES_MAX; i++) {
          const p = randomUUID();
          const e = randomUUID();
          await c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', $3)", [o.orgId, p, `Khách ${i}`]);
          await c.query("INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'bulk', 'finance.journal_voucher', $4, $5)", [o.orgId, e, day(-5), randomUUID(), o.entity]);
          await c.query(
            "INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '131', $3, 0, $4, $5), ($1, $2, 2, '511', 0, $3, NULL, $5)",
            [o.orgId, e, 1000 + i, p, o.entity],
          );
        }
        await c.query('COMMIT');
      });
      expect((await aging(o, { side: 'receivable' })).truncated).toBe(true);
      expect((await aging(await org(), { side: 'receivable' })).truncated).toBe(false);
    }, 120_000);
  });

  describe('finance.aging, payables', () => {
    it('dates a purchase invoice by its own due date, else its date plus 30 days (said as an estimate)', async () => {
      const o = await org();
      const x = await party(o, 'Nhà cung cấp X');
      await purchase(o, x, '1', day(-10), '100'); // no due date: due in 20 days, estimated
      await purchase(o, x, '2', day(-50), '200', { dueDate: day(-20) }); // its own due date: 20 days overdue
      await purchase(o, x, '3', day(-100), '400'); // no due date: due 70 days ago, estimated
      const r = await aging(o, { side: 'payable' });
      expect(r.side).toBe('payable');
      expect(r.buckets).toEqual({ ...zeroBuckets, not_due: '100', overdue_1_30: '200', overdue_61_90: '400' });
      expect(r.overdue).toEqual({ total: '600', partyCount: 1, parties: [{ name: 'Nhà cung cấp X', amount: '600' }] });
      expect(r.estimatedDueDates).toBe(true);
      // With every invoice on its own due date nothing is estimated.
      const own = await org();
      const y = await party(own, 'Nhà cung cấp Y');
      await purchase(own, y, '1', day(-10), '100', { dueDate: day(5) });
      expect((await aging(own, { side: 'payable' })).estimatedDueDates).toBe(false);
    });

    it('keeps the 331 credit that names no supplier as undated, an advance to a supplier as the other side, and does not take an approved payment out', async () => {
      const o = await org();
      const x = await party(o, 'Nhà cung cấp X');
      const y = await party(o, 'Nhà cung cấp Y');
      const doc = await purchase(o, x, '1', day(-50), '200', { dueDate: day(-20) });
      // 50 more owed with no supplier named (a journal voucher), and 70 advanced to another supplier.
      await entry(o, day(-3), [{ account: '6422', debit: '50' }, { account: '331', credit: '50' }]);
      await entry(o, day(-3), [{ account: '331', debit: '70', party: y }, { account: '112', credit: '70' }]);
      // An approved supplier payment (written with the table's triggers set aside): the books do not show it yet, so aging does not take it out.
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(
          `INSERT INTO ludy_finance.supplier_payment (org_id, legal_entity_id, party_id, purchase_document_id, amount, currency, bank_account_id, number_hash, hash_key_id, proposal_id, approver_step_up_at)
           VALUES ($1, $2, $3, $4, 200, 'VND', $5, $6, 'k-test', $7, now())`,
          [o.orgId, o.entity, x, doc, randomUUID(), 'a'.repeat(64), randomUUID()],
        );
        await c.query('COMMIT');
      });
      const r = await aging(o, { side: 'payable' });
      expect(r.buckets).toEqual({ ...zeroBuckets, overdue_1_30: '200' });
      expect(r.undated).toBe('50');
      expect(r.advances).toBe('70');
      expect(r.overdue.parties).toEqual([{ name: 'Nhà cung cấp X', amount: '200' }]);
    });
  });

  describe('finance.party_ranking', () => {
    it('is empty for an org with no document, and every role can read it', async () => {
      const o = await org();
      const empty = { side: 'sales', period: '2025-03', from: '2025-03-01', to: '2025-03-31', total: '0', partyCount: 0, parties: [] };
      expect(await ranking(o, { side: 'sales', period: '2025-03' })).toEqual(empty);
      expect((await ranking(o, { side: 'purchases', period: '2025-03' }, o.viewer)).parties).toEqual([]);
    });

    it('ranks the customers by invoiced sales of a month, a quarter or a year, largest first, with the total and the count', async () => {
      const o = await org();
      const a = await party(o, 'Khách A');
      const b = await party(o, 'Khách B');
      const c = await party(o, 'Khách C');
      await sale(o, a, '1', '2025-03-05', '1000');
      await sale(o, a, '2', '2025-03-20', '500');
      await sale(o, b, '3', '2025-03-10', '3000');
      await sale(o, c, '4', '2025-02-28', '9999');
      await sale(o, b, '5', '2025-04-01', '100');
      const month = await ranking(o, { side: 'sales', period: '2025-03' });
      expect(month).toMatchObject({ side: 'sales', period: '2025-03', from: '2025-03-01', to: '2025-03-31', total: '4500', partyCount: 2 });
      expect(month.parties).toEqual([
        { name: 'Khách B', amount: '3000' },
        { name: 'Khách A', amount: '1500' },
      ]);
      const quarter = await ranking(o, { side: 'sales', period: '2025-Q1' });
      expect(quarter.parties.map((p) => [p.name, p.amount])).toEqual([
        ['Khách C', '9999'],
        ['Khách B', '3000'],
        ['Khách A', '1500'],
      ]);
      expect(quarter).toMatchObject({ total: '14499', partyCount: 3, from: '2025-01-01', to: '2025-03-31' });
      const year = await ranking(o, { side: 'sales', period: '2025' });
      expect(year).toMatchObject({ total: '14599', partyCount: 3, to: '2025-12-31' });
      expect(year.parties[1]).toEqual({ name: 'Khách B', amount: '3100' });
    });

    it('ranks the suppliers by invoiced purchases, apart from the sales', async () => {
      const o = await org();
      const customer = await party(o, 'Khách A');
      const x = await party(o, 'Nhà cung cấp X');
      const y = await party(o, 'Nhà cung cấp Y');
      await sale(o, customer, '1', '2025-03-05', '8000');
      await purchase(o, x, '2', '2025-03-06', '700');
      await purchase(o, y, '3', '2025-03-07', '900');
      await purchase(o, x, '4', '2025-03-08', '500');
      const purchases = await ranking(o, { side: 'purchases', period: '2025-03' });
      expect(purchases.parties).toEqual([
        { name: 'Nhà cung cấp X', amount: '1200' },
        { name: 'Nhà cung cấp Y', amount: '900' },
      ]);
      expect(purchases.total).toBe('2100');
      expect((await ranking(o, { side: 'sales', period: '2025-03' })).parties).toEqual([{ name: 'Khách A', amount: '8000' }]);
    });

    it('counts the net of VAT, leaves a voided document out, nets an adjustment that lowers an invoice, and drops a party whose net is zero or less', async () => {
      const o = await org();
      const a = await party(o, 'Khách A');
      const b = await party(o, 'Khách B');
      const c = await party(o, 'Khách C');
      await sale(o, a, '1', '2025-05-02', '1000', { vat: '100' });
      const voided = await sale(o, b, '2', '2025-05-03', '700');
      await voidDocument(o, voided as string);
      // A decrease of 300 on customer C's 300 invoice (an adjustment carries the signed difference): net zero, not ranked.
      await sale(o, c, '3', '2025-05-04', '300');
      await entry(o, '2025-05-05', [{ account: '511', debit: '300' }, { account: '131', credit: '300', party: c }], o.entity, { number: '4', direction: 'sale', party: c, subtotal: '-300' });
      const r = await ranking(o, { side: 'sales', period: '2025-05' });
      expect(r.parties).toEqual([{ name: 'Khách A', amount: '1000' }]);
      expect(r.total).toBe('1000');
      expect(r.partyCount).toBe(1);
      // A smaller decrease nets the party down without dropping it.
      await entry(o, '2025-05-06', [{ account: '511', debit: '100' }, { account: '131', credit: '100', party: a }], o.entity, { number: '5', direction: 'sale', party: a, subtotal: '-100' });
      expect((await ranking(o, { side: 'sales', period: '2025-05' })).parties).toEqual([{ name: 'Khách A', amount: '900' }]);
    });

    it('counts a party and its duplicates as one, ties by name, and names at most five', async () => {
      const o = await org();
      const kept = await party(o, 'Khách chính');
      const duplicate = await party(o, 'Khách chính (trùng)');
      await admin((c) => c.query('UPDATE ludy_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [o.orgId, duplicate, kept]));
      await sale(o, kept, '1', '2025-06-01', '400');
      await sale(o, duplicate, '2', '2025-06-02', '600');
      for (let i = 0; i < 6; i++) await sale(o, await party(o, `Khách ${String.fromCharCode(65 + i)}`), String(10 + i), '2025-06-03', '100');
      const r = await ranking(o, { side: 'sales', period: '2025-06' });
      expect(r.parties[0]).toEqual({ name: 'Khách chính', amount: '1000' });
      // The six equal customers follow by name; five are named, the count and the total hold all seven.
      expect(r.parties.map((p) => p.name)).toEqual(['Khách chính', 'Khách A', 'Khách B', 'Khách C', 'Khách D']);
      expect(r.partyCount).toBe(7);
      expect(r.total).toBe('1600');
    });

    it('is one legal entity at a time, leaves another org out, refuses a period that is not one, and writes nothing', async () => {
      const o = await org();
      const other = await org();
      const second = await secondEntity(o);
      const a = await party(o, 'Khách A');
      await sale(o, a, '1', '2025-07-01', '400');
      await sale(o, a, '2', '2025-07-02', '900', { entity: second });
      expect((await ranking(o, { side: 'sales', period: '2025-07' })).total).toBe('400');
      expect((await ranking(o, { side: 'sales', period: '2025-07', legalEntityId: second })).total).toBe('900');
      expect((await ranking(other, { side: 'sales', period: '2025-07' })).parties).toEqual([]);
      await expect(ranking(o, { side: 'sales', period: '2025-13' })).rejects.toBeTruthy();
      await expect(ranking(o, { side: 'everything', period: '2025-07' })).rejects.toBeTruthy();
      const rows = () => admin(async (c) => (await c.query<{ n: string }>('SELECT (SELECT count(*) FROM ludy_finance.journal_entry WHERE org_id = $1) + (SELECT count(*) FROM ludy_finance.purchase_document WHERE org_id = $1) + (SELECT count(*) FROM ludy_kernel.audit_event WHERE org_id = $1) AS n', [o.orgId])).rows[0]?.n);
      const before = await rows();
      await ranking(o, { side: 'sales', period: '2025-07' });
      await aging(o, { side: 'receivable' });
      await aging(o, { side: 'payable' });
      expect(await rows()).toBe(before);
    });
  });
});
