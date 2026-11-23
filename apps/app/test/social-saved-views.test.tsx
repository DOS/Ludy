// SPDX-License-Identifier: AGPL-3.0-only
// The saved-views row of the Posts screen (#3655): "Lưu bộ lọc này" only while a filter is set, and no row at all when
// there is nothing to pick and nothing to save. Rendered on the server from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { SavedViews } = await import('../src/components/social-saved-views.tsx');

const render = (node: ReactNode) => {
  setActiveLocale('vi');
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
};
const row = (canSave: boolean) => render(<SavedViews search={{ tab: 'drafts' }} members={[]} canShare canSave={canSave} onApply={() => undefined} />);

describe('saved views (#3655)', () => {
  beforeEach(() => client.current.clear());

  it('draws nothing while no filter is set and no view is saved', () => {
    client.current.setQueryData(['social', 'savedViews', 'list'], []);
    expect(row(false)).toBe('');
  });

  it('offers "Lưu bộ lọc này" once a filter is set', () => {
    client.current.setQueryData(['social', 'savedViews', 'list'], []);
    expect(row(true)).toContain('Lưu bộ lọc này');
  });

  it('keeps the picker of saved views, without the save button, when none is set', () => {
    client.current.setQueryData(['social', 'savedViews', 'list'], [{ id: 'v1', name: 'Bài của Lan', filters: {}, shared: false, mine: true, ownerId: 'u1', canChange: true }]);
    const html = row(false);
    expect(html).toContain('Chế độ xem đã lưu');
    expect(html).not.toContain('Lưu bộ lọc này');
  });
});
