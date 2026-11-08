// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order reports (#2515): the platform is told by its headers, the lines are read from an allow-list of columns, a status becomes a stage, and what cannot be read is named
// by its row. The grids are made in code (no real seller's file exists yet, #2521), with made-up buyers whose values must never come out.
import { describe, expect, it } from 'vitest';
import { findOrderColumns, orderLines, readDay, readDecimal, stageOf, MARKETPLACE_PROFILES, type StatementGrid } from '../src/index.ts';

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

// The buyer columns these files carry, with values that must never be read.
const BUYER = ['Nguyễn Văn Mua', '0900000001', 'mua@example.com', '1 Phố Thử, Hà Nội'];

const SHOPEE_HEAD = ['Mã đơn hàng', 'Ngày đặt hàng', 'Trạng Thái Đơn Hàng', 'Người Mua', 'Số điện thoại', 'Địa chỉ nhận hàng', 'SKU phân loại hàng', 'Tên sản phẩm', 'Giá ưu đãi', 'Số lượng', 'Tổng giá bán (sản phẩm)'];
const shopeeRow = (order: string, status: string, sku: string, qty: string, price: string, total: string, date = '2026-10-30 14:05'): Cell[] => [order, date, status, BUYER[0] ?? '', BUYER[1] ?? '', BUYER[3] ?? '', sku, `Hàng ${sku}`, price, qty, total];

describe('telling a platform by its headers', () => {
  it('reads a Shopee file under a title row, by Vietnamese headers, and says what each field was read from', () => {
    const rows = grid([['Báo cáo đơn hàng', '', ''], SHOPEE_HEAD, shopeeRow('2610A1', 'Hoàn thành', 'QC-1', '2', '50.000', '100.000')]);
    const mapping = findOrderColumns(rows);
    expect(mapping?.profile.platform).toBe('shopee');
    expect(mapping?.headerRow).toBe(2);
    expect(mapping?.headers).toEqual(expect.arrayContaining([{ field: 'orderNo', header: 'Mã đơn hàng' }, { field: 'sku', header: 'SKU phân loại hàng' }, { field: 'amount', header: 'Tổng giá bán (sản phẩm)' }]));
    // No field names a buyer column, so none is claimed.
    expect(mapping?.headers.map((h) => h.header)).not.toEqual(expect.arrayContaining(['Người Mua', 'Số điện thoại', 'Địa chỉ nhận hàng']));
  });

  it('tells TikTok Shop by its English headers and Lazada by its camelCase ones', () => {
    const tiktok = grid([['Order ID', 'Order Status', 'Order Substatus', 'Seller SKU', 'Product Name', 'Quantity', 'SKU Unit Original Price', 'SKU Subtotal After Discount', 'Created Time', 'Recipient', 'Phone #']]);
    expect(findOrderColumns(tiktok)?.profile.platform).toBe('tiktok_shop');
    const lazada = grid([['orderNumber', 'orderItemId', 'status', 'createTime', 'itemName', 'sellerSku', 'unitPrice', 'paidPrice', 'customerName', 'shippingAddress']]);
    expect(findOrderColumns(lazada)?.profile.platform).toBe('lazada');
  });

  it('takes a file for no platform when no word of any is there, or two fit equally', () => {
    expect(findOrderColumns(grid([['Ngày', 'Nội dung', 'Số tiền ghi nợ', 'Số tiền ghi có']]))).toBeNull();
    // Order id, status, SKU and quantity alone are common to every platform: not a marker.
    expect(findOrderColumns(grid([['Order ID', 'Order Status', 'SKU', 'Quantity']]))).toBeNull();
  });

  it('keeps every profile unconfirmed and versioned until a real file confirms it (#2521)', () => {
    expect(MARKETPLACE_PROFILES.map((p) => p.confirmed)).toEqual([false, false, false]);
    expect(MARKETPLACE_PROFILES.every((p) => /-\d{4}-\d{2}-[a-z]$/.test(p.version))).toBe(true);
  });
});

