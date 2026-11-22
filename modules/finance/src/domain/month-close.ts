// SPDX-License-Identifier: AGPL-3.0-only
// The month-close checklist (finance.month_close) as pure functions: the bounds of the month, which VAT period a month belongs to for an entity's filing period, which items
// apply to the entity and the month, and the checklist built from the counts the reads gave. The reads are in ../month-close.ts; nothing here touches the database, so every rule
// below has a plain unit test. No money is read anywhere in the checklist: every item is a count.
import { MONTH_CLOSE_ITEMS, type MonthClose, type MonthCloseItem, type MonthCloseKey, type VatFilingPeriod } from '@ludy/kernel-contract';

export interface MonthBounds {
  month: string;
  // First day of the month, first day of the next month (exclusive end), last day of the month: all YYYY-MM-DD.
  from: string;
  next: string;
  last: string;
}

const two = (n: number) => String(n).padStart(2, '0');

export function monthBounds(month: string): MonthBounds {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const year = Number(match?.[1]);
  const m = Number(match?.[2]);
  if (!match || !(m >= 1 && m <= 12)) throw new Error(`not a month: ${JSON.stringify(month)}`);
  const nextYear = m === 12 ? year + 1 : year;
  const nextMonth = m === 12 ? 1 : m + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth - 1, 0)).getUTCDate();
  return { month, from: `${month}-01`, next: `${nextYear}-${two(nextMonth)}-01`, last: `${month}-${two(lastDay)}` };
}

// The VAT periods whose tax-portal lists the month's invoices are reconciled in, the one to read first first: for an entity that files quarterly, in the last month of its quarter, the
// quarter's (which holds the month's invoices too) and then the month's own; otherwise the month's own (the portal exports a month at a time). Nothing else: a list of another period
// says nothing about this month. The reader takes the first of them that has a list, so one invoice is never counted from the quarter's list and the month's.
export function portalPeriods(month: string, kind: VatFilingPeriod | null): string[] {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return kind === 'quarter' && m % 3 === 0 ? [`${year}-Q${m / 3}`, month] : [month];
}

// The VAT period whose return the checklist asks about, or null when this month does not end one: a monthly filer (the default for an org that never set its period) files for every
// month; a quarterly filer for the last month of each quarter only.
export function vatMarkPeriod(month: string, kind: VatFilingPeriod | null): string | null {
  const [year, m] = month.split('-').map(Number) as [number, number];
  if (kind !== 'quarter') return month;
  return m % 3 === 0 ? `${year}-Q${m / 3}` : null;
}

// Whether the month is over on `today` (the database's, in Vietnam).
export const monthOver = (bounds: MonthBounds, today: string): boolean => bounds.next <= today;

// What the reads found. null means the item does not apply (and is left out): no tax-portal list for the month, no stock move or the month not over for the stock close, a month that
// ends no VAT period for the VAT mark.
export interface MonthCloseCounts {
  proposals: number;
  invoices: { count: number; period: string; direction?: 'sale' } | null;
  bank: number;
  marketplace: number;
  // The stock close is open: the month is over, the entity has stock moves up to it and no close covers the month.
  stock: boolean | null;
  vat: { period: string; open: boolean } | null;
  // The entity's lock does not cover the whole month.
  lock: boolean;
}

// A period lock covers the month when it runs through the month's last day.
export const lockCovers = (lockedThrough: string | null, bounds: MonthBounds): boolean => lockedThrough !== null && lockedThrough >= bounds.last;

export function buildMonthClose(legalEntityId: string, bounds: MonthBounds, counts: MonthCloseCounts): MonthClose {
  const rows: Record<MonthCloseKey, MonthCloseItem | null> = {
    proposals: { key: 'proposals', count: counts.proposals, period: null },
    invoices: counts.invoices === null ? null : { key: 'invoices', count: counts.invoices.count, period: counts.invoices.period, ...(counts.invoices.direction ? { direction: counts.invoices.direction } : {}) },
    bank: { key: 'bank', count: counts.bank, period: null },
    marketplace: { key: 'marketplace', count: counts.marketplace, period: null },
    stock: counts.stock === null ? null : { key: 'stock', count: counts.stock ? 1 : 0, period: null },
    vat: counts.vat === null ? null : { key: 'vat', count: counts.vat.open ? 1 : 0, period: counts.vat.period },
    lock: { key: 'lock', count: counts.lock ? 1 : 0, period: null },
  };
  return { month: bounds.month, legalEntityId, items: MONTH_CLOSE_ITEMS.flatMap((key) => rows[key] ?? []) };
}

/** The keys of the open items, in the fixed order. */
export const openKeys = (checklist: Pick<MonthClose, 'items'>): MonthCloseKey[] => checklist.items.filter((item) => item.count > 0).map((item) => item.key);
