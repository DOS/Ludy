// SPDX-License-Identifier: AGPL-3.0-only
// The duplicate-of hint of a deal (CRM-15, #3294), rendered on the server: a deal whose party was marked a duplicate shows
// "Liên hệ này đã được đánh dấu trùng với <name>" and, to a person who can edit, the button that moves it to the kept party;
// a viewer reads the hint only; a deal on a normal party shows nothing.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { Deal } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  Link: ({ children, ...rest }: { children?: unknown }) => <a {...(rest as object)}>{children as never}</a>,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: node([]), queryClient: new QC(), errorMessage: (e: unknown) => String(e), apiFetch: () => Promise.reject(new Error('not fetched')) };
});

const { DealPartyDuplicate } = await import('../src/components/deal-form.tsx');

const deal = (partyDuplicateOf: Deal['partyDuplicateOf']): Deal => ({
  id: '00000000-0000-4000-8000-000000000001',
  partyId: '00000000-0000-4000-8000-000000000010',
  partyName: 'Công ty ABC (trùng)',
  title: 'Gói kế toán năm',
  amount: '15000000.00',
  currency: 'VND',
  stageId: '00000000-0000-4000-8000-000000000020',
  stageKind: 'open',
  expectedClose: null,
  ownerUserId: null,
  lostReason: null,
  closedAt: null,
  version: 1,
  canDelete: true,
  followUp: null,
  partyDuplicateOf,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});
const KEEP = { id: '00000000-0000-4000-8000-000000000011', name: 'Công ty ABC' };

function render(node: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the duplicate-of hint of a deal', () => {
  it('shows the hint and the move button to an editor', () => {
    const html = render(<DealPartyDuplicate deal={deal(KEEP)} canEdit />);
    expect(html).toContain('Liên hệ này đã được đánh dấu trùng với Công ty ABC.');
    expect(html).toContain('Chuyển cơ hội sang Công ty ABC');
    expect(html).toMatch(/<button[^>]*type="button"/);
  });

  it('shows a viewer the hint and no button', () => {
    const html = render(<DealPartyDuplicate deal={deal(KEEP)} canEdit={false} />);
    expect(html).toContain('Liên hệ này đã được đánh dấu trùng với Công ty ABC.');
    expect(html).not.toContain('<button');
  });

  it('shows nothing for a deal on a party that is not a duplicate', () => {
    expect(render(<DealPartyDuplicate deal={deal(null)} canEdit />)).toBe('');
  });

  it('speaks English too', () => {
    const html = render(<DealPartyDuplicate deal={deal(KEEP)} canEdit />, 'en');
    expect(html).toContain('This contact was marked a duplicate of Công ty ABC.');
    expect(html).toContain('Move the deal to Công ty ABC');
  });
});
