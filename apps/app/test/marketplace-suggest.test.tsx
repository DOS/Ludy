// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's item suggestion on the unassigned marketplace order lines (#2686), rendered on the server with the answer of marketplace.unassigned seeded in the cache: the ask button is there only for a person who can
// write and only when there is an item in use to suggest; reading the screen asks the server for nothing (the button is the only way a model is called); and the button stays off while no line has a product name or SKU to read.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceUnassignedLine, StockItem } from '@ludy/kernel-contract';

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

const { MarketplaceUnassigned } = await import('../src/components/marketplace-orders.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const entity = '00000000-0000-4000-8000-0000000000e1';
const line = (n: number, over: Partial<MarketplaceUnassignedLine> = {}): MarketplaceUnassignedLine => ({
  lineId: `00000000-0000-4000-8000-00000000010${n}`,
  legalEntityId: entity,
  platform: 'shopee',
  orderNo: `S${n}`,
  orderedAt: '2026-10-30',
  sku: `SKU-${n}`,
  itemName: `Áo thun ${n}`,
  quantity: '1',
  stage: 'shipped',
  ...over,
});
const item = (over: Partial<StockItem> = {}): StockItem => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  legalEntityId: entity,
  code: 'AO01',
  name: 'Áo thun',
  unit: 'cái',
  kind: 'goods',
  stockAccount: '156',
  trade: 'goods',
  active: true,
  onHand: '10',
  moves: 0,
  ...over,
} as StockItem);

function render(lines: MarketplaceUnassignedLine[], items: StockItem[], canWrite: boolean, locale: 'vi' | 'en' = 'en'): string {
  setActiveLocale(locale);
  cache.current.setQueryData(['marketplace', 'unassigned'], lines);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <MarketplaceUnassigned legalEntityId={undefined} ready items={items} canWrite={canWrite} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const disabled = (html: string, testId: string): boolean => /\sdisabled=""/.test(html.match(new RegExp(`<[a-z]+ [^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '');

describe('the coworker on the unassigned marketplace lines (#2686)', () => {
  beforeEach(() => {
    cache.current.clear();
    cache.calls.length = 0;
  });

  it('offers the ask button to a person who can write when an item is in use', () => {
    const html = render([line(1), line(2)], [item()], true);
    expect(html).toContain('data-testid="marketplace-suggest"');
    expect(disabled(html, 'marketplace-suggest')).toBe(false);
    // Reading the screen asks the server for nothing: the button only calls the model when pressed.
    expect(cache.calls).toEqual([]);
  });

  it('shows no ask button to a viewer, nor when no item is in use, and the list still works', () => {
    expect(render([line(1)], [item()], false)).not.toContain('marketplace-suggest');
    const none = render([line(1)], [item({ active: false })], true);
    expect(none).not.toContain('marketplace-suggest');
    expect(none).toContain('data-testid="marketplace-unassigned-line"');
  });

  it('keeps the button disabled when no line has a product name or a SKU to read', () => {
    const html = render([line(1, { sku: null, itemName: null }), line(2, { sku: ' ', itemName: '' })], [item()], true);
    expect(html).toContain('data-testid="marketplace-suggest"');
    expect(disabled(html, 'marketplace-suggest')).toBe(true);
  });

  it('shows nothing at all when no line waits', () => {
    expect(render([], [item()], true)).toBe('');
  });
});
