// SPDX-License-Identifier: AGPL-3.0-only
// Calendar month bounds and effective-dated employment term lookup shared across HR employees and pay runs.

export const isoDate = (value: Date | string): string => (typeof value === 'string' ? value : value.toISOString().slice(0, 10));

export const monthStart = (month: string): string => `${month}-01`;

export const monthEnd = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
};

export const previousMonth = (month: string): string => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(year, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Selects the employment row in force on the first day of `month`, or the first starting inside `month`. */
export function termsInForceForMonth<T extends { effective_from: Date | string }>(termsAsc: readonly T[], month: string): T | undefined {
  const start = monthStart(month);
  const end = monthEnd(month);
  return [...termsAsc].reverse().find((t) => isoDate(t.effective_from) <= start) ?? termsAsc.find((t) => isoDate(t.effective_from) <= end);
}
