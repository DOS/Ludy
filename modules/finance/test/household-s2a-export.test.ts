// SPDX-License-Identifier: AGPL-3.0-only
// The S2a-HKD workbook (#2517 slice 2a): the household, the title and the period on top; one column per business line (and "Chưa phân ngành" only when something has none); each entry's amount in the
// column of its line; the revenue, the percentages, the VAT and PIT per line and the total tax at the foot; a signature place. While a row behind the figures is `commentary` the file says so on top,
// lists the rows, and puts the provisional label in a note column on every figure that depends on them; once the rows are confirmed there is no label. Text is never read as a formula.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { HouseholdS2a } from '@crove/kernel-contract';
import { HOUSEHOLD_PROVISIONAL_LABEL } from '@crove/kernel-contract';
import { buildS2aWorkbook } from '../src/household-export.ts';

const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';

const book = (over: Partial<HouseholdS2a> = {}): HouseholdS2a => ({
  period: { period: '2026-09', from: '2026-09-01', to: '2026-09-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: '001234567890', representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2a', version: '2026.1', name: 'Sổ doanh thu theo ngành nghề (S2a-HKD)', status: 'commentary' },
  rows: [
    { entryId: E1, date: '2026-09-05', reference: '1C26TAA-00000042', description: 'Bán hàng và sửa chữa', amount: '1000000', reversal: false, parts: [{ trade: 'goods', amount: '600000' }, { trade: 'services', amount: '400000' }] },
    { entryId: E2, date: '2026-09-20', reference: null, description: '=HYPERLINK("http://evil")', amount: '500000', reversal: false, parts: [{ trade: 'goods', amount: '500000' }] },
  ],
  total: '1500000',
  lines: [
    { trade: 'goods', revenue: '1100000', vatPercent: '1', pitPercent: '0.5', vat: '11000', pit: '5500' },
    { trade: 'services', revenue: '400000', vatPercent: '5', pitPercent: '2', vat: '20000', pit: '8000' },
  ],
  unassigned: '0',
  totals: { revenue: '1500000', vat: '31000', pit: '13500', tax: '44500' },
  unconfirmed: [
    { kind: 'form', key: 'S2a 2026.1', effectiveFrom: '2026-01-01' },
    { kind: 'rate', key: 'goods', effectiveFrom: '2026-01-01' },
  ],
  commentary: true,
  ...over,
});

async function rowsOf(b: HouseholdS2a): Promise<{ sheet: ExcelJS.Worksheet; rows: string[][] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildS2aWorkbook(b)) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet('S2a-HKD');
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

