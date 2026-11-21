// SPDX-License-Identifier: AGPL-3.0-only
// The income CSV the poll leg writes (#4302): each platform's layout is read back by the SAME profile reader the intake uses (findIncomeColumns + incomeLines over the CSV grid), giving the same
// lines, the same net and `other`; the writer is deterministic; and the page check refuses what the identity or the shapes refuse.
import { describe, expect, it } from 'vitest';
import { findIncomeColumns, incomeLines, parseCsv } from '@ludy/l10n-vn';
import { MARKETPLACE_ADAPTER_PLATFORMS, marketplaceIncomeCsv, parseMarketplaceIncomePage, type MarketplaceIncomeLine, type MarketplacePlatformKey } from '../src/index.ts';

const CONNECTION = '5b0f6f1e-0000-4000-8000-000000000001';
const line = (over: Partial<MarketplaceIncomeLine> = {}): MarketplaceIncomeLine => ({
  orderNo: '2611A1',
  paidAt: '2026-11-03',
  sales: '100000',
  sellerDiscount: '10000',
  commission: '5000',
  serviceFee: '2000',
  paymentFee: '1500',
  shipping: '3000',
  taxWithheld: '1000',
  refund: '0',
  other: '-500',
  net: '77000',
  ...over,
});
const LINES = [
  line(),
  line({ orderNo: '2611A2', sales: '50000', sellerDiscount: '0', commission: '2500', serviceFee: '1000', paymentFee: '750', shipping: '0', taxWithheld: '0', other: '1250.5', net: '47000.5' }),
  // A refund-only day of an earlier sale: no sales, a negative net.
  line({ orderNo: '2611A3', sales: '0', sellerDiscount: '0', commission: '0', serviceFee: '0', paymentFee: '0', shipping: '0', taxWithheld: '0', refund: '20000', other: '0', net: '-20000' }),
];
const PLATFORMS: MarketplacePlatformKey[] = ['shopee', 'tiktok_shop', 'lazada'];

describe('marketplaceIncomeCsv', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: the profile reads back the same lines, platform and net`, () => {
      const grid = parseCsv(marketplaceIncomeCsv(platform, LINES, CONNECTION));
      const mapping = findIncomeColumns(grid);
      expect(mapping?.profile.platform).toBe(platform);
      const read = incomeLines(grid, mapping as NonNullable<typeof mapping>, 100);
      expect(read?.skipped).toEqual([]);
      expect(read?.lines.map(({ rowNo: _row, lineKey: _key, ...rest }) => rest)).toEqual(LINES.map((l) => ({ ...l })));
    });
  }

  it('is deterministic and names the connection, so two connections never write the same bytes', () => {
    expect(marketplaceIncomeCsv('shopee', LINES, CONNECTION)).toBe(marketplaceIncomeCsv('shopee', LINES, CONNECTION));
    expect(marketplaceIncomeCsv('shopee', LINES, CONNECTION)).not.toBe(marketplaceIncomeCsv('shopee', LINES, '5b0f6f1e-0000-4000-8000-000000000002'));
    expect(marketplaceIncomeCsv('lazada', LINES, CONNECTION).startsWith(`"Ludy marketplace connection ${CONNECTION}"`)).toBe(true);
  });

  it('writes a Shopee or TikTok deduction as a negative number and a Lazada one as positive, as each profile says', () => {
    expect(marketplaceIncomeCsv('shopee', [line()]).split('\n')[1]).toContain('"-5000"');
    expect(marketplaceIncomeCsv('lazada', [line()]).split('\n')[1]).toContain('"5000"');
    expect(marketplaceIncomeCsv('shopee', [line({ refund: '0' })]).split('\n')[1]).not.toContain('"-0"');
  });

  it('keeps every platform that has a reader writable (the adapter list and the layouts agree)', () => {
    for (const platforms of Object.values(MARKETPLACE_ADAPTER_PLATFORMS)) for (const platform of platforms) expect(() => marketplaceIncomeCsv(platform, [], undefined)).not.toThrow();
  });
});

describe('parseMarketplaceIncomePage', () => {
  const page = (lines: unknown[]) => ({ lines, nextCursor: 'd:2026-11-04', more: true });
  it('takes a page whose lines satisfy the identity', () => {
    expect(parseMarketplaceIncomePage(page(LINES))?.lines).toHaveLength(3);
  });
  it('refuses an identity that does not hold, a negative deduction, a formula-like order number, a bad day, an extra field and too many decimals', () => {
    for (const bad of [
      line({ net: '77001' }),
      line({ commission: '-5000', net: '88000' }),
      line({ orderNo: '=2611A1' }),
      line({ orderNo: '-5' }),
      line({ orderNo: 'ABC' }),
      line({ paidAt: '2026-02-30' }),
      line({ sales: '100000.12345' }),
      { ...line(), buyerName: 'x' },
    ])
      expect(parseMarketplaceIncomePage(page([bad]))).toBeNull();
  });
});
