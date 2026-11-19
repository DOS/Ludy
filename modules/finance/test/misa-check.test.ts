// SPDX-License-Identifier: AGPL-3.0-only
// The check before a MISA SME export (#3848), against the real templates: every finding names a column by MISA's own header, the file and the check read the same rows, and an export with nothing wrong reports
// nothing. Rows come from the same builders the export uses, so a template change that moves a column moves the check with it.
import { describe, expect, it } from 'vitest';
import {
  MISA_SME_BANK_CREDIT,
  MISA_SME_BANK_DEBIT,
  MISA_SME_CASH_PAYMENT,
  MISA_SME_CASH_RECEIPT,
  MISA_SME_PURCHASE_GOODS,
  MISA_SME_PURCHASE_SERVICE,
  MISA_SME_SALES,
  cashRows,
  goodsPurchaseRows,
  salesRows,
  servicePurchaseRows,
  type CashVoucher,
  type PurchaseVoucher,
  type SalesVoucher,
} from '../src/misa.ts';
import { MISA_INVOICE_NUMBER_LIMIT, checkMisaRows } from '../src/misa-check.ts';
import { MISA_CHECK_EXAMPLES, accountParents } from '@crove/kernel-contract';

const ENTRY_ID = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5c';
const SOURCE_ID = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5d';
const CHART = new Set(['111', '1111', '112', '131', '331', '3331', '1331', '1332', '511', '6422', '152', '156']);

const line = (lineNo: number, amount: string, vatRate: string | null, debitAccount = '6422'): PurchaseVoucher['lines'][number] => ({
  lineNo,
  description: `Dòng ${lineNo}`,
  unit: null,
  quantity: null,
  unitPrice: null,
  amount,
  vatRate,
  debitAccount,
});

function purchase(overrides: Partial<PurchaseVoucher> = {}): PurchaseVoucher {
  return {
    sourceId: SOURCE_ID,
    entryId: ENTRY_ID,
    entryDate: '2026-09-30',
    description: 'Mua dịch vụ',
    invoice: { series: 'C26TAA', number: '123', date: '2026-09-29' },
    vendor: { name: 'Công ty TNHH ABC', taxCode: '0101234564', address: '1 Láng Hạ, Hà Nội' },
    vatAmount: '200000',
    lines: [line(1, '1000000', '10%'), line(2, '1000000', '10%')],
    ...overrides,
  };
}

function sale(overrides: Partial<SalesVoucher> = {}): SalesVoucher {
  return {
    sourceId: SOURCE_ID,
    entryId: ENTRY_ID,
    entryDate: '2026-10-05',
    description: 'Bán hàng',
    invoice: { series: 'C26TBB', number: '45', date: '2026-10-05' },
    customer: { name: 'Công ty CP XYZ', taxCode: '0312345678', address: '2 Lê Lợi, TP.HCM' },
    receivableAccount: '131',
    vatAccount: '3331',
    vatAmount: '80000',
    lines: [{ lineNo: 1, description: 'Tư vấn', unit: null, quantity: null, unitPrice: null, amount: '1000000', vatRate: '8%', revenueAccount: '511' }],
    ...overrides,
  };
}

function cash(overrides: Partial<CashVoucher> = {}): CashVoucher {
  return {
    sourceId: SOURCE_ID,
    type: 'cash_payment',
    code: 'PC00012',
    numberPeriod: '2026',
    date: '2026-10-07',
    cashAccount: '1111',
    party: { name: 'Công ty TNHH ABC', taxCode: '0101234564', address: null },
    personName: 'Nguyễn Văn An',
    description: 'Trả tiền',
    lines: [{ lineNo: 1, account: '331', amount: '1650000', memo: null }],
    ...overrides,
  };
}

const rowId = (r: { voucherNo: string; line: { lineNo: number } }) => ({ voucherNo: r.voucherNo, lineNo: r.line.lineNo });
const checkService = (vouchers: PurchaseVoucher[], chart = CHART) =>
  checkMisaRows({ format: 'misa_sme_purchases', template: MISA_SME_PURCHASE_SERVICE, rows: vouchers.flatMap(servicePurchaseRows), chart, rowId });
const group = (result: ReturnType<typeof checkService>, kind: string, column: string) => result.groups.find((g) => g.kind === kind && g.column === column);

