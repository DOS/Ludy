// SPDX-License-Identifier: AGPL-3.0-only
// The bank screen's clean group and the review page of matched lines (#2385): what asking for one clean line sends, the
// words that say why a line matched or why it needs a look, and how a batch's results read. No React imports, so it is
// unit tested. The grouping itself is the server's (finance.bank.match_groups); nothing here decides a match.
import type { BankMatchLine, BankMatchedBy, BankMatchReason, CashVoucherRequest } from '@crove/kernel-contract';
import type { BulkResult } from './review.ts';

// What kernel.proposal.request takes for a clean line: the voucher the line makes with the party and invoice the matcher
// found, marked as the matcher's suggestion so the review page can say how the party was found. The server checks the mark
// against the matcher before it keeps it.
export function voucherRequestOf(item: BankMatchLine, legalEntityId: string | undefined): CashVoucherRequest | null {
  const voucher = item.voucher;
  const suggested = item.suggested;
  if (item.group !== 'clean' || !voucher || !suggested) return null;
  return {
    type: voucher.type,
    date: voucher.date,
    cashAccount: item.bankAccount,
    partyId: suggested.party.id,
    description: voucher.description,
    lines: [{ account: voucher.counterAccount, amount: voucher.amount }],
    bankLineId: item.line.id,
    matchedBy: { kind: 'ly', reason: suggested.reason, ...(suggested.invoice ? { invoice: suggested.invoice } : {}) },
    ...(legalEntityId ? { legalEntityId } : {}),
  };
}

// How a party was found, as a tag the screen turns into words (`bank.match.reason.<tag>`): the tax code in the transfer text
// (with the invoice the amount settles when there is one), the invoice number, the name, or an open balance equal to the
// amount.
export type ReasonTag = 'taxCodeInvoice' | 'taxCode' | 'invoice' | 'name' | 'balance' | 'none';

export function reasonTag(by: { reason?: BankMatchReason | undefined; invoice?: { number: string } | undefined }): { tag: ReasonTag; number: string } {
  const number = by.invoice?.number ?? '';
  switch (by.reason) {
    case 'tax_code':
      return { tag: by.invoice ? 'taxCodeInvoice' : 'taxCode', number };
    case 'invoice':
      return { tag: 'invoice', number };
    case 'name':
      return { tag: 'name', number };
    case 'balance':
      return { tag: 'balance', number };
    default:
      return { tag: 'none', number };
  }
}

// How a match is shown on the review page: the matcher's suggestion with its reason, the person's own choice, or nothing
// for a voucher made before the match was recorded.
export type MatchedByTag = { tag: 'unknown'; number: '' } | { tag: 'manual'; number: '' } | { tag: 'reason'; reason: ReasonTag; number: string };

export function matchedByTag(by: BankMatchedBy | null): MatchedByTag {
  if (by === null) return { tag: 'unknown', number: '' };
  if (by.kind === 'manual') return { tag: 'manual', number: '' };
  const found = reasonTag(by);
  return { tag: 'reason', reason: found.tag, number: found.number };
}

export interface ApprovalSummary {
  approved: number;
  refused: Array<{ id: string; code: string; rule: string | null }>;
}

// A batch's results, as the screen reports them: how many vouchers were approved and posted, and each one the server
// refused with its code (four-eyes, a locked period, a line settled meanwhile ...). A refused voucher posts nothing and stays
// a proposal in the Inbox.
export function summarizeApproval(results: readonly BulkResult[]): ApprovalSummary {
  const summary: ApprovalSummary = { approved: 0, refused: [] };
  for (const r of results) {
    if (r.outcome === 'approved') summary.approved += 1;
    else summary.refused.push({ id: r.id, code: r.code, rule: r.rule });
  }
  return summary;
}

// The codes that mean the person asking is not the one who may approve under the org's policy (a second approver is
// needed), so the screen says why nothing was posted instead of a bare refusal.
export const SECOND_APPROVER_CODES: readonly string[] = ['FOUR_EYES_REQUIRED', 'NOT_ELIGIBLE'];
export const needsSecondApprover = (summary: ApprovalSummary): boolean => summary.refused.some((r) => SECOND_APPROVER_CODES.includes(r.code));
