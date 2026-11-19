// SPDX-License-Identifier: AGPL-3.0-only
// The 1381 rule at the close of a month of stock (#3712 slice 3, research C3 of 2026-11-18, accounting-rules-research-2026-11-18.md): under Circular 99 a balance on 1381 (goods waiting to be
// resolved: a count's shortage beyond the norm) with no evidence of its cause is expensed at the reporting date, so closing a month with such a balance deserves a warning. Under Circular 133
// the research names no such rule. Pure, decimal.js; the warning never blocks a close.
import { money } from '@crove/l10n-vn';

export const WAITING_SHORTAGE_ACCOUNT = '1381';

// Debit minus credit of the account's lines, whole dong as a plain decimal string ('0' for none or a credit balance's absolute zero).
export function balanceOf(lines: ReadonlyArray<{ debit: string; credit: string }>): string {
  let sum = money(0);
  for (const l of lines) sum = sum.plus(money(l.debit)).minus(money(l.credit));
  const text = sum.toDecimalPlaces(0).toFixed();
  return text === '-0' ? '0' : text;
}

// Whether the warning applies: Circular 99 books with a debit balance on 1381 (a credit balance is something else and gets none).
export function closeCheckApplies(regime: string, balance1381: string): boolean {
  return regime === 'tt99' && money(balance1381).greaterThan(0);
}
