// When an org's VAT return is due (issue #318), for the multi-client home screen. Vietnam rules (Law on Tax
// Administration 38/2019/QH14, Article 44(1)): a monthly return is due on the 20th of the following month; a quarterly
// return on the last day of the first month of the following quarter (from 2026-07-01 Decree 252/2026/NĐ-CP, Article 10(2)
// and (3), the same dates). When that day is a Saturday, a Sunday or a public holiday the deadline moves to the next working
// day (Decree 252/2026/NĐ-CP, Article 3(7); deadline-day.ts).
//
// Dates are calendar dates (YYYY-MM-DD) in Vietnam time (UTC+7, no daylight saving).
import { onOrAfterWorkingDay } from './deadline-day.ts';

export const VAT_FILING_PERIODS = ['month', 'quarter'] as const;
export type VatFilingPeriod = (typeof VAT_FILING_PERIODS)[number];

export interface VatDeadline {
  // The period the return covers: "2026-09" for a month, "2026-Q3" for a quarter (the VAT working's period key).
  period: string;
  // The day the return is due, after the day-off rule.
  dueDate: string;
  // Whole days from today to dueDate; 0 on the day itself.
  daysLeft: number;
}

const DAY_MS = 86_400_000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

// A day off (Saturday, Sunday, public holiday) moves to the next working day.
function afterDayOff(date: Date): Date {
  return new Date(`${onOrAfterWorkingDay(iso(date))}T00:00:00Z`);
}

// The return of the period that contains the given month (monthIndex 0-11): its period key and due date.
function deadlineOf(kind: VatFilingPeriod, year: number, monthIndex: number): { period: string; due: Date } {
  if (kind === 'month') {
    // Date.UTC rolls month 12 over to January of the next year.
    return { period: `${year}-${String(monthIndex + 1).padStart(2, '0')}`, due: afterDayOff(utcDate(year, monthIndex + 1, 20)) };
  }
  const quarter = Math.floor(monthIndex / 3) + 1;
  // Day 0 of the month after the first month of the next quarter is that first month's last day.
  return { period: `${year}-Q${quarter}`, due: afterDayOff(utcDate(year, quarter * 3 + 1, 0)) };
}

// The first VAT return due on or after today: the one for the period before today's (still open until its due date),
// otherwise the one for the period that contains today.
export function nextVatDeadline(kind: VatFilingPeriod, today: string): VatDeadline {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`not a calendar date: ${today}`);
  const now = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(now.getTime()) || iso(now) !== today) throw new Error(`not a calendar date: ${today}`);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const step = kind === 'month' ? 1 : 3;
  const previousStart = utcDate(year, month - (kind === 'month' ? 0 : month % 3) - step, 1);
  let deadline = deadlineOf(kind, previousStart.getUTCFullYear(), previousStart.getUTCMonth());
  if (deadline.due.getTime() < now.getTime()) deadline = deadlineOf(kind, year, month);
  return { period: deadline.period, dueDate: iso(deadline.due), daysLeft: Math.round((deadline.due.getTime() - now.getTime()) / DAY_MS) };
}

// The day the return of a given period is due, from the VAT working's period key ("2026-10", "2026-Q3"), after the day-off
// rule; null for a key that is not one. The same rule as nextVatDeadline, for a period the user picked.
export function vatDueDate(period: string): string | null {
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (month) return iso(deadlineOf('month', Number(month[1]), Number(month[2]) - 1).due);
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) return iso(deadlineOf('quarter', Number(quarter[1]), (Number(quarter[2]) - 1) * 3).due);
  return null;
}
