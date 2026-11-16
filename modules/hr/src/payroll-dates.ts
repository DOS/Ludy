// SPDX-License-Identifier: AGPL-3.0-only
// Calendar month bounds and effective-dated employment term lookup shared across HR employees and pay runs.
import { daysInCalendarMonth } from '@crove/l10n-vn';

export const isoDate = (value: Date | string): string => (typeof value === 'string' ? value : value.toISOString().slice(0, 10));

export const monthStart = (month: string): string => `${month}-01`;

export const monthEnd = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const day = String(daysInCalendarMonth(year, m)).padStart(2, '0');
  return `${month}-${day}`;
};

export const previousMonth = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const prevYear = m === 1 ? year - 1 : year;
  const prevMonth = m === 1 ? 12 : m - 1;
  return `${String(prevYear).padStart(4, '0')}-${String(prevMonth).padStart(2, '0')}`;
};

/** Selects the employment row in force on the first day of `month`, or the first starting inside `month`. */
export function termsInForceForMonth<T extends { effective_from: Date | string }>(termsAsc: readonly T[], month: string): T | undefined {
  const start = monthStart(month);
  const end = monthEnd(month);
  return [...termsAsc].reverse().find((t) => isoDate(t.effective_from) <= start) ?? termsAsc.find((t) => isoDate(t.effective_from) <= end);
}
