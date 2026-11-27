// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of the unusual entries card on the Kế toán Tổng quan (#5182): which sentence a hit's detail reads as, the account as text, who may mark a hit as reviewed and where a coworker's note belongs. The
// server decides every hit and every figure; nothing here reads or writes.
import { unusualEntryHitKey, type UnusualEntryHit } from '@ludy/kernel-contract';

export type DetailKind = 'duplicate' | 'control' | 'amount' | 'newParty' | 'newKind' | 'weekend' | 'holiday';

/** Which detail sentence a hit reads as: one per rule, and for a new account or a day off, the basis or the kind of day. */
export function detailKind(hit: Pick<UnusualEntryHit, 'rule' | 'basis' | 'day'>): DetailKind {
  switch (hit.rule) {
    case 'duplicate_invoice':
      return 'duplicate';
    case 'control_manual':
      return 'control';
    case 'amount_outlier':
      return 'amount';
    case 'new_account':
      return hit.basis === 'kind' ? 'newKind' : 'newParty';
    case 'off_day':
      return hit.day === 'holiday' ? 'holiday' : 'weekend';
  }
}

/** The account line as the card writes it: its code and, when the chart has one, its name. */
export function accountText(hit: Pick<UnusualEntryHit, 'accountCode' | 'accountName'>): string {
  if (hit.accountCode === null) return '';
  return hit.accountName ? `${hit.accountCode} ${hit.accountName}` : hit.accountCode;
}

/** Only owners, admins and members mark a hit as reviewed (finance.unusual_entries.review); viewers only read. */
export function canReviewEntries(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}

/** The coworker's note for a hit, by the hit's key, or undefined (none at all with AI off). */
export function noteFor(notes: ReadonlyArray<{ key: string; text: string }>, hit: Pick<UnusualEntryHit, 'rule' | 'entryId'>): string | undefined {
  const key = unusualEntryHitKey(hit.rule, hit.entryId);
  return notes.find((n) => n.key === key)?.text;
}
