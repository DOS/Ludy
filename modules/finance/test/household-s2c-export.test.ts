// SPDX-License-Identifier: AGPL-3.0-only
// The S2c-HKD workbook (#2517 slice 2b): the household, the title and the period on top, saying Ludy files nothing and computes no PIT; the revenue rows and their total; the expense rows with document, account and
// group; a total per group; the expense no map row covers on its own line; the total expense; the income, blank with its reason while an expense line has no group; a signature place. While a row behind the figures is
// `commentary` the file says so on top, lists the rows, and puts the provisional label in a note column on the expense and income figures; once confirmed there is none. Text is never read as a formula.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { HouseholdS2c } from '@crove/kernel-contract';
import { HOUSEHOLD_PROVISIONAL_LABEL } from '@crove/kernel-contract';
import { buildS2cWorkbook } from '../src/household-export.ts';

const E = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const GROUPS = ['materials_goods', 'wages_insurance', 'depreciation', 'outside_services', 'interest', 'other'] as const;
const groups = (amounts: Partial<Record<(typeof GROUPS)[number], string>>) => GROUPS.map((group) => ({ group, amount: amounts[group] ?? '0' }));

const book = (over: Partial<HouseholdS2c> = {}): HouseholdS2c => ({
  period: { period: '2026-09', from: '2026-09-01', to: '2026-09-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: '001234567890', representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2c', version: '2026.1', name: 'Sổ chi tiết doanh thu, chi phí (S2c-HKD)', status: 'commentary' },
  revenueRows: [{ entryId: E(1), date: '2026-09-05', reference: '1C26TAA-00000042', description: 'Bán hàng', amount: '5000000', reversal: false }],
  revenue: '5000000',
  expenseRows: [
    { entryId: E(2), lineNo: 1, date: '2026-09-06', reference: 'AA-0001', description: 'Mua hàng về bán', accountCode: '632', group: 'materials_goods', amount: '3000000', reversal: false },
    { entryId: E(3), lineNo: 2, date: '2026-09-20', reference: null, description: '=HYPERLINK("http://evil")', accountCode: '642', group: 'other', amount: '400000', reversal: false },
  ],
  groups: groups({ materials_goods: '3000000', other: '400000' }),
  unmapped: '0',
  unmappedGross: '0',
  expenseTotal: '3400000',
  income: '1600000',
  unconfirmed: [
    { kind: 'form', key: 'S2c 2026.1', effectiveFrom: '2026-01-01' },
    { kind: 'group', key: '632', effectiveFrom: '2026-01-01' },
    { kind: 'group', key: '642', effectiveFrom: '2026-01-01' },
  ],
  commentary: true,
  ...over,
});

async function rowsOf(b: HouseholdS2c): Promise<{ sheet: ExcelJS.Worksheet; rows: string[][] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildS2cWorkbook(b)) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet('S2c-HKD');
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
const AMOUNT = 5;

