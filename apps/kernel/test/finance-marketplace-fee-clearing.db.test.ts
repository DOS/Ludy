// SPDX-License-Identifier: AGPL-3.0-only
// The clearing of a platform's waiting fees by its fee e-invoice (#2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4 "The payout" and section 11) on a real PostgreSQL 17, through the
// finance proposal path:
// - a member asks (kernel.proposal.request, `finance.marketplace_fee_clearing.record`) with the posted purchase invoice of the platform alone, finance builds ONE journal voucher Dr 331 / Cr 1388, the
//   platform's party on both lines, an owner or an admin approves it, and approving records one voucher that names the invoice, with its entry; the Sàn read shows the fees no longer waiting;
// - the amount is the smaller of what the invoice still has to clear and the platform's 1388 balance; an invoice may be cleared more than once, never beyond its credit to 331, also when two proposals
//   wait together; a reversed clearing frees its amount; a second invoice for the same fees clears only what waits;
// - either order of arrival: an invoice posted before the payout clears nothing until the payout stands;
// - a document that is not the posted, standing, purchase invoice of a platform (in dong, with a credit to 331), a closed period, a stored proposal that differs and a chart with no map are refused;
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
import { MARKETPLACE_POSTING_MAPS, createMarketplaceFeeClearingCommands, createMarketplacePayoutCommands, createMarketplaceSettlementCommands, financeCommands, financeQueries, type MarketplacePostingMap } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A copy of the shipped map with every row confirmed, for the runtime that posts.
const confirmedMaps = (): Record<string, MarketplacePostingMap> => {
  const base = MARKETPLACE_POSTING_MAPS.tt133 as MarketplacePostingMap;
  const c = <T extends { status: string }>(r: T): T => ({ ...r, status: 'confirmed' });
  return { tt133: { ...base, status: 'confirmed', receivable: c(base.receivable), revenue: c(base.revenue), salesReturn: c(base.salesReturn), cash: c(base.cash), feePayable: c(base.feePayable), feeAwaitingInvoice: c(base.feeAwaitingInvoice), taxWithheld: c(base.taxWithheld) } };
};
const notMarketplace = (name: string) => !name.startsWith('finance.marketplace_settlement.') && !name.startsWith('finance.marketplace_payout.') && !name.startsWith('finance.marketplace_fee_clearing.');

