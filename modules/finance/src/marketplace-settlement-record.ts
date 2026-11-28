// SPDX-License-Identifier: AGPL-3.0-only
// The posting of a stored marketplace settlement (issue #2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4): ONE general journal voucher per settlement AND MONTH of delivery
// (marketplace-settlement-months.ts; revenue belongs to the month of successful delivery, working answer A5 of #2520), Dr 131 (the platform) / Cr 511 for the month's sales net of the seller
// discounts and the refunds (the reverse when the net is negative). The entry is built by settlementProposal (marketplace-settlement-posting.ts)
// from the stored lines of channel_settlement, and nothing is built or posted until the accountant has confirmed the account map (requireConfirmedMarketplaceMap, #2520):
// - finance.marketplace_settlement.prepare (R1, internal): the preparer of kernel.proposal.request for `finance.marketplace_settlement.record`. The request carries the settlement alone. It checks
//   the gate, that the settlement stands (it is no reversal and has none), is not posted yet, its period is open, and its accounts are usable, then returns the proposal. It writes nothing.
// - finance.marketplace_settlement.record (R3): runs only through kernel.proposal.approve. It builds the entry again from the stored lines, in the approver's context, and refuses a stored proposal that
//   differs from it (a proposal row written some other way cannot post lines the settlement does not hold). Then, in the same transaction, it finds the platform's party (ludy_finance.marketplace_party;
//   created with its link on the platform's first posting, one per entity and platform) and records the voucher with the settlement on it (one voucher per settlement and month: a unique index holds it,
//   20270103020000), and ALL the months of the settlement in this one transaction: a settlement is either posted in full or not at all, and the payout's check is that its vouchers stand and posts its entry. The database checks at commit that the proposal has such a voucher (ludy_finance.ledger_effect_recorded).
// The commands are made by createMarketplaceSettlementCommands so a test registers a set with a confirmed map; the shipped set uses MARKETPLACE_POSTING_MAPS, whose sales path is confirmed (#4303 S3b) and whose household tax path is not, so it posts a settlement and refuses one that carries a household's withheld tax.
// No model call is made: everything here is deterministic over stored facts.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  JOURNAL_VOUCHER_KIND,
  MARKETPLACE_SETTLEMENT_COMMAND,
  MARKETPLACE_SETTLEMENT_MAX_MONTHS,
  zMarketplaceSettlementProposal,
  zMarketplaceSettlementRequest,
  type JournalVoucherProposal,
  type MarketplaceSettlementProposal,
} from '@ludy/kernel-contract';
import { money, sum, toMoney } from '@ludy/l10n-vn';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { refuseChangedBooksFirst, stampBooks } from './books-stamp.ts';
import { assertUsableAccounts } from './accounts.ts';
import { journalVoucherTitle } from './domain/journal-voucher.ts';
import { checkJournalVoucherLines, postJournalVoucher } from './journal-voucher.ts';
import { requireConfirmedMarketplaceMap, MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from './marketplace-posting-map.ts';
import { householdTaxRate } from './marketplace-household-tax.ts';
import { postingsOf, settlementMonthsFor } from './marketplace-settlement-months.ts';
import { isEmptyEntry, settlementProposal, type SettlementProposal, type SettlementVatRate } from './marketplace-settlement-posting.ts';
import { vatRatesOfMonth } from './marketplace-settlement-vat.ts';
import { booksOn, lockBooks } from './books.ts';
import { dateLabel, periodLockedThrough } from './period-lock.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
type Maps = Readonly<Record<string, MarketplacePostingMap>>;

// The name of the platform's organization party, from the platform's own id (the settlement table allows these three).
const PLATFORM_NAME: Readonly<Record<string, string>> = { shopee: 'Shopee', tiktok_shop: 'TikTok Shop', lazada: 'Lazada' };
export const platformPartyName = (platform: string): string => PLATFORM_NAME[platform] ?? platform;

const notPostable = (reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, reason, extra);
const mismatch = (what: string) => new DomainError('MARKETPLACE_SETTLEMENT_MISMATCH', 422, 'Đề xuất hạch toán không khớp kỳ đối soát đã lưu; hãy lập lại đề xuất', { what });

// A voucher holds whole dong (the books have no minor unit); a settlement whose sums carry a fraction is refused, never rounded, so the entry is exactly what the platform paid for.
function wholeDong(what: string, value: string): string {
  if (!/^\d{1,15}$/.test(value)) throw notPostable('Số tiền của kỳ đối soát phải là số đồng nguyên để hạch toán', { what });
  return value;
}

interface Built {
  settlementId: string;
  legalEntityId: string;
  platform: string;
  // The account of the platform's balance (131), the line that names the platform's party.
  receivable: string;
  periodFrom: string;
  periodTo: string;
  // One entry for each month of delivery, oldest first (marketplace-settlement-months.ts).
  months: SettlementProposal[];
  // The platform's party as linked now, or null before the platform's first posting.
  party: { id: string; name: string; taxCode: string | null } | null;
}

// Everything the proposal and the posting share, read in the caller's context: the stored settlement and its lines, the chart of the entity, the gate, the rules of a settlement that may be
// posted, and the platform's party link. `lock` takes the lock the settlement guards use (one per entity and platform, 20261126110000) for the rest of the transaction, so a reversal of the
// settlement or the first posting of the platform cannot run beside this one.
async function buildSettlement(ctx: QueryContext, maps: Maps, settlementId: string, lock: boolean): Promise<Built> {
  const settlement = await ctx.trx
    .selectFrom('ludy_finance.channel_settlement')
    .select(['id', 'legal_entity_id', 'platform', 'period_start', 'period_end', 'reversal_of'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', settlementId)
    .executeTakeFirst();
  if (!settlement) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_FOUND', 404, 'Không tìm thấy kỳ đối soát này của sàn');
  const periodFrom = String(settlement.period_start).slice(0, 10);
  const periodTo = String(settlement.period_end).slice(0, 10);
  // The chart of the entity on the day the entry is dated, then the gate: the accountant has not confirmed the map, nothing is requested or posted.
  // Posting: the entity's books are locked first, so a switch of regime cannot commit between this read and the posting's commit.
  if (lock) await lockBooks(ctx, settlement.legal_entity_id);
  const regime = (await booksOn(ctx, settlement.legal_entity_id, periodTo)).regime;
  // The early gate asks for the sales path; settlementProposal asks again for the household tax rows when the settlement carries withheld tax.
  const map = requireConfirmedMarketplaceMap(regime, maps, ['sales']);
  if (lock) {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`channel_settlement:${ctx.orgId}:${settlement.legal_entity_id}:${settlement.platform}`}, 0))`.execute(ctx.trx);
  }
  if (settlement.reversal_of !== null) throw notPostable('Đây là bản đảo của một kỳ đối soát khác nên không hạch toán', { reason: 'REVERSAL' });
  const reversed = await ctx.trx.selectFrom('ludy_finance.channel_settlement').select('id').where('org_id', '=', ctx.orgId).where('reversal_of', '=', settlement.id).executeTakeFirst();
  if (reversed) throw notPostable('Kỳ đối soát này đã bị đảo nên không hạch toán', { reason: 'REVERSED' });
  // Any posting voucher, reversed or not (the database holds one per settlement and month for good), or one that posted the whole settlement before the months, counts as posted: all the months of a
  // settlement are posted together by one proposal, so a settlement with a voucher has all of them.
  const postings = (await postingsOf(ctx, [settlement.id])).get(settlement.id) ?? [];
  if (postings.length > 0) throw new DomainError('MARKETPLACE_SETTLEMENT_POSTED', 409, 'Kỳ đối soát này của sàn đã được hạch toán');
  // The months of the settlement: a sale with no delivery day makes the whole settlement wait, and a settlement with no month has no net to post.
  const { months, waiting } = (await settlementMonthsFor(ctx, [{ id: settlement.id, periodEnd: periodTo }])).get(settlement.id) ?? { months: [], waiting: 0 };
  if (waiting > 0) {
    throw new DomainError('MARKETPLACE_SETTLEMENT_WAITING_DELIVERY', 422, 'Kỳ đối soát còn dòng chưa có ngày giao hàng: chờ ngày giao', { lines: waiting });
  }
  if (months.length === 0) throw notPostable('Kỳ đối soát có doanh thu ròng bằng 0; không có bút toán để lập', { net: '0' });
  const link = await ctx.trx
    .selectFrom('ludy_finance.marketplace_party as m')
    .innerJoin('ludy_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'm.org_id').onRef('p.id', '=', 'm.party_id'))
    .select(['p.id', 'p.name', 'p.tax_code'])
    .where('m.org_id', '=', ctx.orgId)
    .where('m.legal_entity_id', '=', settlement.legal_entity_id)
    .where('m.platform', '=', settlement.platform)
    .executeTakeFirst();
  // A household seller's withheld tax is split by its one line of business's rate pair (read only when something was withheld); any other seller has no tax lines.
  const withheld = months.some((m) => m.lines.some((l) => money(l.taxWithheld ?? '0').greaterThan(0)));
  const tax = withheld ? await householdTaxRate(ctx, settlement.legal_entity_id, periodTo) : null;
  // The VAT rate in force on the delivery day of each piece (marketplaceVatRateAt, the one function of the rate table); a day with no row holds the settlement back (the proposal refuses it). A month that has
  // nothing to post once the VAT is known (zero net, zero VAT, nothing withheld) is skipped, not refused: pieces at different rates can net to zero while 33311 does not, and that month is kept and posted.
  const vatMemo = new Map<string, SettlementVatRate | null>();
  const proposals: SettlementProposal[] = [];
  for (const m of months) {
    const vatRates = await vatRatesOfMonth(ctx, settlement.legal_entity_id, m, vatMemo);
    try {
      proposals.push(
        settlementProposal(
          { regime: map.regime, platform: platformPartyName(settlement.platform), periodFrom, periodTo, month: m.month, date: m.date, partyId: link?.id ?? null, lines: m.lines, tax, vatRates },
          maps,
        ),
      );
    } catch (e) {
      if (!isEmptyEntry(e)) throw e;
    }
  }
  if (proposals.length === 0) throw notPostable('Kỳ đối soát có doanh thu ròng bằng 0; không có bút toán để lập', { net: '0' });
  if (proposals.length > MARKETPLACE_SETTLEMENT_MAX_MONTHS) {
    throw notPostable(`Kỳ đối soát trải qua quá nhiều tháng (${proposals.length}, tối đa ${MARKETPLACE_SETTLEMENT_MAX_MONTHS}) để lập một đề xuất`, {
      months: proposals.length,
      maxMonths: MARKETPLACE_SETTLEMENT_MAX_MONTHS,
    });
  }
  // Every entry date must be in an open period: the earliest locked one refuses the whole settlement.
  const lockedThrough = await periodLockedThrough(ctx, settlement.legal_entity_id);
  const locked = lockedThrough ? proposals.find((m) => m.date <= lockedThrough) : undefined;
  if (lockedThrough && locked) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(locked.date)}`, { lockedThrough, entryDate: locked.date });
  }
  // Each voucher holds whole dong, so each month's sums must be whole.
  for (const proposal of proposals) {
    for (const [what, value] of [['sales', proposal.sales], ['sellerDiscount', proposal.sellerDiscount], ['refund', proposal.refund], ['taxWithheld', proposal.taxWithheld], ['total', proposal.total]] as const) wholeDong(what, value);
    for (const l of proposal.lines) {
      wholeDong('debit', l.debit);
      wholeDong('credit', l.credit);
    }
  }
  return {
    settlementId: settlement.id,
    legalEntityId: settlement.legal_entity_id,
    platform: settlement.platform,
    receivable: map.receivable.code,
    periodFrom,
    periodTo,
    months: proposals,
    party: link ? { id: link.id, name: link.name, taxCode: link.tax_code } : null,
  };
}

