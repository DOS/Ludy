// SPDX-License-Identifier: AGPL-3.0-only
// The proposed entry of a stored marketplace settlement (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4), as pure functions over decimal strings.
// ONE entry per settlement AND MONTH of delivery (marketplace-settlement-months.ts says which pieces of the settlement belong to which month): Dr 131 (the platform) / Cr 511 for the sum of the
// pieces' sales minus the sum of their seller discounts. The commission, service, payment and shipping fees and the withheld tax stay in the settlement record and are not posted here (they are cleared at the payout).
// Refunds (PO decision 2026-11-08): an order the platform refunded within the settlement was not paid for, so Cr 511 = sales - seller discounts - refunds, and Dr 131 the same (TT133 has no 521,
// the return reduces 511 directly). A refund of an earlier period's sale reduces 511 in the period the refund occurs (PO decision 2026-11-08, the usual practice; only a material prior-year error is restated). When refunds and discounts exceed the sales the entry runs the other way, Dr 511 / Cr 131 for the excess. The refund total stays visible on the proposal. The rule is commentary until the accountant confirms it (#2520). The income line cannot say whether a refund
// belongs to this period's sale or an earlier one's (the row has the order's paid date and amounts, not the original sale's period), so a refund of an earlier sale is netted the same way here, by that decision.
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
  // The tax the platform withheld on this line (VAT and PIT together), a positive amount; absent is none.
  taxWithheld?: string;
}

// The household's rate pair for its one line of business on the settlement's date (marketplace-household-tax.ts); the withheld tax is split between VAT and PIT in this proportion.
export interface HouseholdTaxRate {
  vatPercent: string;
  pitPercent: string;
}

export interface SettlementProposalInput {
  regime: string;
  platform: string;
  // The settlement's first and last payment date, YYYY-MM-DD.
  periodFrom: string;
  periodTo: string;
  // The month of delivery the entry is for (YYYY-MM) and the date of the entry (marketplace-settlement-months.ts).
  month: string;
  date: string;
  // The platform's party (crove_finance.marketplace_party, a later slice); null until then.
  partyId: string | null;
  lines: readonly SettlementPostingLine[];
  // A household seller's rate pair, or null for any other seller: the withheld tax is posted only for a household (an enterprise seller has no tax lines, plan row 18).
  tax?: HouseholdTaxRate | null;
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
  month: string;
  date: string;
  // The settlement's sales, seller discounts and refunds, so the refund stays visible beside the net.
  sales: string;
  sellerDiscount: string;
  refund: string;
  // The tax the platform withheld that the entry credits to 3331 and 3335, whole dong; '0' for a seller that is no household.
  taxWithheld: string;
  lines: ProposedJournalLine[];
  total: string;
}

