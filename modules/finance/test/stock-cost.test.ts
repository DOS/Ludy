// SPDX-License-Identifier: AGPL-3.0-only
// The provisional cost of stock by month (#2513): the weighted average per item for the month, carried from month to month, in exact decimals.
import { describe, expect, it } from 'vitest';
import { monthlyFigures, nextMonth, type CostMove } from '../src/domain/stock-cost.ts';

const buy = (date: string, quantity: string, value: string): CostMove => ({ date, quantity, value });
const sell = (date: string, quantity: string): CostMove => ({ date, quantity: `-${quantity}`, value: null });

describe('the weighted average of a month', () => {
  it('prices what leaves at (opening value + value in) / (opening quantity + quantity in), and the three always add up', () => {
    const [m] = monthlyFigures([buy('2026-10-03', '10', '1000000'), buy('2026-10-12', '10', '1200000'), sell('2026-10-20', '5')], '2026-10');
    expect(m).toEqual({
      month: '2026-10',
      openingQuantity: '0',
      openingValue: '0',
      inQuantity: '20',
      inValue: '2200000',
      outQuantity: '5',
      outValue: '550000',
      closingQuantity: '15',
      closingValue: '1650000',
      unitCost: '110000',
    });
  });

  it('carries the closing of a month into the next: the opening is what was left, at what it was worth', () => {
    const months = monthlyFigures([buy('2026-10-03', '10', '1000000'), sell('2026-10-20', '4'), buy('2026-11-05', '4', '600000'), sell('2026-11-09', '10')], '2026-11');
    expect(months.map((m) => [m.month, m.openingQuantity, m.openingValue, m.closingQuantity, m.closingValue])).toEqual([
      ['2026-10', '0', '0', '6', '600000'],
      // 600,000 + 600,000 over 6 + 4 units: 120,000 each; ten leave at that.
      ['2026-11', '6', '600000', '0', '0'],
    ]);
    expect(months[1]).toMatchObject({ unitCost: '120000', outQuantity: '10', outValue: '1200000' });
  });

  it('has a month with no move carry the closing of the one before, and nothing before the first move', () => {
    const months = monthlyFigures([buy('2026-08-31', '2', '200')], '2026-10');
    expect(months.map((m) => [m.month, m.openingQuantity, m.closingQuantity, m.closingValue])).toEqual([
      ['2026-08', '0', '2', '200'],
      ['2026-09', '2', '2', '200'],
      ['2026-10', '2', '2', '200'],
    ]);
    expect(monthlyFigures([buy('2026-11-01', '2', '200')], '2026-10')).toEqual([]);
    expect(monthlyFigures([], '2026-10')).toEqual([]);
  });

  it('takes back a purchase that was reversed: its value goes with it', () => {
    const [m] = monthlyFigures([buy('2026-10-03', '10', '1000000'), buy('2026-10-04', '-10', '-1000000')], '2026-10');
    expect(m).toMatchObject({ inQuantity: '0', inValue: '0', closingQuantity: '0', closingValue: '0', unitCost: null });
  });

  it('counts a sale taken back (a reversing move with no value of its own) as less going out', () => {
    const [m] = monthlyFigures([buy('2026-10-03', '10', '1000000'), sell('2026-10-10', '4'), { date: '2026-10-11', quantity: '1', value: null }], '2026-10');
    expect(m).toMatchObject({ outQuantity: '3', outValue: '300000', closingQuantity: '7', closingValue: '700000' });
  });

  it('rounds what leaves to four decimals from the exact average, so the closing value is the opening plus in less out', () => {
    const [m] = monthlyFigures([buy('2026-10-03', '3', '100'), sell('2026-10-04', '1')], '2026-10');
    // 100 / 3 = 33.333333...: one unit leaves at 33.3333, and the two left are worth what remains.
    expect(m).toMatchObject({ unitCost: '33.333333', outValue: '33.3333', closingQuantity: '2', closingValue: '66.6667' });
  });

  it('has no unit cost and values nothing at zero when nothing is there to spread the value over, and shows the stock negative', () => {
    const [m] = monthlyFigures([sell('2026-10-04', '5')], '2026-10');
    expect(m).toMatchObject({ unitCost: null, outQuantity: '5', outValue: '0', closingQuantity: '-5', closingValue: '0' });
  });

  it('ignores a move after the month asked for, and sums quantities with decimals exactly', () => {
    const months = monthlyFigures([buy('2026-10-03', '0.1', '10'), buy('2026-10-04', '0.2', '20'), buy('2026-11-01', '5', '500')], '2026-10');
    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({ inQuantity: '0.3', inValue: '30', unitCost: '100' });
  });
});

describe('the month after', () => {
  it('turns the year', () => {
    expect(nextMonth('2026-11')).toBe('2026-12');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('2026-09')).toBe('2026-10');
  });
});
