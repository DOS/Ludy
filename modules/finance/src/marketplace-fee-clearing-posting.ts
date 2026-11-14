// SPDX-License-Identifier: AGPL-3.0-only
// The proposed entry of the clearing of a platform's waiting fees by its fee e-invoice (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4 "The payout" and section 11), as
// pure functions over decimal strings. A payout put the platform's fees on 1388 (they had no invoice); the platform's fee invoice was posted as a purchase document (Dr expense, Dr 1331, Cr 331, the
// platform as the supplier). The clearing is ONE entry that moves what the invoice covers from one to the other: Dr 331 / Cr 1388, the platform's party on both lines.
// The amount is the smaller of what the invoice still has to clear (its credit to 331 less its standing clearings: an invoice may be cleared more than once, never beyond its credit) and the platform's
// 1388 balance (so 1388 never goes below zero and a second invoice for the same fees clears only what waits). Nothing posts until the accountant has confirmed the account map.
import { DomainError } from '@crove/kernel-runtime';
import { money, toMoney } from '@crove/l10n-vn';
import { journalVoucherProblems, journalVoucherTotal } from './domain/journal-voucher.ts';
import { requireConfirmedMarketplaceMap, type MarketplacePostingMap } from './marketplace-posting-map.ts';
import type { ProposedJournalLine } from './marketplace-settlement-posting.ts';

export interface FeeClearingInput {
  regime: string;
  platform: string;
  // The invoice's own number, for the description (series and number as the document holds them).
  invoice: string;
  // The platform's party: the invoice's supplier, linked through crove_finance.marketplace_party.
  partyId: string | null;
  // The invoice's posted credit to 331, what its standing clearings took already, and the platform's balance on 1388.
  invoiceTotal: string;
  alreadyCleared: string;
  waiting: string;
}

export interface FeeClearingProposal {
  description: string;
  invoiceTotal: string;
  alreadyCleared: string;
  waiting: string;
  amount: string;
  lines: ProposedJournalLine[];
  total: string;
}

const nothing = (reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_FEE_NOTHING_TO_CLEAR', 409, 'Chưa có phí nào của sàn đang chờ hóa đơn, hoặc hóa đơn này đã cấn trừ hết phần của mình', { reason, ...extra });

const DECIMAL = /^\d+(\.\d{1,4})?$/;

// The gated proposal: the map of the regime must be confirmed, the amounts decimals, there must be something to clear, and the entry must pass the journal voucher's own shape checks. The party may
// still be null here (the caller reads it from the platform's link), so that one problem is not raised for it.
export function feeClearingProposal(input: FeeClearingInput, maps?: Readonly<Record<string, MarketplacePostingMap>>): FeeClearingProposal {
  const map = requireConfirmedMarketplaceMap(input.regime, maps);
  for (const v of [input.invoiceTotal, input.alreadyCleared, input.waiting]) {
    if (typeof v !== 'string' || !DECIMAL.test(v)) throw new DomainError('MARKETPLACE_FEE_DOCUMENT', 422, 'Số tiền của hóa đơn phí không hợp lệ', { amount: String(v) });
  }
  const remaining = money(input.invoiceTotal).minus(money(input.alreadyCleared));
  // The invoice has cleared its share (or more, which the command's cap makes impossible: refused all the same).
  if (!remaining.greaterThan(0)) throw nothing('INVOICE_CLEARED');
  if (!money(input.waiting).greaterThan(0)) throw nothing('NOTHING_WAITING');
  const amount = toMoney(remaining.lessThan(money(input.waiting)) ? remaining : money(input.waiting));
  const memo = `${input.platform} hóa đơn ${input.invoice}`;
  const lines: ProposedJournalLine[] = [
    { account: map.feePayable.code, debit: amount, credit: '0', partyId: input.partyId, memo },
    { account: map.feeAwaitingInvoice.code, debit: '0', credit: amount, partyId: input.partyId, memo },
  ];
  const problems = journalVoucherProblems(lines.map((l) => ({ ...l, partyId: l.partyId ?? 'pending' })));
  if (problems.length > 0) throw new DomainError('MARKETPLACE_FEE_DOCUMENT', 422, 'Bút toán cấn trừ phí không hợp lệ', { problems });
  return {
    description: `Cấn trừ phí ${input.platform} theo hóa đơn ${input.invoice}`.slice(0, 500),
    invoiceTotal: toMoney(money(input.invoiceTotal)),
    alreadyCleared: toMoney(money(input.alreadyCleared)),
    waiting: toMoney(money(input.waiting)),
    amount,
    lines,
    total: journalVoucherTotal(lines),
  };
}
