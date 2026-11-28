// SPDX-License-Identifier: AGPL-3.0-only
// The year-end checklist card on the Kế toán screen (#5283), rendered on the server with the answers of finance.year_end and its note seeded in the cache, in Vietnamese and English: every item shows its
// fixed text, a link opens the screen where a person does it (44 px high), each return shows its due date (from the answer, never from the note) with its legal basis, an item that waits for the year to end
// says so, the finance coworker's note and order appear only when the answer is `used` (with AI off, busy, over budget, refused or quiet the same checklist shows in its fixed order with no note and no gap),
// and the coworker is named through the roster.
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { YearEnd, YearEndItem, YearEndKey, YearEndNote } from '@ludy/kernel-contract';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')), retryOnMount: false });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: cache.current, errorMessage: String };
});
vi.mock('../src/components/entity-switcher.tsx', () => ({ useChosenEntity: () => ({ ready: true, legalEntityId: null }) }));
vi.mock('../src/lib/stream-hook.ts', () => ({ useStreamLive: () => false, pollEvery: () => false, SAFETY_POLL_MS: 60_000 }));

const { YearEndCard } = await import('../src/components/year-end-card.tsx');
const { catalog, setActiveLocale } = await import('../src/i18n/runtime.ts');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { COWORKERS } = await import('../src/i18n/brand.ts');
const { formatDate } = await import('../src/lib/format.ts');

// 10 January 2027: the year to close is 2026, and it has ended.
const TODAY = new Date(2027, 0, 10);
const item = (key: YearEndKey, state: YearEndItem['state'], over: Partial<YearEndItem> = {}): YearEndItem => ({ key, state, waiting: false, count: state === 'open' ? 1 : 0, due: null, ...over });
const CHECKLIST: YearEnd = {
  year: 2026,
  legalEntityId: '0190a000-0000-7000-8000-000000000001',
  over: true,
  items: [
    item('balances', 'open', { count: 4 }),
    item('depreciation', 'open', { count: 17 }),
    item('stock_count', 'done'),
    item('closing_entry', 'open'),
    item('months_locked', 'open'),
    item('statements', 'open', { due: '2027-03-31' }),
    item('cit', 'open', { due: '2027-03-31' }),
    item('pit', 'na'),
    item('household_return', 'na'),
    item('einvoice_series', 'open'),
  ],
};
const READY = 'balances,depreciation,closing_entry,months_locked,statements,cit,einvoice_series';
const NOTE: YearEndNote = { ai: 'used', text: 'Make the closing entry first, because the lock and the returns come after it.', order: ['closing_entry', 'balances', 'depreciation', 'months_locked', 'statements', 'cit', 'einvoice_series'] };
const NONE = (ai: YearEndNote['ai']): YearEndNote => ({ ai, text: null, order: [] });

