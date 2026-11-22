// SPDX-License-Identifier: AGPL-3.0-only
// The month-close checklist's pure helpers: the months the picker offers, and the order the card shows the items in. The items and their counts come from the books
// (finance.month_close); the coworker's order is only used when it is exactly the open items, so a wrong answer can never hide or add an item.
import { MONTH_CLOSE_ITEMS, vietnamMonth, type MonthCloseItem, type MonthCloseKey } from '@ludy/kernel-contract';

// The items that count things (a number is shown); the others are a yes or no (the stock close, the VAT mark, the period lock).
export const COUNTED_ITEMS: readonly MonthCloseKey[] = ['proposals', 'invoices', 'bank', 'marketplace'];

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (year: number, month: number) => `${year}-${pad(month)}`;

// The months the picker offers, newest first: the month of `today` in Vietnam (the books' own clock, as the server's) and the 11 before it.
export function closeMonths(today: Date): string[] {
  const out: string[] = [];
  const [thisYear, thisMonth] = vietnamMonth(today).split('-').map(Number) as [number, number];
  let year = thisYear;
  let month = thisMonth;
  for (let i = 0; i < 12; i += 1) {
    out.push(keyOf(year, month));
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

// The month a close is normally for: the calendar month before `today`.
export function defaultCloseMonth(today: Date): string {
  return closeMonths(today)[1] as string;
}

// The items as the card shows them: the open ones first, in the coworker's order when it is exactly the open keys (else the fixed order), then the done ones in the fixed order.
export function orderItems(items: readonly MonthCloseItem[], order: readonly MonthCloseKey[]): MonthCloseItem[] {
  const fixed = MONTH_CLOSE_ITEMS.flatMap((key) => items.filter((item) => item.key === key));
  const open = fixed.filter((item) => item.count > 0);
  const done = fixed.filter((item) => item.count === 0);
  const valid = order.length === open.length && new Set(order).size === order.length && open.every((item) => order.includes(item.key));
  const sorted = valid ? order.flatMap((key) => open.filter((item) => item.key === key)) : open;
  return [...sorted, ...done];
}