describe('the check before a MISA export (#3848)', () => {
  it('reports the catalog codes the services template leaves blank, once per column with a count, and nothing else for a clean voucher', () => {
    const result = checkService([purchase()]);
    expect(result.rows).toBe(2);
    // The codes are the accountant's to fill (MISA catalog), so each blank column is one group counting the rows, not one line per row.
    expect(group(result, 'MISSING_CODE', 'Mã dịch vụ (*)')).toMatchObject({ count: 2, limit: null });
    expect(group(result, 'MISSING_CODE', 'Mã nhà cung cấp')?.count).toBe(2);
    // "Mã NCC" repeats the supplier code further along the template: it is not read twice.
    expect(group(result, 'MISSING_CODE', 'Mã NCC')).toBeUndefined();
    expect(result.groups.every((g) => g.kind === 'MISSING_CODE')).toBe(true);
    expect(result.findings).toBe(4);
    // Examples name the voucher and the line, nothing of the vendor.
    expect(group(result, 'MISSING_CODE', 'Mã dịch vụ (*)')?.examples).toEqual([
      { voucherNo: expect.stringMatching(/^CRMDV/), lineNo: 1 },
      { voucherNo: expect.stringMatching(/^CRMDV/), lineNo: 2 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/ABC|Láng Hạ|0101234564/);
  });

  it('flags an account that is not in the org chart, on the column that holds it', () => {
    const chart = new Set([...CHART].filter((c) => c !== '6422'));
    const result = checkService([purchase()], chart);
    expect(group(result, 'ACCOUNT_NOT_IN_CHART', 'TK chi phí/TK kho')?.count).toBe(2);
    // 331 and 1331 are in the chart: no group for them.
    expect(group(result, 'ACCOUNT_NOT_IN_CHART', 'TK công nợ/TK tiền')).toBeUndefined();
    expect(group(result, 'ACCOUNT_NOT_IN_CHART', 'TK thuế GTGT')).toBeUndefined();
  });

  it('flags a VAT rate cell that is blank on a line that carries VAT, and accepts the codes of the template', () => {
    // An unknown rate on a line: the rounding difference of the invoice's VAT goes to it, so the line has VAT with a blank rate cell.
    const unknown = purchase({ vatAmount: '100000', lines: [line(1, '1000000', null)] });
    expect(group(checkService([unknown]), 'VAT_CODE', '% thuế GTGT')?.count).toBe(1);
    for (const rate of ['0%', '5%', '8%', '10%', 'KCT', 'KKKNT', 'KHAC:5.26%']) {
      const ok = purchase({ vatAmount: '0', lines: [line(1, '1000000', rate)] });
      expect(group(checkService([ok]), 'VAT_CODE', '% thuế GTGT'), rate).toBeUndefined();
    }
    // A blank rate with no VAT on the line is nothing for MISA to refuse.
    const none = purchase({ vatAmount: '0', lines: [line(1, '1000000', null)] });
    expect(group(checkService([none]), 'VAT_CODE', '% thuế GTGT')).toBeUndefined();
  });

  it('flags a text over the template limit (it is cut in the file) and an invoice number over 25 characters (never cut)', () => {
    const long = purchase({ vendor: { name: 'N'.repeat(129), taxCode: null, address: null }, invoice: { series: 'C26TAA', number: '9'.repeat(MISA_INVOICE_NUMBER_LIMIT + 1), date: '2026-09-29' } });
    const result = checkService([long]);
    expect(group(result, 'TOO_LONG', 'Tên nhà cung cấp')).toMatchObject({ limit: 128, count: 2 });
    expect(group(result, 'TOO_LONG', 'Số hóa đơn')).toMatchObject({ limit: MISA_INVOICE_NUMBER_LIMIT, count: 2 });
    const exact = purchase({ vendor: { name: 'N'.repeat(128), taxCode: null, address: null }, invoice: { series: 'C26TAA', number: '9'.repeat(MISA_INVOICE_NUMBER_LIMIT), date: '2026-09-29' } });
    expect(group(checkService([exact]), 'TOO_LONG', 'Tên nhà cung cấp')).toBeUndefined();
    expect(group(checkService([exact]), 'TOO_LONG', 'Số hóa đơn')).toBeUndefined();
  });

  it('keeps at most 20 examples per group and counts them all', () => {
    const many = Array.from({ length: 30 }, (_, i) => purchase({ entryId: `0192f0a1-2b3c-7d4e-8f50-6172839a4b${String(i).padStart(2, '0')}`, lines: [line(1, '1000000', '10%')], vatAmount: '100000' }));
    const g = group(checkService(many), 'MISSING_CODE', 'Mã dịch vụ (*)');
    expect(g?.count).toBe(30);
    expect(g?.examples).toHaveLength(MISA_CHECK_EXAMPLES);
  });

  it('on the goods template only the supplier code is the accountant\'s to fill: the item and warehouse codes come from Settings or the defaults, and a stock account missing from the chart is flagged', () => {
    const parents = accountParents([{ code: '156', parentCode: null }]);
    const stock = purchase({ lines: [line(1, '1000000', '10%', '156')], vatAmount: '100000' });
    const check = (codes: Array<{ accountCode: string; itemCode: string; warehouseCode: string }>, chart = CHART) =>
      checkMisaRows({ format: 'misa_sme_goods_purchases', template: MISA_SME_PURCHASE_GOODS, rows: goodsPurchaseRows(stock, codes as never, parents), chart, rowId });
    for (const result of [check([]), check([{ accountCode: '156', itemCode: 'HH01', warehouseCode: 'KHO1' }])]) {
      expect(result.rows).toBe(1);
      expect(result.groups.map((g) => [g.kind, g.column, g.count])).toEqual([['MISSING_CODE', 'Mã nhà cung cấp', 1]]);
    }
    const noStock = check([], new Set([...CHART].filter((c) => c !== '156')));
    expect(group(noStock, 'ACCOUNT_NOT_IN_CHART', 'TK kho (*)')?.count).toBe(1);
  });

  it('checks every one of the seven templates without throwing, and names columns that exist in the template', () => {
    const results = [
      checkMisaRows({ format: 'misa_sme_sales', template: MISA_SME_SALES, rows: salesRows(sale()), chart: CHART, rowId }),
      ...(
        [
          ['misa_sme_cash_receipts', MISA_SME_CASH_RECEIPT],
          ['misa_sme_cash_payments', MISA_SME_CASH_PAYMENT],
          ['misa_sme_bank_credits', MISA_SME_BANK_CREDIT],
          ['misa_sme_bank_debits', MISA_SME_BANK_DEBIT],
        ] as const
      ).map(([format, template]) => checkMisaRows({ format, template, rows: cashRows(cash()), chart: CHART, rowId })),
    ];
    for (const [i, result] of results.entries()) {
      const headers = new Set(
        [MISA_SME_SALES, MISA_SME_CASH_RECEIPT, MISA_SME_CASH_PAYMENT, MISA_SME_BANK_CREDIT, MISA_SME_BANK_DEBIT][i]?.columns.map((c) => c.header),
      );
      expect(result.rows, String(i)).toBeGreaterThan(0);
      for (const g of result.groups) expect(headers.has(g.column), g.column).toBe(true);
    }
    // The sales template's item code is the accountant's to fill: blank, so a finding; and a sale's accounts are in the chart.
    expect(results[0]?.groups.some((g) => g.kind === 'MISSING_CODE' && g.column === 'Mã hàng (*)')).toBe(true);
    expect(results[0]?.groups.some((g) => g.kind === 'ACCOUNT_NOT_IN_CHART')).toBe(false);
  });

  it('reads one party code per cash or bank template, not the repeats of the tax and detail blocks', () => {
    const payment = checkMisaRows({ format: 'misa_sme_cash_payments', template: MISA_SME_CASH_PAYMENT, rows: cashRows(cash()), chart: CHART, rowId });
    expect(payment.groups.filter((g) => g.kind === 'MISSING_CODE').map((g) => g.column)).toEqual(['Mã đối tượng']);
    const debit = checkMisaRows({ format: 'misa_sme_bank_debits', template: MISA_SME_BANK_DEBIT, rows: cashRows(cash({ type: 'bank_debit' })), chart: CHART, rowId });
    expect(debit.groups.filter((g) => g.kind === 'MISSING_CODE').map((g) => g.column)).toEqual(['Mã đối tượng']);
  });

  it('does not treat a bank account number column as an account of the chart', () => {
    const result = checkMisaRows({ format: 'misa_sme_bank_debits', template: MISA_SME_BANK_DEBIT, rows: cashRows(cash({ type: 'bank_debit' })), chart: CHART, rowId });
    expect(result.groups.some((g) => g.kind === 'ACCOUNT_NOT_IN_CHART' && /ngân hàng|Tài khoản chi|Tài khoản nhận/.test(g.column))).toBe(false);
  });
});
