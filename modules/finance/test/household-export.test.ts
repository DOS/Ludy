// SPDX-License-Identifier: AGPL-3.0-only
// The S1a-HKD workbook (#2517) and the 01/CNKD worksheet workbook (#2518): the household's name and tax code, the book's title, the period and the day the books were opened, the rows with exact amounts, a total and a place for the
// signature; text is never read as a formula; the note about the unchecked layout shows while the book's row is `commentary`.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { HouseholdCnkd, HouseholdS1a, HouseholdYearToDate } from '@crove/kernel-contract';
import { HOUSEHOLD_PROVISIONAL_LABEL } from '@crove/kernel-contract';
import { buildCnkdWorkbook, buildS1aWorkbook } from '../src/household-export.ts';

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

const sheetData = (over: Partial<HouseholdCnkd> = {}): HouseholdCnkd => ({
  period: { year: 2026, quarter: 4, from: '2026-10-01', to: '2026-12-31' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: '001234567890', representativeName: 'Nguyễn Văn A' },
  form: { form: '01/CNKD', version: '2026.2', name: 'Tờ khai thuế đối với hộ kinh doanh (01/CNKD)', status: 'confirmed' },
  revenue: '1600000',
  lines: [
    { trade: 'goods', revenue: '1000000', vatPercent: '1', pitPercent: '0.5', vat: '10000', pit: '5000' },
    { trade: 'services', revenue: '600000', vatPercent: '5', pitPercent: '2', vat: '30000', pit: '12000' },
  ],
  unassigned: '0',
  totals: { revenue: '1600000', vat: '40000', pit: '17000', tax: '57000' },
  vatCut: { answer: 'no', percent: '20.0000', applied: false, lines: [{ trade: 'goods', cut: '0', vatPayable: '10000' }, { trade: 'services', cut: '0', vatPayable: '30000' }], total: { cut: '0', vatPayable: '40000' }, ifEligible: null },
  yearToDate: { year: 2026, revenueToDate: '1500000', revenueBefore: '0', threshold: { amount: '1000000000', effectiveFrom: '2026-01-01', status: 'confirmed' }, crossed: false, deductionTrade: null, deductionNeeded: false, deductionShort: false, payable: { vatBefore: '0', vatCut: '0', vat: '0', pitBefore: '0', pitCut: '0', pit: '0' }, pitCut: null },
  withheld: { total: '4200', settlements: [{ id: '00000000-0000-4000-8000-0000000000a1', platform: 'shopee', periodStart: '2026-10-01', periodEnd: '2026-10-15', taxWithheld: '4200' }] },
  due: '52800',
  overpaid: '0',
  unconfirmed: [],
  commentary: false,
  ...over,
});

async function cnkdSheet(d: HouseholdCnkd): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildCnkdWorkbook(d)) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet('01-CNKD');
  if (!sheet) throw new Error('no sheet');
  return sheet;
}

