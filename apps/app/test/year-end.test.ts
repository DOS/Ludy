// SPDX-License-Identifier: AGPL-3.0-only
// The year-end checklist's pure helpers: the years the picker offers, the year it opens on, and the order the items are shown in.
import { describe, expect, it } from 'vitest';
import type { YearEndItem, YearEndKey } from '@ludy/kernel-contract';
import { closeYears, defaultCloseYear, isReady, orderYearEndItems } from '../src/lib/year-end.ts';

const item = (key: YearEndKey, state: YearEndItem['state'], waiting = false, count = state === 'open' ? 1 : 0): YearEndItem => ({ key, state, waiting, count, due: null });

describe('closeYears', () => {
  it('offers the year of today and the 3 before it, newest first', () => {
    expect(closeYears(new Date(2026, 10, 22))).toEqual([2026, 2025, 2024, 2023]);
    expect(closeYears(new Date(2027, 0, 5))).toEqual([2027, 2026, 2025, 2024]);
  });
});

describe('defaultCloseYear', () => {
  it('is the current year from October on, and the year before otherwise', () => {
    expect(defaultCloseYear(new Date(2026, 9, 1))).toBe(2026);
    expect(defaultCloseYear(new Date(2026, 10, 22))).toBe(2026);
    expect(defaultCloseYear(new Date(2026, 11, 31))).toBe(2026);
    expect(defaultCloseYear(new Date(2027, 0, 5))).toBe(2026);
    expect(defaultCloseYear(new Date(2026, 8, 30))).toBe(2025);
  });
});

describe('isReady', () => {
  it('is an open item that does not wait for the year to end', () => {
    expect(isReady(item('balances', 'open'))).toBe(true);
    expect(isReady(item('closing_entry', 'open', true))).toBe(false);
    expect(isReady(item('statements', 'done'))).toBe(false);
    expect(isReady(item('pit', 'na'))).toBe(false);
  });
});

describe('orderYearEndItems', () => {
  const items = [item('balances', 'open'), item('depreciation', 'done'), item('closing_entry', 'open', true), item('months_locked', 'open'), item('statements', 'na'), item('einvoice_series', 'open')];

  it('puts the items to do now first in the fixed order, then the ones that wait, then the done ones, then the ones that do not apply', () => {
    expect(orderYearEndItems(items, []).map((i) => i.key)).toEqual(['balances', 'months_locked', 'einvoice_series', 'closing_entry', 'depreciation', 'statements']);
  });

  it('sorts the items to do now by the order when it is exactly their keys, and leaves the other groups where they are', () => {
    expect(orderYearEndItems(items, ['einvoice_series', 'balances', 'months_locked']).map((i) => i.key)).toEqual(['einvoice_series', 'balances', 'months_locked', 'closing_entry', 'depreciation', 'statements']);
  });

  it('ignores an order that adds, drops, repeats or names a waiting or done item, so no item is ever hidden or added', () => {
    const fixed = ['balances', 'months_locked', 'einvoice_series', 'closing_entry', 'depreciation', 'statements'];
    for (const order of [['balances', 'months_locked'], ['balances', 'months_locked', 'einvoice_series', 'closing_entry'], ['balances', 'balances', 'months_locked'], ['balances', 'months_locked', 'pit']] as YearEndKey[][]) {
      expect(orderYearEndItems(items, order).map((i) => i.key), order.join()).toEqual(fixed);
    }
  });

  it('keeps the states, counts and due dates of the items it is given', () => {
    const dated: YearEndItem = { key: 'cit', state: 'open', waiting: false, count: 1, due: '2027-03-31' };
    expect(orderYearEndItems([dated], ['cit'])).toEqual([dated]);
  });
});
