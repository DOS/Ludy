// SPDX-License-Identifier: AGPL-3.0-only
// The ads module's pure rules (plan docs/plan/ads.md sections 5.2 and 7): calendar days in an account's own time zone,
// the window a sync reads and the day before which every day is final, and the cost per result. No database and no
// network here. Money is a decimal string and every sum goes through decimal.js (AGENTS.md "Money").
import { Decimal } from 'decimal.js';
import { ADS_BACKFILL_MONTHS, zonedDate } from '@crove/kernel-contract';

const DAY_MS = 86_400_000;

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (day: string, days: number): string => isoDay(dayMs(day) + days * DAY_MS);

// A calendar month back or forward, clamped to the last day of a shorter month (31 March less one month is 28 February).
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// Today in the account's time zone, as the platform's days are bounded.
export const todayIn = (timeZone: string, now: Date): string => zonedDate(timeZone, now.getTime());

// The first day of history a new account reads, and the day before which history is dropped: 13 months back.
export const historyStart = (today: string): string => addMonths(today, -ADS_BACKFILL_MONTHS);

// The days a sync reads: from the day after the last final one (or the start of history) to today. A settled day is not
// read again; a day past it is read again each time, since the platform may restate it.
export function syncWindow(input: { today: string; backfillFrom: string; settledThrough: string | null }): { from: string; to: string } {
  const next = input.settledThrough === null ? input.backfillFrom : addDays(input.settledThrough, 1);
  const from = next < input.backfillFrom ? input.backfillFrom : next;
  return { from: from > input.today ? input.today : from, to: input.today };
}

// The day before which every day is final: the platform's revision window back from today (days strictly before it are
// settled). Null for a platform that declares none.
export const settleBefore = (today: string, revisionDays: number | null): string | null => (revisionDays === null ? null : addDays(today, -revisionDays));

// The settled day after a read of [from, to] when days before `settleBefore` are final: the last of them the read covers,
// and only when the read began on the day after the last one already settled (a gap before it leaves that day unread).
export function nextSettledThrough(input: { current: string | null; backfillFrom: string; window: { from: string; to: string }; settleBefore: string | null }): string | null {
  if (input.settleBefore === null) return input.current;
  const expected = input.current === null ? input.backfillFrom : addDays(input.current, 1);
  if (input.window.from > expected) return input.current;
  const before = addDays(input.settleBefore, -1);
  const last = before < input.window.to ? before : input.window.to;
  // Nothing of this read is final yet, or nothing new is.
  if (last < input.window.from || (input.current !== null && last <= input.current)) return input.current;
  return last;
}

// The decimals of a currency's smallest unit (0 for the dong, 2 for the dollar), as the runtime's Intl knows them.
export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

// Spend over results, rounded to the currency's smallest unit; null when there is no result (never zero). Half up.
export function costPerResult(spend: Decimal.Value, results: Decimal.Value | null, currency: string | null): string | null {
  if (results === null) return null;
  const count = new Decimal(results);
  if (!count.gt(0)) return null;
  const places = currency === null ? 2 : currencyDecimals(currency);
  return new Decimal(spend).div(count).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}

// Spend as text in the currency's own number of decimals.
export function spendText(spend: Decimal.Value, currency: string | null): string {
  const places = currency === null ? 2 : currencyDecimals(currency);
  return new Decimal(spend).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}

// A count of results as text, without a trailing zero decimal.
export const resultsText = (results: Decimal.Value): string => new Decimal(results).toDecimalPlaces(4).toFixed();
