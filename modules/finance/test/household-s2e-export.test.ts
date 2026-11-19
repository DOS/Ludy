// SPDX-License-Identifier: AGPL-3.0-only
// The S2e-HKD workbook (#2517 slice 2e): the household, the title and the period on top; one section per cash and bank account with its opening, rows, totals and closing; the total of all accounts; a signature place.
// While the layout row is `commentary` the file says so on top and puts the provisional label in a note column; once confirmed there is none. A negative balance is flagged; text is never read as a formula.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { HOUSEHOLD_PROVISIONAL_LABEL, type HouseholdS2e } from '@crove/kernel-contract';
import { buildS2eWorkbook } from '../src/household-export.ts';

const E = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const book = (over: Partial<HouseholdS2e> = {}): HouseholdS2e => ({
  period: { period: '2026-09', from: '2026-09-01', to: '2026-09-30' },
  household: { name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: '001234567890', representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' },
  form: { book: 'S2e', version: '2026.1', name: 'Sổ chi tiết tiền (S2e-HKD)', status: 'commentary' },
  accounts: [
    {
      accountCode: '111',
      accountName: 'Tiền mặt',
      opening: '500000',
      rows: [
        { entryId: E(1), lineNo: 1, date: '2026-09-03', reference: 'AA-0001', description: '=HYPERLINK("http://evil")', counterAccounts: ['511'], cashIn: '1000000', cashOut: '0', balance: '1500000', reversal: false },
        { entryId: E(2), lineNo: 2, date: '2026-09-15', reference: null, description: 'Chi', counterAccounts: ['642', '1331'], cashIn: '0', cashOut: '300000', balance: '1200000', reversal: true },
      ],
      totalIn: '1000000',
      totalOut: '300000',
      closing: '1200000',
      negative: false,
    },
    { accountCode: '1121', accountName: 'Ngân hàng A', opening: '0', rows: [], totalIn: '0', totalOut: '0', closing: '-50000', negative: true },
  ],
  totals: { opening: '500000', in: '1000000', out: '300000', closing: '1150000' },
  unconfirmed: [{ kind: 'form', key: 'S2e 2026.1', effectiveFrom: '2026-01-01' }],
  commentary: true,
  ...over,
});

async function rowsOf(b: HouseholdS2e): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildS2eWorkbook(b)) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet('S2e-HKD');
  if (!sheet) throw new Error('no sheet');
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    for (let i = 1; i <= sheet.columnCount; i += 1) cells.push(row.getCell(i).value === null ? '' : String(row.getCell(i).value));
    rows.push(cells);
  });
  return rows;
}
const find = (rows: string[][], text: string) => rows.find((r) => r.includes(text));
const [DATE, REF, DESC, COUNTER, IN, OUT, BAL, NOTE] = [0, 1, 2, 3, 4, 5, 6, 7];

describe('the S2e-HKD workbook', () => {
  it('heads the book, says Ludy files nothing, and ends with a signature place', async () => {
    const all = (await rowsOf(book())).flat();
    expect(all).toContain('HỘ, CÁ NHÂN KINH DOANH: Hộ kinh doanh Nguyễn Văn A');
    expect(all).toContain('Mã số thuế: 001234567890');
    expect(all).toContain('SỔ CHI TIẾT TIỀN (S2E-HKD)');
    expect(all).toContain('Kỳ: từ 01/09/2026 đến 30/09/2026');
    expect(all.some((t) => t.includes('Ludy không nộp tờ khai'))).toBe(true);
    expect(all).toContain('(Ký, họ tên)');
    expect(all).toContain('Nguyễn Văn A');
  });

  it('writes a section per account with opening, each line, the totals and the closing', async () => {
    const rows = await rowsOf(book());
    expect(find(rows, 'Tài khoản 111 - Tiền mặt')).toBeTruthy();
    const opening = rows.find((r) => r[DESC] === 'Số dư đầu kỳ' && r[BAL] === '500000');
    expect(opening).toBeTruthy();
    const first = rows.find((r) => r[REF] === 'AA-0001')!;
    expect([first[DATE], first[COUNTER], first[IN], first[OUT], first[BAL]]).toEqual(['03/09/2026', '511', '1000000', '0', '1500000']);
    const reversal = rows.find((r) => r[DESC] === 'Chi (bút toán đảo)')!;
    expect([reversal[COUNTER], reversal[OUT], reversal[BAL]]).toEqual(['642, 1331', '300000', '1200000']);
    expect(rows.find((r) => r[DESC] === 'Cộng phát sinh')![IN]).toBe('1000000');
    expect(find(rows, 'Tài khoản 1121 - Ngân hàng A')).toBeTruthy();
  });

  it('keeps text as text, never a formula', async () => {
    const rows = await rowsOf(book());
    const evil = rows.find((r) => r[DESC]?.includes('HYPERLINK'))!;
    expect(evil[DESC]).toBe('=HYPERLINK("http://evil")');
  });

  it('flags a negative balance on the account and gives the total of all accounts', async () => {
    const rows = await rowsOf(book());
    const negative = rows.find((r) => r[BAL] === '-50000')!;
    expect(negative[NOTE]).toContain('Số dư âm');
    const all = rows.find((r) => r[DESC] === 'Số dư đầu kỳ, thu, chi, số dư cuối kỳ')!;
    expect([all[IN], all[OUT], all[BAL]]).toEqual(['1000000', '300000', '1150000']);
  });

  it('labels the figures and lists the unconfirmed row while the layout is commentary, and says nothing once it is confirmed', async () => {
    const draft = await rowsOf(book());
    expect(draft.flat()).toContain(HOUSEHOLD_PROVISIONAL_LABEL.toUpperCase());
    expect(draft.flat().some((t) => t.includes('Chưa xác nhận: mẫu S2e 2026.1'))).toBe(true);
    expect(draft.find((r) => r[REF] === 'AA-0001')![NOTE]).toBe(HOUSEHOLD_PROVISIONAL_LABEL);
    const confirmed = await rowsOf(book({ commentary: false, unconfirmed: [], form: { book: 'S2e', version: '2026.1', name: 'Sổ chi tiết tiền (S2e-HKD)', status: 'confirmed' } }));
    expect(confirmed.flat().some((t) => t.includes('Số liệu tạm'))).toBe(false);
    expect(confirmed.find((r) => r[REF] === 'AA-0001')![NOTE]).toBe('');
  });

  it('says so when there is no cash or bank movement', async () => {
    const rows = await rowsOf(book({ accounts: [], totals: { opening: '0', in: '0', out: '0', closing: '0' } }));
    expect(rows.flat()).toContain('Không có số dư hay phát sinh tiền mặt, tiền gửi ngân hàng trong kỳ này.');
  });
});
