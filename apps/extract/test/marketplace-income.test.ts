// SPDX-License-Identifier: AGPL-3.0-only
// The marketplace income report reader of the sandbox (#2516): the per-order table found on a later sheet of the workbook behind a summary, read through its platform's profile into the
// allow-listed fields only, a file that is none answered as such, and the same file through the parser and the sandboxed process. The files are made in code, with made-up buyers: no real
// seller's income report exists yet (#2521), and every mapping says so.
import { describe, expect, it } from 'vitest';
import { EXTRACT_KINDS, EXTRACT_LIMITS, MARKETPLACE_INCOME_FIELDS, MARKETPLACE_INCOME_PLATFORMS, MARKETPLACE_INCOME_SKIP_REASONS, zExtractResponse } from '@crove/extract-contract';
import { INCOME_FIELDS, INCOME_PLATFORMS, INCOME_SKIP_REASONS } from '@crove/l10n-vn';
import { readMarketplaceIncome } from '../src/marketplace-income.ts';
import { parse } from '../src/parse.ts';
import { runSandboxed } from '../src/sandbox.ts';
import { createExtractApp } from '../src/server.ts';
import { buildXlsx, type XlsxCell } from './xlsx-fixture.ts';

const BUYER = { name: 'Trần Thị Mua Thử', phone: '0900000007', email: 'mua.thu@example.com' };

const SUMMARY: XlsxCell[][] = [['Tóm tắt'], ['Kỳ báo cáo', '01/11/2026 - 07/11/2026'], ['Tổng số tiền đã thanh toán', 123500]];
const INCOME_HEAD: XlsxCell[] = ['Mã đơn hàng', 'Người Mua', 'Số điện thoại', 'Email', 'Ngày hoàn tất thanh toán', 'Giá sản phẩm', 'Mã giảm giá của Shop', 'Phí cố định', 'Phí dịch vụ', 'Phí giao dịch', 'Thuế GTGT', 'Thuế TNCN', 'Tổng số tiền đã thanh toán'];
const incomeRow = (order: string, paid: string, sales: number, discount: number, commission: number, service: number, payment: number, vat: number, pit: number, net: number): XlsxCell[] => [
  order,
  BUYER.name,
  BUYER.phone,
  BUYER.email,
  paid,
  sales,
  -discount,
  -commission,
  -service,
  -payment,
  -vat,
  -pit,
  net,
];
const incomeRows = (): XlsxCell[][] => [
  ['Báo cáo thu nhập'],
  INCOME_HEAD,
  incomeRow('2611A1', '2026-11-03', 100000, 10000, 5000, 2000, 1500, 500, 500, 80500),
  incomeRow('2611A2', '2026-11-04', 50000, 0, 2500, 1000, 750, 250, 250, 45250),
  ['', '', '', '', '', '', '', '', '', '', '', '', 125750],
];
// A Shopee-style workbook: the summary first, the per-order table on the second sheet.
const shopeeWorkbook = () => buildXlsx(SUMMARY, { sheetName: 'Summary', moreSheets: [{ name: 'Income', rows: incomeRows() }] });

