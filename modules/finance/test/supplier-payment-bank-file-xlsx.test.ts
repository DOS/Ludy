// SPDX-License-Identifier: AGPL-3.0-only
// The bank file of supplier payments as a workbook (#3113 S3b-2): the holder, the account number, the bank and the remark are string cells with the Text format (a name that a spreadsheet program
// would read as a formula stays inert, an account number keeps its leading zeros), the amount is a money cell, and no cell is a formula.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { SupplierPaymentBankFile } from '@crove/kernel-contract';
import { buildSupplierPaymentBankFileWorkbook } from '../src/supplier-payment-bank-file-xlsx.ts';

const DANGEROUS = ['=HYPERLINK("http://evil.test","x")', '+84 Trần Văn Hai', '-Lê Thu Cúc', '@SUM(A1)', '=1+1'];
const FILE: SupplierPaymentBankFile = {
  currency: 'VND',
  rows: DANGEROUS.map((holder, i) => ({ seq: String(i + 1), holder, account: `00123456${i}`, bank: '=Vietcombank', amount: `${1_000_000 + i}`, content: '-Thanh toan hoa don 12' })),
  total: '5000010',
};

async function sheetOf(file: SupplierPaymentBankFile): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await buildSupplierPaymentBankFileWorkbook(file)) as never);
  return workbook.worksheets[0] as ExcelJS.Worksheet;
}

describe('the supplier payments bank workbook', () => {
  it('writes the holder, the account, the bank and the remark as Text string cells, and no cell as a formula', async () => {
    const sheet = await sheetOf(FILE);
    expect(sheet.rowCount).toBe(DANGEROUS.length + 1);
    sheet.eachRow((row, rowNumber) =>
      row.eachCell((cell, col) => {
        expect((cell as unknown as { formula?: string }).formula).toBeUndefined();
        if (rowNumber > 1 && col === 5) return;
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.numFmt).toBe('@');
      }),
    );
  });

  it('keeps the texts as given, with no apostrophe in front, and the leading zeros of an account number', async () => {
    const sheet = await sheetOf(FILE);
    DANGEROUS.forEach((holder, i) => {
      const row = sheet.getRow(i + 2);
      expect(row.getCell(2).value).toBe(holder);
      expect(row.getCell(3).value).toBe(`00123456${i}`);
      expect(row.getCell(4).value).toBe('=Vietcombank');
      expect(row.getCell(6).value).toBe('-Thanh toan hoa don 12');
    });
  });

  it('writes the amount as a number with its format, or the exact decimal as text when Excel cannot hold it', async () => {
    const sheet = await sheetOf({ ...FILE, rows: [{ ...(FILE.rows[0] as SupplierPaymentBankFile['rows'][number]), amount: '1500000' }, { ...(FILE.rows[1] as SupplierPaymentBankFile['rows'][number]), amount: '12345678901234567.89' }] });
    expect(sheet.getRow(2).getCell(5).value).toBe(1_500_000);
    expect(sheet.getRow(2).getCell(5).numFmt).toBe('#,##0');
    expect(sheet.getRow(3).getCell(5).value).toBe('12345678901234567.89');
    expect(sheet.getRow(3).getCell(5).numFmt).toBe('@');
  });
});
