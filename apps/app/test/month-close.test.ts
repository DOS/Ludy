// SPDX-License-Identifier: AGPL-3.0-only
// The month-close checklist's pure helpers: the months the picker offers and the order the items are shown in.
import { describe, expect, it } from 'vitest';
import type { MonthCloseItem, MonthCloseKey } from '@ludy/kernel-contract';
import { closeMonths, defaultCloseMonth, orderItems } from '../src/lib/month-close.ts';

const item = (key: MonthCloseKey, count: number): MonthCloseItem => ({ key, count, period: null });

describe('closeMonths', () => {
  it('offers the month of today and the 11 before it, newest first, across a year end', () => {
    expect(closeMonths(new Date(2026, 10, 22))).toEqual(['2026-11', '2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01', '2025-12']);
    expect(closeMonths(new Date(2027, 0, 5))[0]).toBe('2027-01');
    expect(closeMonths(new Date(2027, 0, 5))[1]).toBe('2026-12');
    expect(closeMonths(new Date(2027, 0, 5))).toHaveLength(12);
  });

  it('defaults to the calendar month before today', () => {
    expect(defaultCloseMonth(new Date(2026, 10, 22))).toBe('2026-10');
    expect(defaultCloseMonth(new Date(2027, 0, 1))).toBe('2026-12');
    expect(defaultCloseMonth(new Date(2026, 2, 31))).toBe('2026-02');
  });
});

describe('orderItems', () => {
  const items = [item('proposals', 3), item('bank', 0), item('marketplace', 2), item('lock', 1)];

  it('puts the open items first in the fixed order, then the done ones, when there is no order', () => {
    expect(orderItems(items, []).map((i) => i.key)).toEqual(['proposals', 'marketplace', 'lock', 'bank']);
  });

  it('sorts the open items by the order when it is exactly the open keys, and keeps the done ones last', () => {
    expect(orderItems(items, ['lock', 'proposals', 'marketplace']).map((i) => i.key)).toEqual(['lock', 'proposals', 'marketplace', 'bank']);
  });

  it('ignores an order that adds, drops, repeats or names a done item, so no item is ever hidden or added', () => {
    const fixed = ['proposals', 'marketplace', 'lock', 'bank'];
    for (const order of [['lock', 'proposals'], ['lock', 'proposals', 'marketplace', 'bank'], ['lock', 'lock', 'proposals'], ['lock', 'proposals', 'stock']] as MonthCloseKey[][]) {
      expect(orderItems(items, order).map((i) => i.key), order.join()).toEqual(fixed);
    }
  });

  it('keeps the counts and periods of the items it is given', () => {
    expect(orderItems([{ key: 'vat', count: 1, period: '2026-Q4' }], ['vat'])).toEqual([{ key: 'vat', count: 1, period: '2026-Q4' }]);
  });
});