type Party = { id: string; name: string; taxCode: string | null } | null;

// The lines of one month's entry as the voucher holds them, the 131 line naming the platform's party when it has one.
const monthLines = (built: Built, month: SettlementProposal, party: Party) =>
  month.lines.map((l) => ({
    account: l.account,
    party: l.account === built.receivable && party ? { id: party.id, name: party.name, taxCode: party.taxCode } : null,
    debit: l.debit,
    credit: l.credit,
    memo: l.memo,
  }));

// The estimated split's facts of all the months added up (marketplace-settlement-posting.ts taxEstimate), or undefined when no month carries withheld tax.
function taxEstimateOf(months: SettlementProposal[]): MarketplaceSettlementProposal['taxEstimate'] {
  const own = months.flatMap((m) => (m.taxEstimate ? [m.taxEstimate] : []));
  if (own.length === 0) return undefined;
  return { withheld: toMoney(sum(own.map((t) => t.withheld))), expected: toMoney(sum(own.map((t) => t.expected))), difference: toMoney(sum(own.map((t) => t.difference))) };
}

// The proposal of a built settlement: ONE proposal for all its months. `lines` shows the entry of each month one after the other (each line's memo names its month), `months` lists the months with the
// date and total of their entries, and `total`, `sales`, `sellerDiscount` and `refund` are the sums, so the Inbox reads it as a voucher and the refund stays visible beside the net.
function proposalPayload(built: Built, party: Party = built.party): MarketplaceSettlementProposal {
  const sums = (pick: (m: SettlementProposal) => string) => toMoney(sum(built.months.map(pick)));
  return zMarketplaceSettlementProposal.parse({
    date: built.periodTo,
    description: `Đối soát ${platformPartyName(built.platform)} ${built.periodFrom} đến ${built.periodTo}`.slice(0, 300),
    lines: built.months.flatMap((m) => monthLines(built, m, party)),
    total: sums((m) => m.total),
    legalEntityId: built.legalEntityId,
    settlementId: built.settlementId,
    months: built.months.map((m) => ({ month: m.month, date: m.date, total: m.total })),
    platform: built.platform,
    periodFrom: built.periodFrom,
    periodTo: built.periodTo,
    sales: sums((m) => m.sales),
    sellerDiscount: sums((m) => m.sellerDiscount),
    refund: sums((m) => m.refund),
    taxEstimate: taxEstimateOf(built.months),
  });
}

