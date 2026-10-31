// SPDX-License-Identifier: AGPL-3.0-only
// The statement header detection both the browser import and the sandbox use (#326, #2142): the account number above
// the header and the lines under it. The column detection itself is covered through the browser import in
// apps/app/test/bank-statement.test.ts.
import { describe, expect, it } from 'vitest';
import { findAccountNumber, findColumns, statementLines, type StatementCell, type StatementGrid } from '../src/index.ts';

const grid = (rows: Record<number, Array<string | number | null>>): StatementGrid =>
  new Map(
    Object.entries(rows).map(([n, cells]) => [
      Number(n),
      new Map(
        cells.flatMap((v, col): Array<[number, StatementCell]> =>
          v === null ? [] : [[col, typeof v === 'number' ? { kind: 'number', value: String(v) } : { kind: 'text', value: v }]],
        ),
      ),
    ]),
  );

const HEADER = ['Ngày giao dịch', 'Diễn giải', 'Ghi nợ', 'Ghi có', 'Số dư', 'Số tham chiếu'];

describe('findAccountNumber', () => {
  it('reads the number after the label in the same cell, whatever its grouping', () => {
    expect(findAccountNumber(grid({ 1: ['SAO KÊ TÀI KHOẢN'], 2: ['Số tài khoản: 0011 0000 0000'], 4: HEADER }), 4)).toBe('001100000000');
    expect(findAccountNumber(grid({ 2: ['Số TK: 0011.0000.0000'], 4: HEADER }), 4)).toBe('001100000000');
    expect(findAccountNumber(grid({ 2: ['Account number: 001100000000'], 4: HEADER }), 4)).toBe('001100000000');
  });

  it('reads the number in the cell beside the label', () => {
    expect(findAccountNumber(grid({ 2: ['Số tài khoản', '001100000000'], 4: HEADER }), 4)).toBe('001100000000');
    expect(findAccountNumber(grid({ 2: ['STK', 123456789012], 4: HEADER }), 4)).toBe('123456789012');
  });

  it('skips a label whose value is not a number, and takes the next one that is', () => {
    const rows = grid({ 1: ['Tên tài khoản: CÔNG TY TNHH MẪU'], 2: ['Số tài khoản: 001100000000'], 4: HEADER });
    expect(findAccountNumber(rows, 4)).toBe('001100000000');
    expect(findAccountNumber(grid({ 1: ['Tên tài khoản: CÔNG TY TNHH MẪU'], 4: HEADER }), 4)).toBeNull();
  });

  it('finds nothing below the header or when no cell names an account', () => {
    expect(findAccountNumber(grid({ 1: ['SAO KÊ'], 2: ['Từ ngày 01/09/2026 đến ngày 30/09/2026'], 3: HEADER }), 3)).toBeNull();
    expect(findAccountNumber(grid({ 1: HEADER, 2: ['Số tài khoản: 001100000000'] }), 1)).toBeNull();
    // Too short to be an account number.
    expect(findAccountNumber(grid({ 1: ['Số tài khoản: 12345'], 3: HEADER }), 3)).toBeNull();
  });
});

describe('statementLines', () => {
  const rows = grid({
    1: ['Số tài khoản: 001100000000'],
    3: HEADER,
    4: ['01/09/2026', 'Thu tiền hàng', null, '1.500.000', '11.500.000', 'FT001'],
    5: ['02/09/2026', 'Phí', 11000, null, 11489000, 'FT002'],
    6: ['Tổng cộng', null, 11000, '1.500.000'],
  });

  it('lists the rows whose date holds a digit, with the amount cells as they are', () => {
    const mapping = findColumns(rows);
    expect(mapping?.headerRow).toBe(3);
    const lines = statementLines(rows, mapping as NonNullable<typeof mapping>, 100);
    expect(lines?.map((l) => [l.rowNo, l.date, l.description, l.reference])).toEqual([
      [4, '01/09/2026', 'Thu tiền hàng', 'FT001'],
      [5, '02/09/2026', 'Phí', 'FT002'],
    ]);
    expect(lines?.[0]?.moneyIn).toEqual({ kind: 'text', value: '1.500.000' });
    expect(lines?.[1]?.moneyOut).toEqual({ kind: 'number', value: '11000' });
    expect(lines?.[1]?.balance).toEqual({ kind: 'number', value: '11489000' });
  });

  it('is null when the file has more lines than allowed', () => {
    const mapping = findColumns(rows) as NonNullable<ReturnType<typeof findColumns>>;
    expect(statementLines(rows, mapping, 2)).toHaveLength(2);
    expect(statementLines(rows, mapping, 1)).toBeNull();
  });

  it('takes a file with one signed amount column as money in', () => {
    const signed = grid({ 1: ['Ngày', 'Nội dung', 'Số tiền'], 2: ['01/09/2026', 'Chi', '-50000'] });
    const mapping = findColumns(signed) as NonNullable<ReturnType<typeof findColumns>>;
    const [line] = statementLines(signed, mapping, 10) ?? [];
    expect(line?.moneyIn?.value).toBe('-50000');
    expect(line?.moneyOut).toBeUndefined();
  });
});
