// SPDX-License-Identifier: AGPL-3.0-only
// The bank bulk-salary workbook (#2532): every cell is a string cell with the Text format, so a name or a remark that a spreadsheet program would read as a formula (= + - @, a tab or a line break)
// stays inert; no apostrophe is added to the data (the bank reads the cell text); the columns come in the order asked for; nothing is a number, a formula or a rich value.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { HR_BANK_FILE_COLUMNS, HR_BANK_FILE_HEADERS, type HrBankFile } from '@crove/kernel-contract';
import { buildBankFileWorkbook } from '../src/bank-file-xlsx.ts';

const DANGEROUS = ['=HYPERLINK("http://evil.test","x")', '+84 Trần Văn Hai', '-Lê Thu Cúc', '@SUM(A1)', '\tTab đầu dòng', '\rCR đầu dòng', '=1+1'];
const FILE: HrBankFile = {
  runId: '11111111-1111-4111-8111-111111111111',
  month: '2026-03',
  bankCode: 'VCB',
  columns: ['seq', 'name', 'account', 'bank', 'amount', 'content'],
  headers: HR_BANK_FILE_COLUMNS.map((c) => HR_BANK_FILE_HEADERS[c]),
  rows: DANGEROUS.map((name, i) => ({ seq: String(i + 1), name, account: `ACCT-700${i}`, bank: '=Vietcombank', amount: `${9_000_000 + i}`, content: '-Luong thang 03/2026' })),
  total: '63000021',
  otherPeople: 0,
};

async function sheetOf(file: HrBankFile): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await buildBankFileWorkbook(file)) as never);
  return workbook.worksheets[0] as ExcelJS.Worksheet;
}

describe('the bank salary workbook', () => {
  it('writes every cell as a string cell with the Text format, never a formula, a number or a rich value', async () => {
    const sheet = await sheetOf(FILE);
    expect(sheet.rowCount).toBe(DANGEROUS.length + 1);
    let cells = 0;
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        cells++;
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.numFmt).toBe('@');
        expect(typeof cell.value).toBe('string');
        // A formula cell would carry a `formula` or a `result`; a string cell is the string itself.
        expect((cell as unknown as { formula?: string }).formula).toBeUndefined();
      }),
    );
    expect(cells).toBe((DANGEROUS.length + 1) * 6);
  });

  it('keeps the texts as given, with no apostrophe in front, so the bank reads the same name and account', async () => {
    const sheet = await sheetOf(FILE);
    // (a tab or a line break at the start is cleaned out of a name before the file is built, so it is not in this check)
    DANGEROUS.forEach((name, i) => {
      if (/^[\t\r]/.test(name)) return;
      expect(sheet.getRow(i + 2).getCell(2).value).toBe(name);
      expect(sheet.getRow(i + 2).getCell(4).value).toBe('=Vietcombank');
      expect(sheet.getRow(i + 2).getCell(6).value).toBe('-Luong thang 03/2026');
    });
    expect(sheet.getRow(2).getCell(5).value).toBe('9000000');
  });

  it('writes the columns in the order asked for, with their headers', async () => {
    const sheet = await sheetOf({ ...FILE, columns: ['account', 'amount', 'name'], headers: ['Số tài khoản', 'Số tiền', 'Tên người nhận'] });
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(['Số tài khoản', 'Số tiền', 'Tên người nhận']);
    expect((sheet.getRow(2).values as unknown[]).slice(1)).toEqual(['ACCT-7000', '9000000', '=HYPERLINK("http://evil.test","x")']);
  });

  it('writes the headers of a saved template as given, as string cells with the Text format, even when one reads as a formula (#2893)', async () => {
    const headers = ['=HYPERLINK("http://evil.test","STT")', '+Ten', '-So TK', '@Bank', '=1+1', 'Noi dung'];
    const sheet = await sheetOf({ ...FILE, headers });
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(headers);
    sheet.getRow(1).eachCell((cell) => {
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.numFmt).toBe('@');
      expect((cell as unknown as { formula?: string }).formula).toBeUndefined();
    });
  });
});
