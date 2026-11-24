// SPDX-License-Identifier: AGPL-3.0-only
// OverviewPage integration tests (#4644): Row 1 unified TodayList + TodayBrief hero card, Row 2 merged Waiting +
// SinceYesterday strip (hidden when empty), Row 3 side-by-side TaxCalendar + TodayWeekly at lg, Row 4 quiet
// app status links (zero duplicate tall cards), compact SalesNumberGaps, and 3-step Day-1 SME quick-start card.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import type { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SinceYesterday, TodayItem, TodayWeekly as Weekly, zOrgOverview } from '@ludy/kernel-contract';

type OrgOverview = z.infer<typeof zOrgOverview>;
import { I18nProvider } from '../src/i18n/provider.tsx';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';
import { briefDay, briefStorageKey, listFingerprint } from '../src/lib/today-brief.ts';
import { weeklyCacheKey } from '../src/lib/today-weekly.ts';

const state = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['kernel', 'finance', 'notes', 'projects', 'meetings', 'social', 'crm', 'ads', 'hr', 'sign'] as string[],
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.client = new QC({ defaultOptions: { queries: { retry: false } } });
  const keyFor = (path: string[], opts?: { input?: Record<string, unknown> }) => {
    const joined = path.join('.');
    if (joined === 'notes.list' && opts?.input?.view) return [...path, opts.input.view];
    return path;
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: Record<string, unknown> }) => ({
            queryKey: keyFor(path, opts),
            queryFn: () => Promise.reject(new Error('not fetched in SSR test')),
          });
        }
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {},
    queryClient: state.client,
    errorMessage: (e: unknown) => String(e),
    takeOrgLeftNotice: () => null,
  };
});