// The lines of the entry, from the map's accounts. Nothing is checked about the status here: settlementProposal is the gated entry point.
function settlementProposalLines(input: SettlementProposalInput, map: Pick<MarketplacePostingMap, 'receivable' | 'revenue' | 'salesReturn' | 'vatPayable' | 'pitPayable' | 'pitExpense'>): ProposedJournalLine[] {
  const bad = (reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, reason, extra);
  // Each line's amounts are decimal strings of at most four places and not negative: a negative discount or sale must not inflate the revenue.
  for (const l of input.lines) {
    for (const v of [l.sales, l.sellerDiscount, l.refund, l.taxWithheld ?? '0']) {
      if (typeof v !== 'string' || !/^\d+(\.\d{1,4})?$/.test(v)) throw bad('Số tiền của dòng đối soát không hợp lệ', { amount: String(v) });
    }
  }
  const net = money(toMoney(sum(input.lines.map((l) => l.sales)))).minus(money(toMoney(sum(input.lines.map((l) => l.sellerDiscount))))).minus(money(toMoney(sum(input.lines.map((l) => l.refund)))));
  // A negative net (refunds and discounts above the sales, for example a quiet month with returns from the one before) is legitimate: the entry runs the other way, the platform owing less.
  const amount = toMoney(net.abs());
  const tax = withheldSplit(input);
  // A zero net has no 131 / 511 pair; a month that carries withheld tax still posts that tax (the tax lines alone balance), anything else has nothing to post.
  if (money(amount).isZero() && !tax) throw bad('Kỳ đối soát có doanh thu ròng bằng 0; không có bút toán để lập', { net: amount });
  const memo = `${input.platform} ${input.periodFrom} đến ${input.periodTo}, tháng ${input.month}`;
  const owed = net.greaterThan(0);
  const lines: ProposedJournalLine[] = money(amount).isZero()
    ? []
    : [
        { account: owed ? map.receivable.code : map.revenue.code, debit: amount, credit: '0', partyId: owed ? input.partyId : null, memo },
        { account: owed ? map.revenue.code : map.receivable.code, debit: '0', credit: amount, partyId: owed ? null : input.partyId, memo },
      ];
  if (tax) {
    const taxMemo = `${memo}, thuế sàn đã khấu trừ`;
    if (!money(tax.vat).isZero()) lines.push({ account: map.revenue.code, debit: tax.vat, credit: '0', partyId: null, memo: taxMemo }, { account: map.vatPayable.code, debit: '0', credit: tax.vat, partyId: null, memo: taxMemo });
    if (!money(tax.pit).isZero()) lines.push({ account: map.pitExpense.code, debit: tax.pit, credit: '0', partyId: null, memo: taxMemo }, { account: map.pitPayable.code, debit: '0', credit: tax.pit, partyId: null, memo: taxMemo });
  }
  return lines;
}

// The withheld tax of the entry's pieces split into VAT and PIT by the household's rate pair: VAT = tax x vat% / (vat% + pit%) rounded to whole dong, the remainder PIT, so the two add up to
// exactly what the platform withheld. Null when the seller is no household or nothing was withheld.
export function withheldSplit(input: Pick<SettlementProposalInput, 'lines' | 'tax'>): { total: string; vat: string; pit: string } | null {
  const total = money(toMoney(sum(input.lines.map((l) => l.taxWithheld ?? '0'))));
  if (!input.tax || total.isZero()) return null;
  const vatPercent = money(input.tax.vatPercent);
  const rates = vatPercent.plus(money(input.tax.pitPercent));
  if (!rates.greaterThan(0)) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, 'Tỷ lệ thuế của ngành nghề không hợp lệ để tách thuế sàn đã khấu trừ', { vatPercent: input.tax.vatPercent, pitPercent: input.tax.pitPercent });
  const vat = total.times(vatPercent).div(rates).toDecimalPlaces(0, 4);
  return { total: toMoney(total), vat: toMoney(vat), pit: toMoney(total.minus(vat)) };
}

// The gated proposal: the map of the regime must be confirmed, the net not zero, and the entry must pass the journal voucher's own shape checks. The party of the 131 line may still be null
// (the later slice fills it), so that one problem is not raised for it here; the party link is checked when the entry is recorded.
export function settlementProposal(input: SettlementProposalInput, maps?: Readonly<Record<string, MarketplacePostingMap>>): SettlementProposal {
  const map = requireConfirmedMarketplaceMap(input.regime, maps);
  const lines = settlementProposalLines(input, map);
  const problems = journalVoucherProblems(lines.map((l) => ({ ...l, partyId: l.partyId ?? (l.account === map.receivable.code ? 'pending' : null) })));
  if (problems.length > 0) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, 'Bút toán của kỳ đối soát không hợp lệ', { problems });
  return {
    description: `Đối soát ${input.platform} ${input.periodFrom} đến ${input.periodTo}, tháng ${input.month}`.slice(0, 500),
    month: input.month,
    date: input.date,
    sales: toMoney(sum(input.lines.map((l) => l.sales))),
    sellerDiscount: toMoney(sum(input.lines.map((l) => l.sellerDiscount))),
    refund: toMoney(sum(input.lines.map((l) => l.refund))),
    taxWithheld: withheldSplit(input)?.total ?? '0',
    lines, total: journalVoucherTotal(lines),
  };
}
