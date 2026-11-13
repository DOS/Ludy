// SPDX-License-Identifier: AGPL-3.0-only
// The posting of a stored marketplace settlement (issue #2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4): ONE general journal voucher per settlement, Dr 131 (the
// platform) / Cr 511 for the sales net of the seller discounts and the refunds (the reverse when the net is negative). The entry is built by settlementProposal (marketplace-settlement-posting.ts)
// from the stored lines of channel_settlement, and nothing is built or posted until the accountant has confirmed the account map (requireConfirmedMarketplaceMap, #2520):
// - finance.marketplace_settlement.prepare (R1, internal): the preparer of kernel.proposal.request for `finance.marketplace_settlement.record`. The request carries the settlement alone. It checks
//   the gate, that the settlement stands (it is no reversal and has none), is not posted yet, its period is open, and its accounts are usable, then returns the proposal. It writes nothing.
// - finance.marketplace_settlement.record (R3): runs only through kernel.proposal.approve. It builds the entry again from the stored lines, in the approver's context, and refuses a stored proposal that
//   differs from it (a proposal row written some other way cannot post lines the settlement does not hold). Then, in the same transaction, it finds the platform's party (crove_finance.marketplace_party;
//   created with its link on the platform's first posting, one per entity and platform) and records the voucher with the settlement on it (one voucher per settlement: a unique index holds it,
//   20261228011500) and posts its entry. The database checks at commit that the proposal has such a voucher (crove_finance.ledger_effect_recorded).
// The commands are made by createMarketplaceSettlementCommands so a test registers a set with a confirmed map; the shipped set uses MARKETPLACE_POSTING_MAPS, every row `commentary`, so it refuses.
// No model call is made: everything here is deterministic over stored facts.
import { sql } from 'kysely';
import { z } from 'zod';
import { JOURNAL_VOUCHER_KIND, MARKETPLACE_SETTLEMENT_COMMAND, zMarketplaceSettlementProposal, zMarketplaceSettlementRequest, type JournalVoucherProposal, type MarketplaceSettlementProposal } from '@crove/kernel-contract';
import { money } from '@crove/l10n-vn';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { assertUsableAccounts } from './accounts.ts';
import { journalVoucherTitle } from './domain/journal-voucher.ts';
import { checkJournalVoucherLines, postJournalVoucher } from './journal-voucher.ts';
import { requireConfirmedMarketplaceMap, MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from './marketplace-posting-map.ts';
import { settlementProposal, type SettlementProposal } from './marketplace-settlement-posting.ts';
import { booksOn } from './payroll-posting.ts';
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
  proposal: SettlementProposal;
  // The platform's party as linked now, or null before the platform's first posting.
  party: { id: string; name: string; taxCode: string | null } | null;
}

// Everything the proposal and the posting share, read in the caller's context: the stored settlement and its lines, the chart of the entity, the gate, the rules of a settlement that may be
// posted, and the platform's party link. `lock` takes the lock the settlement guards use (one per entity and platform, 20261126110000) for the rest of the transaction, so a reversal of the
// settlement or the first posting of the platform cannot run beside this one.
async function buildSettlement(ctx: QueryContext, maps: Maps, settlementId: string, lock: boolean): Promise<Built> {
  const settlement = await ctx.trx
    .selectFrom('crove_finance.channel_settlement')
    .select(['id', 'legal_entity_id', 'platform', 'period_start', 'period_end', 'reversal_of'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', settlementId)
    .executeTakeFirst();
  if (!settlement) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_FOUND', 404, 'Không tìm thấy kỳ đối soát này của sàn');
  const periodFrom = String(settlement.period_start).slice(0, 10);
  const periodTo = String(settlement.period_end).slice(0, 10);
  // The chart of the entity on the day the entry is dated, then the gate: the accountant has not confirmed the map, nothing is requested or posted.
  const regime = (await booksOn(ctx, settlement.legal_entity_id, periodTo)).regime;
  const map = requireConfirmedMarketplaceMap(regime, maps);
  if (lock) {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`channel_settlement:${ctx.orgId}:${settlement.legal_entity_id}:${settlement.platform}`}, 0))`.execute(ctx.trx);
  }
  if (settlement.reversal_of !== null) throw notPostable('Đây là bản đảo của một kỳ đối soát khác nên không hạch toán', { reason: 'REVERSAL' });
  const reversed = await ctx.trx.selectFrom('crove_finance.channel_settlement').select('id').where('org_id', '=', ctx.orgId).where('reversal_of', '=', settlement.id).executeTakeFirst();
  if (reversed) throw notPostable('Kỳ đối soát này đã bị đảo nên không hạch toán', { reason: 'REVERSED' });
  const posted = await ctx.trx.selectFrom('crove_finance.journal_voucher').select('id').where('org_id', '=', ctx.orgId).where('settlement_id', '=', settlement.id).executeTakeFirst();
  if (posted) throw new DomainError('MARKETPLACE_SETTLEMENT_POSTED', 409, 'Kỳ đối soát này của sàn đã được hạch toán');
  const lockedThrough = await periodLockedThrough(ctx, settlement.legal_entity_id);
  if (lockedThrough && periodTo <= lockedThrough) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(periodTo)}`, { lockedThrough, entryDate: periodTo });
  }
  const lines = await ctx.trx
    .selectFrom('crove_finance.channel_settlement_line')
    .select(['sales', 'seller_discount', 'refund'])
    .where('org_id', '=', ctx.orgId)
    .where('settlement_id', '=', settlement.id)
    .execute();
  const link = await ctx.trx
    .selectFrom('crove_finance.marketplace_party as m')
    .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'm.org_id').onRef('p.id', '=', 'm.party_id'))
    .select(['p.id', 'p.name', 'p.tax_code'])
    .where('m.org_id', '=', ctx.orgId)
    .where('m.legal_entity_id', '=', settlement.legal_entity_id)
    .where('m.platform', '=', settlement.platform)
    .executeTakeFirst();
  const proposal = settlementProposal(
    {
      regime: map.regime,
      platform: platformPartyName(settlement.platform),
      periodFrom,
      periodTo,
      partyId: link?.id ?? null,
      lines: lines.map((l) => ({ sales: l.sales, sellerDiscount: l.seller_discount, refund: l.refund })),
    },
    maps,
  );
  for (const [what, value] of [['sales', proposal.sales], ['sellerDiscount', proposal.sellerDiscount], ['refund', proposal.refund], ['total', proposal.total]] as const) wholeDong(what, value);
  for (const l of proposal.lines) {
    wholeDong('debit', l.debit);
    wholeDong('credit', l.credit);
  }
  return {
    settlementId: settlement.id,
    legalEntityId: settlement.legal_entity_id,
    platform: settlement.platform,
    receivable: map.receivable.code,
    periodFrom,
    periodTo,
    proposal,
    party: link ? { id: link.id, name: link.name, taxCode: link.tax_code } : null,
  };
}