describe('the lines of a Shopee file', () => {
  const shopee = MARKETPLACE_PROFILES[0] as (typeof MARKETPLACE_PROFILES)[number];
  const read = (rows: Cell[][]) => {
    const g = grid(rows);
    const mapping = findOrderColumns(g);
    if (!mapping) throw new Error('no mapping');
    const result = orderLines(g, mapping, 5000);
    if (!result) throw new Error('too many');
    return result;
  };

  it('reads the allow-listed columns as decimals and days, and nothing of the buyer', () => {
    const result = read([SHOPEE_HEAD, shopeeRow('2610A1', 'Hoàn thành', 'QC-1', '2', '50.000', '100.000'), shopeeRow('2610A2', 'Đã hủy', 'QC-2', '1', '1.234.567,50', '1.234.567,50', '30/10/2026')]);
    expect(result.lines).toEqual([
      expect.objectContaining({ orderNo: '2610A1', lineKey: 'QC-1', stage: 'completed', sku: 'QC-1', quantity: '2', unitPrice: '50000', amount: '100000', orderedAt: '2026-10-30' }),
      expect.objectContaining({ orderNo: '2610A2', stage: 'cancelled', quantity: '1', unitPrice: '1234567.5', amount: '1234567.5', orderedAt: '2026-10-30' }),
    ]);
    const everything = JSON.stringify(result.lines);
    for (const buyer of BUYER) expect(everything).not.toContain(buyer);
  });

  it('names a row it cannot read by its number and stops short of guessing', () => {
    const result = read([
      SHOPEE_HEAD,
      shopeeRow('2610B1', 'Hoàn thành', 'QC-1', '0', '50.000', '0'),
      shopeeRow('2610B2', 'Hoàn thành', 'QC-1', '2', '50k', '100.000'),
      shopeeRow('2610B3', 'Hoàn thành', 'QC-1', '2', '50.000', '100.000', 'hôm qua'),
      shopeeRow('2610B4', 'Hoàn thành', 'QC-1', '1', '50.000', '50.000'),
      ['', '', 'Tổng cộng'],
    ]);
    expect(result.skipped).toEqual([
      { rowNo: 2, reason: 'bad_quantity' },
      { rowNo: 3, reason: 'bad_amount' },
      { rowNo: 4, reason: 'bad_date' },
      { rowNo: 6, reason: 'no_order_no' },
    ]);
    expect(result.lines.map((l) => l.orderNo)).toEqual(['2610B4']);
  });

  it('refuses an id a spreadsheet already turned into a number with lost digits', () => {
    const result = read([SHOPEE_HEAD, [{ number: '2610123456789012345' }, '2026-10-30', 'Hoàn thành', '', '', '', 'QC-1', 'x', '1', '1', '1']]);
    expect(result.skipped).toEqual([{ rowNo: 2, reason: 'bad_id' }]);
    expect(result.lines).toEqual([]);
    // A text id that looks like a number in exponent form is one too; an order number that merely has an E in it is not.
    const exponent = read([SHOPEE_HEAD, shopeeRow('2.61E+18', 'Hoàn thành', 'QC-1', '1', '1', '1'), shopeeRow('3E+18', 'Hoàn thành', 'QC-1', '1', '1', '1'), shopeeRow('E1', 'Hoàn thành', 'QC-1', '1', '1', '1'), shopeeRow('2610E1', 'Hoàn thành', 'QC-1', '1', '1', '1')]);
    expect(exponent.skipped).toEqual([
      { rowNo: 2, reason: 'bad_id' },
      { rowNo: 3, reason: 'bad_id' },
    ]);
    expect(exponent.lines.map((l) => l.orderNo)).toEqual(['E1', '2610E1']);
  });

  it('gives a second row of the same product in one order its own line, and lists a status it does not know', () => {
    const result = read([SHOPEE_HEAD, shopeeRow('2610C1', 'Trạng thái lạ', 'QC-1', '1', '1', '1'), shopeeRow('2610C1', 'Trạng thái lạ', 'QC-1', '1', '1', '1')]);
    expect(result.lines.map((l) => l.lineKey)).toEqual(['QC-1', 'QC-1#2']);
    expect(result.lines.map((l) => l.stage)).toEqual(['unknown', 'unknown']);
    expect(result.unknownStatuses).toEqual(['Trạng thái lạ']);
  });

  it('reads a number cell as Excel stored it: a point is a decimal mark, never a thousands mark', () => {
    // 1.234 in a number cell is one and 234 thousandths; the same characters typed as text are 1234 in Vietnamese notation.
    expect(readDecimal({ kind: 'number', value: '1.234' })).toBe('1.234');
    expect(readDecimal({ kind: 'text', value: '1.234' })).toBe('1234');
    expect(readDecimal({ kind: 'number', value: '0.5' })).toBe('0.5');
    expect(readDecimal({ kind: 'number', value: '-2.250' })).toBe('-2.250');
    expect(readDecimal({ kind: 'number', value: '1e+21' })).toBe('bad');
    const stored = read([SHOPEE_HEAD, ['2610D1', '2026-10-30', 'Đang giao', '', '', '', 'QC-1', 'x', { number: '50000' }, { number: '1.234' }, { number: '61700' }]]);
    expect(stored.lines.map((l) => l.quantity)).toEqual(['1.234']);
  });

  it('keeps a quantity and an amount within what the table holds: a float tail is rounded, a number too big is refused', () => {
    const row = (order: string, qty: string, price: string): Cell[] => shopeeRow(order, 'Đang giao', 'QC-1', qty, price, price);
    const result = read([
      SHOPEE_HEAD,
      row('2610F1', '1', '33333.333333333336'),
      row('2610F2', '0.1234567', '1'),
      row('2610F3', '123456789012345', '1'),
      row('2610F4', '1', '12345678901234567'),
      row('2610F5', '2.500000', '0.00005'),
    ]);
    expect(result.skipped.map((s) => [s.rowNo, s.reason])).toEqual([
      [3, 'bad_quantity'],
      [4, 'bad_quantity'],
      [5, 'bad_amount'],
    ]);
    expect(result.lines.map((l) => [l.orderNo, l.quantity, l.unitPrice])).toEqual([
      ['2610F1', '1', '33333.3333'],
      ['2610F5', '2.5', '0.0001'],
    ]);
  });

  it('does not take a completed order for a return, nor a return still asked, refused or withdrawn for one that came back', () => {
    expect(stageOf(shopee, 'Đã hoàn thành')).toBe('completed');
    // Money back is not goods back: a refund alone moves no stock, and a return still asked for is not one that came back.
    expect(stageOf(shopee, 'Đã hoàn tiền')).toBe('unknown');
    expect(stageOf(shopee, 'Yêu cầu trả hàng')).toBe('unknown');
    expect(stageOf(shopee, 'Đang trả hàng')).toBe('unknown');
    expect(stageOf(shopee, 'Đã trả hàng')).toBe('returned');
    const head = [...SHOPEE_HEAD, 'Trạng thái Trả hàng/Hoàn tiền'];
    const line = (order: string, returnStatus: string): Cell[] => [...shopeeRow(order, 'Đang giao', 'QC-1', '1', '1', '1'), returnStatus];
    const result = read([
      head,
      line('R1', 'Return requested'),
      line('R2', 'Return rejected'),
      line('R3', 'Yêu cầu bị từ chối'),
      line('R4', 'Đang xử lý'),
      line('R5', 'Return cancelled'),
      line('R6', 'Không có'),
      line('R7', 'Hoàn thành'),
      line('R8', 'Return completed'),
      line('R9', 'Refunded'),
    ]);
    expect(result.lines.map((l) => [l.orderNo, l.stage])).toEqual([
      ['R1', 'shipped'],
      ['R2', 'shipped'],
      ['R3', 'shipped'],
      ['R4', 'shipped'],
      ['R5', 'shipped'],
      ['R6', 'shipped'],
      ['R7', 'returned'],
      ['R8', 'returned'],
      ['R9', 'shipped'],
    ]);
  });

  it('keeps a long key short and distinct, and refuses a SKU past its length', () => {
    const sku = 'S'.repeat(100);
    const line = (order: string, itemSku: string, variation: string): Cell[] => [...shopeeRow(order, 'Đang giao', itemSku, '1', '1', '1'), variation];
    const long = 'Áo thun cổ tròn cotton '.repeat(5);
    const result = read([
      [...SHOPEE_HEAD, 'Tên phân loại hàng'],
      // A SKU of the full length is kept whole; one a character longer is refused.
      line('2610E1', sku, ''),
      line('2610E2', 'T'.repeat(101), ''),
      // A seller with no SKU: the key is the product name and the variation, long. Two variations that differ only at the end must stay two keys, and a repeat of one gets its '#2'.
      line('2610E3', '', `${long}Đỏ`),
      line('2610E3', '', `${long}Xanh`),
      line('2610E3', '', `${long}Xanh`),
      line('2610E4', 'OK-1', 'Đỏ'),
    ]);
    expect(result.skipped.map((s) => [s.rowNo, s.reason])).toEqual([[3, 'too_long']]);
    expect(result.lines.map((l) => l.orderNo)).toEqual(['2610E1', '2610E3', '2610E3', '2610E3', '2610E4']);
    const keys = result.lines.map((l) => l.lineKey);
    expect(keys[0]).toBe(sku);
    expect(keys.slice(1, 4).every((k) => k.length <= 120)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[3]).toMatch(/#2$/);
    expect(keys[4]).toBe('OK-1|Đỏ');
  });

  it('answers null for a file with more lines than the cap', () => {
    const g = grid([SHOPEE_HEAD, shopeeRow('1', 'Hoàn thành', 'A', '1', '1', '1'), shopeeRow('2', 'Hoàn thành', 'A', '1', '1', '1')]);
    const mapping = findOrderColumns(g);
    expect(mapping && orderLines(g, mapping, 1)).toBeNull();
  });
});

describe('a Lazada file, one row per unit', () => {
  it('keeps each unit as a line of one under its item id, with the quantity of the unit', () => {
    const g = grid([
      ['orderNumber', 'orderItemId', 'status', 'createTime', 'itemName', 'sellerSku', 'unitPrice', 'paidPrice', 'customerName', 'customerEmail', 'shippingAddress'],
      ['9001', '9001001', 'delivered', '30 Oct 2026 13:23', 'Gói quảng cáo', 'QC', '100000', '90000', BUYER[0] ?? '', BUYER[2] ?? '', BUYER[3] ?? ''],
      ['9001', '9001002', 'shipped', '30 Oct 2026 13:23', 'Gói quảng cáo', 'QC', '100000', '90000', BUYER[0] ?? '', BUYER[2] ?? '', BUYER[3] ?? ''],
      ['9002', '9002001', 'ready_to_ship', '31 Oct 2026 08:00', 'Gói quảng cáo', 'QC', '100000', '100000', BUYER[0] ?? '', BUYER[2] ?? '', BUYER[3] ?? ''],
    ]);
    const mapping = findOrderColumns(g);
    expect(mapping?.profile.platform).toBe('lazada');
    const result = mapping && orderLines(g, mapping, 5000);
    expect(result?.lines.map((l) => [l.orderNo, l.lineKey, l.quantity, l.stage, l.orderedAt, l.amount])).toEqual([
      ['9001', '9001001', '1', 'completed', '2026-10-30', '90000'],
      ['9001', '9001002', '1', 'shipped', '2026-10-30', '90000'],
      ['9002', '9002001', '1', 'placed', '2026-10-31', '100000'],
    ]);
    for (const buyer of BUYER) expect(JSON.stringify(result)).not.toContain(buyer);
  });
});

describe('numbers, days and statuses', () => {
  it('reads Vietnamese and English numbers exactly and refuses what is not one', () => {
    const num = (value: string) => readDecimal({ kind: 'text', value });
    expect(num('1.234.567')).toBe('1234567');
    expect(num('1,234,567.50')).toBe('1234567.50');
    expect(num('1.234.567,5')).toBe('1234567.5');
    expect(num('1234567.5')).toBe('1234567.5');
    expect(num('0,5')).toBe('0.5');
    expect(num('12.5')).toBe('12.5');
    expect(num('50.000 ₫')).toBe('50000');
    expect(num('-1.000')).toBe('-1000');
    expect(num('(2.500)')).toBe('-2500');
    expect(num('')).toBeNull();
    for (const bad of ['abc', '1e3', '1..2', '12,34,56', '--1', '1,2,3']) expect(num(bad), bad).toBe('bad');
    expect(readDecimal({ kind: 'number', value: '1000000' })).toBe('1000000');
  });

  it('reads the day of the date forms the platforms write', () => {
    const day = (value: string) => readDay({ kind: 'text', value });
    expect(day('2026-10-30 14:05:00')).toBe('2026-10-30');
    expect(day('30/10/2026 14:05')).toBe('2026-10-30');
    expect(day('30-10-2026')).toBe('2026-10-30');
    expect(day('30 May 2026 13:23')).toBe('2026-05-30');
    expect(day('31/02/2026')).toBeNull();
    expect(day('2026-13-01')).toBeNull();
    expect(day('hôm qua')).toBeNull();
  });

  it('puts a status in its stage, a handed-over parcel before a delivered one, and an unknown word in none', () => {
    const shopee = MARKETPLACE_PROFILES[0];
    if (!shopee) throw new Error('no profile');
    expect(stageOf(shopee, 'Đã giao cho đơn vị vận chuyển')).toBe('shipped');
    expect(stageOf(shopee, 'Đã giao')).toBe('completed');
    expect(stageOf(shopee, 'Đang giao')).toBe('shipped');
    expect(stageOf(shopee, 'Đã hủy')).toBe('cancelled');
    expect(stageOf(shopee, 'Chờ xác nhận')).toBe('placed');
    expect(stageOf(shopee, 'Đã hoàn trả')).toBe('returned');
    expect(stageOf(shopee, 'Chưa rõ')).toBe('unknown');
    expect(stageOf(shopee, '')).toBe('unknown');
  });
});
