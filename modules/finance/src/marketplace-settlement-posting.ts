// SPDX-License-Identifier: AGPL-3.0-only
// The proposed entry of a stored marketplace settlement (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4), as pure functions over decimal strings.
// ONE entry per settlement: Dr 131 (the platform) / Cr 511 for the sum of the lines' sales minus the sum of their seller discounts. The commission, service, payment and shipping fees and the
// withheld tax stay in the settlement record and are not posted here (they are cleared at the payout, a later slice).
// Refunds (PO decision 2026-11-08): an order the platform refunded within the settlement was not paid for, so Cr 511 = sales - seller discounts - refunds, and Dr 131 the same (TT133 has no 521,
// the return reduces 511 directly). The refund total stays visible on the proposal. The rule is commentary until the accountant confirms it (#2520). The income line cannot say whether a refund
// belongs to this period's sale or an earlier one's (the row has the order's paid date and amounts, not the original sale's period), so a refund of an earlier sale is netted the same way here.
// Nothing posts until the accountant has confirmed the account map (requireConfirmedMarketplaceMap). The platform's party link is a later slice: the caller fills `partyId`.
import { DomainError } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { journalVoucherProblems, journalVoucherTotal } from './domain/journal-voucher.ts';
import { requireConfirmedMarketplaceMap, type MarketplacePostingMap } from './marketplace-posting-map.ts';

export interface SettlementPostingLine {
  sales: string;
  sellerDiscount: string;
  // The refund the platform deducted on this line, a positive amount.
  refund: string;
}

export interface SettlementProposalInput {
  regime: string;
  platform: string;
  // The settlement's first and last payment date, YYYY-MM-DD.
  periodFrom: string;
  periodTo: string;
  // The platform's party (crove_finance.marketplace_party, a later slice); null until then.
  partyId: string | null;
  lines: readonly SettlementPostingLine[];
}

export interface ProposedJournalLine {
  account: string;
  debit: string;
  credit: string;
  partyId: string | null;
  memo: string;
}

export interface SettlementProposal {
  description: string;
  // The settlement's sales, seller discounts and refunds, so the refund stays visible beside the net.
  sales: string;
  sellerDiscount: string;
  refund: string;
  lines: ProposedJournalLine[];
  total: string;
}

// The lines of the entry, from the map's accounts. Nothing is checked about the status here: settlementProposal is the gated entry point.
function settlementProposalLines(input: SettlementProposalInput, map: Pick<MarketplacePostingMap, 'receivable' | 'revenue' | 'salesReturn'>): ProposedJournalLine[] {
  const bad = (reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, reason, extra);
  // Each line's amounts are decimal strings of at most four places and not negative: a negative discount or sale must not inflate the revenue.
  for (const l of input.lines) {
    for (const v of [l.sales, l.sellerDiscount, l.refund]) {
      if (typeof v !== 'string' || !/^\d+(\.\d{1,4})?$/.test(v)) throw bad('Số tiền của dòng đối soát không hợp lệ', { amount: String(v) });
    }
  }
  const net = money(toMoney(sum(input.lines.map((l) => l.sales)))).minus(money(toMoney(sum(input.lines.map((l) => l.sellerDiscount))))).minus(money(toMoney(sum(input.lines.map((l) => l.refund)))));
  const amount = toMoney(net);
  if (net.lessThanOrEqualTo(0) || money(amount).lessThanOrEqualTo(0)) throw bad('Kỳ đối soát không có doanh thu ròng dương; không lập được bút toán', { net: amount });
  const memo = `${input.platform} ${input.periodFrom} đến ${input.periodTo}`;
  return [
    { account: map.receivable.code, debit: amount, credit: '0', partyId: input.partyId, memo },
    { account: map.revenue.code, debit: '0', credit: amount, partyId: null, memo },
  ];
}

// The gated proposal: the map of the regime must be confirmed, the net positive, and the entry must pass the journal voucher's own shape checks. The party of the 131 line may still be null
// (the later slice fills it), so that one problem is not raised for it here; the party link is checked when the entry is recorded.
export function settlementProposal(input: SettlementProposalInput, maps?: Readonly<Record<string, MarketplacePostingMap>>): SettlementProposal {
  const map = requireConfirmedMarketplaceMap(input.regime, maps);
  const lines = settlementProposalLines(input, map);
  const problems = journalVoucherProblems(lines.map((l) => ({ ...l, partyId: l.partyId ?? (l.account === map.receivable.code ? 'pending' : null) })));
  if (problems.length > 0) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, 'Bút toán của kỳ đối soát không hợp lệ', { problems });
  return {
    description: `Đối soát ${input.platform} ${input.periodFrom} đến ${input.periodTo}`.slice(0, 500),
    sales: toMoney(sum(input.lines.map((l) => l.sales))),
    sellerDiscount: toMoney(sum(input.lines.map((l) => l.sellerDiscount))),
    refund: toMoney(sum(input.lines.map((l) => l.refund))),
    lines, total: journalVoucherTotal(lines),
  };
}
