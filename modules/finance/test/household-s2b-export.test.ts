// SPDX-License-Identifier: AGPL-3.0-only
// The S2b-HKD workbook (#2517 slice 2c): the same rows and columns by business line as S2a, with the VAT per line and the VAT total, and no PIT rows (on the income method the PIT comes from income, not from a
// percentage of revenue). While a row behind the figures is `commentary` the file says so on top and labels the figures; once confirmed there is no label. A part with no line holds the VAT total back.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { HouseholdS2b } from '@crove/kernel-contract';
import { HOUSEHOLD_PROVISIONAL_LABEL } from '@crove/kernel-contract';
import { buildS2bWorkbook } from '../src/household-export.ts';

const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';

const book = (over: Partial<HouseholdS2b> = {}): HouseholdS2b => ({
  period: { period: '2026-09', from: '2026-09-01', to: '2026-09-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: '001234567890', representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2b', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S2b-HKD)', status: 'commentary' },
  rows: [
    { entryId: E1, date: '2026-09-05', reference: '1C26TAA-00000042', description: 'Bán hàng và sửa chữa', amount: '1000000', reversal: false, parts: [{ trade: 'goods', amount: '600000' }, { trade: 'services', amount: '400000' }] },
    { entryId: E2, date: '2026-09-20', reference: null, description: '=HYPERLINK("http://evil")', amount: '500000', reversal: false, parts: [{ trade: 'goods', amount: '500000' }] },
  ],
  total: '1500000',
  lines: [
    { trade: 'goods', revenue: '1100000', vatPercent: '1', vat: '11000' },
    { trade: 'services', revenue: '400000', vatPercent: '5', vat: '20000' },
  ],
  unassigned: '0',
  unassignedGross: '0',
  totals: { revenue: '1500000', vat: '31000' },
  unconfirmed: [
    { kind: 'form', key: 'S2b 2026.1', effectiveFrom: '2026-01-01' },
    { kind: 'rate', key: 'goods', effectiveFrom: '2026-01-01' },
  ],
  commentary: true,
  ...over,
});

async function rowsOf(b: HouseholdS2b): Promise<{ sheet: ExcelJS.Worksheet; rows: string[][] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildS2bWorkbook(b)) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet('S2b-HKD');
  if (!sheet) throw new Error('no sheet');
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    for (let i = 1; i <= sheet.columnCount; i += 1) cells.push(row.getCell(i).value === null ? '' : String(row.getCell(i).value));
    rows.push(cells);
  });
  return { sheet, rows };
}
const find = (rows: string[][], text: string) => rows.find((r) => r.includes(text));

describe('the S2b-HKD workbook', () => {
  it('heads the book with the household, the title and the period, says Ludy files nothing, and ends with a signature place', async () => {
    const { rows } = await rowsOf(book());
    const all = rows.flat();
    expect(all).toContain('HỘ, CÁ NHÂN KINH DOANH: Hộ kinh doanh Nguyễn Văn A');
    expect(all).toContain('SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ (S2B-HKD)');
    expect(all).toContain('Kỳ: từ 01/09/2026 đến 30/09/2026');
    expect(all.some((t) => t.includes('Ludy không nộp tờ khai'))).toBe(true);
    expect(all).toContain('(Ký, họ tên)');
  });

  it('writes the revenue and the VAT per line and the VAT total, and has no PIT row at all', async () => {
    const { rows } = await rowsOf(book());
    const head = find(rows, 'Diễn giải')!;
    const goods = head.indexOf('Phân phối, cung cấp hàng hóa');
    const services = head.indexOf('Dịch vụ');
    const total = head.indexOf('Tổng số tiền');
    const revenue = find(rows, 'Cộng doanh thu')!;
    expect([revenue[goods], revenue[services], revenue[total]]).toEqual(['1100000', '400000', '1500000']);
    const vat = find(rows, 'Thuế GTGT')!;
    expect([vat[goods], vat[services], vat[total]]).toEqual(['11000', '20000', '31000']);
    expect(find(rows, 'Tổng thuế GTGT')![total]).toBe('31000');
    expect(rows.flat().some((t) => t.includes('TNCN'))).toBe(false);
  });

  it('says on top that the figures are provisional and labels the revenue and VAT rows while a row is commentary', async () => {
    const { rows } = await rowsOf(book());
    const all = rows.flat();
    expect(all).toContain(HOUSEHOLD_PROVISIONAL_LABEL.toUpperCase());
    expect(all.some((t) => t.includes('Chưa xác nhận: mẫu S2b 2026.1'))).toBe(true);
    const labelled = rows.filter((r) => r.includes(HOUSEHOLD_PROVISIONAL_LABEL)).map((r) => r.find((c) => c.startsWith('Cộng') || c.startsWith('Tỷ lệ') || c.startsWith('Thuế') || c.startsWith('Tổng thuế')));
    expect(labelled).toEqual(['Cộng doanh thu', 'Tỷ lệ thuế GTGT (%)', 'Thuế GTGT', 'Tổng thuế GTGT']);
    expect(find(rows, 'Bán hàng và sửa chữa')).not.toContain(HOUSEHOLD_PROVISIONAL_LABEL);
  });

  it('carries no label once every row is confirmed', async () => {
    const { rows } = await rowsOf(book({ form: { book: 'S2b', version: '2026.1', name: 'Sổ doanh thu bán hàng hóa, dịch vụ (S2b-HKD)', status: 'confirmed' }, unconfirmed: [], commentary: false }));
    expect(rows.flat().some((t) => t.includes(HOUSEHOLD_PROVISIONAL_LABEL))).toBe(false);
  });

  it('adds a "Chưa phân ngành" column for revenue with no line, leaves the VAT total blank and says why', async () => {
    const { rows } = await rowsOf(
      book({
        rows: [{ entryId: E1, date: '2026-09-05', reference: null, description: 'Đơn sàn', amount: '300000', reversal: false, parts: [{ trade: 'unassigned', amount: '300000' }] }],
        total: '300000',
        lines: [
          { trade: 'goods', revenue: '0', vatPercent: '1', vat: '0' },
          { trade: 'services', revenue: '0', vatPercent: '5', vat: '0' },
        ],
        unassigned: '300000',
        unassignedGross: '300000',
        totals: null,
      }),
    );
    const head = find(rows, 'Diễn giải')!;
    expect(head).toContain('Chưa phân ngành');
    expect(rows.flat().some((t) => t.includes('còn doanh thu chưa phân ngành nên chưa tính tổng thuế'))).toBe(true);
    expect(find(rows, 'Tổng thuế GTGT')![head.indexOf('Tổng số tiền')]).toBe('');
  });

  it('never reads a description as a formula', async () => {
    const { sheet } = await rowsOf(book());
    let formula = false;
    sheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value) formula = true; }));
    expect(formula).toBe(false);
  });
});
