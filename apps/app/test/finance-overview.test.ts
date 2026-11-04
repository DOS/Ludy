// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of the Kế toán Tổng quan screen (#2631): the direction and tone of a card's change and the bars of the six-month chart.
import { describe, expect, it } from 'vitest';
import { chartBars, chartHasData, directionOf, monthNumber, percentSize, toneOf } from '../src/lib/finance-overview.ts';

describe('directionOf and toneOf', () => {
  it('reads the sign of the change, whatever the decimals the server sends', () => {
    expect(directionOf({ change: '1800000' })).toBe('up');
    expect(directionOf({ change: '-0.5' })).toBe('down');
    expect(directionOf({ change: '0.0000' })).toBe('flat');
    expect(directionOf({ change: '-0' })).toBe('flat');
  });

  it('colors cash and profit by direction and leaves what customers owe and what is owed uncolored', () => {
    expect(toneOf('cash', 'up')).toBe('good');
    expect(toneOf('profit', 'down')).toBe('bad');
    expect(toneOf('receivables', 'up')).toBe('neutral');
    expect(toneOf('payables', 'down')).toBe('neutral');
    expect(toneOf('cash', 'flat')).toBe('neutral');
  });

  it('shows the size of a percent without its sign, and none against zero', () => {
    expect(percentSize({ changePercent: '-66.7' })).toBe('66.7');
    expect(percentSize({ changePercent: '18.0' })).toBe('18.0');
    expect(percentSize({ changePercent: null })).toBeNull();
  });
});

describe('chartBars', () => {
  const months = [
    { month: '2026-09', revenue: '5000000', costs: '2000000', profit: '3000000' },
    { month: '2026-10', revenue: '10000000', costs: '12500000', profit: '-2500000' },
    { month: '2026-11', revenue: '0', costs: '0', profit: '0' },
  ];

  it('scales every bar to the largest figure of the months, and marks a loss', () => {
    const bars = chartBars(months);
    expect(bars[0]).toEqual({ month: '2026-09', revenue: 40, costs: 16, profit: 24, profitNegative: false });
    expect(bars[1]).toEqual({ month: '2026-10', revenue: 80, costs: 100, profit: 20, profitNegative: true });
    expect(bars[2]).toEqual({ month: '2026-11', revenue: 0, costs: 0, profit: 0, profitNegative: false });
  });

  it('draws nothing when every month is empty', () => {
    const empty = months.map((m) => ({ ...m, revenue: '0', costs: '0', profit: '0' }));
    expect(chartHasData(empty)).toBe(false);
    expect(chartBars(empty).every((b) => b.revenue === 0 && b.costs === 0 && b.profit === 0)).toBe(true);
    expect(chartHasData(months)).toBe(true);
  });

  it('names a month by its number', () => {
    expect(monthNumber('2026-09')).toBe(9);
    expect(monthNumber('2026-12')).toBe(12);
  });
});
