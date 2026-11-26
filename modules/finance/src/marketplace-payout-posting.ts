// SPDX-License-Identifier: AGPL-3.0-only
// The proposed entry of a platform's payout (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"), as pure functions over decimal strings, built from the
// lines of a stored settlement and nothing else: ONE entry per settlement, Dr cash (the bank account of the transfer) for the money received, Dr 331 (the platform's party) for the platform's fees
// (route b of the AI consensus 2026-11-15, A1: the fee invoice, Cr 331, nets them), Dr 3331 and Dr 3335 for the VAT and the PIT the platform withheld, Cr 131 (the platform) for what the settlement
// posted there: sales minus the seller discounts minus the refunds (marketplace-settlement-posting.ts). The three debits add up to the credit only when the lines carry no other adjustment, so a
// settlement with one is refused, never balanced by a guessed line: the accountant explains it first.
// A settlement line's money the report does not explain is posted only when a person has classified it (#4303 S4, research rules 2, 3 and 4): an incentive (Cr 711), a carrier compensation (Cr 632 up to the
// cost the person states, the rest Cr 711), tax withheld from a seller that is no household (Dr 1388 under the platform's party, in place of 3331 and 3335). Every adjustment names a stored line and its exact amount;
// an unclassified or negative line is refused as before.
// Nothing posts until the accountant has confirmed the account map (requireConfirmedMarketplaceMap).
import { DomainError } from '@ludy/kernel-runtime';
import type { MarketplacePayoutAdjustment } from '@ludy/kernel-contract';
import { money, sum, toMoney } from '@ludy/l10n-vn';
import { journalVoucherProblems, journalVoucherTotal } from './domain/journal-voucher.ts';
import { requireConfirmedMarketplaceMap, type MarketplacePath, type MarketplacePostingMap } from './marketplace-posting-map.ts';
import type { ProposedJournalLine } from './marketplace-settlement-posting.ts';

export interface PayoutPostingLine {
  // The stored line's id: an adjustment names the line it explains by it.
  id: string;
  sales: string;
  sellerDiscount: string;
  commission: string;
  serviceFee: string;
  paymentFee: string;
  shipping: string;
  taxWithheld: string;
  refund: string;
  // Any other adjustment, positive or negative.
  other: string;
  net: string;
}

export interface PayoutProposalInput {
  regime: string;
  platform: string;
  periodFrom: string;
  periodTo: string;
  // The platform's party (ludy_finance.marketplace_party): the settlement's posting created it, so a payout of a posted settlement has one.
  partyId: string | null;
  // The ledger account of the bank account that received the transfer (the bank line's own account).
  cashAccount: string;
  lines: readonly PayoutPostingLine[];
  // The VAT and the PIT the settlement's vouchers credited to 3331 and 3335 (slice C2), read from the books: the payout debits exactly these, so the two accounts net to zero, and their sum must be the
  // withheld tax of the lines. Null when the settlement credited none (a seller that is no household): any withheld tax is then refused, never booked to a guessed account.
  taxSplit: { vat: string; pit: string } | null;
  // What a person said the lines' unexplained money is (#4303 S4); empty keeps the rule of before: the lines' `other` must add up to zero.
  adjustments?: readonly MarketplacePayoutAdjustment[];
  // The seller is a household (its withheld tax is the settlement's 3331 and 3335, never a mistake). Tax withheld from a seller that is no household can be classified `withheld_in_error`; a household's cannot.
  household: boolean;
}

export interface PayoutProposal {
  description: string;
  // The settlement's receivable (131) the payout clears, the money received, the fees and the withheld tax.
  receivable: string;
  received: string;
  fees: string;
  taxWithheld: string;
  lines: ProposedJournalLine[];
  total: string;
  // The classified amounts the entry carries (whole dong strings): incentives, compensation, the part of it credited to 632, and the tax debited to 1388. All '0' without adjustments.
  incentive: string;
  compensation: string;
  compensationCost: string;
  taxInError: string;
}

