// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" on Home (#2383), the parts without a screen: grouping by kind with flags first, the screen an item
// opens, and what the heading counts.
import { describe, expect, it } from 'vitest';
import { zTodayItem, type TodayItem } from '@crove/kernel-contract';
import { groupToday, todayPath, todayTotal } from '../src/lib/today.ts';

const item = (over: Record<string, unknown>): TodayItem =>
  zTodayItem.parse({ kind: 'proposal', app: 'finance', id: 'a', title: { key: 'finance.x' }, href: '/inbox', ...over });

describe('groupToday', () => {
  it('lists only the kinds that have items, flags first', () => {
    const groups = groupToday([item({ id: 'd', kind: 'deadline' }), item({ id: 'p' }), item({ id: 'f', kind: 'flag', severity: 'warn' })]);
    expect(groups.map((g) => g.kind)).toEqual(['flag', 'proposal', 'deadline']);
    expect(groupToday([])).toEqual([]);
  });

  it('keeps the more severe flag first, and orders the same whatever order the reads answered in', () => {
    const items = [item({ id: 'info', kind: 'flag', severity: 'info' }), item({ id: 'block', kind: 'flag', severity: 'block' }), item({ id: 'warn', kind: 'flag', severity: 'warn' })];
    const ids = (list: TodayItem[]) => groupToday(list)[0]?.items.map((i) => i.id);
    expect(ids(items)).toEqual(['block', 'warn', 'info']);
    expect(ids([...items].reverse())).toEqual(['block', 'warn', 'info']);
  });
});

describe('todayPath', () => {
  it('puts the org in front of a path inside the org, and keeps one that names it', () => {
    expect(todayPath('acme', '/vat')).toBe('/o/acme/vat');
    expect(todayPath('acme', '/inbox?tab=pending')).toBe('/o/acme/inbox?tab=pending');
    expect(todayPath('acme', '/')).toBe('/o/acme');
    expect(todayPath('acme', '/o/acme/bank')).toBe('/o/acme/bank');
    expect(todayPath('a b', '/vat')).toBe('/o/a%20b/vat');
  });
});

describe('todayTotal', () => {
  it('counts an item as one, or as what it groups', () => {
    expect(todayTotal([item({ id: 'a' }), item({ id: 'b', count: 4 })])).toBe(5);
    expect(todayTotal([])).toBe(0);
  });
});
