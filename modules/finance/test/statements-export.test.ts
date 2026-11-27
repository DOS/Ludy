// The financial statements workbook (issue #154): B01-DNN and B02-DNN sheets, each opening with the draft notice,
// totals in bold, the balances no line reads listed after the lines, and the unbalanced warning on B01. Amounts exact
// and no text read as a formula, as in the other exports. With the comparison columns (#2090): B01's start of year, and
// B02 for the same period of the previous year and the period right before; a comparison that does not exist has no column.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildStatementsWorkbook, ledgerPeriod, type FinancialStatements } from '../src/index.ts';
import { B01_TT99_DRAFT, DRAFT_NOTICE, MIXED_CHARTS_NOTICE, TT99_NOTICE } from '../src/statements-export.ts';
import { expectExcelSheetNames } from './sheet-names.ts';

const NO_COMPARISON: FinancialStatements['comparison'] = { startOfYear: null, lastYear: null, previous: null };

function statements(
  overrides: { regime?: 'tt133' | 'tt99'; mixedCharts?: boolean; balanced?: boolean; unmapped?: FinancialStatements['b01']['unmapped']; payable?: string; period?: string; comparison?: FinancialStatements['comparison'] } = {},
): FinancialStatements {
  return {
    period: ledgerPeriod(overrides.period ?? '2026-09'),
    ...(overrides.regime ? { regime: overrides.regime } : {}),
    ...(overrides.mixedCharts !== undefined ? { mixedCharts: overrides.mixedCharts } : {}),
    comparison: overrides.comparison ?? NO_COMPARISON,
    b01: {
      asOf: '2026-09-30',
      lines: [
        { code: '181', label: 'Thuế GTGT được khấu trừ', amount: '360000', total: false },
        { code: '200', label: 'TỔNG CỘNG TÀI SẢN', amount: '360000', total: true },
        { code: '311', label: 'Phải trả người bán', amount: overrides.payable ?? '3960000', total: false },
        { code: '500', label: 'TỔNG CỘNG NGUỒN VỐN', amount: '360000', total: true },
      ],
      unmapped: overrides.unmapped ?? [],
      balanced: overrides.balanced ?? true,
    },
    b02: {
      from: '2026-09-01',
      to: '2026-09-30',
      lines: [
        { code: '24', label: 'Chi phí quản lý kinh doanh', amount: '1800000', total: false },
        { code: '60', label: '=SUM(A1)', amount: '-1800000', total: true },
      ],
      unmapped: [],
    },
  };
}

async function readBack(s: FinancialStatements) {
  const bytes = await buildStatementsWorkbook(s, 'demo');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return workbook;
}

const rowsOf = (sheet: ExcelJS.Worksheet | undefined) => (sheet?.getRows(1, sheet.rowCount) ?? []).map((row) => (row.values as unknown[]).slice(1));

