// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox card of a request to issue an e-invoice says plainly when the sales order the draft was made from was cancelled (#2849, ADR-0050 point 2), rendered on the server with the answer of
// crm.salesOrders.get seeded in the cache: a cancelled order shows the warning with its number, a confirmed one shows none, an order that cannot be read (no answer) shows none, and a request that
// is no longer waiting shows none. The warning is advisory: it adds no button and holds nothing.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EInvoiceIssueView } from '@crove/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => <a>{children as never}</a> }));

const { EInvoiceIssueCard } = await import('../src/components/einvoice-issue-card.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const orderA = '00000000-0000-4000-8000-0000000000a1';
const orderB = '00000000-0000-4000-8000-0000000000b2';
const view = (sourceOrderIds: string[]): EInvoiceIssueView => ({
  draftId: '00000000-0000-4000-8000-0000000000d1',
  state: 'draft',
  date: '2026-11-13',
  currency: 'VND',
  total: '110000',
  lineCount: 1,
  buyerKind: 'business',
  buyerName: 'Công ty Mua Thử',
  buyerTaxCode: '0100109106',
  series: '1/C26TAA',
  subtotal: '100000',
  vatAmount: '10000',
  lines: [{ lineNo: 1, description: 'Hàng A', unit: 'cái', quantity: '1', unitPrice: '100000', vatRate: '10%', amount: '100000', vatAmount: '10000' } as EInvoiceIssueView['lines'][number]],
  sourceOrderIds,
  current: true,
});

function render(data: EInvoiceIssueView, options: { pending?: boolean; orders?: Record<string, { status: 'confirmed' | 'cancelled'; number: string }>; locale?: 'vi' | 'en' } = {}): string {
  setActiveLocale(options.locale ?? 'en');
  for (const [id, order] of Object.entries(options.orders ?? {})) cache.current.setQueryData(['crm', 'salesOrders', 'get', { orderId: id }], order);
  const result = { data, isLoading: false, error: null } as never;
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>
        <EInvoiceIssueCard view={result} title="Phát hành hóa đơn" slug="acme" pending={options.pending ?? true} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the issue card and a cancelled sales order (#2849)', () => {
  beforeEach(() => cache.current.clear());

  it('warns with the order number when the order the draft was made from was cancelled', () => {
    const html = render(view([orderA]), { orders: { [orderA]: { status: 'cancelled', number: 'DH-2026-0007' } } });
    expect(html).toContain('data-testid="einvoice-issue-order-cancelled"');
    expect(html).toContain('DH-2026-0007');
    expect(html).toContain('was cancelled');
    expect(html).not.toContain('<button');
  });

  it('says it in Vietnamese', () => {
    const html = render(view([orderA]), { locale: 'vi', orders: { [orderA]: { status: 'cancelled', number: 'DH-2026-0007' } } });
    expect(html).toContain('đã bị hủy');
  });

  it('shows nothing for a confirmed order, an order it cannot read, a draft with no order, or a request no longer waiting', () => {
    expect(render(view([orderA]), { orders: { [orderA]: { status: 'confirmed', number: 'DH-2026-0001' } } })).not.toContain('einvoice-issue-order-cancelled');
    expect(render(view([orderB]))).not.toContain('einvoice-issue-order-cancelled');
    expect(render(view([]))).not.toContain('einvoice-issue-order-cancelled');
    expect(render(view([orderA]), { pending: false, orders: { [orderA]: { status: 'cancelled', number: 'DH-2026-0007' } } })).not.toContain('einvoice-issue-order-cancelled');
  });

  it('names each cancelled order of a draft made from several', () => {
    const html = render(view([orderA, orderB]), { orders: { [orderA]: { status: 'cancelled', number: 'DH-2026-0007' }, [orderB]: { status: 'cancelled', number: 'DH-2026-0009' } } });
    expect(html.match(/data-testid="einvoice-issue-order-cancelled"/g)).toHaveLength(2);
    expect(html).toContain('DH-2026-0009');
  });
});
