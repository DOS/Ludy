// SPDX-License-Identifier: AGPL-3.0-only
// The marketplace order report reader of the sandbox (#2515): an .xlsx or CSV order report of Shopee, TikTok Shop or Lazada read through its platform's profile into the allow-listed fields
// only, a file that is none answered as such, and the same file through the parser and the sandboxed process. The files are made in code, with made-up buyers: no real seller's file exists
// yet (#2521), and every mapping says so.
import { describe, expect, it } from 'vitest';
import { EXTRACT_KINDS, EXTRACT_LIMITS, MARKETPLACE_PLATFORMS, zExtractResponse } from '@crove/extract-contract';
import { MARKETPLACE_PLATFORMS as PROFILE_PLATFORMS, MARKETPLACE_PROFILES, ORDER_FIELDS, ORDER_SKIP_REASONS, ORDER_STAGES } from '@crove/l10n-vn';
import { MARKETPLACE_ORDER_FIELDS, MARKETPLACE_ORDER_STAGES, MARKETPLACE_SKIP_REASONS } from '@crove/extract-contract';
import { readMarketplaceOrders } from '../src/marketplace-orders.ts';
import { parse } from '../src/parse.ts';
import { runSandboxed } from '../src/sandbox.ts';
import { createExtractApp } from '../src/server.ts';
import { statementXlsx } from './statement-fixture.ts';
import { buildXlsx, type XlsxCell } from './xlsx-fixture.ts';

// The buyer columns these files carry, and values that must come out of nowhere.
const BUYER = { name: 'Trần Thị Mua Thử', phone: '0900000007', email: 'mua.thu@example.com', address: '2 Phố Thử, Quận Thử, Hà Nội' };

const SHOPEE_HEAD: XlsxCell[] = ['Mã đơn hàng', 'Ngày đặt hàng', 'Trạng Thái Đơn Hàng', 'Người Mua', 'Số điện thoại', 'Địa chỉ nhận hàng', 'Email', 'SKU phân loại hàng', 'Tên sản phẩm', 'Giá ưu đãi', 'Số lượng', 'Tổng giá bán (sản phẩm)'];
const shopeeRow = (order: string, status: string, sku: string, qty: number, price: number): XlsxCell[] => [
  order,
  '2026-10-30 14:05',
  status,
  BUYER.name,
  BUYER.phone,
  BUYER.address,
  BUYER.email,
  sku,
  `Sản phẩm ${sku}`,
  price,
  qty,
  price * qty,
];
const shopeeReport = (): XlsxCell[][] => [['Báo cáo đơn hàng Shopee'], [], SHOPEE_HEAD, shopeeRow('2610A1', 'Hoàn thành', 'QC-1', 2, 50000), shopeeRow('2610A2', 'Đã hủy', 'QC-2', 1, 120000), shopeeRow('2610A3', 'Đang giao', 'QC-1', 3, 50000)];

