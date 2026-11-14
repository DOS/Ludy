// SPDX-License-Identifier: AGPL-3.0-only
// The posting of a platform's payout (issue #2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"; Accounting PO decision 2026-11-13): ONE general journal voucher
// per settlement, Dr cash (the bank account of the transfer) for the money received, Dr 1388 for the platform's fees, Dr 333 for the tax the platform withheld, Cr 131 (the platform) for what the
// settlement posted there. The entry is built by payoutProposal (marketplace-payout-posting.ts) from the stored lines of the settlement; the bank line only has to be money in, equal to the net the
// settlement paid, and free, and nothing is built or posted until the accountant has confirmed the account map (requireConfirmedMarketplaceMap, #2520):
// - finance.marketplace_payout.prepare (R1, internal): the preparer of kernel.proposal.request for `finance.marketplace_payout.record`. The request carries the settlement and the bank line alone.
//   It checks the gate, that the settlement stands (it is no reversal and has none) and its posting stands (a payout before its settlement is posted is refused: "ghi sổ kỳ đối soát trước"), that no
//   payout is posted for it, the period of the transfer is open, the bank line follows the settlement and is free, and the accounts are usable, then returns the proposal. It writes nothing.
// - finance.marketplace_payout.record (R3): runs only through kernel.proposal.approve. It builds the entry again from the stored lines, in the approver's context, and refuses a stored proposal that
//   differs from it. Then, in the same transaction, it records the voucher with the settlement and the bank line on it (one voucher per settlement and one per line: unique indexes hold it,
//   20261231110000) and posts its entry. The database checks at commit that the proposal has such a voucher (crove_finance.ledger_effect_recorded, 20261231120000).
// The 131 and 1388 lines name the platform's party, the one the settlement's posting created (the Sàn read of #3096 matches lines by it). The commands are made by createMarketplacePayoutCommands so a
// test registers a set with a confirmed map; the shipped set uses MARKETPLACE_POSTING_MAPS, every row `commentary`, so it refuses. No model call is made: everything here is deterministic over stored facts.
import { sql } from 'kysely';
import { z } from 'zod';
import { JOURNAL_VOUCHER_KIND, MARKETPLACE_PAYOUT_COMMAND, zMarketplacePayoutProposal, zMarketplacePayoutRequest, type JournalVoucherProposal, type MarketplacePayoutProposal } from '@crove/kernel-contract';
import { Decimal, money } from '@crove/l10n-vn';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type QueryContext } from '@crove/kernel-runtime';
import { assertUsableAccounts } from './accounts.ts';
import { bankLineStates, findBankLine, lockBankLine, type StoredBankLine } from './bank-match.ts';
import { JOURNAL_VOUCHER_SOURCE, journalVoucherTitle } from './domain/journal-voucher.ts';
import { checkJournalVoucherLines, postJournalVoucher } from './journal-voucher.ts';
import { payoutOfBankLine } from './marketplace-payout-line.ts';
import { payoutProposal, type PayoutProposal } from './marketplace-payout-posting.ts';
import { requireConfirmedMarketplaceMap, MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from './marketplace-posting-map.ts';
import { platformPartyName } from './marketplace-settlement-record.ts';
import { booksOn } from './payroll-posting.ts';
import { dateLabel, periodLockedThrough } from './period-lock.ts';
import { reversedSource } from './source-entry.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
type Maps = Readonly<Record<string, MarketplacePostingMap>>;

const notPostable = (reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_PAYOUT_NOT_POSTABLE', 422, reason, extra);
const mismatch = (what: string) => new DomainError('MARKETPLACE_PAYOUT_MISMATCH', 422, 'Đề xuất hạch toán không khớp kỳ đối soát hoặc dòng sao kê đã lưu; hãy lập lại đề xuất', { what });
const bankLineRefused = (status: 409 | 422, reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_PAYOUT_BANK_LINE', status, reason, extra);

// A voucher holds whole dong (the books have no minor unit); a payout whose sums carry a fraction is refused, never rounded.
function wholeDong(what: string, value: string): string {
  if (!/^\d{1,15}$/.test(value)) throw notPostable('Số tiền của khoản sàn trả phải là số đồng nguyên để hạch toán', { what });
  return value;
}

interface Built {
  settlementId: string;
  legalEntityId: string;
  platform: string;
  bankLineId: string;
  periodFrom: string;
  periodTo: string;
  date: string;
  proposal: PayoutProposal;
  receivable: string;
  feeAwaiting: string;
  party: { id: string; name: string; taxCode: string | null };
}

// The bank line follows the settlement and is free: in the settlement's legal entity, money in, equal to the net the settlement paid, not before the period began, and not tied to a payout or a
// bank voucher. `pendingToo` also refuses a line another proposal already names (asking for a payout; approving the proposal that names it is the point).
async function checkBankLine(ctx: QueryContext, line: StoredBankLine, legalEntityId: string, received: string, periodFrom: string, pendingToo: boolean): Promise<void> {
  if (line.legalEntityId !== legalEntityId) throw bankLineRefused(422, 'Dòng sao kê này thuộc pháp nhân khác với kỳ đối soát', { reason: 'ENTITY' });
  if (!new Decimal(line.amount).equals(new Decimal(received))) throw bankLineRefused(422, 'Số tiền của dòng sao kê phải đúng bằng số tiền ròng sàn trả của kỳ đối soát', { reason: 'AMOUNT' });
  if (line.date < periodFrom) throw bankLineRefused(422, 'Dòng sao kê này có trước kỳ đối soát nên không phải khoản sàn trả của kỳ', { reason: 'DATE' });
  const payout = await payoutOfBankLine(ctx, line.id, { reversedToo: true });
  if (payout?.state === 'posted' || (pendingToo && payout?.state === 'proposed')) throw bankLineRefused(409, 'Dòng sao kê này đã dùng cho một khoản sàn trả', { reason: 'PAYOUT' });
  const state = (await bankLineStates(ctx, [line.id])).get(line.id);
  if (state?.status === 'matched') throw bankLineRefused(409, `Dòng sao kê này đã có chứng từ ${state.code}`, { reason: 'MATCHED' });
  if (pendingToo && state?.status === 'proposed') throw bankLineRefused(409, 'Dòng sao kê này đã có chứng từ đang chờ duyệt', { reason: 'PROPOSED' });
}

// Everything the proposal and the posting share, read in the caller's context: the stored settlement and its lines, the posting that stands, the bank line, the entity's chart, the gate, and the
// platform's party. `lock` takes the locks (the platform's, which the settlement guards use, 20261126110000, and the bank line's) for the rest of the transaction.
async function buildPayout(ctx: QueryContext, maps: Maps, settlementId: string, bankLineId: string, lock: boolean): Promise<Built> {
  const settlement = await ctx.trx
    .selectFrom('crove_finance.channel_settlement')
    .select(['id', 'legal_entity_id', 'platform', 'period_start', 'period_end', 'reversal_of'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', settlementId)
    .executeTakeFirst();
  if (!settlement) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_FOUND', 404, 'Không tìm thấy kỳ đối soát này của sàn');
  const line = await findBankLine(ctx, bankLineId);
  if (!line) throw new DomainError('BANK_LINE_NOT_FOUND', 422, 'Không tìm thấy dòng sao kê; hãy tải lại trang ngân hàng');
  const periodFrom = String(settlement.period_start).slice(0, 10);
  const periodTo = String(settlement.period_end).slice(0, 10);
  // The chart of the entity on the day the entry is dated (the day of the transfer), then the gate: the accountant has not confirmed the map, nothing is requested or posted.
  const regime = (await booksOn(ctx, settlement.legal_entity_id, line.date)).regime;
  const map = requireConfirmedMarketplaceMap(regime, maps);
  if (lock) {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`channel_settlement:${ctx.orgId}:${settlement.legal_entity_id}:${settlement.platform}`}, 0))`.execute(ctx.trx);
    await lockBankLine(ctx, line.id);
  }
  if (settlement.reversal_of !== null) throw notPostable('Đây là bản đảo của một kỳ đối soát khác nên không ghi khoản sàn trả', { reason: 'REVERSAL' });
  const reversed = await ctx.trx.selectFrom('crove_finance.channel_settlement').select('id').where('org_id', '=', ctx.orgId).where('reversal_of', '=', settlement.id).executeTakeFirst();
  if (reversed) throw notPostable('Kỳ đối soát này đã bị đảo nên không ghi khoản sàn trả', { reason: 'REVERSED' });
  // A payout before its settlement is posted is refused (Accounting PO decision 2026-11-13): there is no holding state, the settlement's posting comes first and stands.
  const postings = await ctx.trx
    .selectFrom('crove_finance.journal_voucher as j')
    .select(['j.id', reversedSource('j', JOURNAL_VOUCHER_SOURCE).as('reversed')])
    .where('j.org_id', '=', ctx.orgId)
    .where('j.settlement_id', '=', settlement.id)
    .execute();
  // `every` is true for no posting at all, so a settlement never posted is refused with one that was posted and reversed.
  if (postings.every((p) => p.reversed)) {
    throw new DomainError('MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED', 409, 'Ghi sổ kỳ đối soát trước, rồi mới ghi khoản sàn trả', { settlementId: settlement.id });
  }
  const paid = await ctx.trx
    .selectFrom('crove_finance.journal_voucher as j')
    .select('j.id')
    .where('j.org_id', '=', ctx.orgId)
    .where('j.payout_settlement_id', '=', settlement.id)
    .executeTakeFirst();
  // Any payout voucher counts, reversed or not, as the settlement's own posting does (the database holds one per settlement for good): a reversed payout is not posted again here, the accountant handles it.
  if (paid) throw new DomainError('MARKETPLACE_PAYOUT_POSTED', 409, 'Khoản sàn trả của kỳ đối soát này đã được ghi sổ');
  const lockedThrough = await periodLockedThrough(ctx, settlement.legal_entity_id);
  if (lockedThrough && line.date <= lockedThrough) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(line.date)}`, { lockedThrough, entryDate: line.date });
  }
  const lines = await ctx.trx
    .selectFrom('crove_finance.channel_settlement_line')
    .select(['sales', 'seller_discount', 'commission', 'service_fee', 'payment_fee', 'shipping', 'tax_withheld', 'refund', 'other', 'net'])
    .where('org_id', '=', ctx.orgId)
    .where('settlement_id', '=', settlement.id)
    .execute();
  // The settlement's posting created the platform's party and its link, so a settlement whose posting stands has one; without it the stored books are not as the posting left them.
  const link = await ctx.trx
    .selectFrom('crove_finance.marketplace_party as m')
    .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'm.org_id').onRef('p.id', '=', 'm.party_id'))
    .select(['p.id', 'p.name', 'p.tax_code'])
    .where('m.org_id', '=', ctx.orgId)
    .where('m.legal_entity_id', '=', settlement.legal_entity_id)
    .where('m.platform', '=', settlement.platform)
    .executeTakeFirst();
  if (!link) throw notPostable('Không tìm thấy đối tượng của sàn mà kỳ đối soát đã tạo khi ghi sổ', { reason: 'PARTY' });
  const proposal = payoutProposal(
    {
      regime: map.regime,
      platform: platformPartyName(settlement.platform),
      periodFrom,
      periodTo,
      partyId: link.id,
      cashAccount: line.bankAccount,
      lines: lines.map((l) => ({
        sales: l.sales,
        sellerDiscount: l.seller_discount,
        commission: l.commission,
        serviceFee: l.service_fee,
        paymentFee: l.payment_fee,
        shipping: l.shipping,
        taxWithheld: l.tax_withheld,
        refund: l.refund,
        other: l.other,
        net: l.net,
      })),
    },
    maps,
  );
  for (const [what, value] of [['receivable', proposal.receivable], ['received', proposal.received], ['fees', proposal.fees], ['taxWithheld', proposal.taxWithheld], ['total', proposal.total]] as const) wholeDong(what, value);
  for (const l of proposal.lines) {
    wholeDong('debit', l.debit);
    wholeDong('credit', l.credit);
  }
  await checkBankLine(ctx, line, settlement.legal_entity_id, proposal.received, periodFrom, !lock);
  return {
    settlementId: settlement.id,
    legalEntityId: settlement.legal_entity_id,
    platform: settlement.platform,
    bankLineId: line.id,
    periodFrom,
    periodTo,
    date: line.date,
    proposal,
    receivable: map.receivable.code,
    feeAwaiting: map.feeAwaitingInvoice.code,
    party: { id: link.id, name: link.name, taxCode: link.tax_code },
  };
}

