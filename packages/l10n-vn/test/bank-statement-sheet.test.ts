// SPDX-License-Identifier: AGPL-3.0-only
// The statement header detection both the browser import and the sandbox use (#326, #2142): the account number above
// the header and the lines under it. The column detection itself is covered through the browser import in
// apps/app/test/bank-statement.test.ts.
import { describe, expect, it } from 'vitest';
import { findAccountNumber, findColumns, parseCsv, statementLines, type StatementCell, type StatementGrid } from '../src/index.ts';

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

describe('parseCsv', () => {
  it('takes the delimiter from outside the quoted cells, so quoted commas do not make a semicolon file a comma file', () => {
    const text = 'Ngày;Diễn giải;Số tiền\n01/09/2026;"Thu tiền hàng A, B, C, D";1500000\n02/09/2026;"Phí, thuế, lệ phí";11000\n';
    const rows = parseCsv(text);
    expect([...(rows.get(2) ?? [])].map(([, cell]) => cell.value)).toEqual(['01/09/2026', 'Thu tiền hàng A, B, C, D', '1500000']);
    const mapping = findColumns(rows);
    expect(mapping?.columns).toMatchObject({ date: 0, description: 1, amount: 2 });
    // A quote inside a quoted cell is written twice, and a tab file is still a tab file.
    expect([...(parseCsv('a\tb\n"x ""y"", z"\tw\n').get(2) ?? [])].map(([, cell]) => cell.value)).toEqual(['x "y", z', 'w']);
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

  it('leaves out a totals or balance row even when its label carries a year', () => {
    const withTotals = grid({
      1: HEADER,
      2: ['01/09/2026', 'Thu tiền hàng', null, '1.500.000', '11.500.000', 'FT001'],
      3: ['Tổng cộng 2026', null, 11000, '1.500.000'],
      4: ['Số dư cuối kỳ 30/09/2026', null, null, null, '11.489.000'],
      5: ['02/09/2026', 'Phí', 11000, null, 11489000, 'FT002'],
    });
    const mapping = findColumns(withTotals) as NonNullable<ReturnType<typeof findColumns>>;
    expect(statementLines(withTotals, mapping, 100)?.map((l) => l.rowNo)).toEqual([2, 5]);
  });
});

describe('findAccountNumber, which decides the account the lines go to', () => {
  it('ignores a label of the other party, whatever its row', () => {
    const rows = grid({
      1: ['Tài khoản thụ hưởng: 123456789012'],
      2: ['Số tài khoản đối ứng: 210987654321'],
      3: ['Số tài khoản: 001100000999'],
      5: HEADER,
    });
    expect(findAccountNumber(rows, 5)).toBe('001100000999');
    // Only the other party's labels: no account is named.
    expect(findAccountNumber(grid({ 1: ['Tài khoản thụ hưởng: 123456789012'], 3: HEADER }), 3)).toBeNull();
    expect(findAccountNumber(grid({ 1: ['Beneficiary account number: 123456789012'], 2: ['Sender account: 210987654321'], 4: HEADER }), 4)).toBeNull();
  });

  it('prefers the strong label to a bare "Tài khoản", and takes the bare one when it is alone', () => {
    expect(findAccountNumber(grid({ 1: ['Tài khoản: 111111111111'], 2: ['Số tài khoản: 222222222222'], 4: HEADER }), 4)).toBe('222222222222');
    expect(findAccountNumber(grid({ 1: ['Tài khoản: 111111111111'], 3: HEADER }), 3)).toBe('111111111111');
  });

  it('names no account when two different numbers stand under equally strong labels, and one number twice is that number', () => {
    expect(findAccountNumber(grid({ 1: ['Số tài khoản: 111111111111'], 2: ['STK: 222222222222'], 4: HEADER }), 4)).toBeNull();
    expect(findAccountNumber(grid({ 1: ['Số tài khoản: 1111 1111 1111'], 2: ['STK: 111111111111'], 4: HEADER }), 4)).toBe('111111111111');
  });
});

describe('parseCsv, choosing the delimiter from the table', () => {
  it('reads a semicolon table under a preamble with more commas than the table has semicolons, and a table that starts late', () => {
    const preamble = Array.from({ length: 12 }, () => 'Công ty A, chi nhánh B, địa chỉ C, thành phố D, quốc gia E').join('\n');
    const rows = parseCsv(`${preamble}\nNgày;Diễn giải;Số tiền\n01/09/2026;Thu tiền;1500000\n`);
    expect(findColumns(rows)).toMatchObject({ columns: { date: 0, description: 1, amount: 2 } });
    // The header is looked for in the first 30 rows, so the table starts at row 26 here; the first ten lines held no semicolon.
    const late = parseCsv(`${Array.from({ length: 25 }, () => 'a, b, c, d, e, f').join('\n')}\nNgày;Số tiền\n01/09/2026;1500000\n`);
    expect(findColumns(late)).toMatchObject({ columns: { date: 0, amount: 1 } });
  });

  it('keeps the most used delimiter when no delimiter gives a table', () => {
    const rows = parseCsv('a,b,c\n1,2,3\n');
    expect([...(rows.get(1) ?? [])].map(([, cell]) => cell.value)).toEqual(['a', 'b', 'c']);
  });
});
