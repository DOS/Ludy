// SPDX-License-Identifier: AGPL-3.0-only
// Customers with custom payment terms on the payment reminders screen (#2544): listed even when nothing is overdue,
// editable/clearable by owners, admins and members with accessible labels and 44px mobile targets, read-only for viewers,
// hidden when empty, and surfacing query errors cleanly.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerCollectionList } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
    client: node([]),
    orpc: node([]),
    queryClient: client.current,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    takeOrgLeftNotice: () => null,
  };
});

const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { CustomerTermsSection } = await import('../src/routes/payment-reminders.tsx');

const KEY = ['paymentReminders', 'customer', 'list'] as const;

function renderSection(canEdit: boolean, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client.current}>
        <I18nProvider>
          <CustomerTermsSection canEdit={canEdit} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale('vi');
  }
}

describe('CustomerTermsSection (#2544)', () => {
  beforeEach(() => client.current.clear());

  it('renders nothing while loading or when no customer holds custom terms', () => {
    expect(renderSection(true)).toBe('');
    client.current.setQueryData([...KEY], { orgTermsDays: 30, customers: [], more: false } satisfies CustomerCollectionList);
    expect(renderSection(true)).toBe('');
  });

  it('shows an error alert when the custom-terms query fails', () => {
    client.current
      .getQueryCache()
      .build(client.current, { queryKey: [...KEY] })
      .setState({ data: undefined, error: new Error('network down'), status: 'error', fetchStatus: 'idle' } as never);
    const html = renderSection(true, 'en');
    expect(html).toContain('role="alert"');
    expect(html).toContain('network down');
  });

  it('lists customers with custom terms, active pauses only, mobile 44px actions, and overflow hint for editors', () => {
    client.current.setQueryData([...KEY], {
      orgTermsDays: 30,
      customers: [
        { partyId: '0195a1b2-c3d4-7000-8000-000000000001', name: 'Công ty An Khang', termsDays: 60, pausedUntil: '2027-02-15', paused: true },
        { partyId: '0195a1b2-c3d4-7000-8000-000000000002', name: 'Công ty Bình Minh', termsDays: 1, pausedUntil: '2026-01-01', paused: false },
      ],
      more: true,
    } satisfies CustomerCollectionList);

    const viHtml = renderSection(true, 'vi');
    expect(viHtml).toContain('data-testid="reminder-custom-terms"');
    expect(viHtml).toContain('2 khách có hạn thanh toán riêng');
    expect(viHtml).toContain('Công ty An Khang');
    expect(viHtml).toContain('Hạn riêng: 60 ngày (tổ chức: 30 ngày)');
    expect(viHtml).toContain('Tạm dừng nhắc đến hết 15/02/2027');
    expect(viHtml).toContain('Công ty Bình Minh');
    expect(viHtml).toContain('Hạn riêng: 1 ngày (tổ chức: 30 ngày)');
    expect(viHtml).not.toContain('01/01/2026');
    expect(viHtml).toContain('aria-label="Sửa hạn thanh toán riêng của Công ty An Khang"');
    expect(viHtml).toContain('aria-label="Bỏ hạn thanh toán riêng của Công ty An Khang"');
    expect(viHtml).toContain('max-md:min-h-11');
    expect(viHtml).toContain(viMessages.paymentReminders.customTerms.more);

    const enHtml = renderSection(true, 'en');
    expect(enHtml).toContain('2 customers with own payment terms');
    expect(enHtml).toContain('Own terms: 60 days (org default: 30 days)');
    expect(enHtml).toContain('Own terms: 1 day (org default: 30 days)');
    expect(enHtml).toContain('Paused through 15/02/2027');
    expect(enHtml).toContain('aria-label="Edit own payment terms for Công ty An Khang"');
    expect(enHtml).toContain('aria-label="Clear own payment terms for Công ty An Khang"');
    expect(enHtml).toContain(en.paymentReminders.customTerms.more);
  });

  it('lets a viewer read custom terms without rendering any edit or clear controls', () => {
    client.current.setQueryData([...KEY], {
      orgTermsDays: 45,
      customers: [{ partyId: '0195a1b2-c3d4-7000-8000-000000000001', name: 'Công ty Chỉ Xem', termsDays: 75, pausedUntil: null, paused: false }],
      more: false,
    } satisfies CustomerCollectionList);

    const html = renderSection(false, 'en');
    expect(html).toContain('Công ty Chỉ Xem');
    expect(html).toContain('Own terms: 75 days (org default: 45 days)');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
  });

  it('keeps vi and en customTerms strings in sync with zero em or en dashes', () => {
    expect(Object.keys(viMessages.paymentReminders.customTerms).sort()).toEqual(Object.keys(en.paymentReminders.customTerms).sort());
    for (const value of [...Object.values(viMessages.paymentReminders.customTerms), ...Object.values(en.paymentReminders.customTerms)]) {
      expect(value).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
