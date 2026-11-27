// SPDX-License-Identifier: AGPL-3.0-only
// SSR, i18n copy parity, role gating, AI-off gating, and accessibility checks for ContactAttention (#4993).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { PARTY_ATTENTION_KINDS, type PartyAttentionItem } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const queryClientState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ aiEnabled: false, modules: ['crm'] }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => ({
            queryKey: [...path, args?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched in unit test')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'call') return () => Promise.resolve({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { client: node([]), orpc: node([]), queryClient: queryClientState.current, errorMessage: String };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'demo-org' }),
    useSearch: () => ({}),
    Link: ({
      children,
      to,
      params,
      search,
      ...rest
    }: {
      children?: ReactNode;
      to: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
      'data-testid'?: string;
      className?: string;
    }) => {
      let href = to.replace('$slug', params?.slug ?? 'demo-org');
      if (search && Object.keys(search).length > 0) {
        const q = new URLSearchParams(search).toString();
        if (q) href = `${href}?${q}`;
      }
      return createElement('a', { href, 'data-testid': rest['data-testid'], className: rest.className }, children);
    },
  };
});

const { ContactAttentionView } = await import('../src/components/contact-attention.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => {
  setActiveLocale(locale);
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClientState.current}>
        <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
          {node}
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
};

const PARTY_ID = '10000000-0000-4000-8000-000000000001';
const DEAL_ID = '20000000-0000-4000-8000-000000000001';
const QUOTE_ID = '30000000-0000-4000-8000-000000000001';
const STEP_ID_1 = '40000000-0000-4000-8000-000000000001';
const STEP_ID_2 = '40000000-0000-4000-8000-000000000002';
const CONV_ID = '50000000-0000-4000-8000-000000000001';

const sampleItems: PartyAttentionItem[] = [
  {
    kind: 'quote_viewed',
    targetId: QUOTE_ID,
    eventAt: '2026-11-27T10:00:00.000Z',
    partyId: PARTY_ID,
    dealId: DEAL_ID,
    quoteId: QUOTE_ID,
    nextStepId: null,
    conversationId: null,
  },
  {
    kind: 'quote_expiring',
    targetId: STEP_ID_1,
    eventAt: '2026-11-26T09:00:00.000Z',
    partyId: PARTY_ID,
    dealId: DEAL_ID,
    quoteId: QUOTE_ID,
    nextStepId: STEP_ID_1,
    conversationId: null,
  },
  {
    kind: 'quote_unanswered',
    targetId: STEP_ID_2,
    eventAt: '2026-11-25T08:00:00.000Z',
    partyId: PARTY_ID,
    dealId: DEAL_ID,
    quoteId: null,
    nextStepId: STEP_ID_2,
    conversationId: null,
  },
  {
    kind: 'customer_replied',
    targetId: CONV_ID,
    eventAt: '2026-11-24T07:00:00.000Z',
    partyId: PARTY_ID,
    dealId: null,
    quoteId: null,
    nextStepId: null,
    conversationId: CONV_ID,
  },
];

describe('ContactAttention card (#4993)', () => {
  it('renders all 4 attention kinds with links, Da xem, and Goi y buoc tiep for editors when AI is on', () => {
    const html = renderToStaticMarkup(
      wrap(
        'vi',
        <ContactAttentionView
          items={sampleItems}
          isLoading={false}
          error={null}
          canEdit
          aiEnabled
          slug="demo-org"
          pendingKey={null}
          markError={null}
          onMarkSeen={() => undefined}
        />,
      ),
    );
    expect(html).toContain('Cần chú ý');
    expect(html).toContain('Khách vừa xem báo giá');
    expect(html).toContain('Báo giá sắp hết hạn');
    expect(html).toContain('Báo giá chưa có trả lời');
    expect(html).toContain('Khách vừa nhắn lại');
    expect(html).toContain(`/o/demo-org/deals?deal=${DEAL_ID}&amp;quote=${QUOTE_ID}`);
    expect(html).toContain(`/o/demo-org/deals?deal=${DEAL_ID}`);
    expect(html).toContain(`/o/demo-org/social/inbox?c=${CONV_ID}`);
    expect(html).toContain('Đã xem');
    expect(html).toContain('Gợi ý bước tiếp');
    // Mobile 44px touch targets + landmark accessibility attributes.
    expect(html).toContain('max-md:min-h-11');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('aria-label="Đánh dấu đã xem:');
  });

  it('keeps list and links working while hiding Goi y buoc tiep when AI is off', () => {
    const html = renderToStaticMarkup(
      wrap(
        'vi',
        <ContactAttentionView
          items={sampleItems}
          isLoading={false}
          error={null}
          canEdit
          aiEnabled={false}
          slug="demo-org"
          pendingKey={null}
          markError={null}
          onMarkSeen={() => undefined}
        />,
      ),
    );
    expect(html).toContain('Xem báo giá');
    expect(html).toContain('Mở cuộc trò chuyện');
    expect(html).toContain('Đã xem');
    expect(html).not.toContain('Gợi ý bước tiếp');
    expect(html).not.toContain('data-testid="followup-ask"');
  });

  it('lets viewers read attention items and links while hiding mark-seen and AI suggestion controls', () => {
    const html = renderToStaticMarkup(
      wrap(
        'en',
        <ContactAttentionView
          items={sampleItems}
          isLoading={false}
          error={null}
          canEdit={false}
          aiEnabled
          slug="demo-org"
          pendingKey={null}
          markError={null}
          onMarkSeen={() => undefined}
        />,
      ),
    );
    expect(html).toContain('Needs attention');
    expect(html).toContain('Customer opened quote');
    expect(html).toContain('Open conversation');
    expect(html).not.toContain('data-testid="attention-mark-seen"');
    expect(html).not.toContain('data-testid="followup-ask"');
  });

  it('has complete vi and en translations for every attention kind', () => {
    for (const locale of ['vi', 'en'] as const) {
      const messages = catalog(locale) as unknown as {
        contacts: { attention: { kind: Record<string, string>; markSeen: string; suggestNextStep: string } };
      };
      const copy = messages.contacts.attention;
      expect(Object.keys(copy.kind).sort()).toEqual([...PARTY_ATTENTION_KINDS].sort());
      for (const value of Object.values(copy.kind)) expect(value.trim().length).toBeGreaterThan(0);
      expect(copy.markSeen.trim().length).toBeGreaterThan(0);
      expect(copy.suggestNextStep.trim().length).toBeGreaterThan(0);
    }
  });
});