describe('readMarketplaceOrders', () => {
  it('lists the rows that stop a file ahead of the rows that do not, whatever the cap cuts', () => {
    // More ignorable rows (a totals row has no order number) than the list holds, then a line with a quantity of zero: the line must still be named.
    const totals = Array.from({ length: EXTRACT_LIMITS.maxOrderSkipped + 1 }, (): XlsxCell[] => ['', '', '', '', '', '', '', '', 'Tổng']);
    const read = readMarketplaceOrders(buildXlsx([SHOPEE_HEAD, ...totals, shopeeRow('2610Z1', 'Đang giao', 'QC-1', 1, 50000), shopeeRow('2610Z2', 'Đang giao', 'QC-1', 0, 50000)]));
    expect(read.skippedCount).toBe(EXTRACT_LIMITS.maxOrderSkipped + 2);
    expect(read.skipped).toHaveLength(EXTRACT_LIMITS.maxOrderSkipped);
    expect(read.skipped[0]).toEqual({ rowNo: EXTRACT_LIMITS.maxOrderSkipped + 4, reason: 'bad_quantity' });
    expect(read.skipped.slice(1).every((s) => s.reason === 'no_order_no')).toBe(true);
  });

  it('reads a Shopee workbook: the platform, the profile it used, the lines with their sheet rows, and nothing of the buyer', () => {
    const read = readMarketplaceOrders(buildXlsx(shopeeReport()));
    expect(read).toMatchObject({ recognized: true, platform: 'shopee', tooMany: false, skippedCount: 0 });
    // Unconfirmed until a real seller's file checks the mapping; the version names the words that read it.
    expect(read.profile).toEqual({ version: expect.stringMatching(/^shopee-/), confirmed: false });
    expect(read.lines.map((l) => [l.rowNo, l.orderNo, l.lineKey, l.stage, l.quantity, l.unitPrice, l.amount])).toEqual([
      [4, '2610A1', 'QC-1', 'completed', '2', '50000', '100000'],
      [5, '2610A2', 'QC-2', 'cancelled', '1', '120000', '120000'],
      [6, '2610A3', 'QC-1', 'shipped', '3', '50000', '150000'],
    ]);
    // Everything that comes back, columns and lines, is free of the buyer's values and of the headers of the buyer's columns.
    const everything = JSON.stringify(read);
    for (const value of Object.values(BUYER)) expect(everything).not.toContain(value);
    for (const header of ['Người Mua', 'Số điện thoại', 'Địa chỉ nhận hàng', 'Email']) expect(everything).not.toContain(header);
  });

  it('reads the same report as CSV, in the delimiter its first rows use', () => {
    const csv = [
      shopeeReport()
        .slice(2)
        .map((row) => row.map((cell) => `"${String(cell)}"`).join(';'))
        .join('\n'),
    ].join('\n');
    const read = readMarketplaceOrders(new TextEncoder().encode(csv));
    expect(read).toMatchObject({ recognized: true, platform: 'shopee' });
    expect(read.lines.map((l) => l.orderNo)).toEqual(['2610A1', '2610A2', '2610A3']);
    for (const value of Object.values(BUYER)) expect(JSON.stringify(read)).not.toContain(value);
  });

  it('reads one point and exactly three digits as a thousands group, and a four-digit fraction as a decimal (what the provider file relies on, #2519)', () => {
    const csv = ['Order ID;Order Status;Seller SKU;Product Name;Quantity;SKU Unit Original Price;SKU Subtotal After Discount;Created Time']
      .concat([['T1', 'Completed', 'S1', 'Mau', '2', '100.125', '200.250', '2026-11-01'], ['T2', 'Completed', 'S1', 'Mau', '2', '100.1250', '200.2500', '2026-11-01']].map((row) => row.map((cell) => `"${cell}"`).join(';')))
      .join('\n');
    const read = readMarketplaceOrders(new TextEncoder().encode(csv));
    expect(read).toMatchObject({ recognized: true, platform: 'tiktok_shop' });
    // Three digits after one point are a thousands group, so the provider writes a value with three decimals with a zero added: the four-digit text is read as the value it is.
    expect(read.lines.map((l) => [l.orderNo, l.unitPrice, l.amount])).toEqual([
      ['T1', '100125', '200250'],
      ['T2', '100.125', '200.25'],
    ]);
  });

  it('reads a Lazada workbook one unit to a row, and tells TikTok Shop by its headers', () => {
    const lazada = readMarketplaceOrders(
      buildXlsx([
        ['orderNumber', 'orderItemId', 'status', 'createTime', 'itemName', 'sellerSku', 'unitPrice', 'paidPrice', 'customerName', 'customerEmail', 'shippingAddress', 'shippingPhone'],
        ['9001', '9001001', 'delivered', '30 Oct 2026 13:23', 'Gói quảng cáo', 'QC', 100000, 90000, BUYER.name, BUYER.email, BUYER.address, BUYER.phone],
        ['9001', '9001002', 'delivered', '30 Oct 2026 13:23', 'Gói quảng cáo', 'QC', 100000, 90000, BUYER.name, BUYER.email, BUYER.address, BUYER.phone],
      ]),
    );
    expect(lazada).toMatchObject({ recognized: true, platform: 'lazada' });
    expect(lazada.lines.map((l) => [l.orderNo, l.lineKey, l.quantity])).toEqual([
      ['9001', '9001001', '1'],
      ['9001', '9001002', '1'],
    ]);
    for (const value of Object.values(BUYER)) expect(JSON.stringify(lazada)).not.toContain(value);
    const tiktok = readMarketplaceOrders(
      buildXlsx([
        ['Order ID', 'Order Status', 'Order Substatus', 'Seller SKU', 'Product Name', 'Quantity', 'SKU Unit Original Price', 'SKU Subtotal After Discount', 'Created Time', 'Recipient', 'Phone #', 'Detail Address'],
        ['5770001', 'Completed', 'Completed', 'QC', 'Gói quảng cáo', 1, 100000, 95000, '10/30/2026', BUYER.name, BUYER.phone, BUYER.address],
      ]),
    );
    expect(tiktok.platform).toBe('tiktok_shop');
    for (const value of Object.values(BUYER)) expect(JSON.stringify(tiktok)).not.toContain(value);
  });

  it('answers a file that is no order report as such: a bank statement, a header with no lines, text', () => {
    expect(readMarketplaceOrders(statementXlsx())).toMatchObject({ recognized: false, platform: null, profile: null, lines: [] });
    expect(readMarketplaceOrders(buildXlsx([SHOPEE_HEAD]))).toMatchObject({ recognized: false });
    expect(readMarketplaceOrders(new TextEncoder().encode('xin chào\nhello'))).toMatchObject({ recognized: false });
    expect(readMarketplaceOrders(new Uint8Array([0, 1, 2, 3]))).toMatchObject({ recognized: false });
    // The same answer says whether the file is an income report, so no second call is needed to find out (#2753): a statement or any other sheet is none, an income report is one.
    expect(readMarketplaceOrders(statementXlsx())).toMatchObject({ recognized: false, incomeReport: false });
    expect(readMarketplaceOrders(new Uint8Array([0, 1, 2, 3]))).toMatchObject({ recognized: false, incomeReport: false });
    const income = buildXlsx([['Mã đơn hàng', 'Ngày hoàn tất thanh toán', 'Giá sản phẩm', 'Phí cố định', 'Tổng số tiền đã thanh toán'], ['2611A1', '2026-11-03', 100000, -5000, 95000]]);
    expect(readMarketplaceOrders(income)).toMatchObject({ recognized: false, incomeReport: true });
    expect(zExtractResponse.parse({ ok: true, kind: 'marketplace_orders', orders: readMarketplaceOrders(income) })).toMatchObject({ ok: true });
    // An order report says nothing of it, and an answer without the field (an older sandbox) is still valid.
    expect(readMarketplaceOrders(buildXlsx([SHOPEE_HEAD, shopeeRow('2610A1', 'Hoàn thành', 'QC-1', 2, 50000)])).incomeReport).toBeUndefined();
    const { incomeReport: _omitted, ...older } = readMarketplaceOrders(statementXlsx());
    expect(zExtractResponse.safeParse({ ok: true, kind: 'marketplace_orders', orders: older }).success).toBe(true);
  });

  it('names what it could not read by its row and stores no guess', () => {
    const read = readMarketplaceOrders(buildXlsx([SHOPEE_HEAD, shopeeRow('2610B1', 'Hoàn thành', 'QC-1', 2, 50000), shopeeRow('2610B2', 'Hoàn thành', 'QC-1', 0, 50000), shopeeRow('2610B3', 'Trạng thái lạ', 'QC-1', 1, 50000)]));
    expect(read.skipped).toEqual([{ rowNo: 3, reason: 'bad_quantity' }]);
    expect(read.skippedCount).toBe(1);
    expect(read.unknownStatuses).toEqual(['Trạng thái lạ']);
    expect(read.lines.map((l) => [l.orderNo, l.stage])).toEqual([
      ['2610B1', 'completed'],
      ['2610B3', 'unknown'],
    ]);
  });
});

