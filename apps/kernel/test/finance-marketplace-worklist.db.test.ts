// SPDX-License-Identifier: AGPL-3.0-only
// What the Sàn screen lets a person act on (#2516 slice F, plan stock-and-marketplaces.md section 8.4) on a real PostgreSQL 17: the read `finance.marketplace.worklist` and the new fact
// `payoutsToMatch` of `finance.marketplace.facts`:
// - the gate: `postingConfirmed` is false while the account map is `commentary` (the shipped read) and true where it is confirmed;
// - the settlements to post: stored settlements that stand and are not posted, with the net their entry would post; a posted one leaves the list;
// - the payouts to match: a posted settlement with no payout voucher, with the bank lines it may be (the entity's, money in, equal to the net, not before the period, free), and gone once its payout
//   is posted; a settlement with a deduction nobody can classify is not offered, one with money to classify is offered with those lines (#4303 S4);
// - the invoices to clear: a platform's posted fee invoice while fees wait on 1388, with what a clearing would take; gone once cleared, and another supplier's or a reversed invoice is not offered;
// - the facts count the posted settlements without a payout, and no more once the payout is posted.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { MARKETPLACE_POSTING_MAPS, createMarketplaceFeeClearingCommands, createMarketplacePayoutCommands, createMarketplaceSettlementCommands, createMarketplaceWorklist, financeCommands, financeQueries, type MarketplacePostingMap } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A copy of the shipped map with every row confirmed, for the runtime that posts.
const confirmedMaps = (feeCode = '331'): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133 as MarketplacePostingMap;
  const c = <T extends { status: string }>(r: T): T => ({ ...r, status: 'confirmed' });
  return { tt133: { ...base, status: 'confirmed', receivable: c(base.receivable), revenue: c(base.revenue), salesReturn: c(base.salesReturn), cash: c(base.cash), feePayable: c({ ...base.feePayable, code: feeCode }), feeAwaitingInvoice: c(base.feeAwaitingInvoice), taxWithheld: c(base.taxWithheld), vatPayable: c(base.vatPayable), pitPayable: c(base.pitPayable), pitOwnerEquity: c(base.pitOwnerEquity), feeExpense: c(base.feeExpense), accruedExpense: c(base.accruedExpense), outputVat: c(base.outputVat) } };
};
const notMarketplace = (name: string) => !name.startsWith('finance.marketplace_settlement.') && !name.startsWith('finance.marketplace_payout.') && !name.startsWith('finance.marketplace_fee_clearing.');

interface SeedLine {
  // The day the line's order was delivered; the first day of the period when absent, no order line (no delivery day) when null.
  delivered?: string | null;
  sales: string;
  discount?: string;
  refund?: string;
  commission?: string;
  service?: string;
  payment?: string;
  shipping?: string;
  tax?: string;
  other?: string;
}
const netOf = (l: SeedLine) => Number(l.sales) - Number(l.discount ?? 0) - Number(l.refund ?? 0) - Number(l.commission ?? 0) - Number(l.service ?? 0) - Number(l.payment ?? 0) - Number(l.shipping ?? 0) - Number(l.tax ?? 0) + Number(l.other ?? 0);