const bad = (reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_PAYOUT_NOT_POSTABLE', 422, reason, extra);

const POSITIVE = /^\d+(\.\d{1,4})?$/;
const SIGNED = /^-?\d+(\.\d{1,4})?$/;
// Suffix on the `otherReceivable` (1388) debit line for tax withheld by mistake (#4303 S4): fee clearing excludes lines with this suffix (#4336).
export const WITHHELD_IN_ERROR_MEMO_SUFFIX = ', thuế sàn khấu trừ nhầm';

// The classification of the lines (#4303 S4), checked against the stored lines with no slack. Returns what each kind adds up to; throws when a line is unclassified, classified twice, or classified as what it is not.
// `other` lines must be above zero and carry an `incentive` or `carrier_compensation`; a line's tax withheld needs `withheld_in_error`, allowed only for a seller that is no household. An adjustment's amount
// must equal its line's exactly, so the adjusted amounts add up to the residual they explain and nothing is rounded or balanced by a guess.
function classify(input: PayoutProposalInput) {
  const adjustments = input.adjustments ?? [];
  // The lines' `other` are checked one by one when they add up to something or a person classified one; an offsetting pair with nothing classified on it stays no adjustment, as before.
  const strictOther = !money(toMoney(sum(input.lines.map((l) => l.other)))).isZero() || adjustments.some((a) => a.kind !== 'withheld_in_error');
  const byLine = new Map<string, MarketplacePayoutAdjustment[]>();
  const known = new Set(input.lines.map((l) => l.id.toLowerCase()));
  for (const a of adjustments) {
    const key = a.lineId.toLowerCase();
    if (!known.has(key)) throw bad('Khoản điều chỉnh nêu một dòng không thuộc kỳ đối soát này', { reason: 'ADJUSTMENT_LINE', lineId: a.lineId });
    byLine.set(key, [...(byLine.get(key) ?? []), a]);
  }
  let incentive = money('0');
  let compensation = money('0');
  let compensationCost = money('0');
  let taxInError = money('0');
  for (const l of input.lines) {
    const own = byLine.get(l.id.toLowerCase()) ?? [];
    const other = money(l.other);
    const tax = money(l.taxWithheld);
    const otherKind = own.filter((a) => a.kind !== 'withheld_in_error');
    const taxKind = own.filter((a) => a.kind === 'withheld_in_error');
    if (otherKind.length > 1 || taxKind.length > 1) throw bad('Một dòng đối soát chỉ được phân loại một lần cho mỗi khoản', { reason: 'ADJUSTMENT_DUPLICATE', lineId: l.id });
    const o = otherKind[0];
    if (!strictOther) {
      // nothing to explain on any line's `other`
    } else if (other.isZero()) {
      if (o) throw bad('Khoản điều chỉnh nêu một dòng không có khoản chưa giải thích', { reason: 'ADJUSTMENT_NOTHING', lineId: l.id });
    } else {
      if (other.isNegative()) throw bad('Dòng đối soát có khoản trừ khác chưa giải thích được; kế toán xử lý trước khi ghi khoản sàn trả', { reason: 'OTHER_NEGATIVE', lineId: l.id, other: toMoney(other) });
      if (!o) throw bad('Dòng đối soát có khoản cộng khác chưa được phân loại; chọn đây là khoản thưởng hay bồi thường mất hàng', { reason: 'OTHER', lineId: l.id, other: toMoney(other) });
      if (!money(o.amount).equals(other)) throw bad('Số tiền của khoản phân loại không khớp dòng đối soát', { reason: 'ADJUSTMENT_AMOUNT', lineId: l.id, other: toMoney(other), amount: o.amount });
      if (o.kind === 'incentive') incentive = incentive.plus(other);
      else if (o.kind === 'carrier_compensation') {
        const cost = money(o.costAmount);
        compensation = compensation.plus(other);
        compensationCost = compensationCost.plus(cost.lessThan(other) ? cost : other);
      }
    }
    const t = taxKind[0];
    if (!t) continue;
    if (input.household) throw bad('Thuế sàn khấu trừ của hộ kinh doanh đi qua 3331 và 3335, không phải khoản khấu trừ nhầm', { reason: 'ADJUSTMENT_HOUSEHOLD', lineId: l.id });
    if (!tax.greaterThan(0)) throw bad('Khoản điều chỉnh nêu một dòng không có thuế sàn đã khấu trừ', { reason: 'ADJUSTMENT_NOTHING', lineId: l.id });
    if (!money(t.amount).equals(tax)) throw bad('Số tiền của khoản phân loại không khớp dòng đối soát', { reason: 'ADJUSTMENT_AMOUNT', lineId: l.id, taxWithheld: toMoney(tax), amount: t.amount });
    taxInError = taxInError.plus(tax);
  }
  return { incentive, compensation, compensationCost, taxInError };
}

// The lines of the entry, from the map's accounts. Nothing is checked about the status here: payoutProposal is the gated entry point.
function payoutProposalLines(
  input: PayoutProposalInput,
  map: Pick<MarketplacePostingMap, 'receivable' | 'feePayable' | 'vatPayable' | 'pitPayable' | 'otherReceivable' | 'costOfGoods' | 'otherIncome'>,
) {
  // Each amount is a decimal string of at most four places; only `other` and `net` may be negative (the table's own checks), so a negative sale or fee must not inflate what is collected.
  for (const l of input.lines) {
    for (const [key, v] of Object.entries(l)) {
      if (key === 'id') continue;
      const pattern = key === 'other' || key === 'net' ? SIGNED : POSITIVE;
      if (typeof v !== 'string' || !pattern.test(v)) throw bad('Số tiền của dòng đối soát không hợp lệ', { amount: String(v) });
    }
  }
  const total = (pick: (l: PayoutPostingLine) => string) => money(toMoney(sum(input.lines.map(pick))));
  const classified = (input.adjustments ?? []).length > 0;
  // Without adjustments the rule is the one of before: the lines' `other` add up to zero (an offsetting pair is no adjustment). With them, every line is checked on its own (classify).
  const other = total((l) => l.other);
  if (!classified && !other.isZero()) throw bad('Kỳ đối soát có khoản điều chỉnh khác chưa giải thích được; kế toán xử lý trước khi ghi khoản sàn trả', { reason: 'OTHER', other: toMoney(other) });
  const kinds = classified ? classify(input) : { incentive: money('0'), compensation: money('0'), compensationCost: money('0'), taxInError: money('0') };
  const classifiedOther = kinds.incentive.plus(kinds.compensation);
  // The adjusted amounts must be exactly the residual they explain: a line missed or counted twice would show here as well as in classify.
  if (classified && !classifiedOther.equals(other)) throw bad('Các khoản đã phân loại không bằng tổng khoản điều chỉnh khác của kỳ đối soát', { reason: 'ADJUSTMENT_SUM', other: toMoney(other), classified: toMoney(classifiedOther) });
  // What the settlement posted to 131 (marketplace-settlement-posting.ts): sales minus seller discounts minus refunds. A payout clears a receivable, so it must be positive.
  const receivable = total((l) => l.sales).minus(total((l) => l.sellerDiscount)).minus(total((l) => l.refund));
  if (!receivable.greaterThan(0)) throw bad('Kỳ đối soát này không để lại khoản phải thu của sàn nên không có khoản sàn trả để ghi', { reason: 'NO_RECEIVABLE' });
  const fees = total((l) => l.commission).plus(total((l) => l.serviceFee)).plus(total((l) => l.paymentFee)).plus(total((l) => l.shipping));
  const tax = total((l) => l.taxWithheld);
  const split = input.taxSplit;
  for (const v of split ? [split.vat, split.pit] : []) if (typeof v !== 'string' || !POSITIVE.test(v)) throw bad('Số thuế đã ghi có khi ghi sổ kỳ đối soát không hợp lệ', { amount: String(v) });
  const taxPosted = split ? money(split.vat).plus(money(split.pit)) : money('0');
  // The withheld tax is cleared by the settlement's credit to 3331 and 3335 (a household) or, classified as withheld in error, by a debit to 1388 (a seller that is no household): never both, never neither.
  if (!taxPosted.plus(kinds.taxInError).equals(tax) || (split !== null && !kinds.taxInError.isZero())) {
    throw bad('Thuế sàn đã khấu trừ không khớp số thuế đã ghi có khi ghi sổ kỳ đối soát; kế toán xử lý trước khi ghi khoản sàn trả', { reason: 'TAX_SPLIT', taxWithheld: toMoney(tax), posted: toMoney(taxPosted) });
  }
  const received = total((l) => l.net);
  if (!received.greaterThan(0)) throw bad('Kỳ đối soát này không có tiền sàn trả về tài khoản ngân hàng', { reason: 'NO_CASH' });
  // The columns of every line add up to its net (a database check), so the split is exact: received + fees + tax = the receivable + the classified other money. A mismatch here is a stored row the checks should have refused.
  if (!received.plus(fees).plus(tax).equals(receivable.plus(classifiedOther))) throw bad('Các cột của kỳ đối soát không cộng ra số tiền ròng; không ghi sổ', { reason: 'SPLIT' });
  const memo = `${input.platform} ${input.periodFrom} đến ${input.periodTo}`;
  const lines: ProposedJournalLine[] = [{ account: input.cashAccount, debit: toMoney(received), credit: '0', partyId: null, memo }];
  if (fees.greaterThan(0)) lines.push({ account: map.feePayable.code, debit: toMoney(fees), credit: '0', partyId: input.partyId, memo });
  if (split && money(split.vat).greaterThan(0)) lines.push({ account: map.vatPayable.code, debit: toMoney(money(split.vat)), credit: '0', partyId: null, memo });
  if (split && money(split.pit).greaterThan(0)) lines.push({ account: map.pitPayable.code, debit: toMoney(money(split.pit)), credit: '0', partyId: null, memo });
  // Tax withheld from a seller that is no household: not a prepayment of its tax, a receivable from the platform (research rule 4; Uncertain (#2520): the refund may come from the tax office).
  if (kinds.taxInError.greaterThan(0)) lines.push({ account: map.otherReceivable.code, debit: toMoney(kinds.taxInError), credit: '0', partyId: input.partyId, memo: `${memo}${WITHHELD_IN_ERROR_MEMO_SUFFIX}` });
  lines.push({ account: map.receivable.code, debit: '0', credit: toMoney(receivable), partyId: input.partyId, memo });
  // Money the platform paid beyond the sales (#4303 S4): an incentive is other income; a compensation reduces the cost of goods already booked, up to the cost the person stated, and the rest is other income.
  // Below cost the shortfall stays a loss in 632 by itself: no line. The compensation is netted with its receipt here, so it never touches 1388 (research rule 2, direct route; 1381 is not used).
  if (kinds.incentive.greaterThan(0)) lines.push({ account: map.otherIncome.code, debit: '0', credit: toMoney(kinds.incentive), partyId: null, memo: `${memo}, khoản thưởng của sàn` });
  if (kinds.compensationCost.greaterThan(0)) lines.push({ account: map.costOfGoods.code, debit: '0', credit: toMoney(kinds.compensationCost), partyId: null, memo: `${memo}, bồi thường mất hàng, giảm giá vốn` });
  const excess = kinds.compensation.minus(kinds.compensationCost);
  if (excess.greaterThan(0)) lines.push({ account: map.otherIncome.code, debit: '0', credit: toMoney(excess), partyId: null, memo: `${memo}, bồi thường vượt giá vốn` });
  return {
    lines,
    receivable: toMoney(receivable),
    received: toMoney(received),
    fees: toMoney(fees),
    tax: toMoney(tax),
    incentive: toMoney(kinds.incentive),
    compensation: toMoney(kinds.compensation),
    compensationCost: toMoney(kinds.compensationCost),
    taxInError: toMoney(kinds.taxInError),
  };
}

// The gated proposal: the map of the regime must be confirmed, there must be a receivable to clear and money received, and the entry must pass the journal voucher's own shape checks. The party of the
// 131 and 331 lines may still be null here (the caller reads it from the platform's link), so that one problem is not raised for it; the party link is checked when the entry is recorded.
export function payoutProposal(input: PayoutProposalInput, maps?: Readonly<Record<string, MarketplacePostingMap>>): PayoutProposal {
  // The household tax rows only when the settlement posted tax lines (taxSplit): the payout then debits exactly what they credited. The adjustment rows only when a person classified lines (#4303 S4).
  const map = requireConfirmedMarketplaceMap(input.regime, maps, payoutPaths(input.taxSplit !== null, (input.adjustments ?? []).length > 0));
  const built = payoutProposalLines(input, map);
  // The platform's party stands on 131 and 331, and on 1388 when the withheld tax of a seller that is no household is debited there.
  const needing = new Set([map.receivable.code, map.feePayable.code, ...(built.taxInError === '0' ? [] : [map.otherReceivable.code])]);
  const problems = journalVoucherProblems(built.lines.map((l) => ({ ...l, partyId: l.partyId ?? (needing.has(l.account) ? 'pending' : null) })));
  if (problems.length > 0) throw new DomainError('MARKETPLACE_PAYOUT_NOT_POSTABLE', 422, 'Bút toán của khoản sàn trả không hợp lệ', { problems });
  return {
    description: `Sàn trả ${input.platform} ${input.periodFrom} đến ${input.periodTo}`.slice(0, 500),
    receivable: built.receivable,
    received: built.received,
    fees: built.fees,
    taxWithheld: built.tax,
    lines: built.lines,
    total: journalVoucherTotal(built.lines),
    incentive: built.incentive,
    compensation: built.compensation,
    compensationCost: built.compensationCost,
    taxInError: built.taxInError,
  };
}

// The paths a payout asks the account map for: the payout itself, the household tax rows when the settlement posted tax lines, and the adjustment rows when a person classified lines (#4303 S4).
export function payoutPaths(householdTax: boolean, adjusted: boolean): MarketplacePath[] {
  return ['payout', ...(householdTax ? (['household_tax'] as const) : []), ...(adjusted ? (['payout_adjustments'] as const) : [])];
}
