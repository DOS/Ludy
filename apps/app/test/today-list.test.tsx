// SPDX-License-Identifier: AGPL-3.0-only
// The "Hôm nay cần bạn" list on Home (#2383) as the member sees it: grouped by kind with flags first, one link per
// item to the screen where it is acted on, the states of DESIGN.md 5.3, and a title key the app does not know falling
// back to a general sentence. Rendered on the server with the query answered from a seeded cache and stub reads.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayItem } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('../src/lib/stream-hook.ts', () => ({ useStreamLive: () => false, pollEvery: () => false, SAFETY_POLL_MS: 300_000 }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: () => undefined } }),
  Link: ({ to, params, children, className }: { to: string; params: { slug: string }; children?: unknown; className?: string }) => (
    <a href={to.replace('$slug', params.slug)} className={className}>
      {children as never}
    </a>
  ),
}));
// The apps the org has: the accounting app by default; a test switches it off.
const modules = vi.hoisted(() => ({ installed: ['finance'] as string[] }));
vi.mock('../src/lib/org-modules.ts', () => ({ installedModules: () => modules.installed, useModulesVersion: () => 0 }));

const { TodayList } = await import('../src/components/today-list.tsx');
const { briefDay, briefStorageKey, listFingerprint } = await import('../src/lib/today-brief.ts');

// The coworkers' names as the list answer carries them (the roster's, until an org renames one).
const NAMES = { gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' };
const base = { app: 'finance', title: { key: 'finance.unknown' }, href: '/inbox' };
const ITEMS = [
  { ...base, kind: 'deadline', id: 'd1', title: { key: 'tax.vat' }, dueAt: '2026-11-20T00:00:00+07:00', href: '/vat' },
  { ...base, kind: 'proposal', id: 'p1', count: 3, amount: '12500000', title: { key: 'finance.byVendor', params: { vendor: 'Phú Thịnh' } } },
  { ...base, kind: 'flag', id: 'f1', severity: 'block', title: { key: 'finance.unbalanced' }, href: '/ledger?tab=checks' },
  { ...base, app: 'ads', kind: 'flag', id: 'f2', severity: 'warn', amount: '120', currency: 'USD', title: { key: 'ads.pace' }, href: '/o/acme/ads' },
];

function render(opts: { data?: unknown; error?: boolean; locale?: 'en' | 'vi'; brief?: unknown } = {}): string {
  const qc = client.current;
  qc.clear();
  const key = ['today', 'list'];
  if (opts.data !== undefined) qc.setQueryData(key, opts.data);
  if (opts.brief !== undefined) {
    // Vy's brief is cached by day, language and the list it was written from; seed both languages.
    const items = (opts.data as { items: TodayItem[] }).items;
    for (const language of ['vi', 'en']) qc.setQueryData(['today', 'brief', briefStorageKey('acme', briefDay(), language, listFingerprint(items))], opts.brief);
  }
  if (opts.error) void qc.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error('boom')), retry: false }).catch(() => undefined);
  const locale = opts.locale ?? 'en';
  const messages = structuredClone(catalog(locale)) as unknown as { today: { items: Record<string, unknown> } };
  // Two lines' keys, as a line adds them to the catalog with its read.
  messages.today.items = {
    finance: { byVendor: locale === 'en' ? '{vendor}: proposals waiting' : '{vendor}: đề xuất chờ duyệt', unbalanced: locale === 'en' ? 'A voucher does not balance' : 'Có chứng từ lệch' },
    ads: { pace: locale === 'en' ? 'Ad spend is running ahead' : 'Chi quảng cáo đang vượt tiến độ' },
    tax: { vat: locale === 'en' ? 'VAT return due' : 'Hạn tờ khai GTGT' },
  };
  // useFormat() follows the app's active locale: pinned, so the amount reads in the rendered language on every runtime
  // (navigator.languages is the machine's on Node and empty on Bun).
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <IntlProvider locale={locale} messages={messages as never}>
          <TodayList slug="acme" />
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  client.current.clear();
  modules.installed = ['finance'];
});