// What a stored proposal holds that the settlement, rebuilt now, does not: the first difference, or null when they are the same. The platform's party is the one exception: a proposal made before
// the platform's first posting names none, and one made after names the linked party; a party the link does not hold is a difference.
export function settlementProposalMismatch(stored: MarketplaceSettlementProposal, built: MarketplaceSettlementProposal): string | null {
  if (stored.settlementId.toLowerCase() !== built.settlementId.toLowerCase()) return 'settlementId';
  if (!stored.legalEntityId || stored.legalEntityId.toLowerCase() !== built.legalEntityId?.toLowerCase()) return 'legalEntityId';
  if (stored.months.length !== built.months.length) return 'months';
  for (const [i, m] of built.months.entries()) {
    const have = stored.months[i];
    if (!have || have.month !== m.month || have.date !== m.date || !money(have.total).equals(money(m.total))) return 'months';
  }
  if (stored.platform !== built.platform) return 'platform';
  if (stored.periodFrom !== built.periodFrom || stored.periodTo !== built.periodTo || stored.date !== built.date) return 'period';
  if (stored.description !== built.description) return 'description';
  for (const key of ['sales', 'sellerDiscount', 'refund', 'total'] as const) if (!money(stored[key]).equals(money(built[key]))) return key;
  if (stored.lines.length !== built.lines.length) return 'lines';
  for (const [i, line] of built.lines.entries()) {
    const have = stored.lines[i];
    if (!have || have.account !== line.account || !money(have.debit).equals(money(line.debit)) || !money(have.credit).equals(money(line.credit)) || (have.memo ?? '') !== (line.memo ?? '')) return 'lines';
    // A line naming a party must be the platform's 131 line with the party the link holds now (the rebuilt line names it); the other line names none.
    if (have.party !== null && (line.party === null || have.party.id.toLowerCase() !== line.party.id.toLowerCase())) return 'party';
  }
  return null;
}