describe('the S2a-HKD workbook', () => {
  it('heads the book with the household, the title and the period, says Ludy files nothing, and ends with a signature place', async () => {
    const { rows } = await rowsOf(book());
    const all = rows.flat();
    expect(all).toContain('HỘ, CÁ NHÂN KINH DOANH: Hộ kinh doanh Nguyễn Văn A');
    expect(all).toContain('Mã số thuế: 001234567890');
    expect(all).toContain('SỔ DOANH THU THEO NGÀNH NGHỀ (S2A-HKD)');
    expect(all).toContain('Kỳ: từ 01/09/2026 đến 30/09/2026');
    expect(all).toContain('Ngày mở sổ: 01/01/2026');
    expect(all.some((t) => t.includes('Ludy không nộp tờ khai'))).toBe(true);
    expect(all).toContain('Người đại diện hộ kinh doanh');
    expect(all).toContain('(Ký, họ tên)');
  });

  it('puts each entry amount in the column of its business line and the total beside it, and no unassigned column when nothing is unassigned', async () => {
    const { rows } = await rowsOf(book());
    const head = find(rows, 'Diễn giải')!;
    expect(head).toContain('Phân phối, cung cấp hàng hóa');
    expect(head).toContain('Dịch vụ');
    expect(head).not.toContain('Chưa phân ngành');
    const split = find(rows, 'Bán hàng và sửa chữa')!;
    expect(split[head.indexOf('Phân phối, cung cấp hàng hóa')]).toBe('600000');
    expect(split[head.indexOf('Dịch vụ')]).toBe('400000');
    expect(split[head.indexOf('Tổng số tiền')]).toBe('1000000');
  });

  it('writes the revenue per line, the percentages, the VAT and PIT per line and the total tax at the foot', async () => {
    const { rows } = await rowsOf(book());
    const head = find(rows, 'Diễn giải')!;
    const goods = head.indexOf('Phân phối, cung cấp hàng hóa');
    const services = head.indexOf('Dịch vụ');
    const total = head.indexOf('Tổng số tiền');
    const revenue = find(rows, 'Cộng doanh thu')!;
    expect([revenue[goods], revenue[services], revenue[total]]).toEqual(['1100000', '400000', '1500000']);
    expect([find(rows, 'Tỷ lệ thuế GTGT (%)')![goods], find(rows, 'Tỷ lệ thuế GTGT (%)')![services]]).toEqual(['1', '5']);
    const vat = find(rows, 'Thuế GTGT')!;
    expect([vat[goods], vat[services], vat[total]]).toEqual(['11000', '20000', '31000']);
    const pit = find(rows, 'Thuế TNCN')!;
    expect([pit[goods], pit[services], pit[total]]).toEqual(['5500', '8000', '13500']);
    expect(find(rows, 'Tổng thuế GTGT và TNCN')![total]).toBe('44500');
  });

  it('says on top that the figures are provisional, lists the rows still waiting, and labels the revenue and tax rows while a row is commentary', async () => {
    const { rows } = await rowsOf(book());
    const all = rows.flat();
    expect(all).toContain(HOUSEHOLD_PROVISIONAL_LABEL.toUpperCase());
    expect(all.some((t) => t.includes('Chưa xác nhận: mẫu S2a 2026.1'))).toBe(true);
    expect(all.some((t) => t.includes('Chưa xác nhận: tỷ lệ thuế của ngành "Phân phối, cung cấp hàng hóa"'))).toBe(true);
    const labelled = rows.filter((r) => r.includes(HOUSEHOLD_PROVISIONAL_LABEL)).map((r) => r.find((c) => c.startsWith('Cộng') || c.startsWith('Tỷ lệ') || c.startsWith('Thuế') || c.startsWith('Tổng thuế')));
    expect(labelled).toEqual(['Cộng doanh thu', 'Tỷ lệ thuế GTGT (%)', 'Thuế GTGT', 'Tỷ lệ thuế TNCN (%)', 'Thuế TNCN', 'Tổng thuế GTGT và TNCN']);
    // A plain entry row carries no label: it is a ledger fact, not a figure that rests on a rule.
    expect(find(rows, 'Bán hàng và sửa chữa')).not.toContain(HOUSEHOLD_PROVISIONAL_LABEL);
  });

  it('carries no label and no list of waiting rows once every row is confirmed', async () => {
    const { rows } = await rowsOf(book({ form: { book: 'S2a', version: '2026.1', name: 'Sổ doanh thu theo ngành nghề (S2a-HKD)', status: 'confirmed' }, unconfirmed: [], commentary: false }));
    expect(rows.flat().some((t) => t.includes(HOUSEHOLD_PROVISIONAL_LABEL))).toBe(false);
    expect(rows.flat().some((t) => t.startsWith('Chưa xác nhận'))).toBe(false);
  });

  it('adds a "Chưa phân ngành" column for revenue with no line, holds the tax total back and says why', async () => {
    const { rows } = await rowsOf(
      book({
        rows: [{ entryId: E1, date: '2026-09-05', reference: null, description: 'Đơn sàn', amount: '300000', reversal: false, parts: [{ trade: 'unassigned', amount: '300000' }] }],
        total: '300000',
        lines: [
          { trade: 'goods', revenue: '0', vatPercent: '1', pitPercent: '0.5', vat: '0', pit: '0' },
          { trade: 'services', revenue: '0', vatPercent: '5', pitPercent: '2', vat: '0', pit: '0' },
        ],
        unassigned: '300000',
        totals: null,
      }),
    );
    const head = find(rows, 'Diễn giải')!;
    expect(head).toContain('Chưa phân ngành');
    expect(find(rows, 'Đơn sàn')![head.indexOf('Chưa phân ngành')]).toBe('300000');
    expect(rows.flat().some((t) => t.includes('còn doanh thu chưa phân ngành nên chưa tính tổng thuế'))).toBe(true);
    expect(find(rows, 'Tổng thuế GTGT và TNCN')![head.indexOf('Tổng số tiền')]).toBe('0');
  });

  it('never reads a description as a formula', async () => {
    const { sheet } = await rowsOf(book());
    let formula = false;
    sheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value) formula = true; }));
    expect(formula).toBe(false);
    const dump: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => dump.push(String(cell.value))));
    expect(dump).toContain('=HYPERLINK("http://evil")');
  });
});
