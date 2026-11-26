// SPDX-License-Identifier: AGPL-3.0-only
// The proposed entry of a stored marketplace settlement (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4), as pure functions over decimal strings.
// ONE entry per settlement AND MONTH of delivery (marketplace-settlement-months.ts says which pieces of the settlement belong to which month): Dr 131 (the platform) / Cr 511 for the sum of the
// pieces' sales minus the sum of their seller discounts. The commission, service, payment and shipping fees and the withheld tax stay in the settlement record and are not posted here (they are cleared at the payout).
// Refunds under a map whose refund account is not the revenue account (TT99: 521, research C3, #4017): the refund is its own debit line, Dr 131 (sales - seller discounts - refunds) + Dr 521 (refunds) / Cr 511 (sales - seller discounts).
// Refunds (PO decision 2026-11-08): an order the platform refunded within the settlement was not paid for, so Cr 511 = sales - seller discounts - refunds, and Dr 131 the same (TT133 has no 521,
// the return reduces 511 directly). A refund of an earlier period's sale reduces 511 in the period the refund occurs (PO decision 2026-11-08, the usual practice; only a material prior-year error is restated). When refunds and discounts exceed the sales the entry runs the other way, Dr 511 / Cr 131 for the excess. The refund total stays visible on the proposal. The rule is commentary until the accountant confirms it (#2520). The income line cannot say whether a refund
// belongs to this period's sale or an earlier one's (the row has the order's paid date and amounts, not the original sale's period), so a refund of an earlier sale is netted the same way here, by that decision.
// Output VAT (#4303 S3b, research rule 1): the sales and refunds are VAT-inclusive prices, so for an entity on the deduction method each piece is split into revenue and output VAT on 33311 at the rate in force on its
// delivery day (`rateDate`; a piece with none takes the entry's date), read by the caller with marketplaceVatRateAt: Dr 131 R / Cr 511 (R - T), Cr 33311 T. T is the VAT inside the base, base x p / (100 + p), rounded
// half up to whole dong once per rate and entry (decimal.js, never JS numbers); the revenue is the remainder, so the entry balances exactly. A refund takes the rate of the sale it reverses and reduces 33311 and the
// revenue (521 under Circular 99) by its VAT-free part. Method `none` adds no VAT line. A date with NO row is not guessed: the proposal is refused (MARKETPLACE_SETTLEMENT_WAITING_VAT_RATE) and the settlement waits.
// Nothing posts until the accountant has confirmed the account map (requireConfirmedMarketplaceMap). The platform's party link is a later slice: the caller fills `partyId`.
import { DomainError } from '@ludy/kernel-runtime';
import { money, sum, toMoney, type DecimalValue } from '@ludy/l10n-vn';
import { journalVoucherProblems, journalVoucherTotal } from './domain/journal-voucher.ts';
import { requireConfirmedMarketplaceMap, type MarketplacePath, type MarketplacePostingMap } from './marketplace-posting-map.ts';

// A refusal that only says a month has nothing to post (zero net, zero VAT, nothing withheld): the caller skips such a month and refuses the settlement only when no month is left.
export const isEmptyEntry = (e: unknown): boolean => e instanceof DomainError && e.code === 'MARKETPLACE_SETTLEMENT_NOT_POSTABLE' && (e.details as { empty?: boolean } | undefined)?.empty === true;

export interface SettlementPostingLine {
  sales: string;
  sellerDiscount: string;
  // The refund the platform deducted on this line, a positive amount.
  refund: string;
  // The tax the platform withheld on this line (VAT and PIT together), a positive amount; absent is none.
  taxWithheld?: string;
  // The day whose VAT rate applies to this piece (YYYY-MM-DD): the delivery day of the sale, which a refund of that sale also takes. Absent or null: the date of the entry (a line refunded at least as much
  // as it sold has no usable delivery day and is dated by its refund).
  rateDate?: string | null;
}

