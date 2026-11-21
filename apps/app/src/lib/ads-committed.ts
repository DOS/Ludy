// SPDX-License-Identifier: AGPL-3.0-only
// What the committed-spend line of the Ads screen says for the server's figures (#3297): which of the three states it is in, and for each scope
// whether the room left went below zero. No arithmetic on money here: the server worked every amount out in decimal, and the screen only reads the
// sign of a decimal string.
import type { AdsCommitted, AdsCommittedLine } from '@ludy/kernel-contract';
import { isZeroAmount } from './decimal.ts';

// A decimal string below zero, in any spelling of zero ("-0.00" is not below zero).
export const isBelowZero = (value: string): boolean => value.trim().startsWith('-') && !isZeroAmount(value);

export interface CommittedRow {
  scope: 'account' | 'org';
  committed: string;
  // The monthly cap of the scope and the room left under it; null when the scope has no monthly cap.
  cap: string | null;
  left: string | null;
  // A cap was lowered under what is committed: shown as the amount over it, never as a negative room.
  over: string | null;
}

export type CommittedView =
  // No cap of any kind in force in the currency: every launch is refused until the owner or an admin sets one.
  | { kind: 'noCap'; committed: string }
  // A cap in another currency than the account's: every launch is refused until the caps match (the currency is what must change, not a missing cap).
  | { kind: 'capCurrency'; committed: string }
  | { kind: 'rows'; rows: CommittedRow[] };

const row = (scope: CommittedRow['scope'], line: AdsCommittedLine): CommittedRow => {
  const below = line.left !== null && isBelowZero(line.left);
  return { scope, committed: line.committed, cap: line.cap, left: below ? null : line.left, over: below && line.left !== null ? line.left.slice(1) : null };
};

// The account's own line always; the org's only when it says something more (an org cap, or launches of other accounts that the org's cap counts).
export function committedView(data: AdsCommitted): CommittedView {
  if (data.capCurrencyMismatch) return { kind: 'capCurrency', committed: data.account.committed };
  if (!data.hasCap) return { kind: 'noCap', committed: data.account.committed };
  const rows = [row('account', data.account)];
  if (data.org.cap !== null || data.org.committed !== data.account.committed) rows.push(row('org', data.org));
  return { kind: 'rows', rows };
}
