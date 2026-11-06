// SPDX-License-Identifier: AGPL-3.0-only
// The close of a month of stock (#2513): the cost per item to the last dong, the entry that posts it and why it balances, a negative item blocking the close, the cost coming back
// into stock, several stock accounts, and a month that opens with the balance of a closed one. Pure; the moves are made in code.
import { describe, expect, it } from 'vitest';
import { money } from '@crove/l10n-vn';
import { closeDescription, closeMonth, monthEnd, type CloseItem } from '../src/domain/stock-close.ts';

const item = (code: string, moves: CloseItem['moves'], extra: Partial<CloseItem> = {}): CloseItem => ({ itemId: `id-${code}`, code, name: `Hàng ${code}`, unit: 'cái', stockAccount: '156', moves, ...extra });

describe('the cost of a closed month', () => {
  it('prices what left at the month\'s average of two receipts at two prices, to the last dong, and the entry balances', () => {
    // Ten in at 100,000 each, four out, ten more in at 130,000 each, six out: the average is 2,300,000 / 20 = 115,000, so the ten that left cost 1,150,000.
    const result = closeMonth(
      [
        item('QC', [
          { date: '2026-10-02', quantity: '10', value: '1000000' },
          { date: '2026-10-05', quantity: '-4', value: null },
          { date: '2026-10-12', quantity: '10', value: '1300000' },
          { date: '2026-10-20', quantity: '-6', value: null },
        ]),
      ],
      '2026-10',
    );
    expect(result.items[0]).toMatchObject({ openingQuantity: '0', inQuantity: '20', inValue: '2300000', outQuantity: '10', outValue: '1150000', closingQuantity: '10', closingValue: '1150000', unitCost: '115000' });
    expect(result.lines).toEqual([
      { account: '156', debit: '0', credit: '1150000' },
      { account: '632', debit: '1150000', credit: '0' },
    ]);
    expect(result.total).toBe('1150000');
    expect(result.negative).toEqual([]);
  });

  it('rounds what left to a whole dong and leaves the rest in the closing value, so opening plus in less out is closing', () => {
    // Three in for 100: a third of 100 is 33.33; one out costs 33 and the two left are worth 67.
    const result = closeMonth([item('A', [{ date: '2026-10-02', quantity: '3', value: '100' }, { date: '2026-10-03', quantity: '-1', value: null }])], '2026-10');
    expect(result.items[0]).toMatchObject({ outValue: '33', closingValue: '67', closingQuantity: '2' });
    expect(money(result.items[0]?.inValue ?? '0').minus(result.items[0]?.outValue ?? '0').toFixed()).toBe(result.items[0]?.closingValue);
    expect(result.lines).toEqual([
      { account: '156', debit: '0', credit: '33' },
      { account: '632', debit: '33', credit: '0' },
    ]);
  });

  it('names an item below zero at the end of the month, which blocks the close', () => {
    const result = closeMonth([item('OK', [{ date: '2026-10-02', quantity: '5', value: '500' }]), item('NEG', [{ date: '2026-10-02', quantity: '2', value: '200' }, { date: '2026-10-09', quantity: '-5', value: null }])], '2026-10');
    expect(result.negative).toEqual([{ itemId: 'id-NEG', code: 'NEG', name: 'Hàng NEG', closingQuantity: '-3' }]);
  });

  it('takes cost back into stock when more came back than left: the sides swap and 632 takes the credit', () => {
    // Seven on hand at 100 each from an earlier month; three come back from a sale of that month: the cost of goods sold falls by 300.
    const result = closeMonth([item('R', [{ date: '2026-11-04', quantity: '3', value: null }], { opening: { quantity: '7', value: '700' } })], '2026-11');
    expect(result.items[0]).toMatchObject({ openingQuantity: '7', openingValue: '700', outQuantity: '-3', outValue: '-300', closingQuantity: '10', closingValue: '1000' });
    expect(result.lines).toEqual([
      { account: '156', debit: '300', credit: '0' },
      { account: '632', debit: '0', credit: '300' },
    ]);
    expect(result.total).toBe('300');
  });

  it('keeps one line per stock account and lets 632 take the balance of them all', () => {
    const result = closeMonth(
      [
        item('A', [{ date: '2026-10-02', quantity: '10', value: '1000' }, { date: '2026-10-03', quantity: '-5', value: null }]),
        item('B', [{ date: '2026-10-02', quantity: '4', value: '800' }, { date: '2026-10-03', quantity: '-1', value: null }], { stockAccount: '156.HK' }),
        item('C', [{ date: '2026-10-02', quantity: '2', value: '400' }, { date: '2026-10-04', quantity: '-2', value: null }]),
      ],
      '2026-10',
    );
    // A: 5 x 100 = 500, C: 2 x 200 = 400, both on 156 (900); B: 1 x 200 on 156.HK.
    expect(result.lines).toEqual([
      { account: '156', debit: '0', credit: '900' },
      { account: '156.HK', debit: '0', credit: '200' },
      { account: '632', debit: '1100', credit: '0' },
    ]);
    expect(result.total).toBe('1100');
  });

  it('proposes no entry for a month in which nothing left, and carries the balance of an item with no move', () => {
    const result = closeMonth([item('A', [{ date: '2026-10-02', quantity: '10', value: '1000' }]), item('B', [], { opening: { quantity: '4', value: '400' } }), item('NOTHING', [])], '2026-10');
    expect(result.lines).toEqual([]);
    expect(result.total).toBe('0');
    expect(result.items.map((i) => i.code)).toEqual(['A', 'B']);
    expect(result.items[1]).toMatchObject({ openingQuantity: '4', closingQuantity: '4', closingValue: '400', inQuantity: '0' });
  });

  it('names the items that moved with no value to price them at, and not an item priced from its opening or a purchase', () => {
    // Ten entered by hand and four out: nothing to average over, so what left would cost zero. A purchase or an opening value gives a price.
    const result = closeMonth(
      [
        item('LOOSE', [{ date: '2026-10-02', quantity: '10', value: null }, { date: '2026-10-05', quantity: '-4', value: null }]),
        item('BOUGHT', [{ date: '2026-10-02', quantity: '10', value: '1000' }, { date: '2026-10-05', quantity: '-4', value: null }]),
        item('OPENED', [{ date: '2026-10-05', quantity: '-1', value: null }], { opening: { quantity: '4', value: '400' } }),
        item('RETURNED', [{ date: '2026-10-05', quantity: '2', value: null }]),
      ],
      '2026-10',
    );
    expect(result.unpriced.map((u) => [u.code, u.outQuantity])).toEqual([
      ['LOOSE', '-6'],
      ['RETURNED', '-2'],
    ]);
  });

  it('writes the voucher date and description of a month', () => {
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(monthEnd('2026-12')).toBe('2026-12-31');
    expect(closeDescription('2026-10')).toBe('Giá vốn hàng bán tháng 10/2026 (đóng sổ kho)');
  });
});