// The VAT of the entity's marketplace sales on one day, from ludy_finance.marketplace_vat_rate (marketplaceVatRateAt): `deduction` splits output VAT at `vatPercent` (a decimal string, percent), `none` adds no VAT line.
export type SettlementVatRate = { method: 'deduction'; vatPercent: string } | { method: 'none' };
// The rate in force on each date the pieces need (vatDatesOf), resolved by the caller; null where no row covers the date, which holds the settlement back.
export type SettlementVatRates = Readonly<Record<string, SettlementVatRate | null>>;

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
  // The platform's party (ludy_finance.marketplace_party, a later slice); null until then.
  partyId: string | null;
  lines: readonly SettlementPostingLine[];
  // A household seller's rate pair, or null for any other seller: the withheld tax is posted only for a household (an enterprise seller has no tax lines, plan row 18).
  tax?: HouseholdTaxRate | null;
  // The VAT rate in force on each date the pieces need (vatDatesOf), read by the caller with marketplaceVatRateAt.
  vatRates: SettlementVatRates;
}

export interface TaxEstimate {
  withheld: string;
  expected: string;
  // withheld - expected, whole dong, negative when the platform withheld less than the rate pair would.
  difference: string;
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
  // The output VAT the entry credits to 33311 net of the VAT of the refunds, whole dong, signed ('0' for method `none`).
  outputVat: string;
  // The tax the platform withheld that the entry credits to 3331 and 3335, whole dong; '0' for a seller that is no household.
  taxWithheld: string;
  // A household's withheld tax is ONE amount the platform gave, split into VAT and PIT only as an estimate by the household's rate pair (research D1): what the platform withheld, what the rate pair
  // would have taken from the revenue (sales - seller discounts - refunds), and the difference, a fact shown beside the estimate and never posted. Null for a seller with no withheld tax.
  taxEstimate: TaxEstimate | null;
  lines: ProposedJournalLine[];
  total: string;
}

// The lines of the entry, from the map's accounts. Nothing is checked about the status here: settlementProposal is the gated entry point.
// The days whose VAT rate the pieces of an entry need: each piece's `rateDate`, or the entry's date. Only pieces that carry a sale or a refund need one.
// A piece carries something to post when its sale after the seller's discount, or its refund, is not zero: the one test vatDatesOf and outputVatOf share, so a day is asked for exactly when it is used.
const carriesAmount = (l: SettlementPostingLine): boolean => !money(l.sales).minus(money(l.sellerDiscount)).isZero() || !money(l.refund).isZero();

export function vatDatesOf(input: Pick<SettlementProposalInput, 'lines' | 'date'>): string[] {
  const dates = new Set<string>();
  for (const l of input.lines) if (carriesAmount(l)) dates.add(l.rateDate ?? input.date);
  return [...dates].sort();
}

// Whether the entry of a month has nothing to post: no net, no VAT difference between its sales and its refunds (pieces at different rates can net to zero while 33311 is not), no tax the platform withheld
// (`withheld`, true when any line carries some) and, under a map with a separate refund account, no refund (it is its own debit line there). The rates of the days it needs must be in `vatRates`.
export function entryIsEmpty(input: Pick<SettlementProposalInput, 'lines' | 'date' | 'vatRates'>, separateReturn: boolean, withheld: boolean): boolean {
  const sales = money(toMoney(sum(input.lines.map((l) => l.sales)))).minus(money(toMoney(sum(input.lines.map((l) => l.sellerDiscount)))));
  const refunds = money(toMoney(sum(input.lines.map((l) => l.refund))));
  const vat = outputVatOf(input);
  return sales.minus(refunds).isZero() && vat.sales.minus(vat.refunds).isZero() && !withheld && !(separateReturn && !refunds.isZero());
}