// The proposal of a built payout: lines as the voucher holds them, the 131 and 1388 lines naming the platform's party.
function proposalPayload(built: Built): MarketplacePayoutProposal {
  const { proposal } = built;
  return zMarketplacePayoutProposal.parse({
    date: built.date,
    description: proposal.description,
    lines: proposal.lines.map((l) => ({
      account: l.account,
      party: l.account === built.receivable || l.account === built.feeAwaiting ? { id: built.party.id, name: built.party.name, taxCode: built.party.taxCode } : null,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
    })),
    total: proposal.total,
    legalEntityId: built.legalEntityId,
    settlementId: built.settlementId,
    bankLineId: built.bankLineId,
    platform: built.platform,
    periodFrom: built.periodFrom,
    periodTo: built.periodTo,
    received: proposal.received,
    fees: proposal.fees,
    taxWithheld: proposal.taxWithheld,
  });
}

// What a stored proposal holds that the settlement and the bank line, rebuilt now, do not: the first difference, or null when they are the same. A line naming a party must be the line the rebuilt one
// names, with the party the link holds now; the other lines name none.
export function payoutProposalMismatch(stored: MarketplacePayoutProposal, built: MarketplacePayoutProposal): string | null {
  if (stored.settlementId.toLowerCase() !== built.settlementId.toLowerCase()) return 'settlementId';
  if (stored.bankLineId.toLowerCase() !== built.bankLineId.toLowerCase()) return 'bankLineId';
  if (!stored.legalEntityId || stored.legalEntityId.toLowerCase() !== built.legalEntityId?.toLowerCase()) return 'legalEntityId';
  if (stored.platform !== built.platform) return 'platform';
  if (stored.periodFrom !== built.periodFrom || stored.periodTo !== built.periodTo || stored.date !== built.date) return 'period';
  if (stored.description !== built.description) return 'description';
  for (const key of ['received', 'fees', 'taxWithheld', 'total'] as const) if (!money(stored[key]).equals(money(built[key]))) return key;
  if (stored.lines.length !== built.lines.length) return 'lines';
  for (const [i, line] of built.lines.entries()) {
    const have = stored.lines[i];
    if (!have || have.account !== line.account || !money(have.debit).equals(money(line.debit)) || !money(have.credit).equals(money(line.credit)) || (have.memo ?? '') !== (line.memo ?? '')) return 'lines';
    if ((have.party === null) !== (line.party === null) || (have.party !== null && line.party !== null && have.party.id.toLowerCase() !== line.party.id.toLowerCase())) return 'party';
  }
  return null;
}

