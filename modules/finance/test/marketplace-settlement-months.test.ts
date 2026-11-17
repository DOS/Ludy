// SPDX-License-Identifier: AGPL-3.0-only
// The months a settlement is posted in (#2516 rework, slice C1): the sale of a line belongs to the month of its order's delivery, a refund to the month of the settlement's last day, a line refunded at
// least as much as it sold needs no delivery day, a line with no usable day makes the settlement wait, and the two questions asked of the vouchers that exist (what still waits, whether it is posted).
import { describe, expect, it } from 'vitest';
import { monthEntryDate, settlementMonthsOf, settlementPosted, type SettlementMonthLine } from '../src/marketplace-settlement-months.ts';

const line = (sales: string, deliveredOn: string | null, over: Partial<SettlementMonthLine> = {}): SettlementMonthLine => ({ sales, sellerDiscount: '0', refund: '0', taxWithheld: '0', deliveredOn, ...over });

describe('the months of a settlement', () => {
  it('puts the sale in the month of delivery and dates the entry on the last day of that month, or the settlement\'s last day for its own month', () => {
    const r = settlementMonthsOf([line('100000', '2026-09-28'), line('50000', '2026-10-02'), line('20000', '2026-10-12', { sellerDiscount: '5000' })], '2026-10-15');
    expect(r.waiting).toBe(0);
    expect(r.months.map((m) => [m.month, m.date, m.net])).toEqual([
      ['2026-09', '2026-09-30', '100000'],
      ['2026-10', '2026-10-15', '65000'],
    ]);
  });

  it('puts a refund in the settlement\'s own month and a negative month runs the other way', () => {
    const r = settlementMonthsOf([line('100000', '2026-09-20', { refund: '30000' }), line('10000', '2026-10-03')], '2026-10-15');
    expect(r.months.map((m) => [m.month, m.net])).toEqual([
      ['2026-09', '100000'],
      ['2026-10', '-20000'],
    ]);
  });

  it('needs no delivery day for a line refunded at least as much as it sold, and counts the lines that wait', () => {
    const refunded = settlementMonthsOf([line('100000', null, { refund: '100000' }), line('40000', null, { refund: '50000' })], '2026-10-15');
    expect(refunded.waiting).toBe(0);
    expect(refunded.months.map((m) => [m.month, m.net])).toEqual([['2026-10', '-10000']]);
    const waits = settlementMonthsOf([line('100000', null), line('50000', '2026-10-02'), line('7000', '2026-11-02')], '2026-10-15');
    // A day after the settlement's last day is no usable day either.
    expect(waits.waiting).toBe(2);
  });

  it('lists no month whose net is zero', () => {
    expect(settlementMonthsOf([line('0', '2026-10-02')], '2026-10-15').months).toEqual([]);
    expect(settlementMonthsOf([line('10000', '2026-10-02', { refund: '10000' })], '2026-10-15').months).toEqual([]);
  });

  it('dates the last day of a short month', () => {
    expect(monthEntryDate('2026-02', '2026-03-10')).toBe('2026-02-28');
    expect(monthEntryDate('2028-02', '2028-03-10')).toBe('2028-02-29');
  });
});

describe('whether the posting stands', () => {
  it('stands when the settlement has vouchers and none is reversed: all its months are posted together or none', () => {
    expect(settlementPosted([])).toBe(false);
    expect(settlementPosted([{ month: '2026-09', reversed: false }, { month: '2026-10', reversed: false }])).toBe(true);
    // One month reversed, the others standing: not posted, the payout waits until the accountant puts the settlement right.
    expect(settlementPosted([{ month: '2026-09', reversed: false }, { month: '2026-10', reversed: true }])).toBe(false);
    expect(settlementPosted([{ month: null, reversed: false }])).toBe(true);
    expect(settlementPosted([{ month: null, reversed: true }])).toBe(false);
  });

  it('keeps a month whose net is zero when tax was withheld on its lines, and drops it when none was', () => {
    const lines = [line('40000', '2026-11-03', { taxWithheld: '600' }), line('100000', '2026-10-05', { refund: '40000' })];
    const kept = settlementMonthsOf(lines, '2026-11-15');
    expect(kept.months.map((m) => [m.month, m.net])).toEqual([['2026-10', '100000'], ['2026-11', '0']]);
    const dropped = settlementMonthsOf([line('40000', '2026-11-03'), line('100000', '2026-10-05', { refund: '40000' })], '2026-11-15');
    expect(dropped.months.map((m) => m.month)).toEqual(['2026-10']);
  });
});
