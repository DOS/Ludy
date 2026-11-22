// SPDX-License-Identifier: AGPL-3.0-only
// The month-close checklist card on the Kế toán screen, rendered on the server with the answers of finance.month_close and its note seeded in the cache, in Vietnamese and English:
// every item shows its fixed text and its count, a link opens the screen where a person does it (44 px high), the finance coworker's note and order appear only when the answer is
// `used` (with AI off, busy, over budget, refused or quiet the same checklist shows in its fixed order with no note and no gap), and the coworker is named through the roster.
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonthClose, MonthCloseItem, MonthCloseKey, MonthCloseNote } from '@ludy/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: cache.current, errorMessage: String };
});
vi.mock('../src/components/entity-switcher.tsx', () => ({ useChosenEntity: () => ({ ready: true, legalEntityId: null }) }));
vi.mock('../src/lib/stream-hook.ts', () => ({ useStreamLive: () => false, pollEvery: () => false, SAFETY_POLL_MS: 60_000 }));

const { MonthCloseCard } = await import('../src/components/month-close-card.tsx');
const { catalog } = await import('../src/i18n/runtime.ts');
const { COWORKERS } = await import('../src/i18n/brand.ts');

const TODAY = new Date(2026, 10, 22);
const item = (key: MonthCloseKey, count: number, period: string | null = null): MonthCloseItem => ({ key, count, period });
const CHECKLIST: MonthClose = {
  month: '2026-10',
  legalEntityId: '0190a000-0000-7000-8000-000000000001',
  items: [item('proposals', 4), item('invoices', 2, '2026-10'), item('bank', 17), item('marketplace', 0), item('stock', 1), item('vat', 1, '2026-10'), item('lock', 1)],
};
const NOTE: MonthCloseNote = { ai: 'used', text: 'Lock the period last, because it stops further changes.', order: ['lock', 'bank', 'proposals', 'invoices', 'stock', 'vat'] };
const NONE = (ai: MonthCloseNote['ai']): MonthCloseNote => ({ ai, text: null, order: [] });

async function render(checklist: MonthClose | null, note: MonthCloseNote | null, locale: 'vi' | 'en', updatedAt = 1000): Promise<string> {
  cache.current.clear();
  if (checklist) cache.current.setQueryData(['financeMonthClose', 'get'], checklist, { updatedAt: updatedAt });
  // The note is asked again whenever the set of open items changes, so its key carries that set (and not the time they were read: a poll that finds the same items keeps the note).
  if (note && checklist) cache.current.setQueryData(['financeMonthClose', 'explain', checklist.items.filter((i) => i.count > 0).map((i) => i.key).join(',')], note);
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={cache.current}>
        <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
          <MonthCloseCard slug="demo" today={TODAY} />
        </IntlProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

const rowKeys = (html: string) => [...html.matchAll(/data-testid="month-close-item-([a-z]+)"/g)].map((m) => m[1]);
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => (m[1] as string).replaceAll('&amp;', '&'));

beforeEach(() => cache.current?.clear());

