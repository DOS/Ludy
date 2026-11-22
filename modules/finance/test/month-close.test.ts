// SPDX-License-Identifier: AGPL-3.0-only
// The month-close checklist's rules (finance.month_close) as pure functions: the bounds of a month, which VAT period a month belongs to for a monthly and a quarterly filer, when a
// lock covers a month, which items apply, and the checklist built from the counts. The reads themselves are checked in apps/kernel/test/finance-month-close.db.test.ts.
import { describe, expect, it } from 'vitest';
import { MONTH_CLOSE_ITEMS } from '@ludy/kernel-contract';
import { buildMonthClose, lockCovers, monthBounds, monthOver, openKeys, portalPeriods, vatMarkPeriod, type MonthCloseCounts } from '../src/domain/month-close.ts';

const ENTITY = 'le-1';
const COUNTS: MonthCloseCounts = { proposals: 3, invoices: { count: 2, period: '2026-10' }, bank: 17, marketplace: 0, stock: true, vat: { period: '2026-10', open: true }, lock: true };

describe('monthBounds', () => {
  it('gives the first day, the first day of the next month and the last day, across year ends and leap years', () => {
    expect(monthBounds('2026-10')).toEqual({ month: '2026-10', from: '2026-10-01', next: '2026-11-01', last: '2026-10-31' });
    expect(monthBounds('2026-12')).toEqual({ month: '2026-12', from: '2026-12-01', next: '2027-01-01', last: '2026-12-31' });
    expect(monthBounds('2028-02').last).toBe('2028-02-29');
    expect(monthBounds('2027-02').last).toBe('2027-02-28');
    expect(monthBounds('2026-04').last).toBe('2026-04-30');
  });

  it('refuses what is not a month', () => {
    for (const bad of ['2026-13', '2026-00', '2026', 'abc', '2026-1']) expect(() => monthBounds(bad), bad).toThrow();
  });
});

describe('monthOver', () => {
  it('is true from the first day of the next month on', () => {
    const b = monthBounds('2026-10');
    expect(monthOver(b, '2026-10-31')).toBe(false);
    expect(monthOver(b, '2026-11-01')).toBe(true);
    expect(monthOver(b, '2027-03-01')).toBe(true);
  });
});

describe('the VAT period of a month', () => {
  it('is the month itself for a monthly filer, and for an org that never set a period', () => {
    expect(vatMarkPeriod('2026-10', 'month')).toBe('2026-10');
    expect(vatMarkPeriod('2026-10', null)).toBe('2026-10');
    expect(portalPeriods('2026-10', 'month')).toEqual(['2026-10']);
    expect(portalPeriods('2026-12', null)).toEqual(['2026-12']);
  });

  it('is the quarter for a quarterly filer in the last month of it only, and nothing in the other two', () => {
    expect(vatMarkPeriod('2026-10', 'quarter')).toBeNull();
    expect(vatMarkPeriod('2026-11', 'quarter')).toBeNull();
    expect(vatMarkPeriod('2026-12', 'quarter')).toBe('2026-Q4');
    expect(vatMarkPeriod('2026-03', 'quarter')).toBe('2026-Q1');
    expect(vatMarkPeriod('2026-09', 'quarter')).toBe('2026-Q3');
  });

  it('reads the portal lists of the month, and of the quarter too in its last month for a quarterly filer', () => {
    expect(portalPeriods('2026-10', 'quarter')).toEqual(['2026-10']);
    expect(portalPeriods('2026-12', 'quarter')).toEqual(['2026-12', '2026-Q4']);
  });
});

describe('lockCovers', () => {
  const b = monthBounds('2026-10');
  it('covers the month only when it runs through the last day', () => {
    expect(lockCovers(null, b)).toBe(false);
    expect(lockCovers('2026-09-30', b)).toBe(false);
    expect(lockCovers('2026-10-30', b)).toBe(false);
    expect(lockCovers('2026-10-31', b)).toBe(true);
    expect(lockCovers('2026-11-30', b)).toBe(true);
  });
});

describe('buildMonthClose', () => {
  const b = monthBounds('2026-10');

  it('lists every applicable item in the fixed order, with its count and period', () => {
    const view = buildMonthClose(ENTITY, b, COUNTS);
    expect(view.month).toBe('2026-10');
    expect(view.legalEntityId).toBe(ENTITY);
    expect(view.items.map((i) => i.key)).toEqual([...MONTH_CLOSE_ITEMS]);
    expect(view.items).toEqual([
      { key: 'proposals', count: 3, period: null },
      { key: 'invoices', count: 2, period: '2026-10' },
      { key: 'bank', count: 17, period: null },
      { key: 'marketplace', count: 0, period: null },
      { key: 'stock', count: 1, period: null },
      { key: 'vat', count: 1, period: '2026-10' },
      { key: 'lock', count: 1, period: null },
    ]);
  });

  it('leaves out the items that do not apply, and counts the done yes or no items as 0', () => {
    const view = buildMonthClose(ENTITY, b, { ...COUNTS, invoices: null, stock: null, vat: { period: '2026-Q4', open: false }, lock: false });
    expect(view.items.map((i) => i.key)).toEqual(['proposals', 'bank', 'marketplace', 'vat', 'lock']);
    expect(view.items.find((i) => i.key === 'vat')).toEqual({ key: 'vat', count: 0, period: '2026-Q4' });
    expect(view.items.find((i) => i.key === 'lock')?.count).toBe(0);
    expect(buildMonthClose(ENTITY, b, { ...COUNTS, vat: null }).items.some((i) => i.key === 'vat')).toBe(false);
  });

  it('names the open items, in the fixed order, for the coworker', () => {
    expect(openKeys(buildMonthClose(ENTITY, b, COUNTS))).toEqual(['proposals', 'invoices', 'bank', 'stock', 'vat', 'lock']);
    expect(openKeys(buildMonthClose(ENTITY, b, { proposals: 0, invoices: null, bank: 0, marketplace: 0, stock: false, vat: { period: '2026-10', open: false }, lock: false }))).toEqual([]);
  });
});