suite("the Sàn screen's work list on PostgreSQL (#2516)", () => {
  const dbName = `crove_test_mkt_work_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let rtShipped: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => withAdmin(async (c) => (await c.query<T>(sql, params)).rows);

  // An org with an owner, an admin (who asks) and a member.
  async function org(regime: 'tt133' | 'tt99' = 'tt133', household = true) {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'mktrecord', subject: `${name}-${tag}`, email: `${name}-${tag}@mkt.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const { orgId } = await createOrg(rt, asUser(owner), `Đối soát sàn ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, admin, member]));
    if (regime === 'tt99') {
      await withAdmin((c) =>
        c.query(`INSERT INTO ludy_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) SELECT $1, id, 'tt99', '2026.1', '2026-01-01' FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default`, [orgId]),
      );
    }
    const entity = (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    // Method `none` from the start: these tests are about posting, not about VAT, so a sale posts VAT-inclusive revenue as before (#4303 S3b; the VAT split has its own test).
    await withAdmin((c) => c.query("INSERT INTO ludy_finance.marketplace_vat_rate (org_id, legal_entity_id, effective_from, method) VALUES ($1, $2, '2000-01-01', 'none')", [orgId, entity]));
    // A household seller of one line of business with its rates confirmed for the test: the withheld tax is split into VAT and PIT at the settlement's posting (slice C2) and the payout debits it.
    if (household) {
      await withAdmin(async (c) => {
        await c.query("UPDATE ludy_kernel.legal_entity SET kind = 'household' WHERE org_id = $1 AND id = $2", [orgId, entity]);
        await c.query("INSERT INTO ludy_finance.household_profile (org_id, legal_entity_id, effective_from, tax_group, pit_method, trades) VALUES ($1, $2, '2026-01-01', 2, 'percentage', ARRAY['goods']::text[])", [orgId, entity]);
        await c.query("UPDATE ludy_finance.household_trade_rate SET status = 'confirmed' WHERE trade = 'goods'");
      });
    }
    return { orgId, owner, admin, member, entity };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  // A settlement as an importer leaves it: the row and one line per order, every amount a decimal string.
  async function seed(o: Org, platform: string, start: string, end: string, lines: SeedLine[]): Promise<string> {
    const id = randomUUID();
    await withAdmin(async (c) => {
      const net = lines.reduce((n, l) => n + netOf(l), 0);
      await c.query('BEGIN');
      await c.query('INSERT INTO ludy_finance.channel_settlement (org_id, id, platform, period_start, period_end, report_net) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, id, platform, start, end, net]);
      for (const [i, l] of lines.entries()) {
        const orderId = randomUUID();
        await c.query('INSERT INTO ludy_finance.channel_order (org_id, id, platform, order_no) VALUES ($1, $2, $3, $4)', [o.orgId, orderId, platform, `MK${randomUUID().slice(0, 12)}`]);
        if (l.delivered !== null) await c.query("INSERT INTO ludy_finance.channel_order_line (org_id, order_id, line_key, quantity, stage, delivered_at) VALUES ($1, $2, 'L1', 1, 'completed', $3)", [o.orgId, orderId, l.delivered ?? start]);
        await c.query(
          'INSERT INTO ludy_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, sales, seller_discount, commission, service_fee, payment_fee, shipping, tax_withheld, refund, other, net) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
          [o.orgId, randomUUID(), id, orderId, `K${i}`, l.sales, l.discount ?? '0', l.commission ?? '0', l.service ?? '0', l.payment ?? '0', l.shipping ?? '0', l.tax ?? '0', l.refund ?? '0', l.other ?? '0', netOf(l)],
        );
      }
      await c.query('COMMIT');
    });
    return id;
  }
  // A bank line of the entity's bank account (1121), money in unless the amount is negative.
  async function bankLine(o: Org, date: string, amount: string | number, account = '1121'): Promise<string> {
    const [line] = await rows<{ id: string }>(
      `INSERT INTO ludy_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount, bank_ref) VALUES ($1, $2, $3, 1, $4, 'Shopee thanh toan', $5, $6) RETURNING id`,
      [o.orgId, account, randomUUID(), date, String(amount), `FT${randomUUID().slice(0, 8)}`],
    );
    return line?.id as string;
  }

  const askSettlement = (o: Org, settlementId: string, user = o.admin, runtime = rt) =>
    runtime.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.marketplace_settlement.record', input: { settlementId } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const ask = (o: Org, settlementId: string, bankLineId: string, user = o.admin, runtime = rt) =>
    runtime.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.marketplace_payout.record', input: { settlementId, bankLineId } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  async function approve(o: Org, proposalId: string, user = o.owner, runtime = rt) {
    const detail = await runtime.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return runtime.execute<{ voucherId: string; journalEntryId: string; code: string }>('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(user), orgId: o.orgId });
  }
  // The settlement posted (Dr 131 / Cr 5111), the state a payout needs.
  const post = async (o: Org, settlementId: string) => approve(o, (await askSettlement(o, settlementId)).proposalId);
  const partyOf = async (o: Org, platform: string) => (await rows<{ party_id: string }>('SELECT party_id FROM ludy_finance.marketplace_party WHERE org_id = $1 AND legal_entity_id = $2 AND platform = $3', [o.orgId, o.entity, platform]))[0]?.party_id;

  // Two orders: sales 100 000 + 250 000, seller discounts 5 000 + 10 000 (the settlement posts Dr 131 335 000); fees 10 000 + 18 000, withheld tax 3 000: money received 85 000 + 219 000 = 304 000.
  const PAID: SeedLine[] = [
    { sales: '100000', discount: '5000', commission: '6000', service: '2000', payment: '1000', shipping: '1000' },
    { sales: '250000', discount: '10000', commission: '12000', service: '3000', payment: '2000', shipping: '1000', tax: '3000' },
  ];
  const RECEIVED = '304000';
  // The org with the settlement posted and a bank line for its transfer, the usual start.
  async function posted(platform = 'shopee', lines: SeedLine[] = PAID, received: string | number = RECEIVED) {
    const o = await org();
    const settlement = await seed(o, platform, '2026-10-01', '2026-10-15', lines);
    await post(o, settlement);
    const line = await bankLine(o, '2026-10-20', received);
    return { o, settlement, line };
  }

  const askFee = (o: Org, purchaseDocumentId: string, user = o.admin, runtime = rt) =>
    runtime.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.marketplace_fee_clearing.record', input: { purchaseDocumentId } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  // The platform's fee invoice as the purchase path leaves it: the document and its standing entry, Dr expense and Dr 1331, Cr 331 naming the party (one transaction, the deferred checks run at commit).
  async function invoice(o: Org, partyId: string, over: { total?: number; vat?: number; date?: string; direction?: string; currency?: string; credit?: string } = {}): Promise<string> {
    const total = over.total ?? 30800;
    const vat = over.vat ?? 2800;
    const docId = randomUUID();
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      const foreign = (over.currency ?? 'VND') !== 'VND';
      await c.query(
        `INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, currency, exchange_rate, exchange_rate_source, foreign_subtotal, foreign_vat_amount, foreign_total)
         VALUES ($1, $2, $3, '1C26TPF', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [o.orgId, docId, partyId, randomUUID().slice(0, 8), over.date ?? '2026-10-25', total - vat, vat, total, over.direction ?? 'purchase', over.currency ?? 'VND', foreign ? 25000 : null, foreign ? 'entered' : null, foreign ? 1 : null, foreign ? 0 : null, foreign ? 1 : null],
      );
      {
        const entryId = randomUUID();
        await c.query(`INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, $3, 'Phí sàn', 'finance.purchase_document', $4)`, [o.orgId, entryId, over.date ?? '2026-10-25', docId]);
        await c.query(`INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 1, '6422', $3, 0, NULL)`, [o.orgId, entryId, total - vat]);
        if (vat > 0) await c.query(`INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 2, '1331', $3, 0, NULL)`, [o.orgId, entryId, vat]);
        await c.query(`INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 3, $3, 0, $4, $5)`, [o.orgId, entryId, over.credit ?? '331', total, partyId]);
      }
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('COMMIT');
    });
    return docId;
  }
  // The org with the settlement posted and its payout posted too: the platform's fees (28 000) wait on 1388.
  async function paid() {
    const base = await posted();
    await approve(base.o, (await ask(base.o, base.settlement, base.line)).proposalId);
    return { ...base, party: (await partyOf(base.o, 'shopee')) as string };
  }
  const worklist = (o: Org, runtime = rt, legalEntityId?: string) =>
    runtime.query<{
      postingConfirmed: boolean;
      salesPostingConfirmed: boolean;
      settlements: { id: string; platform: string; platformName: string; periodFrom: string; periodTo: string; months: string[]; net: string; waitingLines: number; proposalId: string | null }[];
      payouts: { settlementId: string; received: string; proposalId: string | null; candidates: { id: string; date: string; amount: string; reference: string | null }[]; adjustable: { lineId: string; source: string; amount: string }[] }[];
      invoices: { documentId: string; clearable: string; invoice: string; proposalId: string | null }[];
    }>('finance.marketplace.worklist', legalEntityId === undefined ? {} : { legalEntityId }, { actor: asUser(o.owner), orgId: o.orgId });
  const facts = (o: Org) => rt.query<{ settlementsToPost: number; payoutsToMatch: number }>('finance.marketplace.facts', {}, { actor: asUser(o.owner), orgId: o.orgId });

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 6 });
    const base = { queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    // The runtime that posts reads the worklist over a confirmed map; the shipped one reads it over the shipped (commentary) map.
    const confirmedBase = { queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries.filter((q) => q.name !== 'finance.marketplace.worklist'), createMarketplaceWorklist({ maps: confirmedMaps(), feeClearing: true })] };
    // The runtime that posts registers both marketplace command sets over a confirmed map; the other, the shipped sets.
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands.filter((c) => notMarketplace(c.name)), ...createMarketplaceSettlementCommands({ maps: confirmedMaps() }).commands, ...createMarketplacePayoutCommands({ maps: confirmedMaps('1388') }).commands, ...createMarketplaceFeeClearingCommands({ maps: confirmedMaps(), retired: false }).commands],
      ...confirmedBase,
    });
    rtShipped = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], ...base });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('says whether posting is open: closed on the shipped map, open on a confirmed one', async () => {
    const o = await org();
    expect((await worklist(o, rtShipped)).postingConfirmed).toBe(false);
    expect((await worklist(o)).postingConfirmed).toBe(true);
    // The sales path alone (#4303 S3b): open on the shipped map, where the payout and fee accrual rows are still commentary, so the settlement rows are not held by them.
    expect((await worklist(o, rtShipped)).salesPostingConfirmed).toBe(true);
    expect((await worklist(o)).salesPostingConfirmed).toBe(true);
    // A chart whose map is not in the injected set (TT99; the shipped TT99 map is commentary, #3711 slice 4) is closed too, and an entity the caller does not name is not looked at.
    const tt99 = await org('tt99');
    expect((await worklist(tt99)).postingConfirmed).toBe(false);
    expect((await worklist(tt99)).salesPostingConfirmed).toBe(false);
    expect((await worklist(o, rt, o.entity)).postingConfirmed).toBe(true);
    expect((await worklist(o, rt, o.entity)).salesPostingConfirmed).toBe(true);
    // Closed on the shipped map though its sales path is applied (#4303 S3b): the payout and fee accrual rows are still commentary, and the gate reads all three.
    expect(MARKETPLACE_POSTING_MAPS.tt133?.cash.status).toBe('commentary');
  });

  it('lists the settlements to post with the net their entry would post, and drops one once it is posted', async () => {
    const o = await org();
    const a = await seed(o, 'shopee', '2026-10-01', '2026-10-15', PAID);
    const b = await seed(o, 'tiktok_shop', '2026-10-01', '2026-10-15', [{ sales: '90000', discount: '10000', refund: '5000' }]);
    const list = await worklist(o);
    expect(list.settlements.map((s) => [s.id, s.platformName, s.periodFrom, s.periodTo, s.net]).sort()).toEqual(
      [[a, 'Shopee', '2026-10-01', '2026-10-15', '335000'], [b, 'TikTok Shop', '2026-10-01', '2026-10-15', '75000']].sort(),
    );
    expect((await facts(o)).settlementsToPost).toBe(2);
    // A pending proposal for a settlement is carried on its row, so the screen links to it; the other has none.
    expect(list.settlements.every((s) => s.proposalId === null)).toBe(true);
    const asked = await askSettlement(o, b);
    expect((await worklist(o)).settlements.find((s) => s.id === b)?.proposalId).toBe(asked.proposalId);
    expect((await worklist(o)).settlements.find((s) => s.id === a)?.proposalId).toBeNull();
    await post(o, a);
    expect((await worklist(o)).settlements.map((s) => s.id)).toEqual([b]);
    // A zero net posts nothing and is not offered.
    await seed(o, 'lazada', '2026-10-01', '2026-10-15', [{ sales: '5000', discount: '5000' }]);
    expect((await worklist(o)).settlements.map((s) => s.id)).toEqual([b]);
    // Another org sees none of it.
    expect((await worklist(await org())).settlements).toEqual([]);
  });

  it('lists a settlement once with its months of delivery, and one that waits for a delivery day with nothing to ask for', async () => {
    const o = await org();
    const two = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', delivered: '2026-09-28' }, { sales: '200000', delivered: '2026-10-02' }]);
    const waits = await seed(o, 'tiktok_shop', '2026-10-01', '2026-10-15', [{ sales: '90000' }, { sales: '10000', delivered: null }, { sales: '5000', delivered: null }]);
    const list = await worklist(o);
    expect(list.settlements.map((s) => [s.id === two ? 'two' : s.id === waits ? 'waits' : 'other', s.months, s.net, s.waitingLines]).sort()).toEqual(
      [['two', ['2026-09', '2026-10'], '300000', 0], ['waits', [], '0', 2]].sort(),
    );
    expect((await facts(o)).settlementsToPost).toBe(2);
    // A pending proposal is carried on the row; a settlement that waits has none to carry.
    const asked = await askSettlement(o, two);
    expect((await worklist(o)).settlements.find((s) => s.id === two)?.proposalId).toBe(asked.proposalId);
    await expect(askSettlement(o, waits)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_WAITING_DELIVERY' });
    // One approval posts both months: the row goes, the settlement is offered for its payout, and counts once there.
    await approve(o, asked.proposalId);
    expect((await worklist(o)).settlements.map((s) => s.id)).toEqual([waits]);
    expect((await worklist(o)).payouts.map((p) => p.settlementId)).toContain(two);
    expect((await facts(o)).payoutsToMatch).toBe(1);
    expect((await facts(o)).settlementsToPost).toBe(1);
  });

  it('lists a posted settlement with the bank lines its payout may be, and drops it once its payout is posted', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', PAID);
    // Not offered before its posting.
    expect((await worklist(o)).payouts).toEqual([]);
    await post(o, settlement);
    expect((await facts(o)).payoutsToMatch).toBe(1);
    const right = await bankLine(o, '2026-10-20', RECEIVED);
    const later = await bankLine(o, '2026-10-22', RECEIVED);
    await bankLine(o, '2026-10-20', '303999');
    await bankLine(o, '2026-09-30', RECEIVED);
    await bankLine(o, '2026-10-20', `-${RECEIVED}`);
    const taken = await bankLine(o, '2026-10-21', RECEIVED);
    // A bank voucher already proposed for a line takes it out of the list.
    await rt.execute('kernel.proposal.request', { command: 'finance.voucher.record', input: { type: 'bank_credit', date: '2026-10-21', cashAccount: '1121', description: 'thu', lines: [{ account: '711', amount: RECEIVED }], bankLineId: taken } }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    const [item] = (await worklist(o)).payouts;
    expect(item).toMatchObject({ settlementId: settlement, received: '304000' });
    expect(item?.candidates.map((c) => [c.id, c.date, c.amount])).toEqual([[right, '2026-10-20', '304000'], [later, '2026-10-22', '304000']]);
    expect(item?.candidates[0]?.reference).toMatch(/^FT/);
    await approve(o, (await ask(o, settlement, right)).proposalId);
    expect((await worklist(o)).payouts).toEqual([]);
    expect((await facts(o)).payoutsToMatch).toBe(0);
  });

  it('carries the pending proposal of a payout and of a clearing on its row', async () => {
    const { o, settlement, line, party } = await (async () => {
      const base = await posted();
      return { ...base, party: (await partyOf(base.o, 'shopee')) as string };
    })();
    const pendingPayout = await ask(o, settlement, line);
    const [item] = (await worklist(o)).payouts;
    expect(item?.proposalId).toBe(pendingPayout.proposalId);
    // The line its proposal holds is not offered to another.
    expect(item?.candidates.map((c) => c.id)).not.toContain(line);
    await approve(o, pendingPayout.proposalId);
    const doc = await invoice(o, party);
    expect((await worklist(o)).invoices.map((i) => [i.documentId, i.proposalId])).toEqual([[doc, null]]);
    const pendingClearing = await askFee(o, doc);
    expect((await worklist(o)).invoices.map((i) => [i.documentId, i.proposalId])).toEqual([[doc, pendingClearing.proposalId]]);
  });

  it('does not offer a payout the command would refuse: a deduction nobody can classify, nothing to collect', async () => {
    const o = await org();
    // Money the report does not explain, below zero in one line and not adding up to zero: a person cannot classify a deduction, so the settlement is not offered (the accountant handles it).
    const odd = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', other: '500' }, { sales: '50000', other: '-200' }]);
    await post(o, odd);
    await bankLine(o, '2026-10-20', '150300');
    expect((await worklist(o)).payouts).toEqual([]);
  });

  it('lists the lines a person must classify (#4303 S4): money paid beyond the sales, and tax withheld from a seller that is no household; nothing for an offsetting pair or a household\'s tax', async () => {
    const lineIds = async (o: Org, settlement: string) => (await rows<{ id: string; line_key: string }>('SELECT id, line_key FROM ludy_finance.channel_settlement_line WHERE org_id = $1 AND settlement_id = $2 ORDER BY line_key', [o.orgId, settlement]));
    const company = await org('tt133', false);
    const s1 = await seed(company, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', other: '500' }, { sales: '50000', tax: '1500' }, { sales: '20000' }]);
    await post(company, s1);
    await bankLine(company, '2026-10-20', '169000');
    const ids = await lineIds(company, s1);
    const [item] = (await worklist(company)).payouts;
    expect(item?.settlementId).toBe(s1);
    expect(item?.adjustable).toEqual([
      { lineId: ids[0]?.id, source: 'other', amount: '500' },
      { lineId: ids[1]?.id, source: 'withheld', amount: '1500' },
    ].sort((a, b) => String(a.lineId).localeCompare(String(b.lineId))));
    // A household's withheld tax goes through 3331 and 3335: only the other money is offered.
    const house = await org();
    const s2 = await seed(house, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', other: '500', tax: '1000' }]);
    await post(house, s2);
    await bankLine(house, '2026-10-20', '99500');
    expect((await worklist(house)).payouts[0]?.adjustable).toEqual([{ lineId: (await lineIds(house, s2))[0]?.id, source: 'other', amount: '500' }]);
    // An offsetting pair is no adjustment: offered as before, with nothing to classify.
    const pair = await org();
    const s3 = await seed(pair, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', other: '500' }, { sales: '50000', other: '-500' }]);
    await post(pair, s3);
    await bankLine(pair, '2026-10-20', '150000');
    expect((await worklist(pair)).payouts.map((p) => [p.settlementId, p.adjustable])).toEqual([[s3, []]]);
    // A line with a fraction of a dong cannot be classified (an adjustment is whole dong): the settlement is not offered, never a request that fails validation.
    const frac = await org('tt133', false);
    const s5 = await seed(frac, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', other: '6000.5' }]);
    await post(frac, s5);
    await bankLine(frac, '2026-10-20', '106000.5');
    expect((await worklist(frac)).payouts).toEqual([]);
    // More lines than a request can carry: not offered (an accountant's), never cut short.
    const many = await org('tt133', false);
    const s4 = await seed(many, 'shopee', '2026-10-01', '2026-10-15', Array.from({ length: 101 }, () => ({ sales: '1000', other: '10' })));
    await post(many, s4);
    await bankLine(many, '2026-10-20', '102010');
    expect((await worklist(many)).payouts).toEqual([]);
  });

  it("lists the platform's fee invoices that can clear while fees wait, with the amount a clearing would take, and drops them once cleared", async () => {
    const { o, party } = await paid();
    const doc = await invoice(o, party);
    const small = await invoice(o, party, { total: 10000, vat: 0 });
    // Another supplier's invoice and a reversed one are not offered.
    const [other] = await rows<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'organization', 'Nhà cung cấp khác') RETURNING id`, [o.orgId]);
    await invoice(o, other?.id as string);
    const gone = await invoice(o, party);
    const [entry] = await rows<{ id: string }>(`SELECT id FROM ludy_finance.journal_entry WHERE org_id = $1 AND source_type = 'finance.purchase_document' AND source_id = $2`, [o.orgId, gone]);
    const asked = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: entry?.id, entryDate: '2026-10-26', reason: 'Nhập nhầm' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await approve(o, asked.proposalId);
    const listed = (await worklist(o)).invoices;
    expect(listed.map((i) => [i.documentId, i.clearable]).sort()).toEqual([[doc, '28000'], [small, '10000']].sort());
    // Clearing the small invoice leaves 18 000 waiting: the big one can take only that.
    await approve(o, (await askFee(o, small)).proposalId);
    expect((await worklist(o)).invoices.map((i) => [i.documentId, i.clearable])).toEqual([[doc, '18000']]);
    await approve(o, (await askFee(o, doc)).proposalId);
    expect((await worklist(o)).invoices).toEqual([]);
  });

  it('shows nothing to anyone who may not see the entity, and every role may read it', async () => {
    const { o } = await paid();
    for (const who of [o.owner, o.admin, o.member]) {
      expect((await rt.query<{ postingConfirmed: boolean }>('finance.marketplace.worklist', {}, { actor: asUser(who), orgId: o.orgId })).postingConfirmed).toBe(true);
    }
    expect((await worklist(o, rt, randomUUID())).settlements).toEqual([]);
  });
});
