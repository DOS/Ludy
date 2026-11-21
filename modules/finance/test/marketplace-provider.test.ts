// SPDX-License-Identifier: AGPL-3.0-only
// How a page of orders is written as the platform's own report (#2519): cell escaping, the units of a Lazada line adding up to the line, refusing a fractional quantity, and a file of its own
// for each connection.
import { describe, expect, it } from 'vitest';
import { money } from '@crove/l10n-vn';
import {
  MARKETPLACE_CSV_MAX_ROWS,
  MARKETPLACE_PLATFORM_LIMITS,
  createSandboxMarketplaceProvider,
  marketplaceCsvRows,
  marketplaceOrdersCsv,
  parseMarketplaceOrderPage,
  splitWritableOrders,
  type MarketplaceOrder,
  type MarketplaceOrderPage,
  type MarketplacePlatformKey,
} from '../src/marketplace-provider.ts';

const order = (over: Partial<MarketplaceOrder['lines'][number]> = {}, quantity = '1', amount = '100000'): MarketplaceOrder => ({
  orderNo: '9101000009',
  orderedAt: '2026-11-02',
  shippedAt: null,
  deliveredAt: null,
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
    expect(rows[1]?.slice(6, 9)).toEqual(['100000', '1', '100000']);
  });

  it('writes the delivery day in the completion column of each platform, and nothing while the platform gives none', () => {
    const delivered = { ...order(), deliveredAt: '2026-11-05', stage: 'completed' as const };
    const cells = (platform: 'shopee' | 'tiktok_shop' | 'lazada', o: MarketplaceOrder) => cellsOf(marketplaceOrdersCsv(platform, [o])).slice(0, 2);
    const [shopeeHead, shopeeRow] = cells('shopee', delivered);
    expect(shopeeHead?.at(-1)).toBe('Thời gian hoàn thành đơn hàng');
    expect(shopeeRow?.at(-1)).toBe('2026-11-05');
    const [tiktokHead, tiktokRow] = cells('tiktok_shop', delivered);
    expect(tiktokHead?.at(-1)).toBe('Delivered Time');
    expect(tiktokRow?.at(-1)).toBe('2026-11-05');
    const [lazadaHead, lazadaRow] = cells('lazada', delivered);
    expect(lazadaHead?.at(-1)).toBe('deliveredTime');
    expect(lazadaRow?.at(-1)).toBe('2026-11-05');
    for (const platform of ['shopee', 'tiktok_shop', 'lazada'] as const) expect(cells(platform, order())[1]?.at(-1)).toBe('');
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

// #2840 point 1: the rows are counted before any is built, so a few lines with huge quantities on a platform that writes a row for each unit are refused early and never materialised.
describe('counting rows before building them', () => {
  const lines = (n: number, quantity: string) =>
    Array.from({ length: n }, (_, i) => ({ lineKey: `9101-${i}`, sku: 'MAU-001', itemName: 'Áo', quantity, unitPrice: '1000', amount: money(quantity).times('1000').toFixed() }));
  const huge: MarketplaceOrder = { orderNo: '9101000009', orderedAt: '2026-11-02', shippedAt: null, deliveredAt: null, stage: 'placed', lines: lines(300, '100000') };

  it('counts one row for each line, and on a per-unit platform one for each unit', () => {
    expect(marketplaceCsvRows('shopee', [huge])).toBe(300);
    expect(marketplaceCsvRows('tiktok_shop', [huge])).toBe(300);
    expect(marketplaceCsvRows('lazada', [huge])).toBe(30_000_000);
    expect(marketplaceCsvRows('lazada', [])).toBe(0);
    // A line a per-unit layout cannot carry counts as one row (splitWritableOrders names it).
    expect(marketplaceCsvRows('lazada', [{ ...huge, lines: lines(1, '1.5') }])).toBe(1);
  });

  it('refuses a page of 30 million rows at once, without building any', () => {
    const started = Date.now();
    expect(() => marketplaceOrdersCsv('lazada', [huge])).toThrow(/more rows than one file may carry/);
    expect(Date.now() - started).toBeLessThan(500);
    // The same lines on a platform that writes one row for each line are fine.
    expect(marketplaceOrdersCsv('shopee', [huge]).trimEnd().split('\n')).toHaveLength(1 + 300);
    expect(MARKETPLACE_CSV_MAX_ROWS).toBe(20_000);
  });
});

// #2840 point 2: the page a provider returns is checked before anything of it is used.
describe('parseMarketplaceOrderPage', () => {
  const good = (): MarketplaceOrderPage => ({
    orders: [{ orderNo: '9101000001', orderedAt: '2026-11-02', shippedAt: '2026-11-03', deliveredAt: null, stage: 'shipped', lines: [{ lineKey: '9101000001-1', sku: 'MAU-001', itemName: 'Áo thun', quantity: '2', unitPrice: '150000', amount: '300000' }] }],
    nextCursor: 'sandbox:1',
  });
  // A copy with one field changed deep inside, for the cases below.
  const withOrder = (change: (o: Record<string, unknown>) => void): unknown => {
    const page = JSON.parse(JSON.stringify(good())) as { orders: Array<Record<string, unknown>> };
    change(page.orders[0]!);
    return page;
  };
  const withLine = (change: (l: Record<string, unknown>) => void): unknown => withOrder((o) => change((o.lines as Array<Record<string, unknown>>)[0]!));

  it('takes a good page, and every page the offline provider serves for every platform', async () => {
    expect(parseMarketplaceOrderPage(good())).toEqual(good());
    const sandbox = createSandboxMarketplaceProvider();
    for (const platform of Object.keys(MARKETPLACE_PLATFORM_LIMITS) as MarketplacePlatformKey[]) {
      expect(parseMarketplaceOrderPage(await sandbox.listOrders('sandbox', platform, null))).not.toBeNull();
    }
  });

  it('refuses what is not a page: a missing list, a field the port does not name, a buyer\'s data riding along', () => {
    expect(parseMarketplaceOrderPage(null)).toBeNull();
    expect(parseMarketplaceOrderPage({ orders: 'x', nextCursor: null })).toBeNull();
    expect(parseMarketplaceOrderPage({ ...good(), extra: 1 })).toBeNull();
    expect(parseMarketplaceOrderPage(withOrder((o) => (o.customerName = 'Nguyễn Văn A')))).toBeNull();
    expect(parseMarketplaceOrderPage(withLine((l) => (l.buyer = { phone: '0912345678' })))).toBeNull();
  });

  it('refuses an amount or a quantity that is not a decimal string, and a quantity that is not positive', () => {
    for (const amount of [150000, '1e5', '1,000', '12.34567', '', ' 5', '--5', 'NaN', null, '12345678901234567']) expect(parseMarketplaceOrderPage(withLine((l) => (l.amount = amount)))).toBeNull();
    for (const quantity of [2, '0', '-1', '1.5555', '', 'two']) expect(parseMarketplaceOrderPage(withLine((l) => (l.quantity = quantity)))).toBeNull();
    expect(parseMarketplaceOrderPage(withLine((l) => (l.amount = '-5000.25')))).not.toBeNull();
  });

  it('refuses a day that does not exist, a stage that is not known, and text that is too long or has a control character', () => {
    for (const day of ['2026-02-30', '2026-13-01', '02/11/2026', '2026-11-02T00:00:00Z', '']) expect(parseMarketplaceOrderPage(withOrder((o) => (o.orderedAt = day)))).toBeNull();
    expect(parseMarketplaceOrderPage(withOrder((o) => (o.shippedAt = 'soon')))).toBeNull();
    expect(parseMarketplaceOrderPage(withOrder((o) => (o.stage = 'lost')))).toBeNull();
    expect(parseMarketplaceOrderPage(withOrder((o) => (o.orderNo = 'x'.repeat(101))))).toBeNull();
    expect(parseMarketplaceOrderPage(withOrder((o) => (o.orderNo = '')))).toBeNull();
    expect(parseMarketplaceOrderPage(withLine((l) => (l.itemName = 'a'.repeat(301))))).toBeNull();
    expect(parseMarketplaceOrderPage(withLine((l) => (l.itemName = 'a\u0000b')))).toBeNull();
    expect(parseMarketplaceOrderPage({ ...good(), nextCursor: 'c'.repeat(201) })).toBeNull();
  });

  it('refuses an order with no line, a page of more than a thousand orders and an order of more than 500 lines', () => {
    expect(parseMarketplaceOrderPage(withOrder((o) => (o.lines = [])))).toBeNull();
    const order = good().orders[0]!;
    expect(parseMarketplaceOrderPage({ orders: Array.from({ length: 1001 }, () => order), nextCursor: null })).toBeNull();
    expect(parseMarketplaceOrderPage({ orders: [{ ...order, lines: Array.from({ length: 501 }, () => order.lines[0]) }], nextCursor: null })).toBeNull();
  });
});
