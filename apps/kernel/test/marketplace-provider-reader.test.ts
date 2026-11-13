// SPDX-License-Identifier: AGPL-3.0-only
// What the marketplace provider writes is read back as it was (#2519): the reader takes one point and exactly three digits for a thousands group, so a value with three decimals (a Lazada
// unit share of a line that does not divide by its units, a unit price or an amount a provider gives with three decimals) must survive the file.
import { describe, expect, it } from 'vitest';
import { readMarketplaceOrders } from '../../extract/src/marketplace-orders.ts';
import { marketplaceOrdersCsv, type MarketplaceOrder } from '../../../modules/finance/src/marketplace-provider.ts';

const order = (line: Partial<MarketplaceOrder['lines'][number]>): MarketplaceOrder =>
  ({ orderNo: 'R-1', stage: 'placed', orderedAt: '2026-11-01', shippedAt: null, lines: [{ lineKey: 'R-1-1', sku: 'S1', itemName: 'Mau', quantity: '2', unitPrice: '100', amount: '200', ...line }] }) as MarketplaceOrder;

const readLines = (platform: 'shopee' | 'tiktok_shop' | 'lazada', orders: MarketplaceOrder[]) => {
  const read = readMarketplaceOrders(new TextEncoder().encode(marketplaceOrdersCsv(platform, orders))) as unknown as { recognized: boolean; lines: Array<{ quantity: string; unitPrice: string; amount: string }> };
  expect(read.recognized).toBe(true);
  return read.lines;
};

describe('marketplace provider file, read back', () => {
  it.each(['shopee', 'tiktok_shop'] as const)('%s: three decimals in a unit price and an amount stay as they are', (platform) => {
    const [line] = readLines(platform, [order({ unitPrice: '100.125', amount: '200.250' })]);
    expect(line?.unitPrice).toBe('100.125');
    expect(line?.amount).toBe('200.25');
  });

  it('shopee: three decimals in a quantity stay as they are', () => {
    const [line] = readLines('shopee', [order({ quantity: '1.500', unitPrice: '100', amount: '150' })]);
    expect(line?.quantity).toBe('1.5');
  });

  it('lazada: the unit shares of a line that does not divide by its units add up to the line', () => {
    const lines = readLines('lazada', [order({ quantity: '8', unitPrice: '125.125', amount: '1001' })]);
    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 7).every((l) => l.amount === '125.125')).toBe(true);
    expect(lines[7]?.amount).toBe('125.125');
  });

  it('whole amounts and plain decimals are untouched', () => {
    const [line] = readLines('shopee', [order({ unitPrice: '1500000', amount: '3000000' })]);
    expect(line?.unitPrice).toBe('1500000');
    expect(line?.amount).toBe('3000000');
  });
});
