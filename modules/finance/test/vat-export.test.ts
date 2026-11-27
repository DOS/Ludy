// The VAT working workbook (issue #316): the summary with the form 01/GTGT indicators, one listing per side, amounts
// exact (text beyond Excel's 15 digits) and no text read as a formula.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildVatWorkbook, form01Indicators, sideTotals, vatPeriod, type VatInvoiceView, type VatReport } from '../src/index.ts';
import { expectExcelSheetNames } from './sheet-names.ts';

function invoice(id: string, overrides: Partial<VatInvoiceView> = {}): VatInvoiceView {
  return {
    id,
    issueDate: '2026-09-15',
    saleDate: null,
    postingDate: '2026-09-15',
    series: 'C26TAB',
    number: '1234',
    partyName: 'Công ty TNHH ABC',
    partyTaxCode: '0101234564',
    subtotal: '1800000',
    vatAmount: '180000',
    total: '1980000',
    rates: [{ rate: '10', taxable: '1800000', vat: '180000' }],
    warnings: [],
    ...overrides,
  };
}

function report(input: VatInvoiceView[], output: VatInvoiceView[] | null, supplementary: VatInvoiceView[] = []): VatReport {
  const inputSide = { available: true, documents: input, totals: sideTotals(input) };
  const outputSide = { available: output !== null, documents: output ?? [], totals: sideTotals(output ?? []) };
  const supplementaryTotals = sideTotals(supplementary);
  return { period: vatPeriod('2026-09'), input: inputSide, output: outputSide, supplementary: { documents: supplementary, totals: supplementaryTotals }, lateSales: [], indicators: form01Indicators(inputSide.totals, outputSide.totals), paymentChecks: { items: [], vatAtRisk: '0', notDeductibleVat: '0', unchecked: 0, suggested25: inputSide.totals.vat }, carryForward: { amount: '0', previous: null, lookedFor: [] }, filed: null };
}

async function readBack(r: VatReport, brand?: string): Promise<ExcelJS.Workbook> {
  const bytes = await buildVatWorkbook(r, 'demo', brand);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return workbook;
}

const rowsOf = (sheet: ExcelJS.Worksheet) => (sheet.getRows(1, sheet.rowCount) ?? []).map((row) => (row.values as unknown[]).slice(1));

