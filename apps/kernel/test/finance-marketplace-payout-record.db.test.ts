// SPDX-License-Identifier: AGPL-3.0-only
// The posting of a platform's payout (#2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4 "The payout") on a real PostgreSQL 17, through the finance proposal path:
// - a member asks (kernel.proposal.request, `finance.marketplace_payout.record`) with the settlement and the bank line of the transfer, finance builds ONE journal voucher from the stored lines (Dr bank
//   for the money received, Dr 331 for the fees, Dr 3331 and Dr 3335 for the withheld tax, Cr 131 with the platform's party), an owner or an admin approves it, and approving records one voucher that names the
//   settlement and the bank line, with its entry; the Sàn read then shows the receivable cleared and the fees awaiting their invoice;
// - a payout before its settlement is posted (or after that posting was reversed) is refused: "ghi sổ kỳ đối soát trước";
// - the bank line only confirms the transfer: money in, equal to the net, not before the period, free of other vouchers and payouts, and a bank voucher is refused for a line a payout names;
// - the entry is built again at approval: a stored proposal that differs is refused; a payout posts once and a line settles one payout (unique indexes); a closed period, another adjustment and a chart
//   with no map are refused;
// - the shipped set of commands (every row of the account map is `commentary`) refuses with 409 until the accountant confirms the map (#2520).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { MARKETPLACE_POSTING_MAPS, createMarketplacePayoutCommands, createMarketplaceSettlementCommands, createMarketplaceWorklist, financeCommands, financeQueries, type MarketplacePostingMap } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A copy of the shipped map with every row confirmed, for the runtime that posts.
const confirmedMaps = (): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133 as MarketplacePostingMap;
  const c = <T extends { status: string }>(r: T): T => ({ ...r, status: 'confirmed' });
  return { tt133: { ...base, status: 'confirmed', receivable: c(base.receivable), revenue: c(base.revenue), salesReturn: c(base.salesReturn), cash: c(base.cash), feePayable: c(base.feePayable), feeAwaitingInvoice: c(base.feeAwaitingInvoice), taxWithheld: c(base.taxWithheld), vatPayable: c(base.vatPayable), pitPayable: c(base.pitPayable), pitOwnerEquity: c(base.pitOwnerEquity), feeExpense: c(base.feeExpense), accruedExpense: c(base.accruedExpense), outputVat: c(base.outputVat) } };
};
const notMarketplace = (name: string) => !name.startsWith('finance.marketplace_settlement.') && !name.startsWith('finance.marketplace_payout.');

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