describe('buildStatementsWorkbook', () => {
  it('adds the start of year to B01 and the same period a year earlier and the period before to B02', async () => {
    const workbook = await readBack(
      statements({
        comparison: {
          startOfYear: { asOf: '2025-12-31', amounts: { '181': '100000', '200': '100000', '311': '-12345678901234567', '500': '100000' }, balanced: true, unmapped: 0 },
          lastYear: { period: '2025-09', from: '2025-09-01', to: '2025-09-30', amounts: { '24': '900000', '60': '-900000' }, unmapped: 0 },
          previous: { period: '2026-08', from: '2026-08-01', to: '2026-08-31', amounts: { '24': '1800000' }, unmapped: 0 },
        },
      }),
    );
    const b01 = rowsOf(workbook.getWorksheet('B01-DNN'));
    expect(b01.slice(2)).toEqual([
      ['Chỉ tiêu', 'Mã số', 'Số cuối kỳ (2026-09-30)', 'Số đầu năm (2025-12-31)'],
      ['Thuế GTGT được khấu trừ', '181', 360000, 100000],
      ['TỔNG CỘNG TÀI SẢN', '200', 360000, 100000],
      // Amounts stay exact, and a line the start of year has nothing on reads 0.
      ['Phải trả người bán', '311', 3960000, '-12345678901234567'],
      ['TỔNG CỘNG NGUỒN VỐN', '500', 360000, 100000],
    ]);
    const b02 = rowsOf(workbook.getWorksheet('B02-DNN'));
    expect(b02.slice(2)).toEqual([
      ['Chỉ tiêu', 'Mã số', 'Kỳ này', 'Cùng kỳ năm trước (2025-09)', 'Kỳ liền trước (2026-08)'],
      ['Chi phí quản lý kinh doanh', '24', 1800000, 900000, 1800000],
      ['=SUM(A1)', '60', -1800000, -900000, 0],
    ]);
  });

  it('names the TT99 sheets B01-DN and B02-DN, and the TT133 ones B01-DNN and B02-DNN', async () => {
    const tt99 = await readBack(statements({ regime: 'tt99' }));
    expect(tt99.worksheets.map((sheet) => sheet.name)).toEqual(['B01-DN', 'B02-DN']);
    expectExcelSheetNames(tt99);
    const tt133 = await readBack(statements({ regime: 'tt133' }));
    expect(tt133.worksheets.map((sheet) => sheet.name)).toEqual(['B01-DNN', 'B02-DNN']);
    expect((await readBack(statements())).worksheets.map((sheet) => sheet.name)).toEqual(['B01-DNN', 'B02-DNN']);
  });

  it('puts the fixed draft label under the draft notice of a TT99 B01, and nowhere on a TT133 sheet (#5204)', async () => {
    const tt99 = await readBack(statements({ regime: 'tt99' }));
    const b01 = rowsOf(tt99.getWorksheet('B01-DN'));
    expect(b01[0]).toEqual([DRAFT_NOTICE]);
    expect(b01[1]).toEqual([B01_TT99_DRAFT]);
    expect(B01_TT99_DRAFT).toBe('Bản nháp, kế toán chưa xác nhận cách lập');
    // The header row follows the label, and the freeze keeps it with the rows above.
    expect(b01[3]?.[0]).toBe('Chỉ tiêu');
    expect(tt99.getWorksheet('B01-DN')?.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });
    expect(rowsOf(tt99.getWorksheet('B02-DN'))[1]).not.toEqual([B01_TT99_DRAFT]);
    const tt133 = await readBack(statements({ regime: 'tt133' }));
    for (const sheet of tt133.worksheets) expect(rowsOf(sheet).map((row) => row[0])).not.toContain(B01_TT99_DRAFT);
    expect(tt133.getWorksheet('B01-DNN')?.views[0]).toMatchObject({ ySplit: 3 });
  });

  it('says on the TT99 B02 sheet that it is read under the TT99 chart, and adds the mixed-chart warning to both sheets only when asked (#5187)', async () => {
    const tt99 = await readBack(statements({ regime: 'tt99' }));
    const b02 = rowsOf(tt99.getWorksheet('B02-DN')).map((row) => row[0]);
    expect(b02).toContain(TT99_NOTICE);
    expect(b02).not.toContain(MIXED_CHARTS_NOTICE);
    // The old sentence that B01 keeps the TT133 layout is gone: B01 has its own label instead.
    expect(TT99_NOTICE).not.toMatch(/Thông tư 133/);
    const mixed = await readBack(statements({ regime: 'tt99', mixedCharts: true }));
    for (const name of ['B01-DN', 'B02-DN']) expect(rowsOf(mixed.getWorksheet(name)).map((row) => row[0])).toContain(MIXED_CHARTS_NOTICE);
    const tt133 = await readBack(statements({ regime: 'tt133' }));
    expect(rowsOf(tt133.getWorksheet('B02-DNN')).map((row) => row[0])).not.toContain(TT99_NOTICE);
  });

  it('names the TT99 total lines (280 and 440) in the unbalanced warnings, and the TT133 ones (200 and 500) otherwise', async () => {
    const column = { startOfYear: { asOf: '2025-12-31', amounts: {}, balanced: false, unmapped: 0 }, lastYear: null, previous: null };
    const tt99 = await readBack(statements({ regime: 'tt99', balanced: false, comparison: column }));
    const labels99 = rowsOf(tt99.getWorksheet('B01-DN')).map((row) => String(row[0]));
    expect(labels99.filter((label) => label.includes('mã 280') && label.includes('mã 440'))).toHaveLength(2);
    const tt133 = await readBack(statements({ regime: 'tt133', balanced: false, comparison: column }));
    const labels133 = rowsOf(tt133.getWorksheet('B01-DNN')).map((row) => String(row[0]));
    expect(labels133.filter((label) => label.includes('mã 200') && label.includes('mã 500'))).toHaveLength(2);
  });

  it('warns under a comparison column that does not balance or that no line reads in full', async () => {
    const workbook = await readBack(
      statements({
        comparison: {
          startOfYear: { asOf: '2025-12-31', amounts: { '200': '100' }, balanced: false, unmapped: 2 },
          lastYear: { period: '2025-09', from: '2025-09-01', to: '2025-09-30', amounts: {}, unmapped: 1 },
          previous: { period: '2026-08', from: '2026-08-01', to: '2026-08-31', amounts: {}, unmapped: 0 },
        },
      }),
    );
    // B01's own figures balance here, so the only warnings are the start of year's.
    expect(rowsOf(workbook.getWorksheet('B01-DNN')).slice(7)).toEqual([
      ['Cảnh báo: tổng tài sản (mã 200) và tổng nguồn vốn (mã 500) của cột Số đầu năm (2025-12-31) không bằng nhau'],
      ['Cảnh báo: cột Số đầu năm (2025-12-31) có số dư chưa được chỉ tiêu nào đọc, báo cáo chưa đầy đủ'],
    ]);
    expect(rowsOf(workbook.getWorksheet('B02-DNN')).slice(5)).toEqual([['Cảnh báo: cột Cùng kỳ năm trước (2025-09) có số dư chưa được chỉ tiêu nào đọc, báo cáo chưa đầy đủ']]);
  });

  it('names the previous year for a year, and leaves out a comparison that does not exist', async () => {
    const year = await readBack(
      statements({
        period: '2026',
        comparison: { startOfYear: null, lastYear: { period: '2025', from: '2025-01-01', to: '2025-12-31', amounts: { '24': '5000' }, unmapped: 0 }, previous: null },
      }),
    );
    expect(rowsOf(year.getWorksheet('B02-DNN')).slice(2, 4)).toEqual([
      ['Chỉ tiêu', 'Mã số', 'Kỳ này', 'Năm trước (2025)'],
      ['Chi phí quản lý kinh doanh', '24', 1800000, 5000],
    ]);
    // B01 has no start of year here: its header row keeps the three columns.
    expect(rowsOf(year.getWorksheet('B01-DNN'))[2]).toEqual(['Chỉ tiêu', 'Mã số', 'Số cuối kỳ (2026-09-30)']);
  });

  it('writes B01 and B02, each under the draft notice, with totals in bold', async () => {
    const workbook = await readBack(statements());
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['B01-DNN', 'B02-DNN']);
    expectExcelSheetNames(workbook);
    expect(workbook.title).toMatch(/^Báo cáo tài chính /);
    const b01 = workbook.getWorksheet('B01-DNN');
    expect(rowsOf(b01)).toEqual([
      [DRAFT_NOTICE],
      ['Báo cáo tình hình tài chính (B01-DNN) tại ngày 2026-09-30'],
      ['Chỉ tiêu', 'Mã số', 'Số cuối kỳ (2026-09-30)'],
      ['Thuế GTGT được khấu trừ', '181', 360000],
      ['TỔNG CỘNG TÀI SẢN', '200', 360000],
      ['Phải trả người bán', '311', 3960000],
      ['TỔNG CỘNG NGUỒN VỐN', '500', 360000],
    ]);
    expect(b01?.getRow(4).font?.bold).toBeFalsy();
    expect(b01?.getRow(5).font?.bold).toBe(true);
    const b02 = rowsOf(workbook.getWorksheet('B02-DNN'));
    expect(b02[0]).toEqual([DRAFT_NOTICE]);
    expect(b02[1]).toEqual(['Báo cáo kết quả hoạt động kinh doanh (B02-DNN), kỳ 2026-09 (2026-09-01 đến 2026-09-30)']);
    expect(b02.slice(3)).toEqual([
      ['Chi phí quản lý kinh doanh', '24', 1800000],
      // A label that looks like a formula stays text.
      ['=SUM(A1)', '60', -1800000],
    ]);
  });

  it('lists the balances no line reads, warns when B01 does not balance, and keeps amounts exact', async () => {
    const workbook = await readBack(
      statements({
        balanced: false,
        payable: '12345678901234567',
        unmapped: [{ accountCode: '3388', accountName: 'Phải trả khác', partyName: 'Công ty TNHH ABC', amount: '-500000' }],
      }),
    );
    const b01 = rowsOf(workbook.getWorksheet('B01-DNN'));
    expect(b01.find((r) => r[1] === '311')?.[2]).toBe('12345678901234567');
    expect(b01.slice(7)).toEqual([
      [],
      ['Cảnh báo: các số dư dưới đây chưa được chỉ tiêu nào đọc, báo cáo chưa đầy đủ (số dư Nợ dương, Có âm)'],
      ['Phải trả khác, Công ty TNHH ABC', '3388', -500000],
      ['Cảnh báo: tổng tài sản (mã 200) và tổng nguồn vốn (mã 500) không bằng nhau'],
    ]);
  });
});