describe('the S2c-HKD workbook', () => {
  it('heads the book, says Ludy files nothing and computes no PIT, and ends with a signature place', async () => {
    const { rows } = await rowsOf(book());
    const all = rows.flat();
    expect(all).toContain('HỘ, CÁ NHÂN KINH DOANH: Hộ kinh doanh Nguyễn Văn A');
    expect(all).toContain('Mã số thuế: 001234567890');
    expect(all).toContain('SỔ CHI TIẾT DOANH THU, CHI PHÍ (S2C-HKD)');
    expect(all).toContain('Kỳ: từ 01/09/2026 đến 30/09/2026');
    expect(all.some((t) => t.includes('Ludy không nộp tờ khai') && t.includes('chưa tính thuế thu nhập cá nhân'))).toBe(true);
    expect(all).toContain('Người đại diện hộ kinh doanh');
    expect(all).toContain('(Ký, họ tên)');
  });

  it('writes the revenue rows with their total, and each expense row with document, account, group and amount', async () => {
    const { rows } = await rowsOf(book());
    expect(find(rows, 'Bán hàng')![AMOUNT]).toBe('5000000');
    expect(find(rows, 'Cộng doanh thu')![AMOUNT]).toBe('5000000');
    const buy = find(rows, 'Mua hàng về bán')!;
    expect(buy.slice(0, 6)).toEqual(['06/09/2026', 'AA-0001', 'Mua hàng về bán', '632', 'Nguyên liệu, vật liệu, hàng hóa', '3000000']);
    expect(find(rows, '=HYPERLINK("http://evil")')!.slice(3, 6)).toEqual(['642', 'Chi phí khác', '400000']);
  });

  it('totals per group, in the fixed order, then the expense total and the income', async () => {
    const { rows } = await rowsOf(book());
    const start = rows.findIndex((r) => r.includes('Cộng chi phí theo nhóm'));
    const names = rows.slice(start + 1, start + 7).map((r) => r[4]);
    expect(names).toEqual(['Nguyên liệu, vật liệu, hàng hóa', 'Tiền lương, tiền công, bảo hiểm', 'Khấu hao tài sản cố định', 'Dịch vụ thuê ngoài', 'Lãi vay', 'Chi phí khác']);
    expect(rows.slice(start + 1, start + 7).map((r) => r[AMOUNT])).toEqual(['3000000', '0', '0', '0', '0', '400000']);
    expect(find(rows, 'Cộng chi phí')![AMOUNT]).toBe('3400000');
    expect(find(rows, 'Thu nhập (doanh thu trừ chi phí)')![AMOUNT]).toBe('1600000');
  });

  it('says on top that the figures are provisional, lists the rows waiting, and labels the expense and income figures while a row is commentary', async () => {
    const { rows } = await rowsOf(book());
    const all = rows.flat();
    expect(all).toContain(HOUSEHOLD_PROVISIONAL_LABEL.toUpperCase());
    expect(all.some((t) => t.includes('Chưa xác nhận: mẫu S2c 2026.1'))).toBe(true);
    expect(all.some((t) => t.includes('Chưa xác nhận: nhóm chi phí của tài khoản 632'))).toBe(true);
    const labelled = rows.filter((r) => r.includes(HOUSEHOLD_PROVISIONAL_LABEL));
    // Two expense rows with a group, six group totals, the expense total and the income; none on a revenue row.
    expect(labelled).toHaveLength(10);
    expect(find(rows, 'Bán hàng')).not.toContain(HOUSEHOLD_PROVISIONAL_LABEL);
    expect(find(rows, 'Cộng doanh thu')).not.toContain(HOUSEHOLD_PROVISIONAL_LABEL);
  });

  it('carries no label and no list of waiting rows once every row is confirmed', async () => {
    const { rows } = await rowsOf(book({ form: { book: 'S2c', version: '2026.2', name: 'S2c', status: 'confirmed' }, unconfirmed: [], commentary: false }));
    expect(rows.flat().some((t) => t.includes(HOUSEHOLD_PROVISIONAL_LABEL))).toBe(false);
    expect(rows.flat().some((t) => t.startsWith('Chưa xác nhận'))).toBe(false);
  });

  it('shows an expense with no group on its own line, leaves the income blank and says why', async () => {
    const { rows } = await rowsOf(
      book({
        expenseRows: [{ entryId: E(2), lineNo: 1, date: '2026-09-06', reference: null, description: 'Trả tiền thuê nhà', accountCode: '641', group: null, amount: '700000', reversal: false }],
        groups: groups({}),
        unmapped: '700000',
        unmappedGross: '700000',
        expenseTotal: '700000',
        income: null,
        unconfirmed: [{ kind: 'form', key: 'S2c 2026.1', effectiveFrom: '2026-01-01' }],
      }),
    );
    expect(find(rows, 'Trả tiền thuê nhà')!.slice(3, 6)).toEqual(['641', 'Chưa xếp nhóm', '700000']);
    expect(find(rows, 'Trả tiền thuê nhà')).not.toContain(HOUSEHOLD_PROVISIONAL_LABEL);
    // The unmapped total has its own line among the group totals.
    expect(rows.filter((r) => r[4] === 'Chưa xếp nhóm' && r[AMOUNT] === '700000')).toHaveLength(2);
    expect(find(rows, 'Thu nhập (doanh thu trừ chi phí)')![AMOUNT]).toBe('');
    expect(rows.flat().some((t) => t.includes('còn chi phí chưa xếp nhóm'))).toBe(true);
  });

  it('never reads a description as a formula', async () => {
    const { sheet } = await rowsOf(book());
    let formula = false;
    sheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value) formula = true; }));
    expect(formula).toBe(false);
  });
});
