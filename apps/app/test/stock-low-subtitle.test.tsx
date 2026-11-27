// SPDX-License-Identifier: AGPL-3.0-only
// The "Hàng sắp hết" section subtitle shows the org's configured supplier delivery lead time (#2685), falling back to 14 when unset.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StockLowItem } from '@ludy/kernel-contract';

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
  return { orpc: node([]), client: node([]), queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});

const { LowStock } = await import('../src/components/stock-ai.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');
const { en } = await import('../src/i18n/messages/en.ts');
const { vi: viMessages } = await import('../src/i18n/messages/vi.ts');

const ITEM: StockLowItem = {
  itemId: '00000000-0000-4000-8000-000000000001',
  legalEntityId: '00000000-0000-4000-8000-0000000000e1',
  code: 'A1',
  name: 'Áo thun',
  unit: 'cái',
  onHand: '2',
  dailyOut: '1',
  coverDays: 2,
  suggestedQuantity: '12',
  supplier: null,
};

function render(locale: 'vi' | 'en', leadDays?: number): string {
  setActiveLocale(locale);
  cache.current.setQueryData(['stock', 'low'], [ITEM]);
  if (leadDays !== undefined) cache.current.setQueryData(['stock', 'settings', 'get'], { leadDays });
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <LowStock legalEntityId={undefined} ready canWrite />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('LowStock subtitle (#2685)', () => {
  beforeEach(() => cache.current.clear());

  it('shows the org lead days setting in English and Vietnamese, defaulting to 14', () => {
    expect(render('en')).toContain('delivery time (14 days)');
    expect(render('vi')).toContain('giao hàng (14 ngày)');

    cache.current.clear();
    expect(render('en', 7)).toContain('delivery time (7 days)');
    expect(render('vi', 7)).toContain('giao hàng (7 ngày)');

    cache.current.clear();
    expect(render('en', 1)).toContain('delivery time (1 day)');
    expect(render('vi', 1)).toContain('giao hàng (1 ngày)');
  });

  it('defines vi/en command labels for finance.stock_setting.{get,set}', () => {
    expect(en.commands.finance.stock_setting.get.trim()).not.toBe('');
    expect(en.commands.finance.stock_setting.set.trim()).not.toBe('');
    expect(viMessages.commands.finance.stock_setting.get.trim()).not.toBe('');
    expect(viMessages.commands.finance.stock_setting.set.trim()).not.toBe('');
  });
});
