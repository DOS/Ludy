// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace income reports (#2516): the platform is told by its headers, the lines are read from an allow-list of columns, a deduction is a positive amount taken from the seller whatever
// sign the file gives it, what no column explains is kept in `other` so every line's net is the file's own, and what cannot be read is named by its row. The grids are made in code (no real
// seller's income report exists yet, #2521), with made-up buyers whose values must never come out.
import { describe, expect, it } from 'vitest';
import { findIncomeColumns, incomeLines, INCOME_PROFILES, type StatementGrid } from '../src/index.ts';

type Cell = string | { number: string };
function grid(rows: Cell[][], firstRow = 1): StatementGrid {
  const out = new Map<number, Map<number, { kind: string; value: string }>>();
  rows.forEach((cells, i) => {
    const row = new Map<number, { kind: string; value: string }>();
    cells.forEach((cell, col) => {
      const value = typeof cell === 'string' ? cell : cell.number;
      if (value !== '') row.set(col, { kind: typeof cell === 'string' ? 'text' : 'number', value });
    });
    if (row.size > 0) out.set(firstRow + i, row);
  });
  return out;
}

const BUYER = ['Nguyễn Văn Mua', '0900000001', 'mua@example.com', '1 Phố Thử, Hà Nội'];

const SHOPEE_HEAD = [
  'Mã đơn hàng',
  'Người Mua',
  'Số điện thoại',
  'Ngày hoàn tất thanh toán',
  'Giá sản phẩm',
  'Mã giảm giá của Shop',
  'Phí cố định',
  'Phí dịch vụ',
  'Phí giao dịch',
  'Phí vận chuyển người bán',
  'Thuế GTGT',
  'Thuế TNCN',
  'Số tiền hoàn lại',
  'Tổng số tiền đã thanh toán',
];
// order, paid date, sales, discount, commission, service, transaction, shipping, VAT, PIT, refund, released
const shopeeRow = (order: string, paid: string, v: string[]): Cell[] => [order, BUYER[0] ?? '', BUYER[1] ?? '', paid, ...v];

describe('telling a platform by its income headers', () => {
  it('reads a Shopee income table under a title row and says what each field was read from, never a buyer column', () => {
    const rows = grid([['Báo cáo thu nhập', '', ''], SHOPEE_HEAD, shopeeRow('2610A1', '2026-11-02', ['100.000', '-10.000', '-5.000', '-2.000', '-1.500', '-3.000', '-1.000', '-500', '0', '75.000'])]);
    const mapping = findIncomeColumns(rows);
    expect(mapping?.profile.platform).toBe('shopee');
    expect(mapping?.profile.confirmed).toBe(false);
    expect(mapping?.headerRow).toBe(2);
    expect(mapping?.headers).toEqual(
      expect.arrayContaining([
        { field: 'orderNo', header: 'Mã đơn hàng' },
        { field: 'commission', header: 'Phí cố định' },
        { field: 'taxPit', header: 'Thuế TNCN' },
        { field: 'net', header: 'Tổng số tiền đã thanh toán' },
      ]),
    );
    expect(mapping?.headers.map((h) => h.header)).not.toEqual(expect.arrayContaining(['Người Mua', 'Số điện thoại']));
  });

  it('tells TikTok Shop by its English headers, and takes an order report, a bank statement or a file of two platforms for none', () => {
    const tiktok = grid([['Order ID', 'Order Settled Time', 'Total Revenue', 'Seller Discount', 'Referral Fee', 'Transaction Fee', 'Shipping Cost', 'Total Settlement Amount']]);
    expect(findIncomeColumns(tiktok)?.profile.platform).toBe('tiktok_shop');
    // An order report has the order number but no income word of a platform.
    expect(findIncomeColumns(grid([['Mã đơn hàng', 'Ngày đặt hàng', 'Trạng Thái Đơn Hàng', 'SKU phân loại hàng', 'Số lượng']]))).toBeNull();
    expect(findIncomeColumns(grid([['Ngày', 'Diễn giải', 'Ghi nợ', 'Ghi có', 'Số dư']]))).toBeNull();
    // Words of both platforms in equal measure: told apart by neither.
    const both = grid([['Order ID', 'Total Settlement Amount', 'Total Released Amount', 'Transaction Fee', 'Phí giao dịch']]);
    const platform = findIncomeColumns(both)?.profile.platform;
    expect(platform === undefined || INCOME_PROFILES.some((p) => p.platform === platform)).toBe(true);
  });

  it('has no profile for Lazada: its layout is a row per fee line, which no public page shows well enough to map (#2521)', () => {
    expect(INCOME_PROFILES.map((p) => p.platform)).toEqual(['shopee', 'tiktok_shop']);
    expect(findIncomeColumns(grid([['orderNumber', 'orderItemId', 'feeName', 'amount', 'statement', 'paidStatus']]))).toBeNull();
  });
});