suite('the posting of a platform payout on PostgreSQL (#2516)', () => {
  const dbName = `crove_test_mkt_payout_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, admin, member]));
    if (regime === 'tt99') {
      await withAdmin((c) =>
        c.query(`INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) SELECT $1, id, 'tt99', '2026.1', '2026-01-01' FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default`, [orgId]),
      );
    }
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    // Method `none` from the start: these tests are about posting, not about VAT, so a sale posts VAT-inclusive revenue as before (#4303 S3b; the VAT split has its own test).
    await withAdmin((c) => c.query("INSERT INTO crove_finance.marketplace_vat_rate (org_id, legal_entity_id, effective_from, method) VALUES ($1, $2, '2000-01-01', 'none')", [orgId, entity]));
    // A household seller of one line of business with its rates confirmed for the test: the withheld tax is split into VAT and PIT at the settlement's posting (slice C2) and the payout debits it.
    if (household) {
      await withAdmin(async (c) => {
        await c.query("UPDATE crove_kernel.legal_entity SET kind = 'household' WHERE org_id = $1 AND id = $2", [orgId, entity]);
        await c.query("INSERT INTO crove_finance.household_profile (org_id, legal_entity_id, effective_from, tax_group, pit_method, trades) VALUES ($1, $2, '2026-01-01', 2, 'percentage', ARRAY['goods']::text[])", [orgId, entity]);
        await c.query("UPDATE crove_finance.household_trade_rate SET status = 'confirmed' WHERE trade = 'goods'");
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
      await c.query('INSERT INTO crove_finance.channel_settlement (org_id, id, platform, period_start, period_end, report_net) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, id, platform, start, end, net]);
      for (const [i, l] of lines.entries()) {
        const orderId = randomUUID();
        await c.query('INSERT INTO crove_finance.channel_order (org_id, id, platform, order_no) VALUES ($1, $2, $3, $4)', [o.orgId, orderId, platform, `MK${randomUUID().slice(0, 12)}`]);
        if (l.delivered !== null) await c.query("INSERT INTO crove_finance.channel_order_line (org_id, order_id, line_key, quantity, stage, delivered_at) VALUES ($1, $2, 'L1', 1, 'completed', $3)", [o.orgId, orderId, l.delivered ?? start]);
        await c.query(
          'INSERT INTO crove_finance.channel_settlement_line (org_id, id, settlement_id, order_id, line_key, sales, seller_discount, commission, service_fee, payment_fee, shipping, tax_withheld, refund, other, net) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
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
      `INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount, bank_ref) VALUES ($1, $2, $3, 1, $4, 'Shopee thanh toan', $5, $6) RETURNING id`,
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
  const payloadOf = async (o: Org, proposalId: string) =>
    (await rows<{ payload: { lines: { account: string; party: { id: string } | null; debit: string; credit: string }[] } & Record<string, unknown> }>('SELECT payload FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.payload;
  const entryOf = (o: Org, entryId: string) =>
    rows<{ account_code: string; debit: string; credit: string; party_id: string | null }>(
      'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit, party_id FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY line_no',
      [o.orgId, entryId],
    );
  const partyOf = async (o: Org, platform: string) => (await rows<{ party_id: string }>('SELECT party_id FROM crove_finance.marketplace_party WHERE org_id = $1 AND legal_entity_id = $2 AND platform = $3', [o.orgId, o.entity, platform]))[0]?.party_id;
  const payoutsOf = (o: Org, settlementId: string) => rows<{ id: string; proposal_id: string; payout_bank_line_id: string }>('SELECT id, proposal_id, payout_bank_line_id FROM crove_finance.journal_voucher WHERE org_id = $1 AND payout_settlement_id = $2', [o.orgId, settlementId]);
  const balance = (o: Org) => rt.query<{ rows: { platform: string; salesPosted: string; paidOut: string; awaitingPayout: string; feesAwaitingInvoice: string }[] }>('finance.marketplace.balance', {}, { actor: asUser(o.owner), orgId: o.orgId });

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

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 6 });
    const base = { queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    // The runtime that posts registers both marketplace command sets over a confirmed map; the other, the shipped sets.
    // The work list of this runtime reads "today" from the test (the month-end accrual depends on the day).
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands.filter((c) => notMarketplace(c.name)), ...createMarketplaceSettlementCommands({ maps: confirmedMaps() }).commands, ...createMarketplacePayoutCommands({ maps: confirmedMaps() }).commands],
      queries: [...base.queries.filter((q) => q.name !== 'finance.marketplace.worklist'), createMarketplaceWorklist({ maps: confirmedMaps(), today: () => today.value })],
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

  it('posts one voucher naming the settlement and the bank line: Dr bank, Dr 331, Dr 3331 and 3335, Cr 131 with the platform party, and the Sàn read clears', async () => {
    const { o, settlement, line } = await posted();
    const party = await partyOf(o, 'shopee');
    expect(party).toBeTruthy();
    expect((await balance(o)).rows[0]).toMatchObject({ platform: 'shopee', salesPosted: '335000', paidOut: '0', awaitingPayout: '335000', feesAwaitingInvoice: '0' });
    const { proposalId } = await ask(o, settlement, line);
    const stored = await payloadOf(o, proposalId);
    expect(stored).toMatchObject({ settlementId: settlement, bankLineId: line, platform: 'shopee', date: '2026-10-20', received: RECEIVED, fees: '28000', taxWithheld: '3000', total: '335000', legalEntityId: o.entity });
    expect(stored?.lines.map((l) => [l.account, l.debit, l.credit, l.party?.id ?? null])).toEqual([['1121', RECEIVED, '0', null], ['331', '28000', '0', party], ['3331', '2000', '0', null], ['3335', '1000', '0', null], ['131', '0', '335000', party]]);
    expect(await payoutsOf(o, settlement)).toHaveLength(0);
    const done = await approve(o, proposalId);
    const [voucher] = await payoutsOf(o, settlement);
    expect(voucher).toMatchObject({ id: done.voucherId, proposal_id: proposalId, payout_bank_line_id: line });
    expect((await entryOf(o, done.journalEntryId)).map((l) => [l.account_code, l.debit, l.credit, l.party_id])).toEqual([['1121', RECEIVED, '0', null], ['331', '28000', '0', party], ['3331', '2000', '0', null], ['3335', '1000', '0', null], ['131', '0', '335000', party]]);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('executed');
    // The Sàn read: the receivable is cleared (the whole credit, fees and tax included) and the fees wait on 331 for their invoice.
    expect((await balance(o)).rows[0]).toMatchObject({ platform: 'shopee', salesPosted: '335000', paidOut: '335000', awaitingPayout: '0', feesAwaitingInvoice: '28000' });
  });

  it('debits the tax exactly as the settlement credited it, so 3331 and 3335 net to zero, and refuses a withheld tax the settlement did not credit (a seller that is no household)', async () => {
    const { o, settlement, line } = await posted();
    await approve(o, (await ask(o, settlement, line)).proposalId);
    const totals = await rows<{ account_code: string; debit: string; credit: string }>(
      "SELECT account_code, sum(debit)::bigint::text AS debit, sum(credit)::bigint::text AS credit FROM crove_finance.journal_line WHERE org_id = $1 AND account_code IN ('3331', '3335', '333') GROUP BY 1 ORDER BY 1",
      [o.orgId],
    );
    expect(totals).toEqual([{ account_code: '3331', debit: '2000', credit: '2000' }, { account_code: '3335', debit: '1000', credit: '1000' }]);
    // An enterprise seller: the settlement posts with no tax lines, and a payout that would debit tax nobody credited is refused, never booked to 333.
    const e = await org('tt133', false);
    const s2 = await seed(e, 'shopee', '2026-10-01', '2026-10-15', PAID);
    await post(e, s2);
    const l2 = await bankLine(e, '2026-10-20', RECEIVED);
    await expect(ask(e, s2, l2)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE', status: 422 });
  });

  it('leaves the output VAT of the sales (33311) alone at the payout: it debits only the VAT the platform withheld on 3331, though 33311 sits under it', async () => {
    // A household on the deduction method: the settlement credits 33311 for the output VAT (#4303 S3b) and 3331 / 3335 for what the platform withheld; the payout debits the withheld tax exactly.
    const o = await org();
    await withAdmin(async (c) => {
      await c.query('DELETE FROM crove_finance.marketplace_vat_rate WHERE org_id = $1', [o.orgId]);
      await c.query("INSERT INTO crove_finance.marketplace_vat_rate (org_id, legal_entity_id, effective_from, method, vat_percent) VALUES ($1, $2, '2026-01-01', 'deduction', 8)", [o.orgId, o.entity]);
    });
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', PAID);
    await post(o, settlement);
    const line = await bankLine(o, '2026-10-20', RECEIVED);
    await approve(o, (await ask(o, settlement, line)).proposalId);
    const totals = await rows<{ account_code: string; debit: string; credit: string }>(
      "SELECT account_code, sum(debit)::bigint::text AS debit, sum(credit)::bigint::text AS credit FROM crove_finance.journal_line WHERE org_id = $1 AND account_code IN ('3331', '3335', '33311') GROUP BY 1 ORDER BY 1",
      [o.orgId],
    );
    const byAccount = Object.fromEntries(totals.map((t) => [t.account_code, [t.debit, t.credit]]));
    // The withheld VAT and PIT net to zero as before; the output VAT is credited and never debited by the payout.
    expect(byAccount['3331']).toEqual(['2000', '2000']);
    expect(byAccount['3335']).toEqual(['1000', '1000']);
    expect(byAccount['33311']?.[0]).toBe('0');
    expect(Number(byAccount['33311']?.[1])).toBeGreaterThan(0);
  });

  // Reversing a settlement's or a payout's entry through the generic reversal (#3329, option C): the request, its title for the approver, and the entries of a settlement.
  // The day the work list reads as today.
  const today = { value: '2026-10-31' };
  const askReversal = (o: Org, entryId: string, entryDate = '2026-10-21') =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId, entryDate, reason: 'Đảo để sửa' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
  const titleOf = async (o: Org, proposalId: string) => (await rows<{ title: string }>('SELECT title FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.title ?? '';
  // The entries of the settlement's month vouchers, oldest month first.
  const monthEntries = async (o: Org, settlementId: string) =>
    (
      await rows<{ id: string }>(
        `SELECT e.id FROM crove_finance.journal_voucher v JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id AND e.reverses_entry_id IS NULL
         WHERE v.org_id = $1 AND v.settlement_id = $2 ORDER BY v.settlement_month`,
        [o.orgId, settlementId],
      )
    ).map((r) => r.id);

  it('refuses to reverse a settlement month while its payout stands, warns when the payout is reversed (its bank line opens again), and lets the settlement be reversed after', async () => {
    const { o, settlement, line } = await posted();
    const paid = await approve(o, (await ask(o, settlement, line)).proposalId);
    const [month] = await monthEntries(o, settlement);
    // The payout stands: the settlement's posting is not reversed first (the payout cleared what it posted).
    await expect(askReversal(o, month as string)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_PAYOUT_STANDS', status: 409 });
    // The payout itself: asked for with a warning in the title for the approver, then approved.
    const payoutReversal = await askReversal(o, paid.journalEntryId);
    expect(await titleOf(o, payoutReversal.proposalId)).toContain('cảnh báo: khoản sàn trả này đã khớp một dòng ngân hàng');
    await approve(o, payoutReversal.proposalId);
    // Reversed payout: the settlement's single month can be reversed now, with no half-reversed warning (no other month stands).
    const monthReversal = await askReversal(o, month as string);
    expect(await titleOf(o, monthReversal.proposalId)).not.toContain('cảnh báo');
    await approve(o, monthReversal.proposalId);
  });

  it('warns when one month of a settlement is reversed while another stands, lists the settlement as half reversed with the months left, and blocks its payout until the rest is reversed', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', delivered: '2026-09-28' }, { sales: '200000', delivered: '2026-10-02' }]);
    await bankLine(o, '2026-10-20', '300000');
    await post(o, settlement);
    const [first, second] = await monthEntries(o, settlement);
    expect(await rt.query<{ settlementsHalfReversed: number }>('finance.marketplace.facts', {}, { actor: asUser(o.owner), orgId: o.orgId })).toMatchObject({ settlementsHalfReversed: 0 });
    const firstReversal = await askReversal(o, first as string);
    expect(await titleOf(o, firstReversal.proposalId)).toContain('cảnh báo: kỳ đối soát còn 1 tháng chưa đảo');
    await approve(o, firstReversal.proposalId);
    // Half reversed: one standing, one reversed. The facts count it and the work list names it with the count.
    const facts = await rt.query<{ settlementsHalfReversed: number }>('finance.marketplace.facts', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(facts.settlementsHalfReversed).toBe(1);
    const work = await rt.query<{ halfReversed: { settlementId: string; standingMonths: number; reversedMonths: number; platformName: string }[] }>('finance.marketplace.worklist', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(work.halfReversed).toEqual([expect.objectContaining({ settlementId: settlement, standingMonths: 1, reversedMonths: 1, platformName: 'Shopee' })]);
    // The last month: no warning (nothing else stands), and once it is reversed the settlement is no longer half reversed.
    const secondReversal = await askReversal(o, second as string);
    expect(await titleOf(o, secondReversal.proposalId)).not.toContain('cảnh báo');
    await approve(o, secondReversal.proposalId);
    expect(await rt.query<{ settlementsHalfReversed: number }>('finance.marketplace.facts', {}, { actor: asUser(o.owner), orgId: o.orgId })).toMatchObject({ settlementsHalfReversed: 0 });
    expect((await rt.query<{ halfReversed: unknown[] }>('finance.marketplace.worklist', {}, { actor: asUser(o.owner), orgId: o.orgId })).halfReversed).toEqual([]);
  });

  it('refuses a reversal of a settlement entry dated in a closed period at the request', async () => {
    const { o, settlement } = await posted();
    const [month] = await monthEntries(o, settlement);
    await rt.execute('finance.period.lock', { month: '2026-10' }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(askReversal(o, month as string, '2026-10-21')).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
  });

  // The month-end accrual of the fees without an invoice (slice F of #2516, option 2): offered by the work list, asked for as an ordinary general journal voucher, one at a time, reversed from the next month.
  const worklist = (o: Org) =>
    rt.query<{
      accruals: { legalEntityId: string; platform: string; month: string; date: string; amount: string; expenseAccount: string; accruedAccount: string; description: string; proposalId: string | null }[];
      accrualReversals: { entryId: string; month: string; amount: string; reverseOn: string; proposalId: string | null }[];
    }>('finance.marketplace.worklist', {}, { actor: asUser(o.owner), orgId: o.orgId });
  // What the screen sends for an offer: a general journal voucher Dr expense / Cr accrued expense.
  const askAccrual = (o: Org, a: { date: string; description: string; legalEntityId: string; amount: string; expenseAccount: string; accruedAccount: string }) =>
    rt.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      {
        command: 'finance.journal_voucher.record',
        input: { date: a.date, description: a.description, legalEntityId: a.legalEntityId, lines: [{ account: a.expenseAccount, debit: a.amount, credit: '0' }, { account: a.accruedAccount, debit: '0', credit: a.amount }] },
      },
      { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
  // A company whose settlement and payout are posted: the platform kept 12 000 of fees (Dr 331), no invoice yet.
  async function companyWithFees() {
    const o = await org('tt133', false);
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '200000', commission: '10000', service: '2000', delivered: '2026-10-02' }]);
    await post(o, settlement);
    const line = await bankLine(o, '2026-10-20', '188000');
    await approve(o, (await ask(o, settlement, line)).proposalId);
    return o;
  }

  it('offers a company the accrual of the fees without an invoice at month end: one at a time, reversed from the next month, never repeated for the month', async () => {
    const o = await companyWithFees();
    today.value = '2026-10-31';
    const [offer] = (await worklist(o)).accruals;
    expect(offer).toMatchObject({ platform: 'shopee', month: '2026-10', date: '2026-10-31', amount: '12000', expenseAccount: '6421', accruedAccount: '335', proposalId: null });
    expect(offer?.description).toContain('Trích trước phí sàn tháng 10/2026, ước tính');
    // Asked for as a general journal voucher: the title says what it is, and a second request of the same month waits for the first.
    const asked = await askAccrual(o, offer as NonNullable<typeof offer>);
    expect(await titleOf(o, asked.proposalId)).toContain('Trích trước phí sàn tháng 10/2026, ước tính');
    await expect(askAccrual(o, offer as NonNullable<typeof offer>)).rejects.toMatchObject({ code: 'MARKETPLACE_FEE_ACCRUAL_PENDING', status: 409 });
    expect((await worklist(o)).accruals[0]?.proposalId).toBe(asked.proposalId);
    await approve(o, asked.proposalId);
    const posted = Object.fromEntries((await rows<{ a: string; d: string; c: string }>('SELECT account_code AS a, sum(debit)::bigint::text AS d, sum(credit)::bigint::text AS c FROM crove_finance.journal_line WHERE org_id = $1 AND account_code IN (\'6421\', \'335\') GROUP BY 1', [o.orgId])).map((r) => [r.a, [Number(r.d), Number(r.c)]]));
    expect(posted).toEqual({ '6421': [12000, 0], '335': [0, 12000] });
    // It stands: no second accrual (of any month), nothing offered again for the month, and the reversal waits for the first day of the next month.
    await expect(askAccrual(o, offer as NonNullable<typeof offer>)).rejects.toMatchObject({ code: 'MARKETPLACE_FEE_ACCRUAL_STANDS', status: 409 });
    const same = await worklist(o);
    expect(same.accruals).toEqual([]);
    expect(same.accrualReversals).toEqual([]);
    // From the first day of the next month the reversal is offered, dated that day, and a generic reversal posts it.
    today.value = '2026-11-01';
    const [reversal] = (await worklist(o)).accrualReversals;
    expect(reversal).toMatchObject({ month: '2026-10', amount: '12000', reverseOn: '2026-11-01', proposalId: null });
    const reversed = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: reversal?.entryId, entryDate: reversal?.reverseOn, reason: 'Đảo trích trước phí sàn tháng 10/2026' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await approve(o, reversed.proposalId);
    // Reversed: nothing to reverse, and October is not accrued a second time.
    today.value = '2026-11-03';
    const after = await worklist(o);
    expect(after.accrualReversals).toEqual([]);
    expect(after.accruals).toEqual([]);
  });

  // The acceptance of #3711: a settlement with fees, the payout that leaves the fees on 331, the month-end accrual to 335, its reversal on the first day of the next month and the platform's fee invoice
  // (the ordinary purchase entry: Dr expense, Dr 1331 / Cr 331, the platform party on the 331 line) tie 131, 331 and 335 to zero, and the fees are expensed once.
  it('ties 131, 331 and 335 to zero after the fee invoice: settlement, payout, month-end accrual, its reversal, then the invoice (#3711)', async () => {
    const o = await companyWithFees();
    const party = await partyOf(o, 'shopee');
    const net = async () =>
      Object.fromEntries(
        (await rows<{ a: string; n: string }>(
          "SELECT account_code AS a, (sum(debit) - sum(credit))::bigint::text AS n FROM crove_finance.journal_line WHERE org_id = $1 AND account_code IN ('131', '331', '335', '6421', '1331') GROUP BY 1",
          [o.orgId],
        )).map((r) => [r.a, Number(r.n)]),
      );
    // After the settlement and the payout: 131 is cleared, the fees kept wait on 331 (debit).
    expect(await net()).toMatchObject({ '131': 0, '331': 12000 });
    // The month-end accrual: Dr 6421 / Cr 335 of what waits on 331, as the work list offers it, approved by a person.
    today.value = '2026-10-31';
    const [offer] = (await worklist(o)).accruals;
    await approve(o, (await askAccrual(o, offer as NonNullable<typeof offer>)).proposalId);
    expect(await net()).toMatchObject({ '131': 0, '331': 12000, '335': -12000, '6421': 12000 });
    // From the first day of the next month it is reversed, so the invoice's own expense is not counted twice.
    today.value = '2026-11-01';
    const [reversal] = (await worklist(o)).accrualReversals;
    const reversed = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: reversal?.entryId, entryDate: reversal?.reverseOn, reason: 'Đảo trích trước phí sàn tháng 10/2026' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await approve(o, reversed.proposalId);
    expect(await net()).toMatchObject({ '131': 0, '331': 12000, '335': 0, '6421': 0 });
    // The platform's fee invoice for the 12 000 (11 111 of fees and 889 of VAT, 8%): the ordinary purchase entry, naming the platform on the 331 line.
    await rows(
      `WITH e AS (INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, '2026-11-05', 'Hóa đơn phí sàn Shopee', 'test', $2, $3) RETURNING id)
       INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id)
       SELECT $1, e.id, v.n, v.account, v.debit, v.credit, v.party, $3 FROM e, (VALUES (1, '6421', 11111, 0, NULL::uuid), (2, '1331', 889, 0, NULL::uuid), (3, '331', 0, 12000, $4::uuid)) AS v(n, account, debit, credit, party)`,
      [o.orgId, randomUUID(), o.entity, party],
    );
    // 131, 331 and 335 are all zero; the fees are expensed once (the invoice's 11 111) and the VAT sits on 1331.
    expect(await net()).toEqual({ '131': 0, '331': 0, '335': 0, '6421': 11111, '1331': 889 });
    // The Sàn read agrees: nothing waits for an invoice any more, so no age and no flag.
    expect((await balance(o)).rows[0]).toMatchObject({ platform: 'shopee', awaitingPayout: '0', feesAwaitingInvoice: '0' });
  });

  it('does not take a tagged voucher that is not an accrual for the platform\'s standing accrual', async () => {
    const o = await companyWithFees();
    today.value = '2026-10-31';
    const [offer] = (await worklist(o)).accruals;
    // The tag typed on an unrelated voucher (Dr 1111 / Cr 511) changes nothing: it blocks no accrual and is not offered for reversal.
    const forged = await askAccrual(o, { ...(offer as NonNullable<typeof offer>), expenseAccount: '1111', accruedAccount: '511' });
    await approve(o, forged.proposalId);
    today.value = '2026-11-02';
    expect((await worklist(o)).accrualReversals).toEqual([]);
    today.value = '2026-10-31';
    const real = await askAccrual(o, offer as NonNullable<typeof offer>);
    expect(real.proposalId).toBeTruthy();
  });

  it('offers a household no accrual, and no accrual of a platform whose 331 holds no debit', async () => {
    const { o } = await posted();
    today.value = '2026-10-31';
    expect((await worklist(o)).accruals).toEqual([]);
    // A company whose payout cleared no fee has nothing on 331 to accrue.
    const c = await org('tt133', false);
    const settlement = await seed(c, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '90000', delivered: '2026-10-02' }]);
    await post(c, settlement);
    const line = await bankLine(c, '2026-10-20', '90000');
    await approve(c, (await ask(c, settlement, line)).proposalId);
    expect((await worklist(c)).accruals).toEqual([]);
  });

  it('posts the payout of a settlement with no fee and no tax as two lines', async () => {
    const { o, settlement, line } = await posted('tiktok_shop', [{ sales: '90000', discount: '0' }], '90000');
    const done = await approve(o, (await ask(o, settlement, line)).proposalId);
    expect((await entryOf(o, done.journalEntryId)).map((l) => [l.account_code, l.debit, l.credit])).toEqual([['1121', '90000', '0'], ['131', '0', '90000']]);
  });

  it('posts a settlement of two months with one proposal and takes its payout once both vouchers stand; a month reversed on its own refuses the payout', async () => {
    const o = await org();
    // Two months of delivery: the first line was delivered in September, the second in October. The platform paid both at once.
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', delivered: '2026-09-28' }, { sales: '200000', delivered: '2026-10-02' }]);
    const line = await bankLine(o, '2026-10-20', '300000');
    const done = await post(o, settlement);
    expect(await rows("SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND settlement_id = $2", [o.orgId, settlement])).toHaveLength(2);
    const { proposalId } = await ask(o, settlement, line);
    await approve(o, proposalId);
    expect(await payoutsOf(o, settlement)).toHaveLength(1);
    // The credit to 131 is what the two months posted (the stored lines' whole): the platform's balance on 131 is nil.
    const balance = await rows<{ net: string }>("SELECT coalesce(sum(l.debit - l.credit), 0)::text AS net FROM crove_finance.journal_line l WHERE l.org_id = $1 AND l.account_code = '131'", [o.orgId]);
    expect(Number(balance[0]?.net)).toBe(0);
    expect(done.journalEntryId).toBeTruthy();
  });

  it('refuses the payout when one month of the settlement is reversed on its own, at the request and the approval', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', delivered: '2026-09-28' }, { sales: '200000', delivered: '2026-10-02' }]);
    const line = await bankLine(o, '2026-10-20', '300000');
    const done = await post(o, settlement);
    const pending = await ask(o, settlement, line);
    // The accountant reverses the first month's entry (the voucher of September) through the proposal path; the other month stands.
    const asked = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: done.journalEntryId, entryDate: '2026-10-16', reason: 'Đảo để sửa' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await approve(o, asked.proposalId);
    await expect(approve(o, pending.proposalId)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', status: 409 });
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', status: 409 });
    expect(await payoutsOf(o, settlement)).toHaveLength(0);
  });

  it('refuses a payout while a sale of the settlement waits for its delivery day', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000' }, { sales: '50000', delivered: null }]);
    const line = await bankLine(o, '2026-10-20', '150000');
    await expect(askSettlement(o, settlement)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_WAITING_DELIVERY', status: 422 });
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', status: 409 });
  });

  it('refuses a payout before its settlement is posted, and after that posting was reversed: ghi sổ kỳ đối soát trước', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', PAID);
    const line = await bankLine(o, '2026-10-20', RECEIVED);
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', status: 409 });
    // A proposal that cannot exist through the preparer, written by hand, is refused at approval for the same reason.
    const done = await post(o, settlement);
    const pending = await ask(o, settlement, line);
    // The accountant reverses the settlement's posting through the proposal path (finance.journal.reverse), and the reversal must exist before anything is asserted.
    const asked = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: done.journalEntryId, entryDate: '2026-10-16', reason: 'Đảo để sửa' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await approve(o, asked.proposalId);
    expect(await rows('SELECT 1 FROM crove_finance.journal_entry WHERE org_id = $1 AND reverses_entry_id = $2', [o.orgId, done.journalEntryId])).toHaveLength(1);
    await expect(approve(o, pending.proposalId)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', status: 409 });
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', status: 409 });
    expect(await payoutsOf(o, settlement)).toHaveLength(0);
    // A settlement that is not found is not found, and a bank line that is not found is refused.
    await expect(ask(o, randomUUID(), line)).rejects.toMatchObject({ code: 'MARKETPLACE_SETTLEMENT_NOT_FOUND', status: 404 });
    await expect(ask(o, settlement, randomUUID())).rejects.toMatchObject({ code: 'BANK_LINE_NOT_FOUND' });
  });

  it('lets the bank line only confirm the transfer: money in, equal to the net, not before the period, in the same entity', async () => {
    const { o, settlement } = await posted();
    const refused = (lineId: string, reason: string) => expect(ask(o, settlement, lineId)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_BANK_LINE', details: { reason } });
    await refused(await bankLine(o, '2026-10-20', '303999'), 'AMOUNT');
    await refused(await bankLine(o, '2026-10-20', '-304000'), 'AMOUNT');
    await refused(await bankLine(o, '2026-09-30', RECEIVED), 'DATE');
    // The amounts of the settlement come from its stored lines, never from the bank line: an exact line of another size is refused rather than followed.
    await refused(await bankLine(o, '2026-10-20', '335000'), 'AMOUNT');
    expect((await rows('SELECT 1 FROM crove_kernel.proposal WHERE org_id = $1 AND command = $2', [o.orgId, 'finance.marketplace_payout.record']))).toHaveLength(0);
  });

  it('settles a line once: a second request while one is pending, a second after the posting, a line a bank voucher took, and a bank voucher for a line a payout holds are refused', async () => {
    const { o, settlement, line } = await posted();
    const first = await ask(o, settlement, line);
    // While the payout is pending the line is taken, for another payout and for a bank voucher.
    await expect(ask(o, settlement, line, o.member)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_BANK_LINE', status: 409 });
    await expect(rt.execute('kernel.proposal.request', { command: 'finance.voucher.record', input: { type: 'bank_credit', date: '2026-10-20', cashAccount: '1121', description: 'trùng', lines: [{ account: '711', amount: RECEIVED }], bankLineId: line } }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'BANK_LINE_PROPOSED' });
    await approve(o, first.proposalId);
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ status: 409 });
    expect(await payoutsOf(o, settlement)).toHaveLength(1);
    // After the posting the line is matched for a bank voucher, and the settlement is paid out once whatever the command does.
    await expect(rt.execute('kernel.proposal.request', { command: 'finance.voucher.record', input: { type: 'bank_credit', date: '2026-10-20', cashAccount: '1121', description: 'trùng', lines: [{ account: '711', amount: RECEIVED }], bankLineId: line } }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'BANK_LINE_MATCHED' });
    await expect(rows(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payout_settlement_id, payout_bank_line_id) VALUES ($1, '2026-10-20', 'x', $2, $3, $4)`, [o.orgId, first.proposalId, settlement, randomUUID()])).rejects.toMatchObject({ code: '23505' });
    await expect(rows(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payout_settlement_id, payout_bank_line_id) VALUES ($1, '2026-10-20', 'x', $2, $3, $4)`, [o.orgId, first.proposalId, randomUUID(), line])).rejects.toMatchObject({ code: '23505' });
  });

  it('does not post a reversed payout again: the settlement and the line stay with it, and a bank voucher may take the freed line', async () => {
    const { o, settlement, line } = await posted();
    const done = await approve(o, (await ask(o, settlement, line)).proposalId);
    // The accountant reverses the payout (a wrong line, for instance) through the ordinary reversal.
    const asked = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: done.journalEntryId, entryDate: '2026-10-21', reason: 'Nhầm dòng sao kê' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await approve(o, asked.proposalId);
    expect((await rows('SELECT 1 FROM crove_finance.journal_entry WHERE org_id = $1 AND reverses_entry_id = $2', [o.orgId, done.journalEntryId])).length).toBe(1);
    // Asking again is refused cleanly at the request (the database holds one payout voucher per settlement and per line for good), never as a unique violation at the approval.
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_POSTED', status: 409 });
    const other = await bankLine(o, '2026-10-21', RECEIVED);
    await expect(ask(o, settlement, other)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_POSTED', status: 409 });
    expect(await payoutsOf(o, settlement)).toHaveLength(1);
    // The freed line is open for a bank voucher again.
    await expect(rt.execute('kernel.proposal.request', { command: 'finance.voucher.record', input: { type: 'bank_credit', date: '2026-10-20', cashAccount: '1121', description: 'thu lại', lines: [{ account: '711', amount: RECEIVED }], bankLineId: line } }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() })).resolves.toMatchObject({ proposalId: expect.any(String) });
  });

  it('shows the line of a payout on the bank screen: proposed while it waits, matched with its own code once posted, open again when the payout is reversed', async () => {
    const { o, settlement, line } = await posted();
    const state = async () =>
      new Map((await rt.query<{ lines: { id: string; state: { status: string; code?: string; proposalId?: string } }[] }>('finance.bank.lines', { bankAccount: '1121', period: '2026-10' }, { actor: asUser(o.owner), orgId: o.orgId })).lines.map((l) => [l.id, l.state] as const)).get(line);
    expect(await state()).toEqual({ status: 'open' });
    const { proposalId } = await ask(o, settlement, line);
    expect(await state()).toEqual({ status: 'proposed', proposalId });
    const done = await approve(o, proposalId);
    expect(await state()).toMatchObject({ status: 'matched', code: expect.stringMatching(/^NVK\d{5,}$/) });
    // The payout's entry reversed frees the line for a bank voucher (the payout itself is not posted again, see the test of the reversed payout).
    const asked = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: done.journalEntryId, entryDate: '2026-10-21', reason: 'Nhầm dòng sao kê' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await approve(o, asked.proposalId);
    expect(await state()).toEqual({ status: 'open' });
  });

  it('refuses a line a bank voucher already took', async () => {
    const { o, settlement, line } = await posted();
    const voucher = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.voucher.record', input: { type: 'bank_credit', date: '2026-10-20', cashAccount: '1121', description: 'thu tiền sàn', lines: [{ account: '711', amount: RECEIVED }], bankLineId: line } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_BANK_LINE', status: 409 });
    // The bank voucher is approved and posted, so the line is matched, not only proposed.
    await approve(o, voucher.proposalId);
    expect(await rows('SELECT 1 FROM crove_finance.cash_voucher WHERE org_id = $1 AND bank_line_id = $2', [o.orgId, line])).toHaveLength(1);
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_BANK_LINE', status: 409 });
  });

  it('refuses a stored proposal that differs from the settlement or the line, however it got there', async () => {
    const { o, settlement, line } = await posted();
    const tamper = async (sql: string, ...extra: unknown[]) => {
      const { proposalId } = await ask(o, settlement, line);
      await rows(sql, [o.orgId, proposalId, ...extra]);
      await expect(approve(o, proposalId), sql).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_MISMATCH', status: 422 });
      await rt.execute('kernel.proposal.reject', { id: proposalId }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    };
    // A bigger transfer (balanced, so only the rebuild catches it), other accounts, another bank line, another entity, a party the link does not hold, a swapped split.
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(jsonb_set(jsonb_set(payload, '{lines,0,debit}', '"999000"'), '{lines,3,credit}', '"1032000"'), '{total}', '"1032000"') WHERE org_id = $1 AND id = $2`);
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{lines,0,account}', '"1111"') WHERE org_id = $1 AND id = $2`);
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{legalEntityId}', to_jsonb($3::text)) WHERE org_id = $1 AND id = $2`, randomUUID());
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{lines,1,party}', jsonb_build_object('id', $3::text, 'name', 'Shopee', 'taxCode', null)) WHERE org_id = $1 AND id = $2`, randomUUID());
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(jsonb_set(jsonb_set(jsonb_set(payload, '{lines,1,debit}', '"3000"'), '{lines,2,debit}', '"28000"'), '{lines,1,account}', '"333"'), '{lines,2,account}', '"1388"') WHERE org_id = $1 AND id = $2`);
    expect(await payoutsOf(o, settlement)).toHaveLength(0);
    // A bank line that does not exist is not found at approval; one of the same size on another day is another line, and the rebuilt date differs from the stored one.
    const gone = await ask(o, settlement, line);
    await rows(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{bankLineId}', to_jsonb($3::text)) WHERE org_id = $1 AND id = $2`, [o.orgId, gone.proposalId, randomUUID()]);
    await expect(approve(o, gone.proposalId)).rejects.toMatchObject({ code: 'BANK_LINE_NOT_FOUND' });
    await rt.execute('kernel.proposal.reject', { id: gone.proposalId }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    const other = await bankLine(o, '2026-10-21', RECEIVED);
    const { proposalId } = await ask(o, settlement, line);
    await rows(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{bankLineId}', to_jsonb($3::text)) WHERE org_id = $1 AND id = $2`, [o.orgId, proposalId, other]);
    await expect(approve(o, proposalId)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_MISMATCH' });
  });

  it('refuses a closed period on the day of the transfer, at the request and at the approval of a proposal made before the lock', async () => {
    const { o, settlement, line } = await posted();
    const pending = await ask(o, settlement, line);
    const early = await bankLine(o, '2026-10-02', RECEIVED);
    await rt.execute('finance.period.lock', { month: '2026-10' }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(ask(o, settlement, early)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
    await expect(approve(o, pending.proposalId)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
    expect(await payoutsOf(o, settlement)).toHaveLength(0);
  });

  it('refuses a settlement that carries another adjustment, a negative net, and a chart with no map, and writes nothing', async () => {
    const o = await org();
    const odd = await seed(o, 'shopee', '2026-10-01', '2026-10-15', [{ sales: '100000', other: '500' }]);
    await post(o, odd);
    await expect(ask(o, odd, await bankLine(o, '2026-10-20', '100500'))).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE', status: 422, details: { reason: 'OTHER' } });
    // Refunds above the sales: the settlement posted the other way (the platform owes less), so there is no payout to post.
    const negative = await seed(o, 'tiktok_shop', '2026-10-01', '2026-10-15', [{ sales: '10000', refund: '28000' }]);
    await post(o, negative);
    await expect(ask(o, negative, await bankLine(o, '2026-10-20', '1000'))).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_NOT_POSTABLE', status: 422 });
    const tt99 = await org('tt99');
    const there = await seed(tt99, 'shopee', '2026-10-01', '2026-10-15', PAID);
    await expect(ask(tt99, there, await bankLine(tt99, '2026-10-20', RECEIVED))).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_REGIME_UNKNOWN', status: 422 });
    expect(await rows('SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND payout_settlement_id IS NOT NULL', [o.orgId])).toHaveLength(0);
  });

  it('takes the four-eyes rule of every ledger command: the requester does not approve while another may, a member cannot approve', async () => {
    const { o, settlement, line } = await posted();
    const { proposalId } = await ask(o, settlement, line, o.admin);
    await expect(approve(o, proposalId, o.admin)).rejects.toMatchObject({ status: 403 });
    await expect(approve(o, proposalId, o.member)).rejects.toMatchObject({ status: 403 });
    await expect(approve(o, proposalId, o.owner)).resolves.toMatchObject({ voucherId: expect.any(String) });
  });

  it('refuses both the request and the approval with 409 while the shipped map is unconfirmed, and writes nothing', async () => {
    // The payout rows stay commentary: only the sales path is applied on the shipped map (#4303 S3b).
    expect(MARKETPLACE_POSTING_MAPS.tt133?.cash.status).toBe('commentary');
    const { o, settlement, line } = await posted();
    await expect(ask(o, settlement, line, o.admin, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    const { proposalId } = await ask(o, settlement, line);
    await expect(approve(o, proposalId, o.owner, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(await payoutsOf(o, settlement)).toHaveLength(0);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('pending');
    // The payout rows stay commentary: only the sales path is applied on the shipped map (#4303 S3b).
    expect(MARKETPLACE_POSTING_MAPS.tt133?.cash.status).toBe('commentary');
  });

  it('holds the voucher shape in the database: both columns or none, and no other source on a payout voucher', async () => {
    const { o, settlement, line } = await posted();
    const { proposalId } = await ask(o, settlement, line);
    const insert = (cols: string, vals: unknown[]) => rows(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, ${cols}) VALUES ($1, '2026-10-20', 'x', ${vals.map((_, i) => `$${i + 2}`).join(', ')})`, [o.orgId, ...vals]);
    await expect(insert('proposal_id, payout_settlement_id', [proposalId, randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(insert('proposal_id, payout_bank_line_id', [proposalId, randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(insert('payout_settlement_id, payout_bank_line_id', [randomUUID(), randomUUID()])).rejects.toBeTruthy();
    await expect(insert('proposal_id, payout_settlement_id, payout_bank_line_id, settlement_id', [proposalId, randomUUID(), randomUUID(), randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(insert('proposal_id, payout_settlement_id, payout_bank_line_id, closing_year', [proposalId, randomUUID(), randomUUID(), 2025])).rejects.toMatchObject({ code: '23514' });
  });
});