describe('the 01/CNKD worksheet workbook', () => {
  it('heads the worksheet with the household, the form and the quarter, and says it is a worksheet that Ludy does not file', async () => {
    const all = texts(await cnkdSheet(sheetData()));
    expect(all).toContain('HỘ, CÁ NHÂN KINH DOANH: Hộ kinh doanh Nguyễn Văn A');
    expect(all).toContain('Mã số thuế: 001234567890');
    expect(all).toContain('BẢNG TÍNH TỜ KHAI TỜ KHAI THUẾ ĐỐI VỚI HỘ KINH DOANH (01/CNKD)');
    expect(all).toContain('Phiên bản mẫu: 2026.2');
    expect(all).toContain('Kỳ tính thuế: quý 4 năm 2026 (từ 01/10/2026 đến 31/12/2026)');
    expect(all.some((t) => t.includes('Ludy không nộp tờ khai'))).toBe(true);
    expect(all).toContain('(Ký, họ tên)');
    // The exempt band is not deducted, and the file says so.
    expect(all.some((t) => t.includes('được tính ở mục thuế theo doanh thu cả năm'))).toBe(true);
  });

  it('writes revenue, percentages and tax by trade, the totals, the withheld tax and what is left to pay', async () => {
    const sheet = await cnkdSheet(sheetData());
    const rows = new Map<string, ExcelJS.Row>();
    sheet.eachRow((row) => rows.set(String(row.getCell(1).value), row));
    const goods = rows.get('Phân phối, cung cấp hàng hóa');
    expect([goods?.getCell(2).value, goods?.getCell(3).value, goods?.getCell(4).value, goods?.getCell(5).value, goods?.getCell(6).value]).toEqual([1000000, '1', 10000, '0.5', 5000]);
    const services = rows.get('Dịch vụ');
    expect([services?.getCell(2).value, services?.getCell(4).value, services?.getCell(6).value]).toEqual([600000, 30000, 12000]);
    const total = rows.get('Cộng');
    expect([total?.getCell(2).value, total?.getCell(4).value, total?.getCell(6).value]).toEqual([1600000, 40000, 17000]);
    expect(rows.get('Tổng thuế GTGT và TNCN theo tỷ lệ trên doanh thu của kỳ, chưa xét ngưỡng năm')?.getCell(2).value).toBe(57000);
    expect(rows.get('  shopee, 01/10/2026 - 15/10/2026')?.getCell(2).value).toBe(4200);
    expect(rows.get('Cộng thuế đã khấu trừ')?.getCell(2).value).toBe(4200);
    expect(rows.get('Số thuế còn phải nộp')?.getCell(2).value).toBe(52800);
    expect(rows.has('Số thuế đã khấu trừ vượt số phải nộp')).toBe(false);
  });

  it('carries no label once every row is confirmed', async () => {
    const sheet = await cnkdSheet(sheetData());
    expect(texts(sheet).some((t) => t.toLowerCase().includes('số liệu tạm'))).toBe(false);
    expect(sheet.getRow(8).getCell(7).value).toBeNull();
  });

  it('says on top that the figures are provisional, lists the rows still waiting, and labels every figure that depends on them while a row is commentary (#2518)', async () => {
    const sheet = await cnkdSheet(
      sheetData({
        commentary: true,
        form: { form: '01/CNKD', version: '2026.1', name: 'Tờ khai thuế đối với hộ kinh doanh (01/CNKD)', status: 'commentary' },
        unconfirmed: [
          { kind: 'form', key: '01/CNKD 2026.1', effectiveFrom: '2026-01-01' },
          { kind: 'rate', key: 'goods', effectiveFrom: '2026-01-01' },
        ],
        overpaid: '3500',
        due: '0',
      }),
    );
    const all = texts(sheet);
    // On top, the label in capitals, then the rows that wait for the accountant; the file still says Ludy files nothing.
    expect(HOUSEHOLD_PROVISIONAL_LABEL).toBe('Số liệu tạm, kế toán chưa xác nhận tỷ lệ');
    expect(all).toContain(HOUSEHOLD_PROVISIONAL_LABEL.toUpperCase());
    expect(all).toContain('  Chưa xác nhận: mẫu 01/CNKD 2026.1, hiệu lực từ 01/01/2026');
    expect(all).toContain('  Chưa xác nhận: tỷ lệ thuế của ngành "Phân phối, cung cấp hàng hóa", từ 01/01/2026');
    expect(all.some((t) => t.includes('Ludy không nộp tờ khai'))).toBe(true);
    // The label sits in the note column of each figure that depends on a rule, and not on the tax the platforms withheld (a settlement fact).
    const rows = new Map<string, ExcelJS.Row>();
    sheet.eachRow((row) => rows.set(String(row.getCell(1).value), row));
    const note = (label: string) => rows.get(label)?.getCell(7).value;
    expect(note('Ngành nghề')).toBe('Ghi chú');
    for (const label of ['Phân phối, cung cấp hàng hóa', 'Dịch vụ', 'Cộng', 'Tổng thuế GTGT và TNCN theo tỷ lệ trên doanh thu của kỳ, chưa xét ngưỡng năm', 'Số thuế còn phải nộp', 'Số thuế đã khấu trừ vượt số phải nộp']) {
      expect(note(label), label).toBe(HOUSEHOLD_PROVISIONAL_LABEL);
    }
    expect(note('  shopee, 01/10/2026 - 15/10/2026') ?? null).toBeNull();
    expect(note('Cộng thuế đã khấu trừ') ?? null).toBeNull();
    // The figures themselves are the same as in a confirmed file.
    expect(rows.get('Số thuế đã khấu trừ vượt số phải nộp')?.getCell(2).value).toBe(3500);
  });

  it('shows the overpaid line only when more was withheld than owed, and never reads a name as a formula', async () => {
    const sheet = await cnkdSheet(sheetData({ due: '0', overpaid: '3500', household: { name: '=HYPERLINK("http://evil")', taxCode: null, representativeName: null } }));
    const rows = new Map<string, ExcelJS.Row>();
    sheet.eachRow((row) => rows.set(String(row.getCell(1).value), row));
    expect(rows.get('Số thuế đã khấu trừ vượt số phải nộp')?.getCell(2).value).toBe(3500);
    const first = sheet.getRow(1).getCell(1);
    expect(typeof first.value).toBe('string');
    expect(first.value).toBe('HỘ, CÁ NHÂN KINH DOANH: =HYPERLINK("http://evil")');
  });
});

