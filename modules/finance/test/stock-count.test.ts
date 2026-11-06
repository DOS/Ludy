// SPDX-License-Identifier: AGPL-3.0-only
// The count of stock (#2513 part b): the difference per item, what it is worth to the last dong, the shortage split at the norm, the entry that posts it and why it balances, and the items
// that differ with no cost to price them at. Pure; the quantities are made in code.
import { describe, expect, it } from 'vitest';
import { money } from '@crove/l10n-vn';
import { countDescription, countDifferences, type CountItem } from '../src/domain/stock-count.ts';

const item = (code: string, bookQuantity: string, countedQuantity: string, extra: Partial<CountItem> = {}): CountItem => ({
  itemId: `id-${code}`,
  code,
  name: `Hàng ${code}`,
  unit: 'cái',
  stockAccount: '156',
  bookQuantity,
  averageCost: '100',
  countedQuantity,
  unitCost: null,
  ...extra,
});

describe('the difference of a count', () => {
  it('splits a shortage at the norm: the part within it to 632, the rest to 1381, both out of the stock account', () => {
    // Ten on the books, seven counted at an average of 100: three are missing worth 300; a norm of 10 percent allows one of the ten, worth 100.
    const result = countDifferences([item('A', '10', '7')], '10');
    expect(result.lines[0]).toMatchObject({ difference: '-3', unitCost: '100', value: '-300', withinNorm: '100' });
    expect(result.entry).toEqual([
      { account: '1381', debit: '200', credit: '0' },
      { account: '156', debit: '0', credit: '300' },
      { account: '632', debit: '100', credit: '0' },
    ]);
    expect(result.total).toBe('300');
    expect(result.unpriced).toEqual([]);
  });

  it('puts a surplus into the stock account against 3381, at the cost the person typed when the books have none', () => {
    const result = countDifferences([item('B', '2', '5', { averageCost: null, unitCost: '50' })], '0');
    expect(result.lines[0]).toMatchObject({ difference: '3', unitCost: '50', value: '150', withinNorm: '0' });
    expect(result.entry).toEqual([
      { account: '156', debit: '150', credit: '0' },
      { account: '3381', debit: '0', credit: '150' },
    ]);
    expect(result.total).toBe('150');
  });

  it('prefers the cost typed to the average, and names an item that differs with no cost at all', () => {
    const typed = countDifferences([item('T', '4', '3', { unitCost: '70' })], '0');
    expect(typed.lines[0]).toMatchObject({ unitCost: '70', value: '-70' });
    const none = countDifferences([item('C', '0', '4', { averageCost: null }), item('D', '5', '5', { averageCost: null })], '0');
    expect(none.unpriced).toEqual([{ itemId: 'id-C', code: 'C', name: 'Hàng C' }]);
    expect(none.entry).toEqual([]);
    expect(none.total).toBe('0');
    // An item that matches the books has no difference, so it needs no cost.
    expect(none.lines[1]).toMatchObject({ difference: '0', value: '0' });
  });

  it('rounds what a difference is worth to a whole dong and keeps the entry balanced', () => {
    // One of three missing at 33.333333 a unit is worth 33.
    const result = countDifferences([item('E', '3', '2', { averageCost: '33.333333' }), item('F', '1', '3', { averageCost: '10.5' })], '0');
    expect(result.lines.map((l) => l.value)).toEqual(['-33', '21']);
    const debits = result.entry.reduce((sum, l) => sum.plus(money(l.debit)), money(0));
    const credits = result.entry.reduce((sum, l) => sum.plus(money(l.credit)), money(0));
    expect(debits.toFixed()).toBe(credits.toFixed());
    expect(result.total).toBe(debits.toFixed());
  });

  it('never lets the norm allow more than the shortage, and allows nothing on a book quantity that is not above zero', () => {
    expect(countDifferences([item('G', '10', '0')], '100').lines[0]).toMatchObject({ value: '-1000', withinNorm: '1000' });
    expect(countDifferences([item('H', '10', '9')], '100').lines[0]).toMatchObject({ value: '-100', withinNorm: '100' });
    // A negative book quantity counted up to zero is a surplus, not a shortage.
    expect(countDifferences([item('I', '-3', '0')], '50').lines[0]).toMatchObject({ difference: '3', value: '300', withinNorm: '0' });
  });

  it('keeps a debit and a credit line on the same stock account when one item is short and another over', () => {
    const result = countDifferences([item('J', '5', '4'), item('K', '1', '2')], '100');
    expect(result.entry).toEqual([
      { account: '156', debit: '0', credit: '100' },
      { account: '156', debit: '100', credit: '0' },
      { account: '3381', debit: '0', credit: '100' },
      { account: '632', debit: '100', credit: '0' },
    ]);
    expect(result.total).toBe('200');
  });

  it('writes the description of the voucher with the date of the count', () => {
    expect(countDescription('2026-11-03')).toBe('Chênh lệch kiểm kê kho ngày 03/11/2026');
  });
});