// The proposal of a built settlement: lines as the voucher holds them, the 131 line naming the platform's party when it has one.
function proposalPayload(built: Built): MarketplaceSettlementProposal {
  const { proposal } = built;
  return zMarketplaceSettlementProposal.parse({
    date: built.periodTo,
    description: proposal.description,
    lines: proposal.lines.map((l) => ({
      account: l.account,
      party: l.account === built.receivable && built.party ? { id: built.party.id, name: built.party.name, taxCode: built.party.taxCode } : null,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
    })),
    total: proposal.total,
    legalEntityId: built.legalEntityId,
    settlementId: built.settlementId,
    platform: built.platform,
    periodFrom: built.periodFrom,
    periodTo: built.periodTo,
    sales: proposal.sales,
    sellerDiscount: proposal.sellerDiscount,
    refund: proposal.refund,
  });
}

// What a stored proposal holds that the settlement, rebuilt now, does not: the first difference, or null when they are the same. The platform's party is the one exception: a proposal made before
// the platform's first posting names none, and one made after names the linked party; a party the link does not hold is a difference.
export function settlementProposalMismatch(stored: MarketplaceSettlementProposal, built: MarketplaceSettlementProposal): string | null {
  if (stored.settlementId.toLowerCase() !== built.settlementId.toLowerCase()) return 'settlementId';
  if (!stored.legalEntityId || stored.legalEntityId.toLowerCase() !== built.legalEntityId?.toLowerCase()) return 'legalEntityId';
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
  await ctx.trx.insertInto('crove_kernel.party').values({ id: partyId, org_id: ctx.orgId, kind: 'organization', name, source_trust: 'user', created_at: ctx.now, updated_at: ctx.now }).execute();
  await ctx.trx
    .insertInto('crove_finance.marketplace_party')
    .values({ org_id: ctx.orgId, legal_entity_id: built.legalEntityId, platform: built.platform, party_id: partyId, created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null })
    .onConflict((oc) => oc.columns(['org_id', 'legal_entity_id', 'platform']).doNothing())
    .execute();
  const linked = await ctx.trx
    .selectFrom('crove_finance.marketplace_party as m')
    .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'm.org_id').onRef('p.id', '=', 'm.party_id'))
    .select(['p.id', 'p.name', 'p.tax_code'])
    .where('m.org_id', '=', ctx.orgId)
    .where('m.legal_entity_id', '=', built.legalEntityId)
    .where('m.platform', '=', built.platform)
    .executeTakeFirstOrThrow();
  if (linked.id === partyId) await ctx.activity('kernel.party', partyId, 'party.created', `Thêm đối tượng của sàn ${name}`);
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
      await assertUsableAccounts(ctx, built.proposal.lines.map((l) => l.account));
      const payload = proposalPayload(built);
      return { kind: JOURNAL_VOUCHER_KIND, command: MARKETPLACE_SETTLEMENT_COMMAND, title: journalVoucherTitle(payload), payload };
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
      // The platform's party, created with its link on the platform's first posting; the rebuilt 131 line names it.
      const party = await platformParty(ctx, built);
      const rebuilt = proposalPayload({ ...built, party });
      const voucher: JournalVoucherProposal = { date: rebuilt.date, description: rebuilt.description, lines: rebuilt.lines, total: rebuilt.total, legalEntityId: rebuilt.legalEntityId };
      // The shape, the accounts and the parties checked as any voucher's, the parties read FOR SHARE so they stay as read until commit.
      await checkJournalVoucherLines(ctx, voucher.lines.map((l) => ({ account: l.account, partyId: l.party?.id ?? null, debit: l.debit, credit: l.credit })), true);
      return postJournalVoucher(ctx, voucher, null, null, null, null, built.settlementId);
    },
  });

  return { prepare, record, commands: [prepare, record] };
}

export const marketplaceSettlementCommands = createMarketplaceSettlementCommands().commands;