interface SeedLine {
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

suite("the clearing of a platform's waiting fees on PostgreSQL (#2516)", () => {
  const dbName = `crove_test_mkt_fee_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  async function org(regime: 'tt133' | 'tt99' = 'tt133') {
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
  // The settlement posted (Dr 131 / Cr 511), the state a payout needs.
  const post = async (o: Org, settlementId: string) => approve(o, (await askSettlement(o, settlementId)).proposalId);
  const payloadOf = async (o: Org, proposalId: string) =>
    (await rows<{ payload: { lines: { account: string; party: { id: string } | null; debit: string; credit: string }[] } & Record<string, unknown> }>('SELECT payload FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.payload;
  const entryOf = (o: Org, entryId: string) =>
    rows<{ account_code: string; debit: string; credit: string; party_id: string | null }>(
      'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit, party_id FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY line_no',
      [o.orgId, entryId],
    );
  const partyOf = async (o: Org, platform: string) => (await rows<{ party_id: string }>('SELECT party_id FROM crove_finance.marketplace_party WHERE org_id = $1 AND legal_entity_id = $2 AND platform = $3', [o.orgId, o.entity, platform]))[0]?.party_id;
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

  const askFee = (o: Org, purchaseDocumentId: string, user = o.admin, runtime = rt) =>
    runtime.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.marketplace_fee_clearing.record', input: { purchaseDocumentId } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const clearingsOf = (o: Org, documentId: string) => rows<{ id: string; proposal_id: string }>('SELECT id, proposal_id FROM crove_finance.journal_voucher WHERE org_id = $1 AND fee_document_id = $2', [o.orgId, documentId]);
  // The platform's fee invoice as the purchase path leaves it: the document and its standing entry, Dr expense and Dr 1331, Cr 331 naming the party (one transaction, the deferred checks run at commit).
  async function invoice(o: Org, partyId: string, over: { total?: number; vat?: number; date?: string; direction?: string; currency?: string; credit?: string } = {}): Promise<string> {
    const total = over.total ?? 30800;
    const vat = over.vat ?? 2800;
    const docId = randomUUID();
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      const foreign = (over.currency ?? 'VND') !== 'VND';
      await c.query(
        `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, currency, exchange_rate, exchange_rate_source, foreign_subtotal, foreign_vat_amount, foreign_total)
         VALUES ($1, $2, $3, '1C26TPF', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [o.orgId, docId, partyId, randomUUID().slice(0, 8), over.date ?? '2026-10-25', total - vat, vat, total, over.direction ?? 'purchase', over.currency ?? 'VND', foreign ? 25000 : null, foreign ? 'entered' : null, foreign ? 1 : null, foreign ? 0 : null, foreign ? 1 : null],
      );
      {
        const entryId = randomUUID();
        await c.query(`INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, $3, 'Phí sàn', 'finance.purchase_document', $4)`, [o.orgId, entryId, over.date ?? '2026-10-25', docId]);
        await c.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 1, '6422', $3, 0, NULL)`, [o.orgId, entryId, total - vat]);
        if (vat > 0) await c.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 2, '1331', $3, 0, NULL)`, [o.orgId, entryId, vat]);
        await c.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 3, $3, 0, $4, $5)`, [o.orgId, entryId, over.credit ?? '331', total, partyId]);
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
  const fees1388 = async (o: Org) => (await balance(o)).rows[0]?.feesAwaitingInvoice;

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
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands.filter((c) => notMarketplace(c.name)), ...createMarketplaceSettlementCommands({ maps: confirmedMaps() }).commands, ...createMarketplacePayoutCommands({ maps: confirmedMaps() }).commands, ...createMarketplaceFeeClearingCommands({ maps: confirmedMaps() }).commands],
      ...base,
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

  it('clears the waiting fees by the invoice: one voucher Dr 331 / Cr 1388, the platform party on both lines, and the Sàn read shows them no longer waiting', async () => {
    const { o, party } = await paid();
    expect(await fees1388(o)).toBe('28000');
    const doc = await invoice(o, party);
    const { proposalId } = await askFee(o, doc);
    const stored = await payloadOf(o, proposalId);
    expect(stored).toMatchObject({ purchaseDocumentId: doc, platform: 'shopee', invoiceTotal: '30800', alreadyCleared: '0', waiting: '28000', amount: '28000', total: '28000', legalEntityId: o.entity });
    expect(stored?.lines.map((l) => [l.account, l.debit, l.credit, l.party?.id ?? null])).toEqual([['331', '28000', '0', party], ['1388', '0', '28000', party]]);
    expect(await clearingsOf(o, doc)).toHaveLength(0);
    const done = await approve(o, proposalId);
    expect(await clearingsOf(o, doc)).toEqual([{ id: done.voucherId, proposal_id: proposalId }]);
    expect((await entryOf(o, done.journalEntryId)).map((l) => [l.account_code, l.debit, l.credit, l.party_id])).toEqual([['331', '28000', '0', party], ['1388', '0', '28000', party]]);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('executed');
    expect(await fees1388(o)).toBe('0');
    // The invoice's own VAT stays as posted: the 2 800 left on 331 is the platform's, not cleared by 1388.
    await expect(askFee(o, doc)).rejects.toMatchObject({ code: 'MARKETPLACE_FEE_NOTHING_TO_CLEAR', status: 409 });
  });

  it('clears an invoice in parts, never beyond what it has to clear or what waits, and a second invoice for the same fees clears only the rest', async () => {
    const { o, party } = await paid();
    const small = await invoice(o, party, { total: 10000, vat: 0 });
    const first = await approve(o, (await askFee(o, small)).proposalId);
    expect((await entryOf(o, first.journalEntryId)).map((l) => l.debit)).toEqual(['10000', '0']);
    expect(await fees1388(o)).toBe('18000');
    // The small invoice has cleared its whole credit to 331: nothing more.
    await expect(askFee(o, small)).rejects.toMatchObject({ code: 'MARKETPLACE_FEE_NOTHING_TO_CLEAR', status: 409, details: { reason: 'INVOICE_CLEARED' } });
    // The fees booked a second time (the statement and a second invoice): the second invoice clears only what waits.
    const big = await invoice(o, party, { total: 30800, vat: 2800 });
    const second = await approve(o, (await askFee(o, big)).proposalId);
    expect((await entryOf(o, second.journalEntryId)).map((l) => l.debit)).toEqual(['18000', '0']);
    expect(await fees1388(o)).toBe('0');
    const third = await invoice(o, party, { total: 5000, vat: 0 });
    await expect(askFee(o, third)).rejects.toMatchObject({ code: 'MARKETPLACE_FEE_NOTHING_TO_CLEAR', details: { reason: 'NOTHING_WAITING' } });
    expect(await clearingsOf(o, small)).toHaveLength(1);
  });

  it('holds the cap when two proposals of one invoice wait together: the second is refused at its approval', async () => {
    const { o, party } = await paid();
    const doc = await invoice(o, party, { total: 20000, vat: 0 });
    const a = await askFee(o, doc);
    const b = await askFee(o, doc, o.member);
    expect(await payloadOf(o, a.proposalId)).toMatchObject({ amount: '20000' });
    expect(await payloadOf(o, b.proposalId)).toMatchObject({ amount: '20000' });
    await approve(o, a.proposalId);
    await expect(approve(o, b.proposalId)).rejects.toMatchObject({ code: 'MARKETPLACE_FEE_NOTHING_TO_CLEAR', status: 409 });
    expect(await clearingsOf(o, doc)).toHaveLength(1);
    expect(await fees1388(o)).toBe('8000');
  });

  it('works in either order of arrival: an invoice posted before the payout clears nothing until the payout stands', async () => {
    const { o, settlement, line } = await posted();
    const party = (await partyOf(o, 'shopee')) as string;
    const doc = await invoice(o, party);
    await expect(askFee(o, doc)).rejects.toMatchObject({ code: 'MARKETPLACE_FEE_NOTHING_TO_CLEAR', status: 409, details: { reason: 'NOTHING_WAITING' } });
    await approve(o, (await ask(o, settlement, line)).proposalId);
    const done = await approve(o, (await askFee(o, doc)).proposalId);
    expect((await entryOf(o, done.journalEntryId)).map((l) => l.debit)).toEqual(['28000', '0']);
    expect(await fees1388(o)).toBe('0');
  });

  it('frees the amount of a reversed clearing: the invoice can clear it again', async () => {
    const { o, party } = await paid();
    const doc = await invoice(o, party);
    const done = await approve(o, (await askFee(o, doc)).proposalId);
    expect(await fees1388(o)).toBe('0');
    const asked = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: done.journalEntryId, entryDate: '2026-10-26', reason: 'Nhầm hóa đơn' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await approve(o, asked.proposalId);
    expect(await fees1388(o)).toBe('28000');
    const again = await approve(o, (await askFee(o, doc)).proposalId);
    expect((await entryOf(o, again.journalEntryId)).map((l) => l.debit)).toEqual(['28000', '0']);
    expect(await clearingsOf(o, doc)).toHaveLength(2);
    expect(await fees1388(o)).toBe('0');
  });

  it('refuses a document that is not the standing purchase invoice of a platform, in dong, with a credit to 331', async () => {
    const { o, party } = await paid();
    const refused = (docId: string, reason: string) => expect(askFee(o, docId)).rejects.toMatchObject({ code: 'MARKETPLACE_FEE_DOCUMENT', status: 422, details: { reason } });
    await refused(randomUUID(), 'NOT_FOUND');
    await refused(await invoice(o, party, { direction: 'sale' }), 'DIRECTION');
    await refused(await invoice(o, party, { currency: 'USD' }), 'CURRENCY');
    // A purchase document with no entry cannot be stored (the database holds that a document is posted in its own transaction), so NOT_POSTED has no case here.
    await refused(await invoice(o, party, { credit: '1111' }), 'NO_PAYABLE');
    // A supplier that is not a platform's party.
    const [other] = await rows<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name) VALUES ($1, 'organization', 'Nhà cung cấp khác') RETURNING id`, [o.orgId]);
    await refused(await invoice(o, other?.id as string), 'NOT_PLATFORM');
    // A reversed invoice no longer stands.
    const doc = await invoice(o, party);
    const [entry] = await rows<{ id: string }>(`SELECT id FROM crove_finance.journal_entry WHERE org_id = $1 AND source_type = 'finance.purchase_document' AND source_id = $2`, [o.orgId, doc]);
    const asked = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: entry?.id, entryDate: '2026-10-26', reason: 'Hóa đơn nhập nhầm' } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await approve(o, asked.proposalId);
    await refused(doc, 'REVERSED');
    expect(await rows('SELECT 1 FROM crove_finance.journal_voucher WHERE org_id = $1 AND fee_document_id IS NOT NULL', [o.orgId])).toHaveLength(0);
  });

  it('refuses a closed period on the date of the entry, at the request and at the approval of a proposal made before the lock', async () => {
    const { o, party } = await paid();
    const doc = await invoice(o, party);
    const pending = await askFee(o, doc);
    await rt.execute('finance.period.lock', { month: '2026-10' }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(askFee(o, doc)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
    await expect(approve(o, pending.proposalId)).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
    expect(await clearingsOf(o, doc)).toHaveLength(0);
  });

  it('refuses a stored proposal that differs from the invoice and the waiting fees, however it got there', async () => {
    const { o, party } = await paid();
    const doc = await invoice(o, party);
    const tamper = async (sql: string, ...extra: unknown[]) => {
      const { proposalId } = await askFee(o, doc);
      await rows(sql, [o.orgId, proposalId, ...extra]);
      await expect(approve(o, proposalId), sql).rejects.toMatchObject({ code: 'MARKETPLACE_FEE_MISMATCH', status: 422 });
      await rt.execute('kernel.proposal.reject', { id: proposalId }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    };
    // A larger amount (balanced, so only the rebuild catches it), other accounts, another entity, a party the link does not hold, a swapped side.
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(jsonb_set(jsonb_set(jsonb_set(payload, '{lines,0,debit}', '"30800"'), '{lines,1,credit}', '"30800"'), '{total}', '"30800"'), '{amount}', '"30800"') WHERE org_id = $1 AND id = $2`);
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{lines,1,account}', '"1381"') WHERE org_id = $1 AND id = $2`);
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{legalEntityId}', to_jsonb($3::text)) WHERE org_id = $1 AND id = $2`, randomUUID());
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{lines,0,party}', jsonb_build_object('id', $3::text, 'name', 'Shopee', 'taxCode', null)) WHERE org_id = $1 AND id = $2`, randomUUID());
    await tamper(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{waiting}', '"99000"') WHERE org_id = $1 AND id = $2`);
    expect(await clearingsOf(o, doc)).toHaveLength(0);
    expect(await fees1388(o)).toBe('28000');
  });

  it('takes the four-eyes rule of every ledger command: the requester does not approve while another may, a member cannot approve', async () => {
    const { o, party } = await paid();
    const doc = await invoice(o, party);
    const { proposalId } = await askFee(o, doc, o.admin);
    await expect(approve(o, proposalId, o.admin)).rejects.toMatchObject({ status: 403 });
    await expect(approve(o, proposalId, o.member)).rejects.toMatchObject({ status: 403 });
    await expect(approve(o, proposalId, o.owner)).resolves.toMatchObject({ voucherId: expect.any(String) });
  });

  it('refuses both the request and the approval with 409 while the shipped map is unconfirmed, and writes nothing', async () => {
    expect(MARKETPLACE_POSTING_MAPS.tt133?.status).toBe('commentary');
    const { o, party } = await paid();
    const doc = await invoice(o, party);
    await expect(askFee(o, doc, o.admin, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    const { proposalId } = await askFee(o, doc);
    await expect(approve(o, proposalId, o.owner, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(await clearingsOf(o, doc)).toHaveLength(0);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('pending');
    expect(MARKETPLACE_POSTING_MAPS.tt133?.status).toBe('commentary');
  });

  it('holds the voucher shape in the database: no other source on a clearing voucher, and a proposal', async () => {
    const { o, party } = await paid();
    const doc = await invoice(o, party);
    const { proposalId } = await askFee(o, doc);
    const insert = (cols: string, vals: unknown[]) => rows(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, ${cols}) VALUES ($1, '2026-10-26', 'x', ${vals.map((_, i) => `$${i + 2}`).join(', ')})`, [o.orgId, ...vals]);
    await expect(insert('fee_document_id', [doc])).rejects.toBeTruthy();
    await expect(insert('proposal_id, fee_document_id, settlement_id', [proposalId, doc, randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(insert('proposal_id, fee_document_id, payout_settlement_id, payout_bank_line_id', [proposalId, doc, randomUUID(), randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(insert('proposal_id, fee_document_id, closing_year', [proposalId, doc, 2025])).rejects.toMatchObject({ code: '23514' });
  });
});