describe('buildVatWorkbook', () => {
  it('writes the summary, then the sales and purchase listings', async () => {
    const workbook = await readBack(
      report(
        [
          invoice('a'),
          invoice('b', {
            number: '99',
            rates: [
              { rate: '8', taxable: '333333', vat: '26667' },
              { rate: '10', taxable: '1000001', vat: '100001' },
            ],
            warnings: ['rate_split'],
          }),
        ],
        null,
      ),
    );
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Tổng hợp', 'Bán ra', 'Mua vào']);
    expectExcelSheetNames(workbook);
    expect(workbook.title).toBe('Tờ khai GTGT 2026-09 demo');

    const summary = rowsOf(workbook.getWorksheet('Tổng hợp') as ExcelJS.Worksheet);
    const byCode = new Map(summary.filter((r) => typeof r[0] === 'string' && String(r[0]).startsWith('[')).map((r) => [r[0], r[2]]));
    expect(byCode.get('[23]')).toBe(3133334);
    expect(byCode.get('[24]')).toBe(306668);
    expect(byCode.get('[32]')).toBe(0);
    expect(summary.some((r) => r.includes('Chưa nhập mã số thuế của tổ chức nên Ludy chưa nhận ra hóa đơn bán ra'))).toBe(true);

    const sales = rowsOf(workbook.getWorksheet('Bán ra') as ExcelJS.Worksheet);
    expect(sales[0]).toEqual(['STT', 'Ngày hóa đơn', 'Ký hiệu HĐ', 'Số HĐ', 'MST người mua', 'Tên người mua', 'Thuế suất', 'Giá trị chưa có thuế', 'Thuế GTGT', 'Ghi chú']);

    const purchases = rowsOf(workbook.getWorksheet('Mua vào') as ExcelJS.Worksheet);
    expect(purchases.slice(1)).toEqual([
      [1, '2026-09-15', 'C26TAB', '1234', '0101234564', 'Công ty TNHH ABC', '10%', 1800000, 180000, ''],
      [2, '2026-09-15', 'C26TAB', '99', '0101234564', 'Công ty TNHH ABC', '8%', 333333, 26667, 'Thuế GTGT chia theo thuế suất là số ước tính'],
      [2, '2026-09-15', 'C26TAB', '99', '0101234564', 'Công ty TNHH ABC', '10%', 1000001, 100001, 'Thuế GTGT chia theo thuế suất là số ước tính'],
      [undefined, undefined, undefined, undefined, undefined, 'Tổng cộng', undefined, 3133334, 306668],
    ]);
  });

  // #1045: the file's creator and its notes name the product by BRAND_NAME, "Ludy" when not given (#1683).
  it('names the product by the brand it is given', async () => {
    const crove = await readBack(report([], null));
    expect(crove.creator).toBe('Ludy');
    const renamed = await readBack(report([], null), 'Tên Mới');
    expect(renamed.creator).toBe('Tên Mới');
    const text = renamed.worksheets.flatMap((sheet) => rowsOf(sheet).flat()).join('\n');
    expect(text).toContain('Chưa nhập mã số thuế của tổ chức nên Tên Mới chưa nhận ra hóa đơn bán ra');
    expect(text).not.toContain('Crove');
  });

  it('says when sales at an unknown rate are in no indicator, and names a VAT mismatch (#358)', async () => {
    const OTHER = 'Doanh thu bán ra chưa rõ thuế suất, không nằm trong chỉ tiêu nào: kiểm tra các hóa đơn đó trước khi nộp tờ khai';
    const workbook = await readBack(
      report(
        [invoice('a', { vatAmount: '0', rates: [{ rate: '10', taxable: '1800000', vat: '0' }], warnings: ['vat_mismatch'] })],
        [invoice('s', { rates: [{ rate: 'other', taxable: '500000', vat: '0' }], warnings: ['rate_unknown'] })],
      ),
    );
    const summary = rowsOf(workbook.getWorksheet('Tổng hợp') as ExcelJS.Worksheet);
    expect(summary.find((r) => r[1] === OTHER)?.[2]).toBe(500000);
    const purchases = rowsOf(workbook.getWorksheet('Mua vào') as ExcelJS.Worksheet);
    expect(purchases[1]?.[9]).toBe('Thuế GTGT lệch giá trị trước thuế nhân thuế suất');

    // No such row when every sale has a known rate.
    const clean = rowsOf((await readBack(report([], [invoice('s')]))).getWorksheet('Tổng hợp') as ExcelJS.Worksheet);
    expect(clean.some((r) => r[1] === OTHER)).toBe(false);
  });

  it('keeps amounts beyond 15 digits as exact text and text as text', async () => {
    const workbook = await readBack(
      report(
        [
          invoice('a', {
            partyName: '=HYPERLINK("http://x","y")',
            series: '-1',
            rates: [{ rate: '10', taxable: '1234567890123456', vat: '123456789012345' }],
          }),
        ],
        [],
      ),
    );
    const sheet = workbook.getWorksheet('Mua vào') as ExcelJS.Worksheet;
    const row = sheet.getRow(2);
    expect(row.getCell(6).type).toBe(ExcelJS.ValueType.String);
    expect(row.getCell(6).value).toBe('=HYPERLINK("http://x","y")');
    expect(row.getCell(3).value).toBe('-1');
    expect(row.getCell(8)).toMatchObject({ type: ExcelJS.ValueType.String, value: '1234567890123456' });
    expect(row.getCell(9)).toMatchObject({ type: ExcelJS.ValueType.Number, value: 123456789012345 });
    // An empty but available sales side has only its header and the total row.
    const sales = rowsOf(workbook.getWorksheet('Bán ra') as ExcelJS.Worksheet);
    expect(sales.slice(1)).toEqual([[undefined, undefined, undefined, undefined, undefined, 'Tổng cộng', undefined, 0, 0]]);
  });

  it('writes supplementary items, their by-rate totals and combined sales when present, without touching regular exports (#3541)', async () => {
    const regular = await readBack(report([invoice('a')], [invoice('s1')]));
    expect(regular.worksheets.map((s) => s.name)).toEqual(['Tổng hợp', 'Bán ra', 'Mua vào']);
    const regularSummary = rowsOf(regular.getWorksheet('Tổng hợp') as ExcelJS.Worksheet);
    expect(regularSummary.some((r) => String(r[1] ?? '').includes('bổ sung'))).toBe(false);

    const supp = [
      invoice('sup1', {
        issueDate: '2026-10-05',
        saleDate: '2026-09-28',
        number: '2001',
        partyName: '=CMD("x")',
        rates: [
          { rate: '8', taxable: '500000', vat: '40000' },
          { rate: '10', taxable: '1234567890123456', vat: '123456789012346' },
        ],
        warnings: ['late_sale'],
      }),
      invoice('sup2', {
        issueDate: '2026-10-06',
        saleDate: '2026-09-29',
        number: '2002',
        rates: [{ rate: 'other', taxable: '250000', vat: '0' }],
        warnings: ['late_sale', 'rate_unknown'],
      }),
    ];
    const workbook = await readBack(report([invoice('a')], [invoice('s1')], supp));
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Tổng hợp', 'Bán ra', 'Mua vào', 'Kê khai bổ sung']);
    expectExcelSheetNames(workbook);

    const summary = rowsOf(workbook.getWorksheet('Tổng hợp') as ExcelJS.Worksheet);
    // Main [32] and [33] on Tổng hợp keep the original declared output (not reopened by supplementary).
    const byCode = new Map(summary.filter((r) => typeof r[0] === 'string' && String(r[0]).startsWith('[')).map((r) => [r[0], r[2]]));
    expect(byCode.get('[32]')).toBe(1800000);
    expect(byCode.get('[33]')).toBe(180000);

    const suppTitleIdx = summary.findIndex((r) => r[1] === 'Hóa đơn bán ra cần kê khai bổ sung theo thuế suất');
    expect(suppTitleIdx).toBeGreaterThan(-1);
    expect(summary[suppTitleIdx]?.slice(2, 4)).toEqual(['Giá trị chưa có thuế', 'Thuế GTGT']);

    const suppTotalRow = summary.slice(suppTitleIdx).find((r) => r[1] === 'Tổng cộng (2 hóa đơn)');
    expect(suppTotalRow?.slice(2, 4)).toEqual(['1234567890873456', 123456789052346]);

    const combinedRow = summary.find((r) => r[1] === 'Tổng bán ra sau bổ sung (3 hóa đơn)');
    expect(combinedRow?.slice(2, 4)).toEqual(['1234567892673456', 123456789232346]);
    expect(summary.some((r) => String(r[1] ?? '').includes('nằm ngoài bảng kê bán ra và chỉ tiêu [26] đến [35]'))).toBe(true);
    const otherSuppRow = summary.find((r) => r[1] === 'Doanh thu bán ra cần kê khai bổ sung chưa rõ thuế suất, không nằm trong chỉ tiêu nào: kiểm tra các hóa đơn đó trước khi nộp tờ khai bổ sung');
    expect(otherSuppRow?.[2]).toBe(250000);

    const suppSheet = workbook.getWorksheet('Kê khai bổ sung') as ExcelJS.Worksheet;
    const suppRows = rowsOf(suppSheet);
    expect(suppRows[0]).toEqual(['STT', 'Ngày hóa đơn', 'Ký hiệu HĐ', 'Số HĐ', 'MST người mua', 'Tên người mua', 'Thuế suất', 'Giá trị chưa có thuế', 'Thuế GTGT', 'Ghi chú']);
    expect(suppRows[1]).toEqual([
      1,
      '2026-10-05',
      'C26TAB',
      '2001',
      '0101234564',
      '=CMD("x")',
      '8%',
      500000,
      40000,
      'Ngày bán 2026-09-28; Hóa đơn lập sau kỳ của ngày bán (hóa đơn lập muộn): kê khai ở kỳ của ngày bán',
    ]);
    expect(suppSheet.getRow(2).getCell(6).type).toBe(ExcelJS.ValueType.String);
    expect(suppSheet.getRow(3).getCell(8)).toMatchObject({ type: ExcelJS.ValueType.String, value: '1234567890123456' });
    expect(suppRows[3]).toEqual([
      2,
      '2026-10-06',
      'C26TAB',
      '2002',
      '0101234564',
      'Công ty TNHH ABC',
      'Chưa rõ thuế suất',
      250000,
      0,
      'Ngày bán 2026-09-29; Hóa đơn lập sau kỳ của ngày bán (hóa đơn lập muộn): kê khai ở kỳ của ngày bán; Có dòng chưa rõ thuế suất',
    ]);
    expect(suppRows[4]).toEqual([undefined, undefined, undefined, undefined, undefined, 'Tổng cộng', undefined, '1234567890873456', 123456789052346]);
  });
});