describe('readMarketplaceIncome', () => {
  it('finds the per-order table on the second sheet and reads it: the platform, the profile, the sheet, the lines with their rows, the stated net, and nothing of the buyer', () => {
    const read = readMarketplaceIncome(shopeeWorkbook());
    expect(read).toMatchObject({ recognized: true, platform: 'shopee', sheet: 'Income', tooMany: false, skippedCount: 1, statedNet: '125750' });
    expect(read.profile).toEqual({ version: expect.stringMatching(/^shopee-income-/), confirmed: false });
    expect(read.lines.map((l) => [l.rowNo, l.orderNo, l.paidAt, l.sales, l.sellerDiscount, l.commission, l.serviceFee, l.paymentFee, l.taxWithheld, l.other, l.net])).toEqual([
      [3, '2611A1', '2026-11-03', '100000', '10000', '5000', '2000', '1500', '1000', '0', '80500'],
      [4, '2611A2', '2026-11-04', '50000', '0', '2500', '1000', '750', '500', '0', '45250'],
    ]);
    const everything = JSON.stringify(read);
    for (const value of Object.values(BUYER)) expect(everything).not.toContain(value);
    for (const header of ['Người Mua', 'Số điện thoại', 'Email']) expect(everything).not.toContain(header);
  });

  it('reads a workbook whose first sheet is the table, and the same report as CSV', () => {
    const first = readMarketplaceIncome(buildXlsx(incomeRows(), { sheetName: 'Income' }));
    expect(first).toMatchObject({ recognized: true, platform: 'shopee', sheet: 'Income' });
    const csv = incomeRows()
      .map((row) => row.map((cell) => (typeof cell === 'string' && cell.includes(',') ? `"${cell}"` : String(cell ?? ''))).join(','))
      .join('\n');
    const read = readMarketplaceIncome(new TextEncoder().encode(csv));
    expect(read).toMatchObject({ recognized: true, platform: 'shopee', sheet: null });
    expect(read.lines).toHaveLength(2);
  });

  it('answers a file that is no income report as such: an order report, a summary alone, a header with no lines, text', () => {
    expect(readMarketplaceIncome(buildXlsx([['Mã đơn hàng', 'Ngày đặt hàng', 'Trạng Thái Đơn Hàng', 'SKU phân loại hàng', 'Số lượng'], ['2610A1', '2026-10-30', 'Hoàn thành', 'QC-1', 2]])).recognized).toBe(false);
    expect(readMarketplaceIncome(buildXlsx(SUMMARY)).recognized).toBe(false);
    expect(readMarketplaceIncome(buildXlsx([INCOME_HEAD])).recognized).toBe(false);
    expect(readMarketplaceIncome(new TextEncoder().encode('not a report')).recognized).toBe(false);
  });

  it('names what it could not read by its row and stores no guess', () => {
    const rows = incomeRows();
    rows.splice(2, 0, ['2611Z9', '', '', '', 'không phải ngày', 100000, 0, 0, 0, 0, 0, 0, 100000]);
    const read = readMarketplaceIncome(buildXlsx(rows));
    expect(read.skipped[0]).toEqual({ rowNo: 3, reason: 'bad_date' });
    expect(read.lines.map((l) => l.orderNo)).toEqual(['2611A1', '2611A2']);
  });
});

describe('the contract and the profiles agree', () => {
  it('lists the same platforms, fields and skip reasons on both sides', () => {
    expect([...MARKETPLACE_INCOME_PLATFORMS]).toEqual([...INCOME_PLATFORMS]);
    expect([...MARKETPLACE_INCOME_FIELDS]).toEqual([...INCOME_FIELDS]);
    expect([...MARKETPLACE_INCOME_SKIP_REASONS]).toEqual([...INCOME_SKIP_REASONS]);
    expect(EXTRACT_KINDS).toContain('marketplace_income');
  });
});

describe('through the parser and the sandbox', () => {
  it('answers a valid contract result for a report and for a file that is none', async () => {
    const ok = zExtractResponse.parse(await parse('marketplace_income', shopeeWorkbook()));
    expect(ok).toMatchObject({ ok: true, kind: 'marketplace_income', income: { recognized: true, platform: 'shopee' } });
    const none = zExtractResponse.parse(await parse('marketplace_income', buildXlsx([['nothing here']])));
    expect(none).toMatchObject({ ok: true, kind: 'marketplace_income', income: { recognized: false } });
  });

  it('reads the report in a parser process, and the buyer stays out of what it answers', async () => {
    const answer = await runSandboxed('marketplace_income', shopeeWorkbook());
    expect(answer).toMatchObject({ ok: true, kind: 'marketplace_income', income: { recognized: true, platform: 'shopee', sheet: 'Income' } });
    for (const value of Object.values(BUYER)) expect(JSON.stringify(answer)).not.toContain(value);
  });

  it('is refused at the door over the size cap, before a byte is read', async () => {
    const app = createExtractApp();
    const over = new Uint8Array(EXTRACT_LIMITS.maxOrderReportBytes + 1);
    const response = await app.fetch(new Request('http://crove-extract.test/extract?kind=marketplace_income', { method: 'POST', body: over, headers: { 'content-type': 'application/octet-stream' } }));
    expect(response.status).toBe(413);
    expect(zExtractResponse.parse(await response.json())).toMatchObject({ ok: false, code: 'too_large' });
  });
});