// The output VAT of an entry: for each piece the VAT inside its base at the rate of its day, summed per rate and rounded half up to whole dong once per rate (sales and refunds apart). Refuses (the settlement
// waits) when a day has no row. Method `none` gives no VAT.
export function outputVatOf(input: Pick<SettlementProposalInput, 'lines' | 'date' | 'vatRates'>): { sales: DecimalValue; refunds: DecimalValue } {
  const salesBase = new Map<string, DecimalValue>();
  const refundBase = new Map<string, DecimalValue>();
  const missing: string[] = [];
  for (const l of input.lines) {
    const sale = money(l.sales).minus(money(l.sellerDiscount));
    const refund = money(l.refund);
    if (!carriesAmount(l)) continue;
    const day = l.rateDate ?? input.date;
    const rate = Object.hasOwn(input.vatRates, day) ? input.vatRates[day] : null;
    if (!rate) {
      if (!missing.includes(day)) missing.push(day);
      continue;
    }
    if (rate.method !== 'deduction') continue;
    salesBase.set(rate.vatPercent, (salesBase.get(rate.vatPercent) ?? money('0')).plus(sale));
    refundBase.set(rate.vatPercent, (refundBase.get(rate.vatPercent) ?? money('0')).plus(refund));
  }
  if (missing.length > 0) {
    throw new DomainError('MARKETPLACE_SETTLEMENT_WAITING_VAT_RATE', 422, 'Chưa có thuế suất GTGT của hàng bán qua sàn cho ngày giao hàng: hãy nhập thuế suất trong Cài đặt, mục Kế toán', { dates: missing.sort() });
  }
  const vatIn = (bases: Map<string, DecimalValue>): DecimalValue => {
    let total = money('0');
    for (const [percent, base] of bases) {
      const p = money(percent);
      // The VAT inside a VAT-inclusive price: base x p / (100 + p), rounded half up to whole dong, once per rate.
      total = total.plus(base.times(p).div(p.plus(100)).toDecimalPlaces(0, 4));
    }
    return total;
  };
  return { sales: vatIn(salesBase), refunds: vatIn(refundBase) };
}