describe('the contract and the profiles agree', () => {
  it('lists the same platforms, stages, fields and skip reasons on both sides', () => {
    expect([...MARKETPLACE_PLATFORMS]).toEqual([...PROFILE_PLATFORMS]);
    expect([...MARKETPLACE_ORDER_STAGES]).toEqual([...ORDER_STAGES]);
    expect([...MARKETPLACE_ORDER_FIELDS]).toEqual([...ORDER_FIELDS]);
    expect([...MARKETPLACE_SKIP_REASONS]).toEqual([...ORDER_SKIP_REASONS]);
    expect(MARKETPLACE_PROFILES.map((p) => p.platform)).toEqual([...PROFILE_PLATFORMS]);
    expect(EXTRACT_KINDS).toContain('marketplace_orders');
  });
});

describe('through the parser and the sandbox', () => {
  it('answers a valid contract result for a report and for a file that is none', async () => {
    const ok = zExtractResponse.parse(await parse('marketplace_orders', buildXlsx(shopeeReport())));
    expect(ok).toMatchObject({ ok: true, kind: 'marketplace_orders', orders: { recognized: true, platform: 'shopee' } });
    const none = zExtractResponse.parse(await parse('marketplace_orders', buildXlsx([['nothing here']])));
    expect(none).toMatchObject({ ok: true, kind: 'marketplace_orders', orders: { recognized: false } });
  });

  it('reads the report in a parser process, and the buyer stays out of what it answers', async () => {
    const answer = await runSandboxed('marketplace_orders', buildXlsx(shopeeReport()));
    expect(answer).toMatchObject({ ok: true, kind: 'marketplace_orders', orders: { recognized: true, platform: 'shopee' } });
    for (const value of Object.values(BUYER)) expect(JSON.stringify(answer)).not.toContain(value);
  });

  it('is refused at the door over the size cap, before a byte is read', async () => {
    const app = createExtractApp();
    const over = new Uint8Array(EXTRACT_LIMITS.maxOrderReportBytes + 1);
    const response = await app.fetch(new Request('http://crove-extract.test/extract?kind=marketplace_orders', { method: 'POST', body: over, headers: { 'content-type': 'application/octet-stream' } }));
    expect(response.status).toBe(413);
    expect(zExtractResponse.parse(await response.json())).toMatchObject({ ok: false, code: 'too_large' });
  });
});
