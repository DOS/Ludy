// SPDX-License-Identifier: AGPL-3.0-only
// The sheet a model may see for an unknown order report header, and the check that decides a proposed mapping (#3850). Synthetic grids only (real files wait on #2521).
import { describe, expect, it } from 'vitest';
import { checkColumnMapping, columnSheet, isBuyerHeader, maskSample, type ColumnAssignment, type StatementGrid } from '../src/index.ts';

function grid(rows: string[][], firstRow = 1): StatementGrid {
  const out = new Map<number, Map<number, { kind: string; value: string }>>();
  rows.forEach((cells, i) => {
    const row = new Map<number, { kind: string; value: string }>();
    cells.forEach((value, col) => {
      if (value !== '') row.set(col, { kind: 'text', value });
    });
    if (row.size > 0) out.set(firstRow + i, row);
  });
  return out;
}

// An invented platform's header, no profile knows it: 0 order, 1 buyer, 2 phone, 3 item, 4 qty, 5 total, 6 placed, 7 state.
const HEAD = ['Số chứng từ bán', 'Khách đặt', 'Số điện thoại', 'Mặt hàng', 'Số lượng bán', 'Thành tiền', 'Đặt lúc', 'Tình trạng'];
const row = (order: string, qty: string, total: string, state = 'Hoàn thành'): string[] => [order, 'Nguyễn Văn Mua', '0900000001', 'Bút bi', qty, total, '2026-10-30', state];
const SHEET = grid([['Báo cáo bán hàng', '', ''], HEAD, row('A1', '2', '100.000'), row('A2', '1', '50.000'), ['', '', '', '', '', '', '', '']]);
const GOOD: ColumnAssignment[] = [
  { index: 0, field: 'orderNo' },
  { index: 3, field: 'itemName' },
  { index: 4, field: 'quantity' },
  { index: 5, field: 'amount' },
  { index: 6, field: 'orderedAt' },
  { index: 7, field: 'status' },
];

