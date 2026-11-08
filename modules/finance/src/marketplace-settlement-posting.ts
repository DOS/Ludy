// SPDX-License-Identifier: AGPL-3.0-only
// The proposed entry of a stored marketplace settlement (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4), as pure functions over decimal strings.
// ONE entry per settlement: Dr 131 (the platform) / Cr 511 for the sum of the lines' sales minus the sum of their seller discounts. The commission, service, payment and shipping fees and the
// withheld tax stay in the settlement record and are not posted here (they are cleared at the payout, a later slice).
// Refunds: section 8.4 lists them among the report's columns but says the entry is "the sales it paid for net of the seller's own discounts", and names no refund line; so refunds are NOT
// posted here and do not reduce the revenue (a refund the platform deducted reaches the books through the payout and the accountant's rule, section 11). The input does not even carry the column.
// Nothing posts until the accountant has confirmed the account map (requireConfirmedMarketplaceMap). The platform's party link is a later slice: the caller fills `partyId`.
import { DomainError } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { journalVoucherProblems, journalVoucherTotal } from './domain/journal-voucher.ts';
import { requireConfirmedMarketplaceMap, type MarketplacePostingMap } from './marketplace-posting-map.ts';

export interface SettlementPostingLine {
  sales: string;
  sellerDiscount: string;
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
  lines: ProposedJournalLine[];
  total: string;
}

// The lines of the entry, from the map's accounts. Nothing is checked about the status here: settlementProposal is the gated entry point.
export function settlementProposalLines(input: SettlementProposalInput, map: Pick<MarketplacePostingMap, 'receivable' | 'revenue'>): ProposedJournalLine[] {
  const net = money(toMoney(sum(input.lines.map((l) => l.sales)))).minus(money(toMoney(sum(input.lines.map((l) => l.sellerDiscount)))));
  if (net.lessThanOrEqualTo(0)) {
    throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, 'Kỳ đối soát không có doanh thu ròng dương; không lập được bút toán', { net: toMoney(net) });
  }
  const amount = toMoney(net);
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
  return { description: `Đối soát ${input.platform} ${input.periodFrom} đến ${input.periodTo}`, lines, total: journalVoucherTotal(lines) };
}
