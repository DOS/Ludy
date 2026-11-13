// SPDX-License-Identifier: AGPL-3.0-only
// The Sàn screen (#2516 slice D), rendered on the server with the answer of marketplace.balance seeded in the cache: a platform shows its four figures, none posted yet says so, nothing is
// asked of a model and nothing on the screen can be pressed (it only reads the ledger).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceBalance } from '@crove/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient, calls: [] as string[] }));

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
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_t, prop: string) => () => cache.calls.push(prop) }) });
  return { orpc: node([]), client, queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('../src/components/entity-switcher.tsx', () => ({ useChosenEntity: () => ({ ready: true, legalEntityId: undefined }) }));

const { MarketplaceBalancePage } = await import('../src/routes/marketplace-balance.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const entity = '00000000-0000-4000-8000-0000000000e1';

function render(answer: MarketplaceBalance | null, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  if (answer) cache.current.setQueryData(['marketplace', 'balance'], answer);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <MarketplaceBalancePage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the Sàn screen (#2516)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('shows each platform with its sales, what it paid out, what it still owes and the fees awaiting an invoice', () => {
    const html = render({
      rows: [
        { legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', salesPosted: '1500000', paidOut: '1000000', awaitingPayout: '500000', feesAwaitingInvoice: '100000' },
        { legalEntityId: entity, platform: 'tiktok_shop', platformName: 'TikTok Shop', salesPosted: '250000', paidOut: '600000', awaitingPayout: '-350000', feesAwaitingInvoice: '0' },
      ],
    });
    expect(html.match(/data-testid="marketplace-balance-row"/g)).toHaveLength(2);
    expect(html).toContain('Shopee');
    expect(html).toContain('TikTok Shop');
    expect(html).toContain('Sales posted (131)');
    expect(html).toContain('Cleared by payouts');
    expect(html).toContain('Still owed by the platform');
    expect(html).toContain('Fees awaiting an invoice (1388)');
    expect(html).toContain('data-testid="marketplace-balance-note"');
    expect(html).not.toContain('<button');
    expect(cache.calls).toEqual([]);
  });

  it('says plainly that no platform has been posted yet', () => {
    const html = render({ rows: [] });
    expect(html).not.toContain('marketplace-balance-row');
    expect(html).toContain('No platform has been posted yet');
  });

  it('reads in Vietnamese', () => {
    const html = render({ rows: [{ legalEntityId: entity, platform: 'shopee', platformName: 'Shopee', salesPosted: '10', paidOut: '0', awaitingPayout: '10', feesAwaitingInvoice: '0' }] }, 'vi');
    expect(html).toContain('Còn chờ sàn trả');
    expect(html).toContain('Phí chờ hóa đơn (1388)');
  });
});