describe('what a model may see', () => {
  it('masks a value to its shape and cuts it', () => {
    expect(maskSample('2026-10-30 14:05')).toBe('9999-99-99 9');
    expect(maskSample('1.234.567')).toBe('9.999.999');
    expect(maskSample('Nguyễn Văn Mua, Hà Nội')).toBe('aaaaaa aaa a');
    expect(maskSample('line one\nline two')).toBe('aaaa aaa');
    expect(maskSample('')).toBe('');
  });

  it('knows a buyer header in Vietnamese, English and camelCase, and not a word that only contains one', () => {
    for (const h of ['Người Mua', 'Tên người nhận', 'Số điện thoại', 'Địa chỉ nhận hàng', 'Buyer Name', 'buyerName', 'Recipient Phone', 'Email', 'Khách đặt', 'Ward', 'Postal Code']) {
      expect(isBuyerHeader(h), h).toBe(true);
    }
    for (const h of ['Mã đơn hàng', 'Reward points', 'Order Status', 'Tổng tiền', 'Seller SKU', 'Wardrobe']) {
      expect(isBuyerHeader(h), h).toBe(false);
    }
  });

  it('gives the header row, the headers and three masked samples, and blanks every buyer column', () => {
    const sheet = columnSheet(SHEET);
    expect(sheet?.headerRow).toBe(2);
    expect(sheet?.columns.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const order = sheet?.columns[0];
    expect(order).toEqual({ index: 0, header: 'Số chứng từ bán', samples: ['a9', 'a9'], buyer: false });
    const buyer = sheet?.columns[1];
    const phone = sheet?.columns[2];
    expect(buyer).toEqual({ index: 1, header: '', samples: [], buyer: true });
    expect(phone).toEqual({ index: 2, header: '', samples: [], buyer: true });
    // Nothing a buyer typed is in what the model gets.
    const wire = JSON.stringify(sheet);
    for (const secret of ['Nguyễn', 'Mua', '0900000001', 'Khách', 'điện thoại']) expect(wire).not.toContain(secret);
  });

  it('shows only shapes for a column whose header is not flagged, so a phone or an email planted there never reaches the model', () => {
    const planted = grid([
      ['Mã đơn', 'Ghi chú', 'Liên hệ', 'Số lượng'],
      ['A1', 'gọi 0900000001', 'mua@example.com', '2'],
      ['A2', 'Nguyễn Văn Mua', '0900000002', '1'],
    ]);
    const sheet = columnSheet(planted);
    expect(sheet?.columns.map((c) => c.buyer)).toEqual([false, false, false, false]);
    const wire = JSON.stringify(sheet);
    for (const secret of ['0900000001', '0900000002', 'mua@example.com', 'example', 'Nguyễn', 'Mua', 'gọi']) expect(wire).not.toContain(secret);
    expect(sheet?.columns[1]?.samples).toEqual(['aaa 99999999', 'aaaaaa aaa a']);
    expect(sheet?.columns[2]?.samples).toEqual(['aaa@aaaaaaa.', '9999999999']);
  });

  it('gives nothing for a sheet with no header-like row, a header with no data under it, or too many columns', () => {
    expect(columnSheet(grid([['a', 'b'], ['c', 'd']]))).toBeNull();
    expect(columnSheet(grid([HEAD]))).toBeNull();
    expect(columnSheet(grid([Array.from({ length: 61 }, (_, i) => `c${i}`), Array.from({ length: 61 }, () => 'x')]))).toBeNull();
  });
});

describe('checking a mapping by reading the file', () => {
  it('accepts a mapping that reads the file and ignores the totals row', () => {
    const check = checkColumnMapping(SHEET, 'shopee', GOOD, 1000);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.read.lines.map((l) => [l.orderNo, l.quantity, l.amount])).toEqual([['A1', '2', '100000'], ['A2', '1', '50000']]);
      // The buyer's values are not in what was read.
      expect(JSON.stringify(check.read.lines)).not.toContain('0900000001');
    }
  });

  it('refuses the order number or the quantity missing, and the line key for a platform with a row per unit', () => {
    expect(checkColumnMapping(SHEET, 'shopee', GOOD.filter((a) => a.field !== 'orderNo'), 1000)).toEqual({ ok: false, reason: 'no_order_no' });
    expect(checkColumnMapping(SHEET, 'shopee', GOOD.filter((a) => a.field !== 'quantity'), 1000)).toEqual({ ok: false, reason: 'no_line' });
    expect(checkColumnMapping(SHEET, 'lazada', GOOD, 1000)).toEqual({ ok: false, reason: 'no_line' });
  });

  it('refuses a buyer column, a column that is not there, an unknown field, a field or a column twice', () => {
    expect(checkColumnMapping(SHEET, 'shopee', [...GOOD, { index: 1, field: 'sku' }], 1000)).toEqual({ ok: false, reason: 'buyer_column' });
    expect(checkColumnMapping(SHEET, 'shopee', [...GOOD, { index: 2, field: 'variation' }], 1000)).toEqual({ ok: false, reason: 'buyer_column' });
    expect(checkColumnMapping(SHEET, 'shopee', [...GOOD, { index: 40, field: 'sku' }], 1000)).toEqual({ ok: false, reason: 'bad_column' });
    expect(checkColumnMapping(SHEET, 'shopee', [...GOOD, { index: 3, field: 'buyerName' as never }], 1000)).toEqual({ ok: false, reason: 'bad_column' });
    expect(checkColumnMapping(SHEET, 'shopee', [...GOOD, { index: 3, field: 'amount' }], 1000)).toEqual({ ok: false, reason: 'field_twice' });
    expect(checkColumnMapping(SHEET, 'shopee', [...GOOD, { index: 5, field: 'unitPrice' }], 1000)).toEqual({ ok: false, reason: 'column_twice' });
  });

  it('refuses a mapping that puts text where the quantity or the money is, naming no row as fine', () => {
    const wrongQty = GOOD.map((a) => (a.field === 'quantity' ? { index: 3, field: 'quantity' as const } : a.field === 'itemName' ? { index: 4, field: 'itemName' as const } : a));
    expect(checkColumnMapping(SHEET, 'shopee', wrongQty, 1000)).toEqual({ ok: false, reason: 'row_stops_file' });
    const wrongAmount = GOOD.map((a) => (a.field === 'amount' ? { index: 7, field: 'amount' as const } : a.field === 'status' ? { index: 5, field: 'status' as const } : a));
    expect(checkColumnMapping(SHEET, 'shopee', wrongAmount, 1000)).toEqual({ ok: false, reason: 'row_stops_file' });
  });

  it('refuses a file that reads no line, a file with no header, and a file past the row cap', () => {
    expect(checkColumnMapping(grid([HEAD, ['', '', '', '', '', '', '', '']]), 'shopee', GOOD, 1000)).toEqual({ ok: false, reason: 'no_header' });
    expect(checkColumnMapping(grid([HEAD, ['', 'x', 'y', '', '', '', '', '']]), 'shopee', GOOD, 1000)).toEqual({ ok: false, reason: 'nothing_read' });
    expect(checkColumnMapping(grid([['a', 'b'], ['c', 'd']]), 'shopee', GOOD, 1000)).toEqual({ ok: false, reason: 'no_header' });
    expect(checkColumnMapping(SHEET, 'shopee', GOOD, 1)).toEqual({ ok: false, reason: 'too_many_rows' });
  });
});
