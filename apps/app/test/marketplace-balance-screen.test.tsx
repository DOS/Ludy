// SPDX-License-Identifier: AGPL-3.0-only
// The "Sàn" screen (#2516 slice D), rendered on the server with the answer of finance.marketplace.balance seeded in the cache: one row per platform with sales, settled, owed and the fees awaiting an
// invoice, a total row, the empty state with no platform, and the platform names (a later platform id is shown as it is). Facts only: it makes no call but the read.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceBalance } from '@crove/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});

vi.mock('../src/components/entity-switcher.tsx', () => ({ useChosenEntity: () => ({ ready: true, legalEntityId: '00000000-0000-4000-8000-0000000000e1' }) }));

const { MarketplaceBalancePage } = await import('../src/routes/marketplace-balance.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const entity = '00000000-0000-4000-8000-0000000000e1';
const balance = (platforms: MarketplaceBalance['platforms'], totals: MarketplaceBalance['totals']): MarketplaceBalance => ({ legalEntityId: entity, asOf: '2026-11-09', platforms, totals });

function page(data: MarketplaceBalance, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  const qc = cache.current;
  qc.setQueryData(['marketplaceBalance', 'get'], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MarketplaceBalancePage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the marketplace balance screen (#2516)', () => {
  beforeEach(() => cache.current.clear());

  it('shows each platform with its figures and the totals', () => {
    const html = page(
      balance(
        [
          { platform: 'shopee', partyId: '00000000-0000-4000-8000-0000000000a1', partyName: 'Sàn Shopee', sales: '1000000', payouts: '750000', owed: '250000', feesAwaitingInvoice: '40000' },
          { platform: 'tiktok_shop', partyId: null, partyName: null, sales: '0', payouts: '0', owed: '0', feesAwaitingInvoice: '0' },
          { platform: 'newplatform', partyId: null, partyName: null, sales: '0', payouts: '0', owed: '0', feesAwaitingInvoice: '0' },
        ],
        { sales: '1000000', payouts: '750000', owed: '250000', feesAwaitingInvoice: '40000' },
      ),
    );
    expect(html).toContain('data-testid="marketplace-balance"');
    expect(html).toContain('data-testid="marketplace-row-shopee"');
    expect(html).toContain('Shopee');
    expect(html).toContain('TikTok Shop');
    // A platform id the screen does not know is shown as it is.
    expect(html).toContain('newplatform');
    expect(html).toContain('data-testid="marketplace-owed-total"');
    expect(html).toContain('Still owed to you');
    expect(html).toContain('Fees awaiting an invoice');
  });

  it('shows the empty state with no platform, and is in Vietnamese too', () => {
    const empty = balance([], { sales: '0', payouts: '0', owed: '0', feesAwaitingInvoice: '0' });
    expect(page(empty)).toContain('No marketplace yet');
    cache.current.clear();
    const html = page(empty, 'vi');
    expect(html).toContain('Chưa có sàn nào');
    expect(html).not.toContain('data-testid="marketplace-balance"');
  });
});
