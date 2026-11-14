// SPDX-License-Identifier: AGPL-3.0-only
// The proposed entry of a platform's payout (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"), as pure functions over decimal strings, built from the
// lines of a stored settlement and nothing else: ONE entry per settlement, Dr cash (the bank account of the transfer) for the money received, Dr 1388 for the platform's fees (their invoice has
// not come, so they wait there until the fee e-invoice clears them, a later slice), Dr 333 for the tax the platform withheld and settled for the seller, Cr 131 (the platform) for what the settlement
// posted there: sales minus the seller discounts minus the refunds (marketplace-settlement-posting.ts). The three debits add up to the credit only when the lines carry no other adjustment, so a
// settlement with one is refused, never balanced by a guessed line: the accountant explains it first.
// Nothing posts until the accountant has confirmed the account map (requireConfirmedMarketplaceMap).
import { DomainError } from '@crove/kernel-runtime';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { journalVoucherProblems, journalVoucherTotal } from './domain/journal-voucher.ts';
import { requireConfirmedMarketplaceMap, type MarketplacePostingMap } from './marketplace-posting-map.ts';
import type { ProposedJournalLine } from './marketplace-settlement-posting.ts';

export interface PayoutPostingLine {
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
  // The platform's party (crove_finance.marketplace_party): the settlement's posting created it, so a payout of a posted settlement has one.
  partyId: string | null;
  // The ledger account of the bank account that received the transfer (the bank line's own account).
  cashAccount: string;
  lines: readonly PayoutPostingLine[];
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
}

const bad = (reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_PAYOUT_NOT_POSTABLE', 422, reason, extra);

const POSITIVE = /^\d+(\.\d{1,4})?$/;
const SIGNED = /^-?\d+(\.\d{1,4})?$/;

// The lines of the entry, from the map's accounts. Nothing is checked about the status here: payoutProposal is the gated entry point.
function payoutProposalLines(input: PayoutProposalInput, map: Pick<MarketplacePostingMap, 'receivable' | 'feeAwaitingInvoice' | 'taxWithheld'>) {
  // Each amount is a decimal string of at most four places; only `other` and `net` may be negative (the table's own checks), so a negative sale or fee must not inflate what is collected.
  for (const l of input.lines) {
    for (const [key, v] of Object.entries(l)) {
      const pattern = key === 'other' || key === 'net' ? SIGNED : POSITIVE;
      if (typeof v !== 'string' || !pattern.test(v)) throw bad('Số tiền của dòng đối soát không hợp lệ', { amount: String(v) });
    }
  }
  const total = (pick: (l: PayoutPostingLine) => string) => money(toMoney(sum(input.lines.map(pick))));
  const other = total((l) => l.other);
  if (!other.isZero()) throw bad('Kỳ đối soát có khoản điều chỉnh khác chưa giải thích được; kế toán xử lý trước khi ghi khoản sàn trả', { reason: 'OTHER', other: toMoney(other) });
  // What the settlement posted to 131 (marketplace-settlement-posting.ts): sales minus seller discounts minus refunds. A payout clears a receivable, so it must be positive.
  const receivable = total((l) => l.sales).minus(total((l) => l.sellerDiscount)).minus(total((l) => l.refund));
  if (!receivable.greaterThan(0)) throw bad('Kỳ đối soát này không để lại khoản phải thu của sàn nên không có khoản sàn trả để ghi', { reason: 'NO_RECEIVABLE' });
  const fees = total((l) => l.commission).plus(total((l) => l.serviceFee)).plus(total((l) => l.paymentFee)).plus(total((l) => l.shipping));
  const tax = total((l) => l.taxWithheld);
  const received = total((l) => l.net);
  if (!received.greaterThan(0)) throw bad('Kỳ đối soát này không có tiền sàn trả về tài khoản ngân hàng', { reason: 'NO_CASH' });
  // The columns of every line add up to its net (a database check), so the split is exact: received + fees + tax = the receivable. A mismatch here is a stored row the checks should have refused.
  if (!received.plus(fees).plus(tax).equals(receivable)) throw bad('Các cột của kỳ đối soát không cộng ra số tiền ròng; không ghi sổ', { reason: 'SPLIT' });
  const memo = `${input.platform} ${input.periodFrom} đến ${input.periodTo}`;
  const lines: ProposedJournalLine[] = [{ account: input.cashAccount, debit: toMoney(received), credit: '0', partyId: null, memo }];
  if (fees.greaterThan(0)) lines.push({ account: map.feeAwaitingInvoice.code, debit: toMoney(fees), credit: '0', partyId: input.partyId, memo });
  if (tax.greaterThan(0)) lines.push({ account: map.taxWithheld.code, debit: toMoney(tax), credit: '0', partyId: null, memo });
  lines.push({ account: map.receivable.code, debit: '0', credit: toMoney(receivable), partyId: input.partyId, memo });
  return { lines, receivable: toMoney(receivable), received: toMoney(received), fees: toMoney(fees), tax: toMoney(tax) };
}

// The gated proposal: the map of the regime must be confirmed, there must be a receivable to clear and money received, and the entry must pass the journal voucher's own shape checks. The party of the
// 131 and 1388 lines may still be null here (the caller reads it from the platform's link), so that one problem is not raised for it; the party link is checked when the entry is recorded.
export function payoutProposal(input: PayoutProposalInput, maps?: Readonly<Record<string, MarketplacePostingMap>>): PayoutProposal {
  const map = requireConfirmedMarketplaceMap(input.regime, maps);
  const built = payoutProposalLines(input, map);
  const needing = new Set([map.receivable.code, map.feeAwaitingInvoice.code]);
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
  };
}
