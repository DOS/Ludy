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

  it('keeps a month whose net is zero while it holds pieces: whether it has an entry is known only with the VAT rates (#4303 S3b)', () => {
    expect(settlementMonthsOf([line('0', '2026-10-02')], '2026-10-15').months.map((m) => [m.month, m.net])).toEqual([['2026-10', '0']]);
    expect(settlementMonthsOf([line('10000', '2026-10-02', { refund: '10000' })], '2026-10-15').months.map((m) => [m.month, m.net])).toEqual([['2026-10', '0']]);
    expect(settlementMonthsOf([], '2026-10-15').months).toEqual([]);
  });

  it('gives each piece the day whose VAT rate applies: the delivery day of a sale and of a refund of that sale, the entry date when the line has no usable day (#4303 S3b, rule 8)', () => {
    const rate = (r: ReturnType<typeof settlementMonthsOf>) => r.months.flatMap((m) => m.lines.map((l) => [m.month, l.sales, l.refund, l.rateDate]));
    // A sale and the refund of it, which falls in the settlement's own month: both take the sale's delivery day.
    expect(rate(settlementMonthsOf([line('100000', '2026-09-20', { refund: '30000' })], '2026-10-15'))).toEqual([['2026-09', '100000', '0', '2026-09-20'], ['2026-10', '0', '30000', '2026-09-20']]);
    // A line refunded at least as much as it sold with a known delivery day (before the last day): the refund takes that day's rate, exactly where the rate changes.
    expect(rate(settlementMonthsOf([line('100000', '2026-12-28', { refund: '100000' })], '2027-01-10'))).toEqual([['2027-01', '100000', '100000', '2026-12-28']]);
    // No delivery day, or one after the settlement's last day: the entry's date decides (null).
    expect(rate(settlementMonthsOf([line('100000', null, { refund: '100000' })], '2027-01-10'))).toEqual([['2027-01', '100000', '100000', null]]);
    expect(rate(settlementMonthsOf([line('100000', '2027-01-20', { refund: '100000' })], '2027-01-10'))).toEqual([['2027-01', '100000', '100000', null]]);
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

  it('keeps a month whose net is zero whether or not tax was withheld on its lines: the entry built with the rates says what it posts', () => {
    const lines = [line('40000', '2026-11-03', { taxWithheld: '600' }), line('100000', '2026-10-05', { refund: '40000' })];
    expect(settlementMonthsOf(lines, '2026-11-15').months.map((m) => [m.month, m.net])).toEqual([['2026-10', '100000'], ['2026-11', '0']]);
    const none = settlementMonthsOf([line('40000', '2026-11-03'), line('100000', '2026-10-05', { refund: '40000' })], '2026-11-15');
    expect(none.months.map((m) => m.month)).toEqual(['2026-10', '2026-11']);
  });
});