function settlementProposalLines(input: SettlementProposalInput, map: Pick<MarketplacePostingMap, 'receivable' | 'revenue' | 'salesReturn' | 'outputVat' | 'vatPayable' | 'pitPayable' | 'pitOwnerEquity'>): ProposedJournalLine[] {
  const bad = (reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, reason, extra);
  // Each line's amounts are decimal strings of at most four places and not negative: a negative discount or sale must not inflate the revenue.
  for (const l of input.lines) {
    for (const v of [l.sales, l.sellerDiscount, l.refund, l.taxWithheld ?? '0']) {
      if (typeof v !== 'string' || !/^\d+(\.\d{1,4})?$/.test(v)) throw bad('Số tiền của dòng đối soát không hợp lệ', { amount: String(v) });
    }
  }
  const grossAfterDiscount = money(toMoney(sum(input.lines.map((l) => l.sales)))).minus(money(toMoney(sum(input.lines.map((l) => l.sellerDiscount)))));
  const refunds = money(toMoney(sum(input.lines.map((l) => l.refund))));
  const net = grossAfterDiscount.minus(refunds);
  // A map whose refund account differs from its revenue account (TT99: 521) books the refund as its own debit line there; one whose refund account is the revenue account (TT133) nets it into 511.
  const separateReturn = map.salesReturn.code !== map.revenue.code;
  const tax = withheldSplit(input);
  // The output VAT inside the sales and inside the refunds (zero for method `none`); refuses a day with no rate before anything else is built.
  const vat = outputVatOf(input);
  const vatNet = vat.sales.minus(vat.refunds);
  // Nothing to post: no tax, no VAT difference and nothing on any of the lines of the entry (a zero net with a separate refund line still has that line, so it is posted).
  if (net.isZero() && vatNet.isZero() && !tax && !(separateReturn && !refunds.isZero())) throw bad('Kỳ đối soát có doanh thu ròng bằng 0; không có bút toán để lập', { net: toMoney(net.abs()), empty: true });
  const memo = `${input.platform} ${input.periodFrom} đến ${input.periodTo}, tháng ${input.month}`;
  // Dr 131 for what the platform owes (net of discounts and refunds); Cr 33311 for the output VAT in the sales less the VAT of the refunds; and the revenue for the rest. A map whose refund account differs from its
  // revenue account (TT99: 521) books the refund, less its VAT, as its own debit line there; one whose refund account is the revenue account (TT133) nets it into 5111. The entry balances in either case (131 + 521 =
  // 511 + 33311, each of the four a signed amount). Each account runs the other way when its own amount is negative (refunds above the sales, a quiet month with returns from the one before), and a zero amount posts no line.
  // The payout clears the same 131 amount (sales - discounts - refunds), which the VAT does not change.
  const lines: ProposedJournalLine[] = [];
  const debitFirst: ProposedJournalLine[] = [];
  const creditSide: ProposedJournalLine[] = [];
  const place = (account: string, signedDebit: DecimalValue, partyId: string | null, lineMemo: string) => {
    if (signedDebit.isZero()) return;
    const line: ProposedJournalLine = signedDebit.greaterThan(0)
      ? { account, debit: toMoney(signedDebit), credit: '0', partyId, memo: lineMemo }
      : { account, debit: '0', credit: toMoney(signedDebit.abs()), partyId, memo: lineMemo };
    (signedDebit.greaterThan(0) ? debitFirst : creditSide).push(line);
  };
  place(map.receivable.code, net, input.partyId, memo);
  if (separateReturn) {
    place(map.salesReturn.code, refunds.minus(vat.refunds), null, `${memo}, hoàn hàng`);
    place(map.revenue.code, grossAfterDiscount.minus(vat.sales).negated(), null, memo);
  } else {
    place(map.revenue.code, net.minus(vatNet).negated(), null, memo);
  }
  place(map.outputVat.code, vatNet.negated(), null, `${memo}, thuế GTGT đầu ra`);
  lines.push(...debitFirst, ...creditSide);
  if (tax) {
    const taxMemo = `${memo}, thuế sàn đã khấu trừ, tách thuế GTGT và TNCN ước tính theo tỷ lệ ngành nghề`;
    if (!money(tax.vat).isZero()) lines.push({ account: map.revenue.code, debit: tax.vat, credit: '0', partyId: null, memo: taxMemo }, { account: map.vatPayable.code, debit: '0', credit: tax.vat, partyId: null, memo: taxMemo });
    if (!money(tax.pit).isZero()) lines.push({ account: map.pitOwnerEquity.code, debit: tax.pit, credit: '0', partyId: null, memo: taxMemo }, { account: map.pitPayable.code, debit: '0', credit: tax.pit, partyId: null, memo: taxMemo });
  }
  return lines;
}

// The withheld tax of the entry's pieces split into VAT and PIT by the household's rate pair: VAT = tax x vat% / (vat% + pit%) rounded to whole dong, the remainder PIT, so the two add up to
// exactly what the platform withheld. Null when the seller is no household or nothing was withheld.
export function withheldSplit(input: Pick<SettlementProposalInput, 'lines' | 'tax'>): { total: string; vat: string; pit: string } | null {
  const total = money(toMoney(sum(input.lines.map((l) => l.taxWithheld ?? '0'))));
  if (!input.tax || total.isZero()) return null;
  // The VAT part is rounded and the PIT part is the remainder, so a total that is not whole dong would leave a fractional PIT: refused here, as the payout refuses it, never rounded.
  if (!total.isInteger()) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, 'Thuế sàn đã khấu trừ phải là số đồng nguyên để hạch toán', { what: 'taxWithheld', taxWithheld: toMoney(total) });
  const vatPercent = money(input.tax.vatPercent);
  const rates = vatPercent.plus(money(input.tax.pitPercent));
  if (!rates.greaterThan(0)) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, 'Tỷ lệ thuế của ngành nghề không hợp lệ để tách thuế sàn đã khấu trừ', { vatPercent: input.tax.vatPercent, pitPercent: input.tax.pitPercent });
  const vat = total.times(vatPercent).div(rates).toDecimalPlaces(0, 4);
  return { total: toMoney(total), vat: toMoney(vat), pit: toMoney(total.minus(vat)) };
}

