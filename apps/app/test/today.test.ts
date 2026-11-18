// SPDX-License-Identifier: AGPL-3.0-only
// "Hôm nay cần bạn" on Home (#2383), the parts without a screen: grouping by kind with flags first, the screen an item
// opens, and what the heading counts.
import { describe, expect, it } from 'vitest';
import { zTodayItem, type TodayItem } from '@crove/kernel-contract';
import { QUEUE_ROWS, groupToday, limitGroups, proposalChips, queueRows, todayPath, todayTotal } from '../src/lib/today.ts';

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

describe('one count per item (#3591)', () => {
  // Seven pending invoices of two vendors that all carry a warning, as finance.today answers them: two groups and the flag over the same seven.
  const SEVEN = [
    item({ id: 'proposals:a', count: 4 }),
    item({ id: 'proposals:b', count: 3 }),
    item({ id: 'checks-warn:e', kind: 'flag', severity: 'warn', count: 7, annotates: 'proposal' }),
  ];

  it('lists the proposals once: the flag over them is a chip, not a row of its own', () => {
    expect(queueRows(SEVEN).map((i) => i.id)).toEqual(['proposals:a', 'proposals:b']);
    expect(groupToday(queueRows(SEVEN)).map((g) => g.kind)).toEqual(['proposal']);
    expect(todayTotal(groupToday(queueRows(SEVEN))[0]?.items ?? [])).toBe(7);
    expect(proposalChips(SEVEN)).toEqual([{ severity: 'warn', count: 7 }]);
  });

  it('never chips more proposals than the member sees', () => {
    // The read flags every pending proposal of the books; two wait for another approver, so only five are listed here.
    const flagged = [item({ id: 'p', count: 5 }), item({ id: 'f1', kind: 'flag', severity: 'block', count: 3, annotates: 'proposal' }), item({ id: 'f2', kind: 'flag', severity: 'warn', count: 4, annotates: 'proposal' })];
    expect(proposalChips(flagged)).toEqual([
      { severity: 'block', count: 3 },
      { severity: 'warn', count: 2 },
    ]);
    // No listed proposal: no chip.
    expect(proposalChips([item({ id: 'f', kind: 'flag', severity: 'warn', count: 2, annotates: 'proposal' })])).toEqual([]);
  });

  it('keeps a flag that is its own item as a row', () => {
    const own = item({ id: 'f', kind: 'flag', severity: 'warn' });
    expect(queueRows([own]).map((i) => i.id)).toEqual(['f']);
  });

  it('shows the first five rows over all the groups, in the groups order', () => {
    const rows = [
      item({ id: 'f1', kind: 'flag', severity: 'block' }),
      item({ id: 'f2', kind: 'flag', severity: 'warn' }),
      ...['p1', 'p2', 'p3'].map((id) => item({ id })),
      item({ id: 'd1', kind: 'deadline' }),
      item({ id: 'd2', kind: 'deadline' }),
    ];
    const groups = limitGroups(groupToday(rows), QUEUE_ROWS);
    expect(groups.map((g) => [g.kind, g.items.length])).toEqual([
      ['flag', 2],
      ['proposal', 3],
    ]);
    // A limit that falls inside a group trims it, and a group with nothing left is not listed.
    expect(limitGroups(groupToday(rows), 3).map((g) => [g.kind, g.items.length])).toEqual([
      ['flag', 2],
      ['proposal', 1],
    ]);
    expect(limitGroups(groupToday(rows), 99).reduce((n, g) => n + g.items.length, 0)).toBe(7);
  });
});