describe('the 01/CNKD worksheet and the Decree 174 VAT cut (#3710)', () => {
  const rowsOf = async (d: HouseholdCnkd) => {
    const rows = new Map<string, ExcelJS.Row>();
    (await cnkdSheet(d)).eachRow((row) => rows.set(String(row.getCell(1).value), row));
    return rows;
  };

  it('writes the cut and the tax after it when the profile answered yes', async () => {
    const rows = await rowsOf(
      sheetData({
        vatCut: { answer: 'yes', percent: '20.0000', applied: true, lines: [{ trade: 'goods', cut: '2000', vatPayable: '8000' }, { trade: 'services', cut: '6000', vatPayable: '24000' }], total: { cut: '8000', vatPayable: '32000' }, ifEligible: null },
        due: '44800',
      }),
    );
    expect(rows.get('Giảm thuế GTGT 20.0000% theo Nghị định 174')?.getCell(2).value).toBe(8000);
    // VAT payable 32000 plus the PIT 17000.
    expect(rows.get('Tổng thuế GTGT và TNCN sau giảm, theo tỷ lệ trên doanh thu của kỳ, chưa xét ngưỡng năm')?.getCell(2).value).toBe(49000);
    expect(rows.get('Số thuế còn phải nộp')?.getCell(2).value).toBe(44800);
  });

  it('says what the VAT would be if eligible when the profile has no answer, and writes no cut row', async () => {
    const d = sheetData({
      vatCut: { answer: null, percent: '20.0000', applied: false, lines: [{ trade: 'goods', cut: '0', vatPayable: '10000' }, { trade: 'services', cut: '0', vatPayable: '30000' }], total: { cut: '0', vatPayable: '40000' }, ifEligible: { cut: '8000', vatPayable: '32000' } },
    });
    expect(texts(await cnkdSheet(d)).some((t) => t.includes('nếu thuộc diện được giảm, thuế GTGT sẽ là 32000 đồng (giảm 8000 đồng)'))).toBe(true);
    expect((await rowsOf(d)).has('Tổng thuế GTGT và TNCN sau giảm, theo tỷ lệ trên doanh thu của kỳ, chưa xét ngưỡng năm')).toBe(false);
  });

  it('writes nothing about the cut when the answer is no', async () => {
    expect(texts(await cnkdSheet(sheetData())).some((t) => t.includes('Nghị định 174'))).toBe(false);
  });
});