// The platform's party of this entity: the linked one, or, on the platform's first posting, a new organization party and its link. The caller holds the platform's lock, so two first postings take
// turns and end with one party and one link; the insert is also guarded by the link's unique key and the party is read again after it, so a link that won the race is the one used.
async function platformParty(ctx: CommandContext, built: Built): Promise<{ id: string; name: string; taxCode: string | null }> {
  if (built.party) return built.party;
  const name = platformPartyName(built.platform);
  const partyId = crypto.randomUUID();
  // The id is given and the row inserted without RETURNING: the entity link of a new party (party_link_new) is not visible to the same statement's RETURNING check (#1280).
  await ctx.trx.insertInto('ludy_kernel.party').values({ id: partyId, org_id: ctx.orgId, kind: 'organization', name, source_trust: 'user', created_at: ctx.now, updated_at: ctx.now }).execute();
  await ctx.trx
    .insertInto('ludy_finance.marketplace_party')
    .values({ org_id: ctx.orgId, legal_entity_id: built.legalEntityId, platform: built.platform, party_id: partyId, created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null })
    .onConflict((oc) => oc.columns(['org_id', 'legal_entity_id', 'platform']).doNothing())
    .execute();
  const linked = await ctx.trx
    .selectFrom('ludy_finance.marketplace_party as m')
    .innerJoin('ludy_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'm.org_id').onRef('p.id', '=', 'm.party_id'))
    .select(['p.id', 'p.name', 'p.tax_code'])
    .where('m.org_id', '=', ctx.orgId)
    .where('m.legal_entity_id', '=', built.legalEntityId)
    .where('m.platform', '=', built.platform)
    .executeTakeFirstOrThrow();
  if (linked.id === partyId) await ctx.activity('kernel.party', partyId, 'party.created', `Thêm đối tượng của sàn ${built.platform}`);
  return { id: linked.id, name: linked.name, taxCode: linked.tax_code };
}

// The commands over a set of account maps. A test passes its own with a confirmed map; the shipped set is made from MARKETPLACE_POSTING_MAPS.
export function createMarketplaceSettlementCommands(options: { maps?: Maps } = {}) {
  const maps = options.maps ?? MARKETPLACE_POSTING_MAPS;

  const prepare = defineCommand({
    name: 'finance.marketplace_settlement.prepare',
    input: zMarketplaceSettlementRequest,
    risk: 'R1',
    sideEffect: 'internal',
    access: REQUESTERS,
    writes: [],
    handler: async (ctx, input) => {
      const built = await buildSettlement(ctx, maps, input.settlementId, false);
      await assertUsableAccounts(ctx, built.months.flatMap((m) => m.lines.map((l) => l.account)));
      const payload = proposalPayload(built);
      return { kind: JOURNAL_VOUCHER_KIND, command: MARKETPLACE_SETTLEMENT_COMMAND, title: journalVoucherTitle(payload), payload: await stampBooks(ctx, payload) };
    },
  });

  const record = defineCommand({
    // A literal, not the shared constant: the job-egress analyzer reads a command's name from the source (the contract's MARKETPLACE_SETTLEMENT_COMMAND equals it).
    name: 'finance.marketplace_settlement.record',
    input: z.object({ payload: zMarketplaceSettlementProposal, acceptFailedChecks: z.boolean().default(false) }),
    risk: 'R3',
    sideEffect: 'financial',
    access: 'proposal',
    proposalKind: JOURNAL_VOUCHER_KIND,
    handler: async (ctx, { payload }) => {
      if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
      // The entry is built again from the stored settlement, in the approver's context, and the stored proposal must equal it: a proposal row not written by the preparer (raw SQL) cannot post lines the
      // settlement does not hold, nor into another entity.
      const built = await buildSettlement(ctx, maps, payload.settlementId, true);
      const wrong = settlementProposalMismatch(payload, proposalPayload(built));
      if (wrong) throw mismatch(wrong);
      // The platform's party, created with its link on the platform's first posting; the rebuilt 131 lines name it.
      const party = await platformParty(ctx, built);
      // Every month's voucher in this one transaction, oldest first, each naming the settlement and its month (unique together): the settlement is posted in full or, if one of them is refused, not at all.
      const posted: Array<Awaited<ReturnType<typeof postJournalVoucher>>> = [];
      for (const m of built.months) {
        // The books the proposal was prepared under (stamped when they are not TT133 2026.1) are the books of every month's voucher, held before its accounts are read (#5320). One map builds every month's lines
        // (the regime at the period's end), so a settlement whose months fall under other books than that is refused here, as it should be, rather than posted with accounts of the wrong chart.
        const voucher: JournalVoucherProposal = { date: m.date, description: m.description, lines: monthLines(built, m, party), total: m.total, legalEntityId: built.legalEntityId, regime: payload.regime, chartVersion: payload.chartVersion };
        await refuseChangedBooksFirst(ctx, voucher, voucher.lines.map((l) => l.account));
        // The shape, the accounts and the parties checked as any voucher's, the parties read FOR SHARE so they stay as read until commit.
        await checkJournalVoucherLines(ctx, voucher.lines.map((l) => ({ account: l.account, partyId: l.party?.id ?? null, debit: l.debit, credit: l.credit })), true, { legalEntityId: voucher.legalEntityId, date: voucher.date });
        posted.push(await postJournalVoucher(ctx, voucher, null, null, null, null, built.settlementId, null, null, m.month));
      }
      // The first month's voucher answers as one voucher does; every month's is listed.
      return { ...(posted[0] as (typeof posted)[number]), vouchers: posted };
    },
  });

  return { prepare, record, commands: [prepare, record] };
}

export const marketplaceSettlementCommands = createMarketplaceSettlementCommands().commands;
