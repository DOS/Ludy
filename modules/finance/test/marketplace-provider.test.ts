// SPDX-License-Identifier: AGPL-3.0-only
// How a page of orders is written as the platform's own report (#2519): cell escaping, the units of a Lazada line adding up to the line, refusing a fractional quantity, and a file of its own
// for each connection.
import { describe, expect, it } from 'vitest';
import { money } from '@crove/l10n-vn';
import { marketplaceOrdersCsv, splitWritableOrders, type MarketplaceOrder } from '../src/marketplace-provider.ts';

const order = (over: Partial<MarketplaceOrder['lines'][number]> = {}, quantity = '1', amount = '100000'): MarketplaceOrder => ({
  orderNo: '9101000009',
  orderedAt: '2026-11-02',
  shippedAt: null,
  stage: 'placed',
  lines: [{ lineKey: '9101000009-1', sku: 'MAU-001', itemName: 'Áo', quantity, unitPrice: '100000', amount, ...over }],
});

// The rows of a CSV that quotes every cell (the writer's own layout; no cell here holds a newline except the CR case, handled apart).
const cellsOf = (csv: string): string[][] => csv.trimEnd().split('\n').map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? '').replaceAll('""', '"')));

describe('marketplaceOrdersCsv', () => {
  it('neutralises a leading = + - @, tab or carriage return in a product name, and only there', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const csv = marketplaceOrdersCsv('shopee', [order({ itemName: `${lead}cmd`, sku: `${lead}SKU` })]);
      expect(csv).toContain(`"'${lead}cmd"`);
      // The SKU is written exactly, so the order's lines still match the shop's items.
      expect(csv).toContain(`"${lead}SKU"`);
    }
    expect(marketplaceOrdersCsv('shopee', [order({ itemName: 'Áo thun - cổ tròn' })])).toContain('"Áo thun - cổ tròn"');
    // The order number and the numbers are never touched either.
    const rows = cellsOf(marketplaceOrdersCsv('shopee', [order({ itemName: '=1+1' })]));
    expect(rows[1]?.[0]).toBe('9101000009');
    expect(rows[1]?.slice(6)).toEqual(['100000', '1', '100000']);
  });

  it('writes the units of a Lazada line so that they add up to the line exactly: 100000 over 3 units', () => {
    const rows = cellsOf(marketplaceOrdersCsv('lazada', [order({}, '3', '100000')])).slice(1);
    const paid = rows.map((r) => r[8] ?? '');
    expect(paid).toEqual(['33333.3333', '33333.3333', '33333.3334']);
    expect(paid.reduce((total, p) => total.plus(p), money('0')).toFixed()).toBe('100000');
    expect(rows.map((r) => r[1])).toEqual(['9101000009-1-1', '9101000009-1-2', '9101000009-1-3']);
    // An even split stays even.
    expect(cellsOf(marketplaceOrdersCsv('lazada', [order({}, '2', '200000')])).slice(1).map((r) => r[8])).toEqual(['100000', '100000']);
  });

  it('refuses a fractional or empty quantity on a platform with a row for each unit, and names the order instead of cutting it', () => {
    const orders = [order({}, '1.5', '150000'), order({ lineKey: 'k' }, '2', '200000'), order({}, '0', '0')];
    const split = splitWritableOrders('lazada', orders);
    expect(split.refused).toBe(2);
    expect(split.writable).toHaveLength(1);
    expect(() => marketplaceOrdersCsv('lazada', [order({}, '1.5', '150000')])).toThrow();
    // A platform that writes the quantity in one cell carries a fraction as it is.
    expect(splitWritableOrders('shopee', orders)).toEqual({ writable: orders, refused: 0 });
  });

  it('writes a file of its own for each connection, and the same file for the same connection', () => {
    const a = marketplaceOrdersCsv('shopee', [order()], '0192a000-0000-7000-8000-00000000000a');
    const b = marketplaceOrdersCsv('shopee', [order()], '0192a000-0000-7000-8000-00000000000b');
    expect(a).not.toBe(b);
    expect(a).toBe(marketplaceOrdersCsv('shopee', [order()], '0192a000-0000-7000-8000-00000000000a'));
    // The first row is one cell naming the connection; the headers follow, and no buyer data exists in it.
    expect(cellsOf(a)[0]).toEqual(['Ludy marketplace connection 0192a000-0000-7000-8000-00000000000a']);
    expect(cellsOf(a)[1]?.[0]).toBe('Mã đơn hàng');
  });

  // The reader takes one point and exactly three digits for a thousands group (see apps/extract/test/marketplace-orders.test.ts), so a number with three decimals is written with a zero added.
  it('writes a number with three decimals with a fourth digit, so the reader does not take it for a thousands group', () => {
    const shopee = cellsOf(marketplaceOrdersCsv('shopee', [order({ unitPrice: '100.125', quantity: '1.500' }, '1.500', '150.188')])).slice(1)[0];
    expect(shopee?.slice(6, 9)).toEqual(['100.1250', '1.5000', '150.1880']);
    const tiktok = cellsOf(marketplaceOrdersCsv('tiktok_shop', [order({ unitPrice: '100.125' }, '2', '200.250')])).slice(1)[0];
    expect(tiktok?.slice(5, 8)).toEqual(['2', '100.1250', '200.2500']);
    // Lazada: each unit's share of a line that does not divide by its units (1001 over 8 is 125.125), the last carrying the rest.
    const lazada = cellsOf(marketplaceOrdersCsv('lazada', [order({ unitPrice: '125.125' }, '8', '1001')])).slice(1);
    expect(lazada).toHaveLength(8);
    expect(lazada.slice(0, 7).every((row) => row[8] === '125.1250')).toBe(true);
    expect(lazada[7]?.[8]).toBe('125.1250');
  });

  it('leaves a whole number and a number of one, two or four decimals as it is', () => {
    const row = cellsOf(marketplaceOrdersCsv('shopee', [order({ unitPrice: '1500000' }, '2', '3000000.5')])).slice(1)[0];
    expect(row?.slice(6, 9)).toEqual(['1500000', '2', '3000000.5']);
  });
});