describe('the 01/CNKD worksheet and the yearly rule (#3710 slice 3)', () => {
  const allText = async (d: HouseholdCnkd) => texts(await cnkdSheet(d));
  const amountOf = async (d: HouseholdCnkd, label: string) => {
    let value: ExcelJS.CellValue | undefined;
    (await cnkdSheet(d)).eachRow((row) => {
      if (row.getCell(1).value === label) value = row.getCell(2).value;
    });
    return value;
  };
  const YT: HouseholdYearToDate = { year: 2026, revenueToDate: '1500000000', revenueBefore: '1000000000', threshold: { amount: '1000000000', effectiveFrom: '2026-01-01', status: 'confirmed' }, crossed: true, deductionTrade: 'goods', deductionNeeded: false, deductionShort: false, payable: { vatBefore: '12000000', vatCut: '2400000', vat: '9600000', pitBefore: '1000000', pitCut: '300000', pit: '700000' }, pitCut: { percent: '30', ceiling: '3000000000', applied: true } };
  it('says nothing is owed yet below the threshold', async () => {
    const d = sheetData();
    expect((await allText(d)).some((t) => t.includes('chưa vượt ngưỡng nên chưa phải nộp thuế'))).toBe(true);
    expect(await amountOf(d, 'Doanh thu lũy kế từ đầu năm')).toBe(1500000);
    expect(await amountOf(d, 'Ngưỡng doanh thu năm 2026 (từ 01/01/2026): chưa vượt')).toBe(1000000000);
  });

  it('writes each amount of the period when the threshold is crossed', async () => {
    const d = sheetData({ yearToDate: YT });
    expect(await amountOf(d, 'Doanh thu lũy kế từ đầu năm')).toBe(1500000000);
    expect(await amountOf(d, 'Ngưỡng doanh thu năm 2026 (từ 01/01/2026): đã vượt')).toBe(1000000000);
    expect((await allText(d)).some((t) => t.includes('chưa vượt ngưỡng'))).toBe(false);
    expect(await amountOf(d, 'Thuế GTGT của kỳ theo doanh thu cả năm (trước giảm)')).toBe(12000000);
    expect(await amountOf(d, 'Giảm thuế GTGT theo Nghị định 174')).toBe(2400000);
    expect(await amountOf(d, 'Thuế GTGT phải nộp của kỳ')).toBe(9600000);
    expect(await amountOf(d, 'Thuế TNCN của kỳ theo doanh thu cả năm (trước giảm)')).toBe(1000000);
    expect(await amountOf(d, 'Giảm thuế TNCN 30% theo Nghị định 398')).toBe(300000);
    expect(await amountOf(d, 'Thuế TNCN phải nộp của kỳ')).toBe(700000);
  });

  it('asks the household to choose the trade that takes the deduction and writes no PIT figure', async () => {
    const d = sheetData({ yearToDate: { ...YT, deductionTrade: null, deductionNeeded: true, deductionShort: false, payable: null } });
    expect((await allText(d)).some((t) => t.includes('hãy chọn ngành nghề được trừ'))).toBe(true);
    expect(await amountOf(d, 'Thuế TNCN phải nộp của kỳ')).toBeUndefined();
    expect(await amountOf(d, 'Thuế GTGT phải nộp của kỳ')).toBeUndefined();
  });

  it('says the PIT is held back for the accountant when no trade reaches the threshold', async () => {
    const d = sheetData({ yearToDate: { ...YT, deductionTrade: null, deductionNeeded: false, deductionShort: true, payable: null, pitCut: null } });
    expect((await allText(d)).some((t) => t.includes('Chưa ngành nghề nào có doanh thu đạt ngưỡng') && t.includes('chờ kế toán xác nhận'))).toBe(true);
    expect((await allText(d)).some((t) => t.includes('hãy chọn ngành nghề'))).toBe(false);
    expect(await amountOf(d, 'Thuế TNCN phải nộp của kỳ')).toBeUndefined();
  });

  it('says the revenue is not all on a trade when the payable is null', async () => {
    const d = sheetData({ yearToDate: { ...YT, payable: null } });
    expect((await allText(d)).some((t) => t.includes('chưa được gán hết cho ngành nghề'))).toBe(true);
    expect(await amountOf(d, 'Thuế GTGT phải nộp của kỳ')).toBeUndefined();
  });

  it('names the unconfirmed threshold and the PIT cut', async () => {
    const d = sheetData({ commentary: true, unconfirmed: [{ kind: 'threshold', key: 'no_tax_revenue', effectiveFrom: '2026-01-01' }, { kind: 'reduction', key: 'pit', effectiveFrom: '2026-07-01' }] });
    const all = await allText(d);
    expect(all).toContain('  Chưa xác nhận: ngưỡng doanh thu năm, từ 01/01/2026');
    expect(all).toContain('  Chưa xác nhận: mức giảm thuế TNCN theo Nghị định 398, từ 01/07/2026');
  });
});
