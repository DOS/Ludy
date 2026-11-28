// SPDX-License-Identifier: AGPL-3.0-only
// The last day of a tax filing or payment deadline that falls on a day off is the next working day (Decree 252/2026/NĐ-CP,
// Article 3(7), from 2026-07-01; before that the Civil Code 2015, Article 148(5)). A day off is a Saturday, a Sunday, a
// Vietnamese public holiday of the shared calendar (holidays.ts: the fixed dates every year, and Tết and the Hùng Kings day for
// the years of its lunar table; a year beyond the table has the fixed ones only) or the compensatory day of a holiday that fell on a
// Saturday or a Sunday (Labor Code 45/2019/QH14, Article 111(3): the next working day is off; 1 May 2027 is a Saturday, so Monday
// 3 May 2027 is off and a deadline on 30 April 2027 is Tuesday 4 May). The government also sets the day next to 2 September, swapped
// working days and Tết days by decision each year (Article 112(3)), and the calendar does not carry those, so a day it lacks counts
// as a working day and the date shown is earlier than the real one, which is the safe side. The table for 2027 is uncertain until the
// accountant confirms it (#2520): a day it lists wrongly shows a date later than the real one.
// Dates are calendar dates (YYYY-MM-DD) in Vietnam time.
import { isCompensatoryDayOff, isVietnamHoliday } from './holidays.ts';

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function parseDate(text: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`not a calendar date: ${text}`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || iso(date) !== text) throw new Error(`not a calendar date: ${text}`);
  return date;
}

/** True when the day is a Saturday, a Sunday, a public holiday of the shared calendar or the compensatory day of one that fell on a weekend. */
export function isDayOff(date: string): boolean {
  const weekday = parseDate(date).getUTCDay();
  return weekday === 0 || weekday === 6 || isVietnamHoliday(date) || isCompensatoryDayOff(date);
}

/** The date itself when it is a working day, otherwise the next working day after it. */
export function onOrAfterWorkingDay(date: string): string {
  let day = parseDate(date);
  while (isDayOff(iso(day))) day = new Date(day.getTime() + DAY_MS);
  return iso(day);
}