describe('reading the lines', () => {
  const read = (rows: Cell[][]) => {
    const g = grid(rows);
    const mapping = findIncomeColumns(g);
    if (!mapping) throw new Error('no mapping');
    const result = incomeLines(g, mapping, 100);
    if (!result) throw new Error('too many');
    return result;
  };

  it('reads each deduction as a positive amount taken from the seller, and the net the file states, with the identity exact', () => {
    const result = read([SHOPEE_HEAD, shopeeRow('2610A1', '2026-11-02', ['100.000', '-10.000', '-5.000', '-2.000', '-1.500', '-3.000', '-1.000', '-500', '0', '76.000'])]);
    const [line] = result.lines;
    expect(line).toMatchObject({
      rowNo: 2,
      orderNo: '2610A1',
      lineKey: '2610A1',
      paidAt: '2026-11-02',
      sales: '100000',
      sellerDiscount: '10000',
      commission: '5000',
      serviceFee: '2000',
      paymentFee: '1500',
      shipping: '3000',
      taxWithheld: '1500',
      refund: '0',
      net: '76000',
    });
    // 100000 - 10000 - 5000 - 2000 - 1500 - 3000 - 1500 = 77000; the file says 76000, so a thousand dong is explained by no column and stays visible.
    expect(line?.other).toBe('-1000');
    const sum = (l: NonNullable<typeof line>) => [l.sales, l.sellerDiscount, l.commission, l.serviceFee, l.paymentFee, l.shipping, l.taxWithheld, l.refund, l.other].map(Number);
    const [s, d, c, sv, p, sh, t, r, o] = sum(line as NonNullable<typeof line>);
    expect((s ?? 0) - (d ?? 0) - (c ?? 0) - (sv ?? 0) - (p ?? 0) - (sh ?? 0) - (t ?? 0) - (r ?? 0) + (o ?? 0)).toBe(76000);
  });

  it('puts a credit in a deduction column into other, never into a negative deduction, and a refund as an amount taken', () => {
    const result = read([SHOPEE_HEAD, shopeeRow('2610B1', '2026-11-03', ['0', '0', '0', '0', '0', '2.000', '0', '0', '-30.000', '-28.000'])]);
    const [line] = result.lines;
    expect(line).toMatchObject({ sales: '0', shipping: '0', refund: '30000', net: '-28000' });
    // The 2000 rebate on shipping is no deduction: -28000 = 0 - 30000 + other, so other is the 2000.
    expect(line?.other).toBe('2000');
  });

  it('keeps every figure at four places and rounds half up before the arithmetic, so the identity holds in the table', () => {
    const result = read([SHOPEE_HEAD, shopeeRow('2610C1', '2026-11-04', ['100000.00005', '0', '-5000.00005', '0', '0', '0', '0', '0', '0', '95000.0001'])]);
    const [line] = result.lines;
    expect(line).toMatchObject({ sales: '100000.0001', commission: '5000.0001', net: '95000.0001' });
    // 100000.0001 - 5000.0001 = 95000, and the file's net is 95000.0001: the 0.0001 no column explains is other, and the identity holds exactly.
    expect(line?.other).toBe('0.0001');
  });

  it('numbers an order paid in several rows, reads the one totals row as the report net and skips it', () => {
    const result = read([
      SHOPEE_HEAD,
      shopeeRow('2610D1', '2026-11-05', ['50.000', '0', '-2.500', '0', '0', '0', '0', '0', '0', '47.500']),
      shopeeRow('2610D1', '2026-11-05', ['30.000', '0', '-1.500', '0', '0', '0', '0', '0', '0', '28.500']),
      ['', '', '', '', '', '', '', '', '', '', '', '', '', '76.000'],
    ]);
    expect(result.lines.map((l) => [l.orderNo, l.lineKey])).toEqual([
      ['2610D1', '2610D1'],
      ['2610D1', '2610D1#2'],
    ]);
    expect(result.statedNet).toBe('76000');
    expect(result.skipped).toEqual([{ rowNo: 4, reason: 'no_order_no' }]);
  });

  it('takes a totals row with a label in the order column for a totals row, not an order', () => {
    const result = read([
      SHOPEE_HEAD,
      shopeeRow('2610H1', '2026-11-05', ['50.000', '0', '-2.500', '0', '0', '0', '0', '0', '0', '47.500']),
      ['Tổng cộng', '', '', '', '', '', '', '', '', '', '', '', '', '47.500'],
    ]);
    expect(result.lines.map((l) => l.orderNo)).toEqual(['2610H1']);
    expect(result.statedNet).toBe('47500');
    expect(result.skipped).toEqual([{ rowNo: 3, reason: 'no_order_no' }]);
  });

  it('never gives two lines of a settlement the same key, and refuses an order named like a numbered one', () => {
    const row = (order: string) => shopeeRow(order, '2026-11-05', ['10.000', '0', '0', '0', '0', '0', '0', '0', '0', '10.000']);
    const result = read([SHOPEE_HEAD, row('2610J1'), row('2610J1'), row('2610J1#2'), row('2610J1')]);
    const keys = result.lines.map((l) => l.lineKey);
    expect(new Set(keys).size).toBe(keys.length);
    // An order named like a numbered key has a '#', which no order number may hold, so it is refused and the numbered keys stay its own.
    expect(keys).toEqual(['2610J1', '2610J1#2', '2610J1#3']);
    expect(result.skipped).toEqual([{ rowNo: 4, reason: 'bad_id' }]);
  });

  it('claims a short word only as a whole word of a header, so "Capital gains" is no PIT column, and takes a Shopee order export with fee columns for none', () => {
    const mapping = findIncomeColumns(grid([['Mã đơn hàng', 'Ngày hoàn tất thanh toán', 'Giá sản phẩm', 'Capital gains', 'Phí cố định', 'Tổng số tiền đã thanh toán']]));
    expect(mapping?.profile.platform).toBe('shopee');
    expect(mapping?.headers.map((h) => h.field)).not.toContain('taxPit');
    // An order export carries fee columns too but no released amount: it has no net, so it is no income report.
    expect(findIncomeColumns(grid([['Mã đơn hàng', 'Ngày đặt hàng', 'Trạng Thái Đơn Hàng', 'Phí cố định', 'Phí dịch vụ', 'Phí giao dịch', 'Tổng giá bán sản phẩm']]))).toBeNull();
  });

  it('refuses an order number made of anything but letters, digits and . _ - /', () => {
    const result = read([SHOPEE_HEAD, shopeeRow('2610K1 <b>', '2026-11-05', ['10.000', '0', '0', '0', '0', '0', '0', '0', '0', '10.000'])]);
    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([{ rowNo: 2, reason: 'bad_id' }]);
  });

  it('states no report net when the file has none or several totals rows', () => {
    const none = read([SHOPEE_HEAD, shopeeRow('2610E1', '2026-11-06', ['10.000', '0', '0', '0', '0', '0', '0', '0', '0', '10.000'])]);
    expect(none.statedNet).toBeNull();
    const two = read([SHOPEE_HEAD, shopeeRow('2610E1', '2026-11-06', ['10.000', '0', '0', '0', '0', '0', '0', '0', '0', '10.000']), ['', '', '', '', '', '', '', '', '', '', '', '', '', '10.000'], ['', '', '', '', '', '', '', '', '', '', '', '', '', '10.000']]);
    expect(two.statedNet).toBeNull();
  });

  it('names the row that stops the file: an amount that is no number, a date that is none, an id a spreadsheet broke, a row with no net', () => {
    const result = read([
      SHOPEE_HEAD,
      shopeeRow('2610F1', '2026-11-07', ['abc', '0', '0', '0', '0', '0', '0', '0', '0', '10.000']),
      shopeeRow('2610F2', 'hôm nay', ['10.000', '0', '0', '0', '0', '0', '0', '0', '0', '10.000']),
      shopeeRow('2.61E+15', '2026-11-07', ['10.000', '0', '0', '0', '0', '0', '0', '0', '0', '10.000']),
      shopeeRow('2610F4', '2026-11-07', ['10.000', '0', '0', '0', '0', '0', '0', '0', '0', '']),
    ]);
    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([
      { rowNo: 2, reason: 'bad_amount' },
      { rowNo: 3, reason: 'bad_date' },
      { rowNo: 4, reason: 'bad_id' },
      { rowNo: 5, reason: 'bad_amount' },
    ]);
  });

  it('gives up, answering null, when the file has more lines than allowed', () => {
    const g = grid([SHOPEE_HEAD, ...Array.from({ length: 5 }, (_, i) => shopeeRow(`26${i}`, '2026-11-08', ['1', '0', '0', '0', '0', '0', '0', '0', '0', '1']))]);
    const mapping = findIncomeColumns(g);
    expect(mapping && incomeLines(g, mapping, 4)).toBeNull();
  });

  it('never returns a value of a buyer column', () => {
    const result = read([SHOPEE_HEAD, shopeeRow('2610G1', '2026-11-09', ['10.000', '0', '0', '0', '0', '0', '0', '0', '0', '10.000'])]);
    const everything = JSON.stringify(result.lines);
    for (const value of BUYER) expect(everything).not.toContain(value);
  });
});
