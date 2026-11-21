// SPDX-License-Identifier: AGPL-3.0-only
// The S2b-HKD workbook (#2517 slice 2c): the same rows and columns by business line as S2a, with the VAT per line and the VAT total, and no PIT rows (on the income method the PIT comes from income, not from a
// percentage of revenue). While a row behind the figures is `commentary` the file says so on top and labels the figures; once confirmed there is no label. A part with no line holds the VAT total back.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { HouseholdS2b, HouseholdYearToDate } from '@ludy/kernel-contract';
import { HOUSEHOLD_PROVISIONAL_LABEL } from '@ludy/kernel-contract';
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
  vatCut: { answer: 'no', percent: '20.0000', applied: false, lines: [{ trade: 'goods', cut: '0', vatPayable: '11000' }, { trade: 'services', cut: '0', vatPayable: '20000' }], total: { cut: '0', vatPayable: '31000' }, ifEligible: null },
  yearToDate: { year: 2026, revenueToDate: '1500000', revenueBefore: '0', threshold: { amount: '1000000000', effectiveFrom: '2026-01-01', status: 'confirmed' }, crossed: false, deductionTrade: null, deductionNeeded: false, deductionShort: false, payable: { vatBefore: '0', vatCut: '0', vat: '0', pitBefore: '0', pitCut: '0', pit: '0' }, pitCut: null },
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
    expect(labelled).toEqual(['Cộng doanh thu', 'Tỷ lệ thuế GTGT (%)', 'Thuế GTGT', 'Tổng thuế GTGT', undefined, undefined, 'Thuế GTGT của kỳ theo doanh thu cả năm (trước giảm)', 'Thuế GTGT phải nộp của kỳ']);
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

  it('names the digital content trade in Vietnamese, in its column and in the list of rows waiting', async () => {
    const { rows } = await rowsOf(
      book({
        rows: [{ entryId: E1, date: '2026-09-05', reference: null, description: 'Bán nhạc số', amount: '100000', reversal: false, parts: [{ trade: 'digital_content', amount: '100000' }] }],
        total: '100000',
        lines: [{ trade: 'digital_content', revenue: '100000', vatPercent: '5', vat: '5000' }],
        totals: { revenue: '100000', vat: '5000' },
        unconfirmed: [{ kind: 'rate', key: 'digital_content', effectiveFrom: '2026-01-01' }],
      }),
    );
    expect(find(rows, 'Diễn giải')).toContain('Nội dung số (trò chơi, phim, ảnh, nhạc, quảng cáo số)');
    expect(rows.flat().some((t) => t.includes('Chưa xác nhận: tỷ lệ thuế của ngành "Nội dung số (trò chơi, phim, ảnh, nhạc, quảng cáo số)"'))).toBe(true);
    expect(rows.flat().some((t) => t.includes('digital_content'))).toBe(false);
  });

  it('never reads a description as a formula', async () => {
    const { sheet } = await rowsOf(book());
    let formula = false;
    sheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value) formula = true; }));
    expect(formula).toBe(false);
  });
});

describe('the S2b-HKD workbook and the Decree 174 VAT cut (#3710)', () => {
  it('writes the cut and the VAT payable when the profile answered yes, and the total follows', async () => {
    const { rows } = await rowsOf(book({ vatCut: { answer: 'yes', percent: '20.0000', applied: true, lines: [{ trade: 'goods', cut: '2200', vatPayable: '8800' }, { trade: 'services', cut: '4000', vatPayable: '16000' }], total: { cut: '6200', vatPayable: '24800' }, ifEligible: null } }));
    expect(find(rows, 'Giảm thuế GTGT 20.0000% theo Nghị định 174 (theo tỷ lệ của kỳ, tham khảo)')).toContain('6200');
    expect(find(rows, 'Thuế GTGT sau giảm (tham khảo theo tỷ lệ của kỳ)')).toContain('24800');
    expect(find(rows, 'Tổng thuế GTGT sau giảm')).toContain('24800');
  });

  it('says what the VAT would be if eligible when the profile has no answer', async () => {
    const { rows } = await rowsOf(book({ vatCut: { answer: null, percent: '20.0000', applied: false, lines: [{ trade: 'goods', cut: '0', vatPayable: '11000' }, { trade: 'services', cut: '0', vatPayable: '20000' }], total: { cut: '0', vatPayable: '31000' }, ifEligible: { cut: '6200', vatPayable: '24800' } } }));
    expect(rows.flat().some((t) => t.includes('nếu thuộc diện được giảm, thuế GTGT sẽ là 24800 đồng'))).toBe(true);
    expect(find(rows, 'Tổng thuế GTGT')).toContain('31000');
  });
});