// The reconciliation fact of an estimated split (research D1): the rate pair's total percentage of the revenue (sales - seller discounts - refunds, never below zero) rounded to whole dong, against what the
// platform withheld. A platform may apply another rate for the category and period (the ratio is not fixed in 2026), so the difference is information for the annual certificate, not an entry. Null when
// the seller is no household or nothing was withheld.
export function taxEstimate(input: Pick<SettlementProposalInput, 'lines' | 'tax'>): TaxEstimate | null {
  const split = withheldSplit(input);
  if (!split || !input.tax) return null;
  const revenue = money(toMoney(sum(input.lines.map((l) => l.sales)))).minus(money(toMoney(sum(input.lines.map((l) => l.sellerDiscount))))).minus(money(toMoney(sum(input.lines.map((l) => l.refund)))));
  const base = revenue.greaterThan(0) ? revenue : money('0');
  const expected = base.times(money(input.tax.vatPercent).plus(money(input.tax.pitPercent))).div(100).toDecimalPlaces(0, 4);
  return { withheld: split.total, expected: toMoney(expected), difference: toMoney(money(split.total).minus(expected)) };
}

// The paths a settlement posts through (#3711 slice 1): the sales, and the household tax lines only when this settlement carries withheld tax for a household seller. Read from the amounts alone, so a
// malformed one is still refused by its own check below and not by the gate.
export function settlementPaths(input: Pick<SettlementProposalInput, 'lines' | 'tax'>): MarketplacePath[] {
  const withheld = input.lines.some((l) => typeof l.taxWithheld === 'string' && /[1-9]/.test(l.taxWithheld));
  return input.tax && withheld ? ['sales', 'household_tax'] : ['sales'];
}

// The gated proposal: the map of the regime must be confirmed, the net not zero, and the entry must pass the journal voucher's own shape checks. The party of the 131 line may still be null
// (the later slice fills it), so that one problem is not raised for it here; the party link is checked when the entry is recorded.
export function settlementProposal(input: SettlementProposalInput, maps?: Readonly<Record<string, MarketplacePostingMap>>): SettlementProposal {
  const map = requireConfirmedMarketplaceMap(input.regime, maps, settlementPaths(input));
  const lines = settlementProposalLines(input, map);
  // The amounts were checked by the lines above; this is the same VAT they used.
  const vat = outputVatOf(input);
  const problems = journalVoucherProblems(lines.map((l) => ({ ...l, partyId: l.partyId ?? (l.account === map.receivable.code ? 'pending' : null) })));
  if (problems.length > 0) throw new DomainError('MARKETPLACE_SETTLEMENT_NOT_POSTABLE', 422, 'Bút toán của kỳ đối soát không hợp lệ', { problems });
  return {
    description: `Đối soát ${input.platform} ${input.periodFrom} đến ${input.periodTo}, tháng ${input.month}`.slice(0, 300),
    month: input.month,
    date: input.date,
    sales: toMoney(sum(input.lines.map((l) => l.sales))),
    sellerDiscount: toMoney(sum(input.lines.map((l) => l.sellerDiscount))),
    refund: toMoney(sum(input.lines.map((l) => l.refund))),
    outputVat: toMoney(vat.sales.minus(vat.refunds)),
    taxWithheld: withheldSplit(input)?.total ?? '0',
    taxEstimate: taxEstimate(input),
    lines, total: journalVoucherTotal(lines),
  };
}