vi.mock('../src/lib/stream-hook.ts', () => ({ useStreamLive: () => false, pollEvery: () => false, SAFETY_POLL_MS: 300_000 }));
vi.mock('../src/lib/org-modules.ts', () => ({ installedModules: () => state.modules, useModulesVersion: () => 0 }));
vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: state.modules, mcpEnabled: false }),
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  useLocation: () => ({ pathname: '/o/acme/overview' }),
  useRouter: () => ({ history: { push: () => undefined } }),
  Link: ({
    to,
    params,
    hash,
    children,
    ...rest
  }: {
    to: string;
    params?: { slug?: string };
    hash?: string;
    children?: ReactNode;
  } & Record<string, unknown>) => {
    const href = `${to.replace('$slug', params?.slug ?? 'acme')}${hash ? `#${hash}` : ''}`;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

const { OverviewPage } = await import('../src/routes/overview.tsx');

// 2026-11-23 is a Monday in Vietnam time, so TodayWeekly shows automatically.
const MONDAY = new Date('2026-11-23T03:00:00Z');
const COWORKERS = { gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' };

const TODAY_ITEMS: TodayItem[] = [
  {
    app: 'finance',
    kind: 'proposal',
    id: 'p1',
    count: 2,
    amount: '32832000',
    title: { key: 'finance.byVendor', params: { vendor: 'Phú Thịnh' } },
    href: '/inbox',
  },
];

const ACTIVE_OVERVIEW: OrgOverview = {
  pendingProposals: 2,
  failedFiles: 1,
  lastActivityAt: '2026-11-23T02:15:00Z',
  vatFilingPeriod: 'month',
  vatDeadline: { period: '2026-10', dueDate: '2026-11-20', daysLeft: 4 },
  taxDues: [
    {
      obligation: 'vat_return',
      period: '2026-10',
      dueDate: '2026-11-20',
      daysLeft: 4,
      legalBasis: 'Nghị định 126/2020/NĐ-CP',
      confirmed: false,
      openEntities: [{ id: 'ent-1', name: 'Công ty Mẫu', canMark: true }],
    },
  ],
  modules: {},
};

const EMPTY_OVERVIEW: OrgOverview = {
  pendingProposals: 0,
  failedFiles: 0,
  lastActivityAt: null,
  vatFilingPeriod: null,
  vatDeadline: null,
  taxDues: [],
  modules: {},
};

const SINCE: SinceYesterday = {
  items: [{ agentId: '0190c1c0-0000-7000-8000-000000000001', name: 'Ly', count: 4, href: '/inbox' }],
};

const WEEKLY: Weekly = {
  figures: {
    from: '2026-11-16',
    to: '2026-11-22',
    before: '2026-11-15',
    deals: { won: { count: 2, amount: '45000000' }, open: 5 },
    money: {
      cash: { amount: '120000000', previous: '100000000' },
      receivables: { amount: '15000000', previous: '20000000' },
      payables: { amount: '5000000', previous: '5000000' },
    },
    tasks: { late: 1 },
  },
  writtenBy: 'vy',
  sentences: ['Tuần qua có 2 deal thắng.'],
  budgetSpent: false,
  final: true,
};

interface SeedOptions {
  locale?: 'vi' | 'en';
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  overview?: OrgOverview;
  todayItems?: TodayItem[];
  brief?: { writtenBy: 'vy' | 'template' | null; sentences: string[]; budgetSpent: boolean; final: boolean };
  unreadWork?: number;
  tasks?: Array<{ id: string }>;
  since?: SinceYesterday;
  weekly?: Weekly;
  posts?: Array<{ status: string }>;
  bookings?: Array<{ status: string }>;
  gaps?: {
    missingCount: number;
    groups: Array<{
      year: number;
      template: string | null;
      series: string;
      firstNumber: string;
      lastNumber: string;
      recorded: number;
      missingCount: number;
      ranges: Array<{ from: string; to: string }>;
      truncated: boolean;
    }>;
  };
}

function renderOverview(opts: SeedOptions = {}): string {
  vi.setSystemTime(MONDAY);
  const qc = state.client;
  qc.clear();
  const locale = opts.locale ?? 'vi';
  const role = opts.role ?? 'owner';
  const todayItems = opts.todayItems ?? [];

  qc.setQueryData(['me', 'get'], {
    userId: 'user-1',
    email: 'owner@example.com',
    orgs: [{ orgId: 'org-1', slug: 'acme', name: 'Gạo Sạch Mekong', role }],
  });
  qc.setQueryData(['org', 'overview'], opts.overview ?? EMPTY_OVERVIEW);
  qc.setQueryData(['notifications', 'list'], { items: [], unreadWork: opts.unreadWork ?? 0 });
  qc.setQueryData(['tasks', 'list'], opts.tasks ?? []);
  qc.setQueryData(['today', 'list'], { items: todayItems, coworkers: COWORKERS, dropped: 0, truncated: 0, failed: 0 });
  qc.setQueryData(['today', 'sinceYesterday'], opts.since ?? { items: [] });
  qc.setQueryData(['bookEntities', 'list'], [{ id: 'ent-1', name: 'Công ty Mẫu', isDefault: true }]);
  qc.setQueryData(['social', 'posts', 'list'], opts.posts ?? []);
  qc.setQueryData(['crm', 'bookings', 'list'], opts.bookings ?? []);
  qc.setQueryData(['vat', 'salesNumberGaps'], opts.gaps ?? { missingCount: 0, groups: [] });
  qc.setQueryData(['notes', 'list', 'pinned'], []);
  qc.setQueryData(['notes', 'list', 'shared'], []);

  if (opts.brief) {
    for (const lang of ['vi', 'en']) {
      qc.setQueryData(['today', 'brief', briefStorageKey('acme', briefDay(), lang, listFingerprint(todayItems))], opts.brief);
    }
  }
  if (opts.weekly) {
    qc.setQueryData(['today', 'weekly', weeklyCacheKey('acme', briefDay(), locale)], opts.weekly);
  }

  const messages = structuredClone(catalog(locale)) as unknown as { today: { items: Record<string, unknown> } };
  messages.today.items = {
    finance: { byVendor: locale === 'en' ? '{vendor}: proposals waiting' : '{vendor}: đề xuất chờ duyệt' },
  };

  setActiveLocale(locale);
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <IntlProvider locale={locale} messages={messages as never} timeZone="Asia/Ho_Chi_Minh">
          <OverviewPage />
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  state.client.clear();
  state.modules = ['kernel', 'finance', 'notes', 'projects', 'meetings', 'social', 'crm', 'ads', 'hr', 'sign'];
});
afterEach(() => vi.useRealTimers());

describe('OverviewPage layout compression and Day-1 SME quick-start (#4644)', () => {
  it('renders compressed Row 1-4 layout for an active SME org in vi and en', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = renderOverview({
        locale,
        overview: ACTIVE_OVERVIEW,
        todayItems: TODAY_ITEMS,
        brief: { writtenBy: 'vy', sentences: ['Hôm nay có 2 việc cần bạn.'], budgetSpent: false, final: true },
        unreadWork: 3,
        tasks: [{ id: 't1' }, { id: 't2' }],
        since: SINCE,
        weekly: WEEKLY,
        posts: [{ status: 'scheduled' }, { status: 'scheduled' }],
        bookings: [{ status: 'confirmed' }],
        gaps: {
          missingCount: 2,
          groups: [{ year: 2026, template: '1C26', series: 'TPT', firstNumber: '000001', lastNumber: '000010', recorded: 8, missingCount: 2, ranges: [{ from: '3', to: '4' }], truncated: false }],
        },
      });

      // Row 1: Unified hero card holding TodayList + TodayBrief, no Day-1 quickstart.
      expect(html).toContain('data-testid="today-hero-card"');
      expect(html).toContain('data-testid="today-brief-host"');
      expect(html).toContain('data-testid="today-brief"');
      expect(html).not.toContain('data-testid="overview-quickstart"');

      // Row 2: Merged Waiting + SinceYesterday strip with 44px phone targets.
      expect(html).toContain('data-testid="overview-operational-strip"');
      expect(html).toContain('data-testid="waiting-failedFiles"');
      expect(html).toContain('data-testid="waiting-notifications"');
      expect(html).toContain('data-testid="waiting-tasks"');
      expect(html).toContain('data-testid="since-yesterday-strip"');
      expect(html).not.toContain('id="overview-waiting"');
      expect(html).not.toContain('id="overview-since"');

      // Row 3: TaxCalendar and TodayWeekly side-by-side at lg, plus compact SalesNumberGaps.
      expect(html).toContain('data-testid="overview-row-3"');
      expect(html).toContain('lg:grid-cols-2');
      expect(html).toContain('id="overview-tax"');
      expect(html).toContain('data-testid="today-weekly"');
      expect(html).toContain('data-testid="sales-number-gaps-compact"');
      expect(html).toContain('1C26TPT: 3-4');

      // Row 4: Quiet compact app status links, zero tall duplicate [data-app-card] tiles.
      expect(html).toContain('data-testid="overview-apps-row"');
      expect(html).not.toContain('data-app-card=');
      expect(html).toContain('data-app-status="finance"');
      expect(html).toContain('data-app-status="engage"');
      expect(html).toContain('data-app-status="teamwork"');
      expect(html).toContain('max-md:min-h-11');

      if (locale === 'vi') {
        expect(html).toContain('4 ngày nữa hạn GTGT');
        expect(html).toContain('2 bài chờ đăng');
        expect(html).toContain('1 lịch hẹn');
        expect(html).toContain('Ly đã làm 4 việc cho bạn');
      } else {
        expect(html).toContain('4d until VAT');
        expect(html).toContain('2 posts scheduled');
        expect(html).toContain('1 booking');
        expect(html).toContain('Ly did 4 things for you');
      }
    }
  });

  it('hides Row 2 operational strip cleanly when waiting counts and SinceYesterday are empty', () => {
    const html = renderOverview({
      overview: { ...ACTIVE_OVERVIEW, failedFiles: 0 },
      todayItems: TODAY_ITEMS,
      brief: { writtenBy: null, sentences: [], budgetSpent: true, final: false },
      unreadWork: 0,
      tasks: [],
      since: { items: [] },
      weekly: { ...WEEKLY, writtenBy: 'template', budgetSpent: true, final: false },
    });

    expect(html).not.toContain('data-testid="overview-operational-strip"');
    expect(html).not.toContain('data-testid="since-yesterday-strip"');
    // AI-off fallback keeps TodayList queue visible and omits TodayBrief cleanly.
    expect(html).toContain('data-testid="today-hero-card"');
    expect(html).not.toContain('data-testid="today-brief"');
    expect(html).toContain('data-testid="today-weekly"');
  });

  it('renders 3-step Day-1 SME quick-start card when a new org has zero items or activity, and preserves E2E anchors', () => {
    const html = renderOverview({
      locale: 'vi',
      overview: EMPTY_OVERVIEW,
      todayItems: [],
      unreadWork: 0,
      tasks: [],
      since: { items: [] },
    });

    expect(html).toContain('data-testid="overview-quickstart"');
    expect(html).toContain('Bắt đầu nhanh trong 3 bước');
    expect(html).toContain(viMessages.today.empty);
    expect(html).toContain('data-testid="quickstart-step-uploadInvoice"');
    expect(html).toContain('data-testid="quickstart-step-configureApps"');
    expect(html).toContain('data-testid="quickstart-step-createNote"');
    expect(html).toContain('href="/o/acme/inbox"');
    expect(html).toContain('href="/o/acme/settings/apps"');
    expect(html).toContain('href="/o/acme/notes"');
    expect(html).toContain('href="/o/acme/guide"');
    expect(html).toContain('max-md:min-h-11');
    // Preserves TaxCalendar + quiet AppCards links expected by E2E.
    expect(html).toContain('Chưa chọn kỳ khai thuế');
    expect(html).toContain('Chọn kỳ khai');
    expect(html).not.toContain('data-testid="today-weekly"');
    expect(html).not.toContain('data-testid="today-weekly-ask"');
    expect(html).not.toContain('data-app-card=');
  });

  it('filters Day-1 quick-start steps strictly to enabled org modules and hides for viewers', () => {
    state.modules = ['kernel', 'social', 'crm', 'sign'];
    const noFinance = renderOverview({ locale: 'en', overview: EMPTY_OVERVIEW, todayItems: [] });
    expect(noFinance).toContain('data-testid="overview-quickstart"');
    expect(noFinance).toContain('data-testid="quickstart-step-connectChannel"');
    expect(noFinance).toContain('data-testid="quickstart-step-configureApps"');
    expect(noFinance).toContain('data-testid="quickstart-step-createEnvelope"');
    expect(noFinance).not.toContain('href="/o/acme/inbox"');
    expect(noFinance).not.toContain('href="/o/acme/guide"');
    // No Finance module: never offers broken #tax-profile settings link.
    expect(noFinance).not.toContain('#tax-profile');

    const viewer = renderOverview({ role: 'viewer', overview: EMPTY_OVERVIEW, todayItems: [] });
    expect(viewer).not.toContain('data-testid="overview-quickstart"');
    expect(viewer).toContain(viMessages.today.empty);
    expect(viewer).not.toContain(viMessages.overview.upload);

    // Members never receive admin-only channel-connect quick-start CTAs.
    state.modules = ['kernel', 'social'];
    const memberSocialOnly = renderOverview({ locale: 'en', role: 'member', overview: EMPTY_OVERVIEW, todayItems: [] });
    expect(memberSocialOnly).toContain('data-testid="quickstart-step-createTask"');
    expect(memberSocialOnly).not.toContain('data-testid="quickstart-step-connectChannel"');
    expect(memberSocialOnly).toContain('Quick start');
    expect(memberSocialOnly).not.toContain('Quick start in 1 steps');
  });

  it('does not mount TodayWeekly or PageHeader uploadAction before initial queries settle', () => {
    vi.setSystemTime(MONDAY);
    const qc = state.client;
    qc.clear();
    setActiveLocale('vi');
    const loadingHtml = renderToStaticMarkup(
      <I18nProvider>
        <QueryClientProvider client={qc}>
          <IntlProvider locale="vi" messages={catalog('vi') as never} timeZone="Asia/Ho_Chi_Minh">
            <OverviewPage />
          </IntlProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(loadingHtml).not.toContain('data-weekly-slot=""');
    expect(loadingHtml).not.toContain(viMessages.overview.upload);
    // Loading spinner inside AppCards link is wrapped aria-hidden so link accessible text stays clean.
    expect(loadingHtml).toMatch(/<span aria-hidden="true"><svg[^>]*data-slot="spinner"/);
  });

  it('replaces Day-1 quick-start with calm caught-up empty state once org activity exists', () => {
    const caughtUp = renderOverview({
      locale: 'vi',
      overview: { ...EMPTY_OVERVIEW, lastActivityAt: '2026-11-22T10:00:00Z' },
      todayItems: [],
      weekly: WEEKLY,
    });
    expect(caughtUp).not.toContain('data-testid="overview-quickstart"');
    expect(caughtUp).toContain(viMessages.today.empty);
    expect(caughtUp).toContain('data-testid="today-weekly"');
  });

  it('contains no em dashes, en dashes, or forbidden assistant copy in new overview/quickstart messages', () => {
    for (const [locale, catalogTree] of [
      ['vi', viMessages],
      ['en', en],
    ] as const) {
      const slice = JSON.stringify({ overview: catalogTree.overview, quickstart: catalogTree.today.quickstart });
      expect(slice, locale).not.toMatch(/[\u2013\u2014]/);
      expect(slice, locale).not.toMatch(/assistant|trợ lý/i);
    }
  });
});