// The commands over a set of account maps. A test passes its own with a confirmed map; the shipped set is made from MARKETPLACE_POSTING_MAPS.
export function createMarketplacePayoutCommands(options: { maps?: Maps } = {}) {
  const maps = options.maps ?? MARKETPLACE_POSTING_MAPS;

  const prepare = defineCommand({
    name: 'finance.marketplace_payout.prepare',
    input: zMarketplacePayoutRequest,
    risk: 'R1',
    sideEffect: 'internal',
    access: REQUESTERS,
    writes: [],
    handler: async (ctx, input) => {
      const built = await buildPayout(ctx, maps, input.settlementId, input.bankLineId, false);
      await assertUsableAccounts(ctx, built.proposal.lines.map((l) => l.account));
      const payload = proposalPayload(built);
      return { kind: JOURNAL_VOUCHER_KIND, command: MARKETPLACE_PAYOUT_COMMAND, title: journalVoucherTitle(payload), payload };
    },
  });

  const record = defineCommand({
    // A literal, not the shared constant: the job-egress analyzer reads a command's name from the source (the contract's MARKETPLACE_PAYOUT_COMMAND equals it).
    name: 'finance.marketplace_payout.record',
    input: z.object({ payload: zMarketplacePayoutProposal, acceptFailedChecks: z.boolean().default(false) }),
    risk: 'R3',
    sideEffect: 'financial',
    access: 'proposal',
    proposalKind: JOURNAL_VOUCHER_KIND,
    handler: async (ctx, { payload }) => {
      if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
      // The entry is built again from the stored settlement and bank line, in the approver's context, and the stored proposal must equal it: a proposal row not written by the preparer (raw SQL) cannot
      // post lines the settlement does not hold, nor into another entity, nor settle a line the transfer does not match.
      const built = await buildPayout(ctx, maps, payload.settlementId, payload.bankLineId, true);
      const rebuilt = proposalPayload(built);
      const wrong = payoutProposalMismatch(payload, rebuilt);
      if (wrong) throw mismatch(wrong);
      const voucher: JournalVoucherProposal = { date: rebuilt.date, description: rebuilt.description, lines: rebuilt.lines, total: rebuilt.total, legalEntityId: rebuilt.legalEntityId };
      // The shape, the accounts and the parties checked as any voucher's, the parties read FOR SHARE so they stay as read until commit.
      await checkJournalVoucherLines(ctx, voucher.lines.map((l) => ({ account: l.account, partyId: l.party?.id ?? null, debit: l.debit, credit: l.credit })), true);
      return postJournalVoucher(ctx, voucher, null, null, null, null, null, { settlementId: built.settlementId, bankLineId: built.bankLineId });
    },
  });

  return { prepare, record, commands: [prepare, record] };
}

export const marketplacePayoutCommands = createMarketplacePayoutCommands().commands;
