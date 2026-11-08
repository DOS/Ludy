// SPDX-License-Identifier: AGPL-3.0-only
// "Tải PDF" on a quote of a deal (#2695, docs/plan/crm-quotes.md step Q3), rendered on the server from a seeded cache: every quote has the button, also for
// a viewer who cannot edit (anyone who may read a quote may take its PDF), and nothing is requested until it is pressed.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const requested = vi.hoisted(() => [] as string[]);

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    queryClient: client.current,
    errorMessage: (e: unknown) => String(e),
    apiFetch: (path: string) => {
      requested.push(path);
      return Promise.reject(new Error('not fetched'));
    },
  };
});

const { DealQuotes } = await import('../src/components/deal-quotes.tsx');

const deal = { id: '00000000-0000-4000-8000-000000000010', title: 'Gói kế toán năm', partyId: '00000000-0000-4000-8000-000000000011' } as never;
const summary = (n: number, over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-0000000001${n}0`,
  dealId: '00000000-0000-4000-8000-000000000010',
  dealTitle: 'Gói kế toán năm',
  partyId: '00000000-0000-4000-8000-000000000011',
  partyName: 'Công ty ABC',
  number: null,
  revision: 1,
  revisesId: null,
  status: 'draft',
  expired: false,
  validUntil: '2026-12-31',
  subtotal: '3000000',
  vatAmount: '300000',
  total: '3300000',
  lineCount: 1,
  version: 1,
  createdBy: 'u',
  createdAt: '2026-11-15T02:00:00.000Z',
  updatedAt: '2026-11-15T02:00:00.000Z',
  ...over,
});

function render(canEdit: boolean): string {
  setActiveLocale('vi');
  client.current.setQueryData(['crm', 'quotes', 'byDeal'], [summary(1, {}), summary(2, { number: 'BG-2026-0002', status: 'sent' })]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>
        <DealQuotes deal={deal} canEdit={canEdit} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the PDF button on a deal\'s quotes (#2695)', () => {
  beforeEach(() => {
    client.current.clear();
    requested.length = 0;
  });

  it('is on every quote, a draft and a sent one, and asks for nothing until it is pressed', () => {
    const html = render(true);
    expect(html.split('data-testid="quote-row"').length - 1).toBe(2);
    expect(html.split('Tải PDF').length - 1).toBe(2);
    expect(requested).toEqual([]);
  });

  it('is there for a viewer too, who can only read: no edit and no delete, but the PDF', () => {
    const html = render(false);
    expect(html.split('Tải PDF').length - 1).toBe(2);
    expect(html).not.toContain('Xóa nháp');
    expect(html).not.toContain('Tạo bản sửa đổi');
  });
});