describe('TodayList', () => {
  it('groups by kind with flags first, one link per item to the screen that handles it', () => {
    const html = render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 } });
    const headings = [...html.matchAll(/<h3[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(headings).toEqual(['Warnings', 'Waiting for your approval', 'Coming up']);
    const links = [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
    // Inside a group, the more severe flag first; paths gain the org, and a path that names it is kept.
    expect(links).toEqual(['/o/acme/ledger?tab=checks', '/o/acme/ads', '/o/acme/inbox', '/o/acme/vat']);
    expect(html).toContain('A voucher does not balance');
    expect(html).toContain('Phú Thịnh: proposals waiting');
    expect(html).toContain('VAT return due');
  });

  it('shows the count, the amount in its own currency, the due date and the severity as words', () => {
    const html = render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 } });
    expect(html).toContain('3 items');
    expect(html).toContain('Blocking');
    expect(html).toContain('Needs a look');
    expect(html).toMatch(/\$120|USD/);
    expect(html).toContain('Due ');
    // The heading counts what the items group: 1 + 1 flags, 3 proposals, 1 deadline.
    expect(html).toMatch(/Waiting for your approval<span[^>]*>3</);
  });

  it('says it in Vietnamese', () => {
    const html = render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 }, locale: 'vi' });
    expect(html).toContain(viMessages.today.title);
    expect(html).toContain('Cảnh báo');
    expect(html).toContain('Đang chặn');
    expect(html).toContain('Phú Thịnh: đề xuất chờ duyệt');
  });

  it('shows the general manager’s brief above the list, marked as written by it', () => {
    const brief = { writtenBy: 'vy', sentences: ['Hôm nay có 4 việc cần bạn.', 'Hạn gần nhất là 20/11/2026.'], budgetSpent: false, final: true };
    const html = render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 }, brief });
    expect(html).toContain('data-testid="today-brief"');
    expect(html).toContain('Hôm nay có 4 việc cần bạn. Hạn gần nhất là 20/11/2026.');
    expect(html).toContain(catalog('en').today.brief.aiBadge);
    expect(html).toContain(catalog('en').today.brief.byVy);
    expect(html.indexOf('data-testid="today-brief"')).toBeLessThan(html.indexOf('<h3', html.indexOf('data-testid="today-brief"') + 1));
  });

  it('says a template brief is automatic, with no AI mark', () => {
    const html = render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 }, brief: { writtenBy: 'template', sentences: ['Hôm nay có 4 việc cần bạn.'], budgetSpent: false, final: true } });
    expect(html).toContain(catalog('en').today.brief.byTemplate);
    expect(html).not.toContain(catalog('en').today.brief.aiBadge);
  });

  it('shows the list alone when there is no brief (the month’s AI budget is spent), and a quiet placeholder while it loads', () => {
    const spent = render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 }, brief: { writtenBy: null, sentences: [], budgetSpent: true, final: false } });
    expect(spent).not.toContain('data-testid="today-brief"');
    expect(spent).toContain('A voucher does not balance');
    const loading = render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 } });
    expect(loading).toContain(catalog('en').today.brief.loading);
    expect(loading).toContain('A voucher does not balance');
  });

  // Vy plan C1a (#3265): who raised each item, by the name the org gave the coworker now.
  const ROWS = (['ads', 'conversations', 'crm', 'finance', 'notes', 'social'] as const).map((app) => ({ ...base, app, kind: 'proposal', id: app, title: { key: 'finance.unbalanced' } }));
  const labels = (html: string) => [...html.matchAll(/data-testid="today-coworker">([^<]*)</g)].map((m) => m[1]);
  // Home lists five rows before "Xem tất cả" (#3591), so the six apps are read in two halves; the rows keep the list's order (same kind and
  // severity: by app, then id), which ROWS already is.
  const allLabels = (coworkers: typeof NAMES, locale?: 'en' | 'vi') =>
    [ROWS.slice(0, 3), ROWS.slice(3)].flatMap((items) => labels(render({ data: { items, coworkers, dropped: 0 }, ...(locale ? { locale } : {}) })));

  it('names the coworker on each item: Ly for finance, Dy for CRM and conversations, Uy for Social and Ads, Vy for the rest', () => {
    expect(allLabels(NAMES)).toEqual(['From Uy', 'From Dy', 'From Dy', 'From Ly', 'From Vy', 'From Uy']);
  });

  it('shows a renamed coworker under its new name, and only on the items of its apps', () => {
    expect(allLabels({ gm: 'Vy', finance: 'Lan', sales: 'Dy', marketing: 'Uy' })).toEqual(['From Uy', 'From Dy', 'From Dy', 'From Lan', 'From Vy', 'From Uy']);
    expect(allLabels({ gm: 'Vy', finance: 'Ly', sales: 'Minh', marketing: 'Uy' })).toEqual(['From Uy', 'From Minh', 'From Minh', 'From Ly', 'From Vy', 'From Uy']);
  });

  it('names the coworker in Vietnamese too', () => {
    expect(allLabels(NAMES, 'vi')).toEqual(['Từ Uy', 'Từ Dy', 'Từ Dy', 'Từ Ly', 'Từ Vy', 'Từ Uy']);
  });

  it('says Vy on the summary line, written by the model or built from the figures, and her new name once renamed', () => {
    const briefLabel = (html: string) => html.match(/data-testid="today-brief-coworker">([^<]*)</)?.[1];
    for (const writtenBy of ['vy', 'template']) {
      const brief = { writtenBy, sentences: ['Hôm nay có 4 việc cần bạn.'], budgetSpent: false, final: true };
      expect(briefLabel(render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 }, brief })), writtenBy).toBe('From Vy');
      expect(briefLabel(render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 }, brief, locale: 'vi' })), writtenBy).toBe('Từ Vy');
      expect(briefLabel(render({ data: { items: ITEMS, coworkers: { ...NAMES, gm: 'Bảo' }, dropped: 0 }, brief })), writtenBy).toBe('From Bảo');
    }
  });

  it('never calls a coworker an assistant on Home, in either language', () => {
    for (const locale of ['en', 'vi'] as const) {
      const html = render({ data: { items: ROWS, coworkers: NAMES, dropped: 0 }, locale, brief: { writtenBy: 'vy', sentences: ['Hôm nay có 6 việc cần bạn.'], budgetSpent: false, final: true } });
      expect(html, locale).not.toMatch(/assistant|trợ lý/i);
      expect(JSON.stringify(catalog(locale).today), locale).not.toMatch(/assistant|trợ lý/i);
    }
  });

  it('falls back to the kind’s sentence for a title key the catalog does not have', () => {
    const html = render({ data: { items: [{ ...base, kind: 'message', id: 'm1', title: { key: 'conversations.never.added' }, app: 'conversations' }], coworkers: NAMES, dropped: 0 } });
    expect(html).toContain(en.today.fallback.message);
  });

  it('falls back for a key that names a group of messages, or a message whose parameters are missing', () => {
    const html = render({
      data: {
        items: [
          { ...base, kind: 'flag', id: 'g', title: { key: 'finance' } },
          { ...base, kind: 'proposal', id: 'x', title: { key: 'finance.byVendor' } },
          { ...base, kind: 'message', id: 'p', title: { key: 'constructor' }, app: 'conversations' },
        ],
        coworkers: NAMES,
        dropped: 0,
      },
    });
    expect(html).toContain(en.today.fallback.flag);
    expect(html).toContain(en.today.fallback.proposal);
    expect(html).toContain(en.today.fallback.message);
    expect(html).not.toContain('today.items');
  });

  // #3591: seven pending invoices of two vendors that all carry a warning, as finance.today answers them.
  const SEVEN = [
    { ...base, id: 'proposals:a', count: 4, kind: 'proposal', title: { key: 'finance.byVendor', params: { vendor: 'Phú Thịnh' } } },
    { ...base, id: 'proposals:b', count: 3, kind: 'proposal', title: { key: 'finance.byVendor', params: { vendor: 'An Phát' } } },
    { ...base, id: 'checks-warn:e', kind: 'flag', severity: 'warn', count: 7, annotates: 'proposal', title: { key: 'finance.unbalanced' } },
  ];

  it('says seven for seven invoices with a warning: one group, one number beside the title, the warning as a chip', () => {
    const html = render({ data: { items: SEVEN, coworkers: NAMES, dropped: 0 } });
    expect([...html.matchAll(/<h3[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(['Waiting for your approval']);
    expect(html).toMatch(/data-testid="today-total"[^>]*>7</);
    expect(html).toMatch(/Waiting for your approval<span[^>]*>7</);
    expect(html).toMatch(/data-testid="today-chip"[^>]*>7 to look at</);
    // Two rows (the vendors), and the flag is not one of them.
    expect([...html.matchAll(/<li>/g)]).toHaveLength(2);
    expect(html).not.toContain('A voucher does not balance');
    // Vietnamese says the same count.
    expect(render({ data: { items: SEVEN, coworkers: NAMES, dropped: 0 }, locale: 'vi' })).toMatch(/data-testid="today-total"[^>]*>7</);
  });

  it('lists five rows and offers the rest behind "Show all"', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...base, id: `p${i}`, kind: 'proposal', title: { key: 'finance.byVendor', params: { vendor: `V${i}` } } }));
    const html = render({ data: { items: many, coworkers: NAMES, dropped: 0 } });
    expect([...html.matchAll(/<li>/g)]).toHaveLength(5);
    expect(html).toMatch(/data-testid="today-toggle"[^>]*>Show all \(8\)</);
    // The heading still counts all eight: hiding rows does not change the count.
    expect(html).toMatch(/Waiting for your approval<span[^>]*>8</);
    // Five or fewer: no button.
    expect(render({ data: { items: many.slice(0, 5), coworkers: NAMES, dropped: 0 } })).not.toContain('today-toggle');
  });

  it('shows the empty state when no line has anything, and a skeleton while it loads', () => {
    expect(render({ data: { items: [], coworkers: NAMES, dropped: 0 } })).toContain(en.today.empty);
    const loading = render();
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain(en.today.empty);
  });

  // #3596: a new owner with nothing waiting is pointed to the quick guide, in either language, where the accounting app is on.
  it('links the quick guide from the empty state when the accounting app is on', () => {
    const empty = { data: { items: [], coworkers: NAMES, dropped: 0 } };
    expect(render(empty)).toContain(`<a href="/o/acme/guide" class="text-sm text-link hover:underline">${en.today.guideLink}</a>`);
    expect(render({ ...empty, locale: 'vi' })).toContain(`href="/o/acme/guide"`);
    expect(render({ ...empty, locale: 'vi' })).toContain(viMessages.today.guideLink);
    modules.installed = ['notes'];
    expect(render(empty)).not.toContain('/guide');
    // A list with something in it has no empty state, so no guide link.
    modules.installed = ['finance'];
    expect(render({ data: { items: ITEMS, coworkers: NAMES, dropped: 0 } })).not.toContain('/guide');
  });

  it('keeps its heading as the label of the section', () => {
    const html = render({ data: { items: [], coworkers: NAMES, dropped: 0 } });
    expect(html).toContain('aria-labelledby="overview-today"');
    expect(html).toContain('id="overview-today"');
  });
});