describe('the month-close checklist card', () => {
  it('shows every item with its fixed text and count, open ones first in the fixed order, and the done one last', async () => {
    const html = await render(CHECKLIST, NONE('off'), 'en');
    expect(rowKeys(html)).toEqual(['proposals', 'invoices', 'bank', 'stock', 'vat', 'lock', 'marketplace']);
    expect(html).toContain('4 proposals dated in this month are waiting for approval');
    expect(html).toContain('2 invoices on the tax portal list match no voucher');
    expect(html).toContain('17 bank statement lines are not booked yet');
    expect(html).toContain('The stock close of this month has not been run');
    expect(html).toContain('The VAT return of this period is not marked as filed');
    expect(html).toContain('The period lock does not cover this month');
    expect(html).toContain('Every marketplace settlement and payout of this month is recorded');
    for (const [key, n] of [['proposals', 4], ['invoices', 2], ['bank', 17]] as const) expect(html).toMatch(new RegExp(`data-testid="month-close-count-${key}"[^>]*>${n}<`));
    expect(html).toContain('6 of 7 items are still open.');
    // The month picker defaults to the month before today.
    expect(html).toMatch(/<option[^>]*value="2026-10"[^>]*selected|selected[^>]*value="2026-10"/);
  });

  it('shows the same checklist in Vietnamese with full diacritics', async () => {
    const html = await render(CHECKLIST, NONE('off'), 'vi');
    expect(html).toContain('Chốt sổ tháng');
    expect(html).toContain('4 đề xuất ghi sổ có ngày trong tháng này đang chờ duyệt');
    expect(html).toContain('17 dòng sao kê ngân hàng chưa hạch toán');
    expect(html).toContain('Khóa sổ chưa bao phủ tháng này');
    expect(html).toContain('6 trên 7 mục còn mở.');
    expect(html).toContain('Tháng 10/2026');
  });

  it('links each open item to the screen where a person does it, and a done item to nothing', async () => {
    const html = await render(CHECKLIST, NONE('off'), 'en');
    expect(hrefs(html)).toEqual([
      '/o/demo/inbox?status=pending',
      '/o/demo/portal-invoices?period=2026-10',
      '/o/demo/bank?month=2026-10',
      '/o/demo/stock',
      '/o/demo/vat?period=2026-10',
      '/o/demo/ledger',
    ]);
    expect(await render({ ...CHECKLIST, items: [item('vat', 1, '2026-Q4')] }, NONE('off'), 'en')).toContain('href="/o/demo/vat?period=2026-Q4"');
  });

  it('makes every link, the status cell, the month picker and the retry 44 px high', async () => {
    const html = await render(CHECKLIST, NONE('off'), 'en');
    const links = [...html.matchAll(/<a [^>]*class="([^"]*)"/g)].map((m) => m[1] as string);
    expect(links).toHaveLength(6);
    for (const cls of links) expect(cls).toContain('min-h-11');
    // The select is the wrapper's child: the wrapper carries the rule that makes it 44 px.
    expect(html).toMatch(/class="[^"]*\[&amp;_select\]:min-h-11[^"]*"[^>]*data-slot="native-select-wrapper"/);
    expect(html.match(/inline-flex min-h-11 min-w-16/g)).toHaveLength(7);
  });

  it('shows the coworker note and sorts the open items by its order, naming the coworker through the roster', async () => {
    const html = await render(CHECKLIST, NOTE, 'en');
    expect(html).toContain('data-testid="month-close-note"');
    expect(html).toContain('Lock the period last, because it stops further changes.');
    expect(html).toContain(`${COWORKERS.finance}, your AI coworker, suggests an order`);
    expect(html).not.toContain('{finance}');
    expect(rowKeys(html)).toEqual(['lock', 'bank', 'proposals', 'invoices', 'stock', 'vat', 'marketplace']);
    const vi = await render(CHECKLIST, NOTE, 'vi');
    expect(vi).toContain(`Đồng nghiệp AI ${COWORKERS.finance} gợi ý thứ tự làm`);
    expect(vi).not.toContain('trợ lý');
  });

  it('keeps the note across a poll that finds the same open items, whatever time they were read', async () => {
    const first = await render(CHECKLIST, NOTE, 'en', 1000);
    const later = await render(CHECKLIST, NOTE, 'en', 90_000);
    expect(later).toBe(first);
    expect(later).toContain('data-testid="month-close-note"');
    expect(rowKeys(later)[0]).toBe('lock');
  });

  it('keeps an always-mounted status line, empty until the answer comes', async () => {
    const loading = await render(null, null, 'en');
    expect(loading).toMatch(/<p [^>]*role="status"[^>]*><\/p>/);
  });

  it('ignores an order that is not exactly the open items, and shows no note, no notice and no gap when there is none', async () => {
    const wrong = await render(CHECKLIST, { ...NOTE, order: ['lock', 'bank'] }, 'en');
    expect(rowKeys(wrong)).toEqual(['proposals', 'invoices', 'bank', 'stock', 'vat', 'lock', 'marketplace']);
    const plain = await render(CHECKLIST, NONE('off'), 'en');
    for (const ai of ['off', 'busy', 'budget', 'failed', 'quiet'] as const) {
      const html = await render(CHECKLIST, NONE(ai), 'en');
      expect(html).not.toContain('month-close-note');
      expect(html).toBe(plain);
    }
    expect(await render(CHECKLIST, null, 'en')).not.toContain('month-close-note');
  });

  it('says every item is done when none is open, and shows a loading state before the answer', async () => {
    const done: MonthClose = { ...CHECKLIST, items: CHECKLIST.items.map((i) => ({ ...i, count: 0 })) };
    const html = await render(done, NONE('quiet'), 'en');
    expect(html).toContain('Every item for this month is done.');
    expect(html).not.toContain('<a ');
    const loading = await render(null, null, 'en');
    expect(loading).toContain('aria-busy="true"');
    expect(rowKeys(loading)).toEqual([]);
  });
});