async function render(checklist: YearEnd | null, note: YearEndNote | null, locale: 'vi' | 'en', open = READY): Promise<string> {
  cache.current.clear();
  setActiveLocale(locale);
  if (checklist) cache.current.setQueryData(['financeYearEnd', 'get'], checklist, { updatedAt: 1000 });
  // The note is asked again whenever the set of items to do now changes, so its key carries that set.
  if (note && checklist) cache.current.setQueryData(['financeYearEnd', 'explain', open], note);
  const root = createRootRoute({
    component: () => (
      <I18nProvider>
        <QueryClientProvider client={cache.current}>
          <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
            <YearEndCard slug="demo" today={TODAY} />
          </IntlProvider>
        </QueryClientProvider>
      </I18nProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

const rowKeys = (html: string) => [...html.matchAll(/data-testid="year-end-item-([a-z_]+)"/g)].map((m) => m[1]);
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => (m[1] as string).replaceAll('&amp;', '&'));

beforeEach(() => cache.current?.clear());

describe('the year-end checklist card', () => {
  it('shows every item with its fixed text, the ones to do now first in the fixed order, then the done and the not applicable ones', async () => {
    const html = await render(CHECKLIST, NONE('off'), 'en');
    expect(rowKeys(html)).toEqual(['balances', 'depreciation', 'closing_entry', 'months_locked', 'statements', 'cit', 'einvoice_series', 'stock_count', 'pit', 'household_return']);
    expect(html).toContain('4 balances to look at at the year end');
    expect(html).toContain('17 asset months are not depreciated or allocated yet');
    expect(html).toContain('The year-closing entry is not made');
    expect(html).toContain('The period lock does not cover the whole year');
    expect(html).toContain('The annual financial statements are not marked as filed');
    expect(html).toContain('No e-invoice series is added for the new year');
    expect(html).toContain('A stock count in December is confirmed');
    expect(html).toContain('Not on this entity tax calendar');
    for (const [key, n] of [['balances', 4], ['depreciation', 17]] as const) expect(html).toMatch(new RegExp(`data-testid="year-end-count-${key}"[^>]*>${n}<`));
    // Eight items apply (two do not), seven of them are open.
    expect(html).toContain('7 of 8 items are still open.');
    // The picker opens on the year before today's, since it is not yet October.
    expect(html).toMatch(/<option[^>]*value="2026"[^>]*selected|selected[^>]*value="2026"/);
    expect(html).not.toContain('data-testid="year-end-waiting-note"');
  });

  it('shows the same checklist in Vietnamese with full diacritics', async () => {
    const html = await render(CHECKLIST, NONE('off'), 'vi');
    expect(html).toContain('Kết thúc năm');
    expect(html).toContain('4 số dư cần xem lại cuối năm');
    expect(html).toContain('Chưa lập bút toán kết chuyển cuối năm');
    expect(html).toContain('Khóa sổ chưa phủ hết năm');
    expect(html).toContain('7 trên 8 mục còn mở.');
    expect(html).toContain('Năm 2026');
  });

  it('shows the due date of a return from the answer, with its legal basis, and none for the other items', async () => {
    const html = await render(CHECKLIST, NONE('off'), 'en');
    expect(html).toContain(`Due ${formatDate('2027-03-31', 'en')}`);
    expect(html.match(/data-testid="year-end-due-/g)).toHaveLength(2);
    expect(html).toContain('Annual financial statements: 90 days after the year ends (Law on Accounting, Art. 29(3))');
    expect(html).toContain('Annual corporate income tax finalization: the last day of the third month after the year (Decree 252/2026/NĐ-CP, Art. 10(5)(a))');
    expect(html).toContain('data-testid="year-end-due-hint"');
    // Once a return is done its date is not shown.
    const done = await render({ ...CHECKLIST, items: [item('statements', 'done', { due: '2027-03-31' })] }, NONE('off'), 'en', '');
    expect(done).not.toContain('year-end-due-');
    expect(done).not.toContain('year-end-due-hint');
    // The household's fourth quarter.
    const household = await render({ ...CHECKLIST, items: [item('household_return', 'open', { due: '2027-02-01' })] }, NONE('off'), 'vi', 'household_return');
    expect(household).toContain(`Hạn ${formatDate('2027-02-01', 'vi')}`);
    expect(household).toContain('Tờ khai 01/CNKD quý bốn của hộ kinh doanh');
  });

  it('links each open item to the screen where a person does it, and a done or not applicable item to nothing', async () => {
    const html = await render(CHECKLIST, NONE('off'), 'en');
    expect(hrefs(html)).toEqual(['/o/demo/ledger', '/o/demo/fixed-assets', '/o/demo/ledger', '/o/demo/ledger', '/o/demo/overview', '/o/demo/overview', '/o/demo/settings/connections']);
    const more = await render({ ...CHECKLIST, items: [item('stock_count', 'open'), item('household_return', 'open', { due: '2027-02-01' })] }, NONE('off'), 'en', 'stock_count,household_return');
    expect(hrefs(more)).toEqual(['/o/demo/stock', '/o/demo/household']);
  });

  it('makes every link, the status cell, the year picker and the retry 44 px high', async () => {
    const html = await render(CHECKLIST, NONE('off'), 'en');
    const links = [...html.matchAll(/<a [^>]*class="([^"]*)"/g)].map((m) => m[1] as string);
    expect(links).toHaveLength(7);
    for (const cls of links) expect(cls).toContain('min-h-11');
    expect(html).toMatch(/class="[^"]*\[&amp;_select\]:min-h-11[^"]*"[^>]*data-slot="native-select-wrapper"/);
    expect(html.match(/inline-flex min-h-11 min-w-20/g)).toHaveLength(10);
  });

  it('says "not yet" for an item that waits for the year to end, and does not offer it to the coworker', async () => {
    const running: YearEnd = {
      ...CHECKLIST,
      over: false,
      items: [item('balances', 'done'), item('depreciation', 'open', { waiting: true, count: 0 }), item('closing_entry', 'open', { waiting: true }), item('statements', 'open', { waiting: true, due: '2027-03-31' })],
    };
    const html = await render(running, NONE('quiet'), 'en', '');
    expect(html).toContain('data-testid="year-end-waiting-note"');
    expect(html).toContain('The year has not ended yet.');
    expect(html).toMatch(/data-testid="year-end-item-closing_entry" data-state="waiting"/);
    expect(html).toContain('The last month of the year is not depreciated or allocated yet; it can be once it ends');
    expect(html).toContain('The year-closing entry can be made once the year has ended');
    // A due date is still shown, so a person sees what comes.
    expect(html).toContain(`Due ${formatDate('2027-03-31', 'en')}`);
    expect(html).not.toContain('year-end-note');
  });

  it('shows a retry button 44 px high when the checklist cannot be read', async () => {
    cache.current.clear();
    cache.current
      .getQueryCache()
      .build(cache.current, { queryKey: ['financeYearEnd', 'get'] })
      .setState({ status: 'error', error: new Error('boom'), data: undefined, dataUpdatedAt: 0, errorUpdatedAt: 1, errorUpdateCount: 1, fetchFailureCount: 1, fetchFailureReason: null, fetchStatus: 'idle', isInvalidated: false });
    setActiveLocale('en');
    const root = createRootRoute({
      component: () => (
        <I18nProvider>
          <QueryClientProvider client={cache.current}>
            <IntlProvider locale="en" messages={catalog('en')} timeZone="Asia/Ho_Chi_Minh">
              <YearEndCard slug="demo" today={TODAY} />
            </IntlProvider>
          </QueryClientProvider>
        </I18nProvider>
      ),
    });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
    await router.load();
    const html = renderToString(<RouterProvider router={router} />);
    expect(html).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*>Try again<\/button>/);
    expect(rowKeys(html)).toEqual([]);
  });

  it('shows the coworker note and sorts the items to do now by its order, naming the coworker through the roster', async () => {
    const html = await render(CHECKLIST, NOTE, 'en');
    expect(html).toContain('data-testid="year-end-note"');
    expect(html).toContain('Make the closing entry first, because the lock and the returns come after it.');
    expect(html).toContain(`${COWORKERS.finance}, your AI coworker, suggests an order`);
    expect(html).not.toContain('{finance}');
    expect(rowKeys(html)).toEqual(['closing_entry', 'balances', 'depreciation', 'months_locked', 'statements', 'cit', 'einvoice_series', 'stock_count', 'pit', 'household_return']);
    const vi = await render(CHECKLIST, NOTE, 'vi');
    expect(vi).toContain(`Đồng nghiệp AI ${COWORKERS.finance} gợi ý thứ tự làm`);
    expect(vi).not.toContain('trợ lý');
  });

  it('ignores an order that is not exactly the items to do now, and shows no note, no notice and no gap when there is none', async () => {
    const wrong = await render(CHECKLIST, { ...NOTE, order: ['closing_entry', 'balances'] }, 'en');
    expect(rowKeys(wrong)).toEqual(['balances', 'depreciation', 'closing_entry', 'months_locked', 'statements', 'cit', 'einvoice_series', 'stock_count', 'pit', 'household_return']);
    const plain = await render(CHECKLIST, NONE('off'), 'en');
    for (const ai of ['off', 'busy', 'budget', 'failed', 'quiet'] as const) {
      const html = await render(CHECKLIST, NONE(ai), 'en');
      expect(html).not.toContain('year-end-note');
      expect(html).toBe(plain);
    }
    expect(await render(CHECKLIST, null, 'en')).not.toContain('year-end-note');
  });

  it('never shows a date or a number from the note: the due dates and counts are the answer\'s', async () => {
    const html = await render(CHECKLIST, NOTE, 'en');
    const plain = await render(CHECKLIST, NONE('off'), 'en');
    // With the note the same due dates are shown as without it.
    expect(html.match(/data-testid="year-end-due-[a-z_]+"/g)).toEqual(plain.match(/data-testid="year-end-due-[a-z_]+"/g));
    expect(html).toContain(`Due ${formatDate('2027-03-31', 'en')}`);
  });

  it('keeps an always-mounted status line, empty until the answer comes, and says every item is done when none is open', async () => {
    const loading = await render(null, null, 'en');
    expect(loading).toMatch(/<p [^>]*role="status"[^>]*><\/p>/);
    expect(loading).toContain('aria-busy="true"');
    expect(rowKeys(loading)).toEqual([]);
    const done: YearEnd = { ...CHECKLIST, items: CHECKLIST.items.map((i) => ({ ...i, state: i.state === 'na' ? 'na' : 'done', count: 0 })) };
    const html = await render(done, NONE('quiet'), 'en', '');
    expect(html).toContain('Every item for this year is done.');
    expect(html).not.toContain('<a ');
  });
});
