// SPDX-License-Identifier: AGPL-3.0-only
// The S2d-HKD workbook (#2517 slice 2d): the household, the title and the month on top; one section per item with opening, move rows, totals line and closing value; the total of all items; a signature place.
// An open month says the cost is provisional; while the layout row is `commentary` the file says so on top and puts the provisional label in a note column; once confirmed there is none. Text is never a formula.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { HOUSEHOLD_LAYOUT_PROVISIONAL_LABEL, type HouseholdS2d } from '@crove/kernel-contract';
import { buildS2dWorkbook } from '../src/household-export.ts';

const E = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const book = (over: Partial<HouseholdS2d> = {}): HouseholdS2d => ({
  period: { month: '2026-09', from: '2026-09-01', to: '2026-09-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: '001234567890', representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2d', version: '2026.1', name: 'Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa (S2d-HKD)', status: 'commentary' },
  items: [
    {
      itemId: E(1),
      code: '=SKU1',
      name: 'Gạo thơm',
      unit: 'kg',
      openingQuantity: '0',
      openingValue: '0',
      rows: [
        { moveId: E(2), date: '2026-09-05', source: 'document_line', reference: 'AA-0001', quantityIn: '10', quantityOut: '0', valueIn: '1000000', balanceQuantity: '10' },
        { moveId: E(3), date: '2026-09-10', source: 'manual', reference: null, quantityIn: '0', quantityOut: '4', valueIn: null, balanceQuantity: '6' },
      ],
      inQuantity: '10',
      inValue: '1000000',
      outQuantity: '4',
      outValue: '400000',
      closingQuantity: '6',
      closingValue: '600000',
      unitCost: '100000',
    },
  ],
  totals: { openingValue: '0', inValue: '1000000', outValue: '400000', closingValue: '600000' },
  monthClosed: false,
  unconfirmed: [{ kind: 'form', key: 'S2d 2026.1', effectiveFrom: '2026-01-01' }],
  commentary: true,
  ...over,
});

async function rowsOf(b: HouseholdS2d): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildS2dWorkbook(b)) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet('S2d-HKD');
  if (!sheet) throw new Error('no sheet');
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    for (let i = 1; i <= sheet.columnCount; i += 1) cells.push(row.getCell(i).value === null ? '' : String(row.getCell(i).value));
    rows.push(cells);
  });
  return rows;
}
const [DATE, REF, DESC, INQ, OUTQ, VALIN, BAL, NOTE] = [0, 1, 2, 3, 4, 5, 6, 7];

describe('the S2d-HKD workbook', () => {
  it('heads the book, says Ludy files nothing, and ends with a signature place', async () => {
    const all = (await rowsOf(book())).flat();
    expect(all).toContain('HỘ, CÁ NHÂN KINH DOANH: Hộ kinh doanh Nguyễn Văn A');
    expect(all).toContain('Mã số thuế: 001234567890');
    expect(all).toContain('SỔ CHI TIẾT VẬT LIỆU, DỤNG CỤ, SẢN PHẨM, HÀNG HÓA (S2D-HKD)');
    expect(all).toContain('Tháng: từ 01/09/2026 đến 30/09/2026');
    expect(all.some((t) => t.includes('Ludy không nộp tờ khai'))).toBe(true);
    expect(all).toContain('(Ký, họ tên)');
  });

  it('writes the item section: opening, each move, the month totals and the closing value; text stays text', async () => {
    const rows = await rowsOf(book());
    expect(rows.flat()).toContain('=SKU1 - Gạo thơm (kg)');
    const purchase = rows.find((r) => r[REF] === 'AA-0001')!;
    expect([purchase[DATE], purchase[DESC], purchase[INQ], purchase[OUTQ], purchase[VALIN], purchase[BAL]]).toEqual(['05/09/2026', 'Từ hóa đơn', '10', '0', '1000000', '10']);
    const out = rows.find((r) => r[DESC] === 'Nhập tay')!;
    expect([out[INQ], out[OUTQ], out[VALIN], out[BAL]]).toEqual(['0', '4', '', '6']);
    const totals = rows.find((r) => r[DESC]?.startsWith('Cộng tháng'))!;
    expect(totals[DESC]).toBe('Cộng tháng: nhập 10 (1000000), xuất 4 (400000), đơn giá bình quân 100000');
    expect(totals[BAL]).toBe('6');
    expect(rows.find((r) => r[DESC] === 'Giá trị tồn cuối tháng' && r[VALIN] === '600000')).toBeTruthy();
    expect(rows.find((r) => r[DESC]?.startsWith('Tồn đầu tháng'))![BAL]).toBe('0');
  });

  it('gives the total value of all items', async () => {
    const rows = await rowsOf(book());
    for (const [label, value] of [['Giá trị tồn đầu tháng', '0'], ['Giá trị nhập', '1000000'], ['Giá trị xuất', '400000']] as const) {
      expect(rows.find((r) => r[DESC] === label)![VALIN]).toBe(value);
    }
  });

  it('says the month is open until it is closed', async () => {
    expect((await rowsOf(book())).flat().some((t) => t.includes('Tháng này chưa chốt'))).toBe(true);
    expect((await rowsOf(book({ monthClosed: true }))).flat().some((t) => t.includes('Tháng này chưa chốt'))).toBe(false);
  });

  it('labels the figures and lists the unconfirmed row while the layout is commentary, and says nothing once it is confirmed', async () => {
    const draft = await rowsOf(book());
    expect(draft.flat()).toContain(HOUSEHOLD_LAYOUT_PROVISIONAL_LABEL.toUpperCase());
    expect(draft.flat().some((t) => t.includes('Chưa xác nhận: mẫu S2d 2026.1'))).toBe(true);
    expect(draft.find((r) => r[REF] === 'AA-0001')![NOTE]).toBe(HOUSEHOLD_LAYOUT_PROVISIONAL_LABEL);
    const confirmed = await rowsOf(book({ commentary: false, unconfirmed: [], form: { book: 'S2d', version: '2026.1', name: 'S2d', status: 'confirmed' } }));
    expect(confirmed.flat().some((t) => t.includes('Số liệu tạm'))).toBe(false);
  });

  it('says so when there is no stock', async () => {
    const rows = await rowsOf(book({ items: [], totals: { openingValue: '0', inValue: '0', outValue: '0', closingValue: '0' } }));
    expect(rows.flat()).toContain('Không có hàng tồn kho hay biến động kho trong tháng này.');
  });
});