describe('the S2b-HKD workbook and the yearly rule (#3710 slice 3)', () => {
  const allText = async (d: HouseholdS2b) => (await rowsOf(d)).rows.flat();
  const amountOf = async (d: HouseholdS2b, label: string) => {
    const { sheet } = await rowsOf(d);
    let value: ExcelJS.CellValue | undefined;
    sheet.eachRow((row) => {
      if (row.getCell(3).value === label) value = row.getCell(sheet.columnCount - 1).value;
    });
    return value;
  };
  const YT: HouseholdYearToDate = { year: 2026, revenueToDate: '1500000000', revenueBefore: '1000000000', threshold: { amount: '1000000000', effectiveFrom: '2026-01-01', status: 'confirmed' }, crossed: true, deductionTrade: 'goods', deductionNeeded: false, deductionShort: false, payable: { vatBefore: '12000000', vatCut: '2400000', vat: '9600000', pitBefore: '1000000', pitCut: '300000', pit: '700000' }, pitCut: { percent: '30', ceiling: '3000000000', applied: true } };
  it('says nothing is owed yet below the threshold', async () => {
    const d = book();
    expect((await allText(d)).some((t) => t.includes('chưa vượt ngưỡng nên chưa phải nộp thuế'))).toBe(true);
    expect(await amountOf(d, 'Doanh thu lũy kế từ đầu năm')).toBe(1500000);
    expect(await amountOf(d, 'Ngưỡng doanh thu năm 2026 (từ 01/01/2026): chưa vượt')).toBe(1000000000);
  });

  it('writes each amount of the period when the threshold is crossed', async () => {
    const d = book({ yearToDate: YT });
    expect(await amountOf(d, 'Doanh thu lũy kế từ đầu năm')).toBe(1500000000);
    expect(await amountOf(d, 'Ngưỡng doanh thu năm 2026 (từ 01/01/2026): đã vượt')).toBe(1000000000);
    expect((await allText(d)).some((t) => t.includes('chưa vượt ngưỡng'))).toBe(false);
    expect(await amountOf(d, 'Thuế GTGT của kỳ theo doanh thu cả năm (trước giảm)')).toBe(12000000);
    expect(await amountOf(d, 'Giảm thuế GTGT theo Nghị định 174')).toBe(2400000);
    expect(await amountOf(d, 'Thuế GTGT phải nộp của kỳ')).toBe(9600000);
    expect((await allText(d)).some((t) => t.includes('TNCN') && t.includes('kỳ'))).toBe(false);
  });

  it('says the revenue is not all on a trade when the payable is null', async () => {
    const d = book({ yearToDate: { ...YT, payable: null } });
    expect((await allText(d)).some((t) => t.includes('chưa được gán hết cho ngành nghề'))).toBe(true);
    expect(await amountOf(d, 'Thuế GTGT phải nộp của kỳ')).toBeUndefined();
  });

  it('names the unconfirmed threshold and the PIT cut', async () => {
    const d = book({ commentary: true, unconfirmed: [{ kind: 'threshold', key: 'no_tax_revenue', effectiveFrom: '2026-01-01' }, { kind: 'reduction', key: 'pit', effectiveFrom: '2026-07-01' }] });
    const all = await allText(d);
    expect(all).toContain('  Chưa xác nhận: ngưỡng doanh thu năm, từ 01/01/2026');
    expect(all).toContain('  Chưa xác nhận: mức giảm thuế TNCN theo Nghị định 398, từ 01/07/2026');
  });
});
