// SPDX-License-Identifier: AGPL-3.0-only
// The year-end checklist's pure helpers: the years the picker offers, the year it opens on, and the order the card shows the items in. The states and the due dates come from the books and the tax
// calendar (finance.year_end); the coworker's order is only used when it is exactly the open items that can be done now, so a wrong answer can never hide or add an item.
import { YEAR_END_ITEMS, vietnamMonth, type YearEndItem, type YearEndKey } from '@ludy/kernel-contract';

// The items that count things (a number is shown); the others are a state.
export const COUNTED_ITEMS: readonly YearEndKey[] = ['balances', 'depreciation'];

const vietnamYearMonth = (today: Date): [number, number] => vietnamMonth(today).split('-').map(Number) as [number, number];

// The years the picker offers, newest first: the year of `today` in Vietnam (the books' own clock, as the server's) and the 3 before it.
export function closeYears(today: Date): number[] {
  const [year] = vietnamYearMonth(today);
  return [year, year - 1, year - 2, year - 3];
}

// The year a year-end is normally for: the current year from October on (the year is about to close), otherwise the year before.
export function defaultCloseYear(today: Date): number {
  const [year, month] = vietnamYearMonth(today);
  return month >= 10 ? year : year - 1;
}

// An item a person can do now: open and not waiting for the year to end.
export const isReady = (item: YearEndItem): boolean => item.state === 'open' && !item.waiting;

// The items as the card shows them: the ones to do now first, in the coworker's order when it is exactly their keys (else the fixed order), then the ones that wait for the year to end, then the
// done ones, then the ones that do not apply, each group in the fixed order.
export function orderYearEndItems(items: readonly YearEndItem[], order: readonly YearEndKey[]): YearEndItem[] {
  const fixed = YEAR_END_ITEMS.flatMap((key) => items.filter((item) => item.key === key));
  const ready = fixed.filter(isReady);
  const valid = order.length === ready.length && new Set(order).size === order.length && ready.every((item) => order.includes(item.key));
  const sorted = valid ? order.flatMap((key) => ready.filter((item) => item.key === key)) : ready;
  return [...sorted, ...fixed.filter((i) => i.state === 'open' && i.waiting), ...fixed.filter((i) => i.state === 'done'), ...fixed.filter((i) => i.state === 'na')];
}
