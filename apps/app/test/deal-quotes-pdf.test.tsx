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

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  Link: ({ children, ...rest }: { children?: unknown }) => <a {...(rest as object)}>{children as never}</a>,
}));

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

function render(canEdit: boolean, seed?: () => void): string {
  setActiveLocale('vi');
  seed?.();
  client.current.setQueryData(['crm', 'quotes', 'byDeal'], [summary(1, {}), summary(2, { number: 'BG-2026-0002', status: 'sent' })]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>
        <DealQuotes deal={deal} canEdit={canEdit} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// The row of a quote shows one primary action and a "⋯" menu (#3645); the menu's items (Tải PDF, the decline, the revision, delete a draft) are mounted when it opens, so
// the server render holds the primary actions and the menu buttons, and the e2e opens the menu.
const row = (html: string, n: number) => html.split('data-testid="quote-row"')[n] ?? '';

describe('the row of a deal\'s quotes (#2695, #3645)', () => {
  beforeEach(() => {
    client.current.clear();
    requested.length = 0;
  });

  it('has one primary action and a menu on every quote, and asks for nothing until the PDF is pressed', () => {
    const html = render(true);
    expect(html.split('data-testid="quote-row"').length - 1).toBe(2);
    // The draft: "Sửa". The sent quote: the customer's answer, "Ghi nhận khách đồng ý".
    expect(row(html, 1)).toContain('>Sửa<');
    expect(row(html, 1)).not.toContain('quote-accept-open');
    expect(row(html, 2)).toContain('>Ghi nhận khách đồng ý<');
    expect(row(html, 2)).toContain('data-testid="quote-accept-open"');
    // Every other action is behind the menu, named for its quote.
    expect(html.split('data-testid="quote-row-menu"').length - 1).toBe(2);
    expect(row(html, 2)).toContain('aria-label="Thêm thao tác cho BG-2026-0002"');
    for (const word of ['Tải PDF', 'Ghi nhận khách từ chối', 'Tạo bản sửa đổi', 'Xóa nháp', 'Khách đã đồng ý', 'Khách từ chối']) expect(html).not.toContain(word);
    expect(requested).toEqual([]);
  });

  it('gives a viewer, who can only read, "Xem" and the menu (the PDF), and no way to decide or edit', () => {
    const html = render(false);
    expect(row(html, 1)).toContain('>Xem<');
    expect(row(html, 2)).toContain('>Xem<');
    expect(html).not.toContain('quote-accept-open');
    expect(html.split('data-testid="quote-row-menu"').length - 1).toBe(2);
    expect(html).not.toContain('Ghi nhận khách đồng ý');
  });
});

describe('the letterhead hint of a deal\'s quotes (#3645)', () => {
  beforeEach(() => client.current.clear());
  const setting = (over: Record<string, unknown>) => ({ validDays: 30, defaultVat: '10%', defaultTerms: null, phone: null, email: null, bankNote: null, logoFileId: null, ...over });
  const seed = (role: string, over: Record<string, unknown>) => () => {
    client.current.setQueryData(['org', 'get'], { role });
    client.current.setQueryData(['crm', 'quotes', 'setting'], setting(over));
  };

  it('says there is no logo or contact on the quotes and links to the Settings card, for an owner, and holds no settings form', () => {
    const html = render(true, seed('owner', {}));
    expect(html).toContain('Chưa có logo và thông tin liên hệ trên báo giá.');
    expect(html).toContain('>Thiết lập<');
    expect(html).not.toContain('data-testid="quote-settings"');
    expect(html).not.toContain('Thông tin trên báo giá');
  });

  it('is quiet once a logo, a phone or an email is set, and for a member, who does not set it', () => {
    expect(render(true, seed('owner', { phone: '0901 234 567' }))).not.toContain('quote-letterhead-hint');
    expect(render(true, seed('member', {}))).not.toContain('quote-letterhead-hint');
  });
});
