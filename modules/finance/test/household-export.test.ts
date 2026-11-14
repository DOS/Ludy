// SPDX-License-Identifier: AGPL-3.0-only
// The S1a-HKD workbook (#2517): the household's name and tax code, the book's title, the period and the day the books were opened, the rows with exact amounts, a total and a place for the
// signature; text is never read as a formula; the note about the unchecked layout shows while the book's row is `commentary`.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { HouseholdS1a } from '@crove/kernel-contract';
import { buildS1aWorkbook } from '../src/household-export.ts';

const book = (over: Partial<HouseholdS1a> = {}): HouseholdS1a => ({
  period: { period: '2026-09', from: '2026-09-01', to: '2026-09-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: '001234567890', representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S1a', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S1a-HKD)', status: 'commentary' },
  rows: [
    { entryId: '00000000-0000-4000-8000-000000000001', date: '2026-09-05', reference: '1C26TAA-00000042', description: 'Bán có hóa đơn', amount: '100000', reversal: false },
    { entryId: '00000000-0000-4000-8000-000000000002', date: '2026-09-20', reference: null, description: '=HYPERLINK("http://evil")', amount: '1234567890123456.5', reversal: false },
    { entryId: '00000000-0000-4000-8000-000000000003', date: '2026-09-25', reference: null, description: 'Đảo bán hàng lẻ', amount: '-60000', reversal: true },
  ],
  total: '1234567890163456.5',
  ...over,
});

async function sheetOf(b: HouseholdS1a): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildS1aWorkbook(b)) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet('S1a-HKD');
  if (!sheet) throw new Error('no sheet');
  return sheet;
}
const texts = (sheet: ExcelJS.Worksheet) => {
  const out: string[] = [];
  sheet.eachRow((row) => row.eachCell((cell) => out.push(String(cell.value))));
  return out;
};

describe('the S1a-HKD workbook', () => {
  it('heads the book with the household, the title, the period and the day it was opened, and ends with a signature place', async () => {
    const all = texts(await sheetOf(book()));
    expect(all).toContain('HỘ, CÁ NHÂN KINH DOANH: Hộ kinh doanh Nguyễn Văn A');
    expect(all).toContain('Mã số thuế: 001234567890');
    expect(all).toContain('SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ (S1A-HKD)');
    expect(all).toContain('Kỳ: từ 01/09/2026 đến 30/09/2026');
    expect(all).toContain('Ngày mở sổ: 01/01/2026');
    expect(all).toContain('Người đại diện hộ kinh doanh');
    expect(all).toContain('(Ký, họ tên)');
    expect(all).toContain('Nguyễn Văn A');
  });

  it('writes each row with its date, document, description and exact amount, and the total', async () => {
    const sheet = await sheetOf(book());
    const rows = new Map<string, ExcelJS.Row>();
    sheet.eachRow((row) => rows.set(String(row.getCell(3).value), row));
    const first = rows.get('Bán có hóa đơn');
    expect([first?.getCell(1).value, first?.getCell(2).value, first?.getCell(4).value]).toEqual(['05/09/2026', '1C26TAA-00000042', 100000]);
    // A reversal is marked and negative; an amount Excel cannot hold exactly stays exact text.
    expect(rows.get('Đảo bán hàng lẻ (bút toán đảo)')?.getCell(4).value).toBe(-60000);
    expect(rows.get('=HYPERLINK("http://evil")')?.getCell(4).value).toBe('1234567890123456.5');
    expect(rows.get('Cộng')?.getCell(4).value).toBe('1234567890163456.5');
  });

  it('never reads a description as a formula', async () => {
    const sheet = await sheetOf(book());
    let found = false;
    sheet.eachRow((row) => {
      const cell = row.getCell(3);
      if (cell.value === '=HYPERLINK("http://evil")') {
        found = true;
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.numFmt).toBe('@');
      }
    });
    expect(found).toBe(true);
  });

  it('says the layout is waiting for the accountant while the row is commentary, and not once it is confirmed', async () => {
    expect(texts(await sheetOf(book())).some((t) => t.startsWith('Ghi chú: bố cục sổ đang chờ kế toán'))).toBe(true);
    expect(texts(await sheetOf(book({ form: { book: 'S1a', version: '2026.1', name: 'Sổ', status: 'confirmed' } }))).some((t) => t.startsWith('Ghi chú'))).toBe(false);
  });
});
