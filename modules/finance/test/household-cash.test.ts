// SPDX-License-Identifier: AGPL-3.0-only
// The cash and bank book of the household income method (#2517, S2e): per account of 111 and 112 (sub-accounts at any depth) the opening balance, one row per line on that account alone, the running balance and the
// closing balance; the days before the book opened go into the opening balance; a parent never repeats its sub-accounts' lines; the sections add up to the ledger's balance of 111 and 112.
import { describe, expect, it } from 'vitest';
import { cashBook } from '../src/domain/household-cash.ts';

const chart = [
  { code: '111', name: 'Tiền mặt', parentCode: null },
  { code: '112', name: 'Tiền gửi ngân hàng', parentCode: null },
  { code: '1121', name: 'Ngân hàng A', parentCode: '112' },
  { code: '1122', name: 'Ngân hàng B', parentCode: '112' },
  { code: '131', name: 'Phải thu', parentCode: null },
  { code: '511', name: 'Doanh thu', parentCode: null },
  { code: '642', name: 'Chi phí', parentCode: null },
];
const open = (accountCode: string, debit: string, credit = '0') => ({ accountCode, partyId: null, debit, credit });
let n = 0;
const line = (entryId: string, entryDate: string, accountCode: string, debit: string, credit: string, extra: Partial<{ reference: string | null; reversal: boolean; lineNo: number }> = {}) => ({
  entryId,
  entryDate,
  reference: extra.reference ?? null,
  description: `e-${entryId}`,
  reversal: extra.reversal ?? false,
  lineNo: extra.lineNo ?? ++n,
  accountCode,
  partyId: null,
  debit,
  credit,
});

describe('cashBook', () => {
  it('gives each cash and bank account its opening, rows, totals and closing, and leaves other accounts out', () => {
    const lines = [
      line('a', '2026-09-03', '111', '1000000', '0'),
      line('a', '2026-09-03', '511', '0', '1000000'),
      line('b', '2026-09-10', '1121', '0', '200000'),
      line('b', '2026-09-10', '642', '200000', '0'),
      line('c', '2026-09-15', '111', '0', '300000'),
      line('c', '2026-09-15', '1122', '300000', '0'),
    ];
    const book = cashBook(chart, [open('111', '500000'), open('1121', '2000000')], lines, '2026-09-01');
    expect(book.map((s) => s.accountCode)).toEqual(['111', '1121', '1122']);
    const cash = book[0]!;
    expect(cash).toMatchObject({ accountName: 'Tiền mặt', opening: '500000', totalIn: '1000000', totalOut: '300000', closing: '1200000' });
    expect(cash.rows.map((r) => [r.cashIn, r.cashOut, r.balance, r.counterAccounts])).toEqual([
      ['1000000', '0', '1500000', ['511']],
      ['0', '300000', '1200000', ['1122']],
    ]);
    expect(book[1]).toMatchObject({ opening: '2000000', totalIn: '0', totalOut: '200000', closing: '1800000' });
    expect(book[2]).toMatchObject({ opening: '0', totalIn: '300000', closing: '300000' });
  });

  it('puts the days before the book opened into the opening balance, so the book starts from the right balance', () => {
    const lines = [line('a', '2026-09-02', '111', '700000', '0'), line('b', '2026-09-20', '111', '100000', '0')];
    const [cash] = cashBook(chart, [open('111', '50000')], lines, '2026-09-10');
    expect(cash!.opening).toBe('750000');
    expect(cash!.rows).toHaveLength(1);
    expect(cash!.closing).toBe('850000');
  });

  it('leaves out an account with no opening balance and no line in the days, and keeps one with lines whose balance returns to zero', () => {
    expect(cashBook(chart, [], [line('a', '2026-09-02', '511', '0', '5')], '2026-09-01')).toEqual([]);
    const zero = cashBook(chart, [], [line('a', '2026-09-02', '111', '100', '0'), line('b', '2026-09-03', '111', '0', '100')], '2026-09-01');
    expect(zero).toHaveLength(1);
    expect(zero[0]!.closing).toBe('0');
  });

  it('shows a reversal as its own row and a negative balance as it is', () => {
    const lines = [line('a', '2026-09-02', '111', '0', '400000'), line('r', '2026-09-03', '111', '400000', '0', { reversal: true })];
    const [cash] = cashBook(chart, [open('111', '100000')], lines, '2026-09-01');
    expect(cash!.rows.map((r) => [r.reversal, r.balance])).toEqual([[false, '-300000'], [true, '100000']]);
    const [neg] = cashBook(chart, [], [line('a', '2026-09-02', '111', '0', '50')], '2026-09-01');
    expect(neg!.closing).toBe('-50');
  });

  it('adds up to the ledger: the closings of the sections equal the net of every line on 111 and 112 plus the openings', () => {
    const lines = [line('a', '2026-09-03', '1121', '123.5', '0'), line('b', '2026-09-04', '112', '0', '20'), line('c', '2026-09-05', '111', '9', '0')];
    const book = cashBook(chart, [open('111', '1'), open('1122', '4', '1')], lines, '2026-09-01');
    const closing = book.reduce((s, a) => s + Number(a.closing), 0);
    expect(closing).toBeCloseTo(1 + 3 + 123.5 - 20 + 9, 6);
  });
});
