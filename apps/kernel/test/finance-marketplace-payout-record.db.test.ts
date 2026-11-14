// SPDX-License-Identifier: AGPL-3.0-only
// The posting of a platform's payout (#2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4 "The payout") on a real PostgreSQL 17, through the finance proposal path:
// - a member asks (kernel.proposal.request, `finance.marketplace_payout.record`) with the settlement and the bank line of the transfer, finance builds ONE journal voucher from the stored lines (Dr bank
//   for the money received, Dr 1388 for the fees, Dr 333 for the withheld tax, Cr 131 with the platform's party), an owner or an admin approves it, and approving records one voucher that names the
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
import { MARKETPLACE_POSTING_MAPS, createMarketplacePayoutCommands, createMarketplaceSettlementCommands, financeCommands, financeQueries, type MarketplacePostingMap } from '@crove/mod-finance';
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
const notMarketplace = (name: string) => !name.startsWith('finance.marketplace_settlement.') && !name.startsWith('finance.marketplace_payout.');

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
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands.filter((c) => notMarketplace(c.name)), ...createMarketplaceSettlementCommands({ maps: confirmedMaps() }).commands, ...createMarketplacePayoutCommands({ maps: confirmedMaps() }).commands],
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

  it('posts one voucher naming the settlement and the bank line: Dr bank, Dr 1388, Dr 333, Cr 131 with the platform party, and the Sàn read clears', async () => {
    const { o, settlement, line } = await posted();
    const party = await partyOf(o, 'shopee');
    expect(party).toBeTruthy();
    expect((await balance(o)).rows[0]).toMatchObject({ platform: 'shopee', salesPosted: '335000', paidOut: '0', awaitingPayout: '335000', feesAwaitingInvoice: '0' });
    const { proposalId } = await ask(o, settlement, line);
    const stored = await payloadOf(o, proposalId);
    expect(stored).toMatchObject({ settlementId: settlement, bankLineId: line, platform: 'shopee', date: '2026-10-20', received: RECEIVED, fees: '28000', taxWithheld: '3000', total: '335000', legalEntityId: o.entity });
    expect(stored?.lines.map((l) => [l.account, l.debit, l.credit, l.party?.id ?? null])).toEqual([['1121', RECEIVED, '0', null], ['1388', '28000', '0', party], ['333', '3000', '0', null], ['131', '0', '335000', party]]);
    expect(await payoutsOf(o, settlement)).toHaveLength(0);
    const done = await approve(o, proposalId);
    const [voucher] = await payoutsOf(o, settlement);
    expect(voucher).toMatchObject({ id: done.voucherId, proposal_id: proposalId, payout_bank_line_id: line });
    expect((await entryOf(o, done.journalEntryId)).map((l) => [l.account_code, l.debit, l.credit, l.party_id])).toEqual([['1121', RECEIVED, '0', null], ['1388', '28000', '0', party], ['333', '3000', '0', null], ['131', '0', '335000', party]]);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('executed');
    // The Sàn read: the receivable is cleared (the whole credit, fees and tax included) and the fees wait on 1388 for their invoice.
    expect((await balance(o)).rows[0]).toMatchObject({ platform: 'shopee', salesPosted: '335000', paidOut: '335000', awaitingPayout: '0', feesAwaitingInvoice: '28000' });
  });

  it('posts the payout of a settlement with no fee and no tax as two lines', async () => {
    const { o, settlement, line } = await posted('tiktok_shop', [{ sales: '90000', discount: '0' }], '90000');
    const done = await approve(o, (await ask(o, settlement, line)).proposalId);
    expect((await entryOf(o, done.journalEntryId)).map((l) => [l.account_code, l.debit, l.credit])).toEqual([['1121', '90000', '0'], ['131', '0', '90000']]);
  });

  it('refuses a payout before its settlement is posted, and after that posting was reversed: ghi sổ kỳ đối soát trước', async () => {
    const o = await org();
    const settlement = await seed(o, 'shopee', '2026-10-01', '2026-10-15', PAID);
    const line = await bankLine(o, '2026-10-20', RECEIVED);
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', status: 409 });
    // A proposal that cannot exist through the preparer, written by hand, is refused at approval for the same reason.
    const done = await post(o, settlement);
    const pending = await ask(o, settlement, line);
    await rt.execute('finance.journal.reverse', { entryId: done.journalEntryId, reason: 'đảo để sửa' }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() }).catch(() => undefined);
    const reversed = (await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_finance.journal_entry WHERE org_id = $1 AND reverses_entry_id = $2', [o.orgId, done.journalEntryId]))[0]?.n === '1';
    if (reversed) {
      await expect(approve(o, pending.proposalId)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', status: 409 });
      await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', status: 409 });
      expect(await payoutsOf(o, settlement)).toHaveLength(0);
    }
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

  it('refuses a line a bank voucher already took', async () => {
    const { o, settlement, line } = await posted();
    const voucher = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.voucher.record', input: { type: 'bank_credit', date: '2026-10-20', cashAccount: '1121', description: 'thu tiền sàn', lines: [{ account: '711', amount: RECEIVED }], bankLineId: line } }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(ask(o, settlement, line)).rejects.toMatchObject({ code: 'MARKETPLACE_PAYOUT_BANK_LINE', status: 409 });
    await approve(o, voucher.proposalId).catch(() => undefined);
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
    expect(MARKETPLACE_POSTING_MAPS.tt133?.status).toBe('commentary');
    const { o, settlement, line } = await posted();
    await expect(ask(o, settlement, line, o.admin, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    const { proposalId } = await ask(o, settlement, line);
    await expect(approve(o, proposalId, o.owner, rtShipped)).rejects.toMatchObject({ code: 'MARKETPLACE_POSTING_MAP_UNCONFIRMED', status: 409 });
    expect(await payoutsOf(o, settlement)).toHaveLength(0);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0]?.status).toBe('pending');
    expect(MARKETPLACE_POSTING_MAPS.tt133?.status).toBe('commentary');
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
