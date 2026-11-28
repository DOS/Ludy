// SPDX-License-Identifier: AGPL-3.0-only
// The occurrences of the items an owner entered into the 90-day cash forecast (#5326) as pure functions: nothing here reads the database. An item is entered once (a date) or repeats (monthly or
// quarterly from its first date); the forecast needs the dates on which it falls inside its window, and the list the next one.
//
// The rules (the design is on #5326):
// - once: on the first date. monthly: the day of the first date each month; quarterly: the same every third month. A month too short for that day uses its last day, and the next month goes back to the
//   original day (a 31st is the 28th (29th) of February and the 31st of March again: the day never drifts, every occurrence is counted from the first date, not from the one before).
// - The end date is inclusive and nothing falls after it. An occurrence before day 0 is ignored (no catch-up of a missed one-off); the window is day 0 to day CASH_FORECAST_DAYS, both inclusive.
// - Dates are YYYY-MM-DD strings, compared as strings; no JS number is an amount. At most a few occurrences fall in a window of 91 days (four a month-by-month item, two a quarterly one), so the
//   loop is bounded.
import { CASH_FORECAST_DAYS, type CashForecastEnteredRecurrence } from '@ludy/kernel-contract';
import { addDays } from './payment-reminder.ts';

export interface RepeatingItem {
  firstDate: string;
  recurrence: CashForecastEnteredRecurrence;
  // Inclusive; null for no end (always null for a one-off).
  endDate: string | null;
}

const STEP_MONTHS: Readonly<Record<CashForecastEnteredRecurrence, number>> = { once: 0, monthly: 1, quarterly: 3 };

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
const two = (n: number): string => String(n).padStart(2, '0');

// The nth occurrence (0 is the first date) of a repeating item, counted from the first date: the first date's day in the month `n * step` months on, clamped to that month's last day.
function nthOccurrence(firstDate: string, stepMonths: number, n: number): string {
  const year = Number(firstDate.slice(0, 4));
  const month = Number(firstDate.slice(5, 7));
  const day = Number(firstDate.slice(8, 10));
  const index = year * 12 + (month - 1) + n * stepMonths;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${String(y).padStart(4, '0')}-${two(m)}-${two(Math.min(day, daysInMonth(y, m)))}`;
}

// The dates on which the item falls from `today` to day CASH_FORECAST_DAYS, oldest first. An item whose first date is after the window, or whose end date is before day 0, has none.
export function occurrencesOf(item: RepeatingItem, today: string, days: number = CASH_FORECAST_DAYS): string[] {
  const last = addDays(today, days);
  const endsOn = item.endDate !== null && item.endDate < last ? item.endDate : last;
  if (item.recurrence === 'once') return item.firstDate >= today && item.firstDate <= endsOn ? [item.firstDate] : [];
  const step = STEP_MONTHS[item.recurrence];
  // Start near day 0 instead of at a first date years back: the nth occurrence of month distance m is at n = m / step, so begin one step early and walk forward.
  const monthsBack = (Number(today.slice(0, 4)) - Number(item.firstDate.slice(0, 4))) * 12 + (Number(today.slice(5, 7)) - Number(item.firstDate.slice(5, 7)));
  let n = Math.max(0, Math.floor(monthsBack / step) - 1);
  const dates: string[] = [];
  for (;;) {
    const date = nthOccurrence(item.firstDate, step, n);
    if (date > endsOn) break;
    if (date >= today) dates.push(date);
    n += 1;
  }
  return dates;
}

// The next date on or after day 0 within the window, or null (finished, or none before day CASH_FORECAST_DAYS).
export function nextOccurrence(item: RepeatingItem, today: string, days: number = CASH_FORECAST_DAYS): string | null {
  return occurrencesOf(item, today, days)[0] ?? null;
}
