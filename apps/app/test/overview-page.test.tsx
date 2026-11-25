// SPDX-License-Identifier: AGPL-3.0-only
// OverviewPage integration & SSR tests (#4644, #4923 Phase 4 / #4928):
// - Anchored PageHeader with Tùy chỉnh toggle (zero Row 0 HomeActions), Hôm nay cần bạn + inline HomeVyBar,
//   Day-1 SME quick-start card, and compact operational strip.
// - Role x Enabled-App modular summary blocks in persisted order, empty collapse rules, all-hidden notice,
//   and HomeCustomizePanel (Switch, Move Up / Move Down, drag handle, polite live announcements, Reset, Save, Cancel).
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import type { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiMeter,
  ConversationCounted,
  HomeLayoutBlock,
  HomeLayoutView,
  SinceYesterday,
  TodayItem,
  TodayWeekly as Weekly,
  zOrgOverview,
} from '@ludy/kernel-contract';

type OrgOverview = z.infer<typeof zOrgOverview>;
import { I18nProvider } from '../src/i18n/provider.tsx';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';
import { buildFallbackHomeLayout } from '../src/lib/home-layout.ts';
import { briefDay, briefStorageKey, listFingerprint } from '../src/lib/today-brief.ts';
import { weeklyCacheKey } from '../src/lib/today-weekly.ts';

const state = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['kernel', 'finance', 'notes', 'projects', 'meetings', 'social', 'crm', 'ads', 'hr', 'sign'] as string[],
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.client = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const keyFor = (path: string[], opts?: { input?: Record<string, unknown> }) => {
    const joined = path.join('.');
    if (joined === 'notes.list' && opts?.input?.view) return [...path, opts.input.view];
    if (joined === 'sign.envelope.list' && opts?.input?.status) return [...path, opts.input.status];
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
    clientForOrg: () => ({}),
    getCurrentOrg: () => 'acme',
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
const { HomeCustomizePanel } = await import('../src/components/home-customize-panel.tsx');
const { HomeVyBar } = await import('../src/components/home-vy-bar.tsx');
const { VyDrawerBody } = await import('../src/components/vy-drawer.tsx');

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

const METER_READY: AiMeter = { aiOn: true, percent: 25, state: 'ok', scope: 'org', resetAt: '2026-12-01T00:00:00Z' };
const METER_OFF: AiMeter = { aiOn: false, percent: null, state: 'none', scope: null, resetAt: '2026-12-01T00:00:00Z' };
const METER_STOP: AiMeter = { aiOn: true, percent: 100, state: 'stop', scope: 'org', resetAt: '2026-12-01T00:00:00Z' };

const HR_LEAVE_PENDING_ITEM: TodayItem = {
  app: 'hr',
  kind: 'proposal',
  id: 'leave-approvals',
  count: 1,
  title: { key: 'hr.leaveApprovalsPending', params: { count: 1 } },
  href: '/hr/employees',
};

const ENVELOPE_WAITING = {
  id: 'env-1',
  title: 'Hợp đồng dịch vụ 2026',
  status: 'sent' as const,
  routingMode: 'parallel' as const,
  sourceKind: 'manual' as const,
  sourceId: null,
  sourceFileId: 'file-1',
  inspectStatus: 'done' as const,
  sealStatus: null,
  certificateCode: null,
  pageCount: 2,
  expiresAt: null,
  sentAt: '2026-11-23T01:00:00Z',
  completedAt: null,
  voidedAt: null,
  expiredAt: null,
  version: 1,
  createdBy: 'user-1',
  createdAt: '2026-11-23T01:00:00Z',
  updatedAt: '2026-11-23T01:00:00Z',
  signerSummary: { total: 2, signed: 0, waitingForMe: true },
};

// A recorded (approved) invoice of the org: the day-1 card goes away once one exists (#4783).
const APPROVED_DOC = { id: 'doc-1', voided: null };

interface SeedOptions {
  locale?: 'vi' | 'en';
  documents?: Array<{ id: string; voided: null | { reversalEntryId: string } }>;
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  permissions?: string[];
  omitOrgDetail?: boolean;
  aiMeter?: AiMeter | null;
  homeLayout?: HomeLayoutView;
  omitHomeLayout?: boolean;
  overview?: OrgOverview;
  todayItems?: TodayItem[];
  coworkers?: typeof COWORKERS;
  brief?: { writtenBy: 'vy' | 'template' | null; sentences: string[]; budgetSpent: boolean; final: boolean };
  unreadWork?: number;
  tasks?: Array<{ id: string }>;
  since?: SinceYesterday;
  weekly?: Weekly;
  posts?: Array<{ status: string }>;
  bookings?: Array<{ status: string }>;
  conversationsCounts?: ConversationCounted;
  envelopes?: Array<typeof ENVELOPE_WAITING>;
  sentEnvelopes?: Array<typeof ENVELOPE_WAITING>;
  inProgressEnvelopes?: Array<typeof ENVELOPE_WAITING>;
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

function renderWithProviders(locale: 'vi' | 'en', node: ReactNode): string {
  const qc = state.client;
  const messages = structuredClone(catalog(locale)) as unknown as { today: { items: Record<string, unknown> } };
  messages.today.items = {
    ...messages.today.items,
    finance: { byVendor: locale === 'en' ? '{vendor}: proposals waiting' : '{vendor}: đề xuất chờ duyệt' },
  };
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <IntlProvider locale={locale} messages={messages as never} timeZone="Asia/Ho_Chi_Minh">
          {node}
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function seedOverviewCache(opts: SeedOptions = {}): 'vi' | 'en' {
  vi.setSystemTime(MONDAY);
  const qc = state.client;
  qc.clear();
  const locale = opts.locale ?? 'vi';
  const role = opts.role ?? 'owner';
  const todayItems = opts.todayItems ?? [];
  const defaultPermissions =
    role === 'owner' || role === 'admin'
      ? ['vy.use', 'finance.proposal.approve']
      : role === 'member'
        ? ['vy.use']
        : [];

  qc.setQueryData(['me', 'get'], {
    userId: 'user-1',
    email: 'owner@example.com',
    orgs: [{ orgId: 'org-1', slug: 'acme', name: 'Gạo Sạch Mekong', role }],
  });
  if (!opts.omitOrgDetail) {
    qc.setQueryData(['org', 'get'], {
      orgId: 'org-1',
      slug: 'acme',
      name: 'Gạo Sạch Mekong',
      role,
      taxCode: null,
      vatFilingPeriod: opts.overview?.vatFilingPeriod ?? null,
      address: null,
      contactEmail: null,
      inboundAddress: null,
      inboundDroppedCount: null,
      members: [],
      permissions: opts.permissions ?? defaultPermissions,
      approvalPreset: 'founder',
      approvalPolicyVersion: 1,
    });
  }
  if (opts.aiMeter !== null) {
    qc.setQueryData(['ai', 'meter'], opts.aiMeter ?? METER_READY);
  }
  if (!opts.omitHomeLayout) {
    const resolvedPermissions = opts.permissions ?? defaultPermissions;
    qc.setQueryData(
      ['overview', 'homeLayout', 'get'],
      opts.homeLayout ?? buildFallbackHomeLayout({ modules: state.modules, role, permissions: resolvedPermissions }),
    );
  }
  qc.setQueryData(['org', 'overview'], opts.overview ?? EMPTY_OVERVIEW);
  // An org with activity has its first invoice approved unless a test says otherwise; an empty org has none.
  qc.setQueryData(['documents', 'list'], opts.documents ?? (opts.overview?.lastActivityAt ? [APPROVED_DOC] : []));
  qc.setQueryData(['notifications', 'list'], { items: [], unreadWork: opts.unreadWork ?? 0 });
  qc.setQueryData(['tasks', 'list'], opts.tasks ?? []);
  qc.setQueryData(['today', 'list'], {
    items: todayItems,
    coworkers: opts.coworkers ?? COWORKERS,
    dropped: 0,
    truncated: 0,
    failed: 0,
  });
  qc.setQueryData(['today', 'sinceYesterday'], opts.since ?? { items: [] });
  qc.setQueryData(['bookEntities', 'list'], [{ id: 'ent-1', name: 'Công ty Mẫu', isDefault: true }]);
  qc.setQueryData(['social', 'posts', 'list'], opts.posts ?? []);
  qc.setQueryData(['crm', 'bookings', 'list'], opts.bookings ?? []);
  qc.setQueryData(['conversations', 'counts'], opts.conversationsCounts ?? { new: 0, pending: 0, resolved: 0, unread: 0 });
  qc.setQueryData(['sign', 'envelope', 'list', 'sent'], { items: opts.sentEnvelopes ?? opts.envelopes ?? [] });
  qc.setQueryData(['sign', 'envelope', 'list', 'in_progress'], { items: opts.inProgressEnvelopes ?? [] });
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

  return locale;
}

function renderOverview(opts: SeedOptions = {}): string {
  const locale = seedOverviewCache(opts);
  return renderWithProviders(locale, <OverviewPage />);
}

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  state.client.clear();
  state.modules = ['kernel', 'finance', 'notes', 'projects', 'meetings', 'social', 'crm', 'ads', 'hr', 'sign'];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OverviewPage Role x Enabled-App Global Home (#4644, #4928)', () => {
  it('renders anchored header with Tùy chỉnh button (no Row 0 HomeActions), inline Vy bar, and all modular blocks in vi and en', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = renderOverview({
        locale,
        overview: ACTIVE_OVERVIEW,
        todayItems: [...TODAY_ITEMS, HR_LEAVE_PENDING_ITEM],
        brief: { writtenBy: 'vy', sentences: ['Hôm nay có 2 việc cần bạn.'], budgetSpent: false, final: true },
        unreadWork: 3,
        tasks: [{ id: 't1' }, { id: 't2' }],
        since: SINCE,
        weekly: WEEKLY,
        posts: [{ status: 'scheduled' }, { status: 'scheduled' }],
        bookings: [{ status: 'confirmed' }],
        conversationsCounts: { new: 1, pending: 0, resolved: 0, unread: 2 },
        sentEnvelopes: [ENVELOPE_WAITING],
        gaps: {
          missingCount: 2,
          groups: [{ year: 2026, template: '1C26', series: 'TPT', firstNumber: '000001', lastNumber: '000010', recorded: 8, missingCount: 2, ranges: [{ from: '3', to: '4' }], truncated: false }],
        },
      });

      // Anchored top zone: Tùy chỉnh button enabled once homeLayout settled, old Row 0 HomeActions removed.
      expect(html).toContain('data-testid="home-customize-btn"');
      expect(html).not.toMatch(/data-testid="home-customize-btn"[^>]*disabled=""/);
      expect(html).toContain('data-testid="home-customize-status"');
      expect(html).not.toContain('data-testid="home-actions"');

      // Row 1: Unified hero card holding TodayList + TodayBrief + compact inline Vy prompt bar.
      expect(html).toContain('data-testid="today-hero-card"');
      expect(html).toContain('data-testid="today-brief-host"');
      expect(html).toContain('data-testid="today-brief"');
      expect(html).toContain('data-testid="home-vy-bar"');
      expect(html).toContain('data-testid="home-vy-input"');
      expect(html).toContain('data-testid="home-vy-chip-pendingApprovals"');
      expect(html).toContain('data-testid="home-vy-approval-note"');
      expect(html).not.toContain('data-testid="overview-quickstart"');

      // Row 2: Merged Waiting + SinceYesterday strip with 44px phone targets.
      expect(html).toContain('data-testid="overview-operational-strip"');
      expect(html).toContain('data-testid="waiting-failedFiles"');
      expect(html).toContain('data-testid="waiting-notifications"');
      expect(html).toContain('data-testid="waiting-tasks"');
      expect(html).toContain('data-testid="since-yesterday-strip"');

      // Row 3: Modular blocks in canonical order + SalesNumberGaps + TodayWeekly.
      expect(html).toContain('data-testid="overview-modular-blocks"');
      expect(html).toContain('data-testid="home-block-finance_tax_deadlines"');
      expect(html).toContain('data-testid="home-block-finance_approvals"');
      expect(html).toContain('data-testid="home-block-teamwork_my_work"');
      expect(html).toContain('data-testid="home-block-engage_pipeline"');
      expect(html).toContain('data-testid="home-block-hr_pending"');
      expect(html).toContain('data-testid="home-block-esign_pending"');
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
        expect(html).toContain('2 đề xuất chờ bạn duyệt');
        expect(html).toContain('1 tệp không đọc được');
        expect(html).toContain('2 hội thoại chưa đọc');
        expect(html).toContain('1 đơn nghỉ phép chờ duyệt');
        expect(html).toContain('1 hồ sơ đang chờ ký');
        expect(html).toContain('1 hồ sơ chờ riêng bạn ký');
        expect(html).toContain('Ly đã làm 4 việc cho bạn');
      } else {
        expect(html).toContain('2 proposals awaiting approval');
        expect(html).toContain('1 unreadable file');
        expect(html).toContain('2 unread conversations');
        expect(html).toContain('1 leave request awaiting approval');
        expect(html).toContain('1 envelope awaiting signature');
        expect(html).toContain('1 envelope waiting for your signature');
        expect(html).toContain('Ly did 4 things for you');
      }
    }
  });

  it('hides Row 2 operational strip cleanly when waiting counts and SinceYesterday are empty, and collapses empty blocks', () => {
    // Even if org.overview.pendingProposals is non-zero (e.g. proposals for another app or authored by caller),
    // finance_approvals uses caller-approvable finance proposals from today.list and collapses cleanly when 0.
    const projectDeadlineToday: TodayItem = {
      app: 'projects',
      kind: 'deadline',
      id: 'd1',
      count: 2,
      title: { key: 'finance.byVendor', params: { vendor: 'Dự án A' } },
      href: '/tasks',
    };
    const html = renderOverview({
      overview: { ...ACTIVE_OVERVIEW, pendingProposals: 5, failedFiles: 0, taxDues: [] },
      todayItems: [projectDeadlineToday],
      brief: { writtenBy: null, sentences: [], budgetSpent: true, final: false },
      unreadWork: 0,
      tasks: [],
      since: { items: [] },
      weekly: { ...WEEKLY, figures: { from: '2026-11-16', to: '2026-11-22', before: '2026-11-15', deals: null, money: null, tasks: null } },
      posts: [],
      bookings: [],
      conversationsCounts: { new: 0, pending: 0, resolved: 0, unread: 0 },
      sentEnvelopes: [],
    });

    expect(html).not.toContain('data-testid="overview-operational-strip"');
    expect(html).not.toContain('data-testid="since-yesterday-strip"');
    expect(html).toContain('data-testid="today-hero-card"');
    expect(html).not.toContain('5 đề xuất chờ bạn duyệt');

    // Every zero-item block collapses to a quiet single bordered line linking to its app.
    expect(html).toContain('data-testid="home-block-empty-finance_tax_deadlines"');
    expect(html).toContain('Không có hạn thuế trong 30 ngày tới');
    expect(html).toContain('href="/o/acme/vat"');
    expect(html).toContain('data-testid="home-block-empty-finance_approvals"');
    expect(html).toContain('Không có chứng từ chờ duyệt');
    expect(html).toContain('href="/o/acme/inbox"');
    expect(html).toContain('data-testid="home-block-empty-teamwork_my_work"');
    expect(html).toContain('Không có việc đến hạn tuần này');
    expect(html).toContain('href="/o/acme/tasks"');
    expect(html).toContain('data-testid="home-block-empty-engage_pipeline"');
    expect(html).toContain('Chưa có bài đăng lên lịch, hội thoại mới hay lịch hẹn');
    expect(html).toContain('href="/o/acme/social"');
    expect(html).toContain('data-testid="home-block-empty-hr_pending"');
    expect(html).toContain('Không có yêu cầu nhân sự chờ duyệt');
    expect(html).toContain('href="/o/acme/hr/employees"');
    expect(html).toContain('data-testid="home-block-empty-esign_pending"');
    expect(html).toContain('Không có hồ sơ chờ ký');
    expect(html).toContain('href="/o/acme/sign/envelopes"');
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
    expect(html).toContain('data-testid="quickstart-step-vatPeriod"');
    expect(html).toContain('data-testid="quickstart-step-twoFactor"');
    expect(html).toContain('href="/o/acme/inbox"');
    expect(html).toContain('href="/o/acme/settings#tax-profile"');
    expect(html).toContain('href="/o/acme/settings/security"');
    expect(html).toContain('data-testid="quickstart-dismiss"');
    expect(html).toContain('href="/o/acme/guide"');
    expect(html).toContain('max-md:min-h-11');
    // Preserves TaxCalendar anchors expected by e2e/tests/overview.spec.ts:21-24.
    expect(html).toContain('Chưa chọn kỳ khai thuế');
    expect(html).toContain('Chọn kỳ khai');
    expect(html).toContain('Việc thuế trong 30 ngày tới');
    expect(html).not.toContain('data-testid="today-weekly"');
    expect(html).not.toContain('data-testid="today-weekly-ask"');
    expect(html).not.toContain('data-app-card=');
  });

  it('filters modular blocks strictly by role, permissions, and enabled modules (member, viewer, crm-only)', () => {
    // Member with HR on sees Cổng nhân viên (/hr/my), never manager queue (/hr/employees), and no finance_approvals.
    const memberHtml = renderOverview({
      locale: 'vi',
      role: 'member',
      overview: ACTIVE_OVERVIEW,
      todayItems: [],
    });
    expect(memberHtml).toContain('data-testid="home-block-hr_pending"');
    expect(memberHtml).toContain('Cổng nhân viên');
    expect(memberHtml).toContain('href="/o/acme/hr/my"');
    expect(memberHtml).not.toContain('href="/o/acme/hr/employees"');
    expect(memberHtml).not.toContain('data-testid="home-block-finance_approvals"');
    expect(memberHtml).not.toContain('data-testid="home-block-finance_tax_deadlines"');

    // Viewer sees only read-only Teamwork notes when notes is on, and zero Vy bar.
    const viewerHtml = renderOverview({
      role: 'viewer',
      overview: EMPTY_OVERVIEW,
      todayItems: [],
    });
    expect(viewerHtml).not.toContain('data-testid="overview-quickstart"');
    expect(viewerHtml).toContain('data-testid="home-block-teamwork_my_work"');
    expect(viewerHtml).toContain('href="/o/acme/notes"');
    expect(viewerHtml).not.toContain('data-testid="home-block-engage_pipeline"');
    expect(viewerHtml).not.toContain('data-testid="home-block-hr_pending"');
    expect(viewerHtml).not.toContain('data-testid="home-block-esign_pending"');
    expect(viewerHtml).not.toContain('data-testid="home-vy-bar"');
    expect(viewerHtml).not.toContain('data-testid="home-vy-status"');

    // Engage with social off and crm on links to /o/acme/bookings and uses CRM-only empty copy.
    state.modules = ['kernel', 'crm'];
    const crmOnly = renderOverview({ role: 'member', overview: EMPTY_OVERVIEW, todayItems: [] });
    expect(crmOnly).toContain('data-testid="home-block-engage_pipeline"');
    expect(crmOnly).toContain('href="/o/acme/bookings"');
    expect(crmOnly).toContain('Chưa có lịch hẹn sắp tới');
    expect(crmOnly).not.toContain('data-testid="home-block-finance_tax_deadlines"');
  });

  it('guards Tùy chỉnh while homeLayout is pending/error, blocks viewer probes, handles >100 counts, and surfaces tasksError', async () => {
    // Pending homeLayout disables Tùy chỉnh so server preferences cannot be overwritten by defaults.
    const pendingLayoutHtml = renderOverview({
      omitHomeLayout: true,
      overview: ACTIVE_OVERVIEW,
    });
    expect(pendingLayoutHtml).toMatch(/disabled=""[^>]*data-testid="home-customize-btn"|data-testid="home-customize-btn"[^>]*disabled=""/);
    // Non-admin waits with skeleton while server layout is in flight.
    const memberPendingHtml = renderOverview({
      role: 'member',
      omitHomeLayout: true,
      overview: ACTIVE_OVERVIEW,
    });
    expect(memberPendingHtml).toContain('data-testid="overview-modular-blocks-loading"');

    // Error loading homeLayout surfaces retry banner and keeps Tùy chỉnh disabled.
    const errLocale = seedOverviewCache({ omitHomeLayout: true, overview: ACTIVE_OVERVIEW });
    await state.client.prefetchQuery({
      queryKey: ['overview', 'homeLayout', 'get'],
      queryFn: () => Promise.reject(new Error('Layout RPC failed')),
    });
    const erroredLayoutHtml = renderWithProviders(errLocale, <OverviewPage />);
    expect(erroredLayoutHtml).toContain('data-testid="home-layout-error"');
    expect(erroredLayoutHtml).toMatch(/disabled=""[^>]*data-testid="home-customize-btn"|data-testid="home-customize-btn"[^>]*disabled=""/);

    // Viewer never hits crm.bookings.list or shows an AppCards failure on Engage, and never renders TodayWeekly.
    const viewerCrmHtml = renderOverview({
      role: 'viewer',
      overview: EMPTY_OVERVIEW,
    });
    expect(viewerCrmHtml).not.toContain('Chưa tải được số liệu');
    expect(viewerCrmHtml).not.toContain('data-testid="today-weekly"');

    // tasksError surfaces an inline error in teamwork_my_work instead of falsely claiming zero tasks.
    const tasksErrLocale = seedOverviewCache({
      overview: ACTIVE_OVERVIEW,
      weekly: { ...WEEKLY, figures: { from: '2026-11-16', to: '2026-11-22', before: '2026-11-15', deals: null, money: null, tasks: null } },
    });
    await state.client.prefetchQuery({
      queryKey: ['tasks', 'list'],
      queryFn: () => Promise.reject(new Error('Tasks unavailable')),
    });
    const tasksErrHtml = renderWithProviders(tasksErrLocale, <OverviewPage />);
    expect(tasksErrHtml).toContain('Tasks unavailable');
    expect(tasksErrHtml).not.toContain('Không có việc đến hạn tuần này');

    // >100 HR leave count from today.list renders full aggregate without PII query; capped 100 eSign renders 100+.
    const hundredSent = Array.from({ length: 100 }, (_, idx) => ({
      ...ENVELOPE_WAITING,
      id: `env-${idx}`,
    }));
    const highCountsHtml = renderOverview({
      overview: ACTIVE_OVERVIEW,
      todayItems: [{ ...HR_LEAVE_PENDING_ITEM, count: 105 }],
      sentEnvelopes: hundredSent,
      inProgressEnvelopes: [{ ...ENVELOPE_WAITING, id: 'env-in-progress' }],
    });
    expect(highCountsHtml).toContain('105 đơn nghỉ phép chờ duyệt');
    expect(highCountsHtml).toContain('101+ hồ sơ đang chờ ký');
  });

  it('respects server-persisted block order and renders quiet notice when all eligible blocks are hidden', () => {
    const customOrder: HomeLayoutView = {
      customized: true,
      blocks: [
        { id: 'esign_pending', visible: true, moduleEnabled: true, permitted: true },
        { id: 'hr_pending', visible: false, moduleEnabled: true, permitted: true },
        { id: 'engage_pipeline', visible: true, moduleEnabled: true, permitted: true },
        { id: 'finance_approvals', visible: true, moduleEnabled: false, permitted: true },
        { id: 'teamwork_my_work', visible: true, moduleEnabled: true, permitted: true },
        { id: 'finance_tax_deadlines', visible: true, moduleEnabled: true, permitted: true },
      ],
      defaults: [],
    };
    const orderedHtml = renderOverview({
      overview: ACTIVE_OVERVIEW,
      homeLayout: customOrder,
      weekly: WEEKLY,
      envelopes: [ENVELOPE_WAITING],
      bookings: [{ status: 'confirmed' }],
    });
    expect(orderedHtml.indexOf('data-testid="home-block-esign_pending"')).toBeLessThan(
      orderedHtml.indexOf('data-testid="home-block-engage_pipeline"'),
    );
    expect(orderedHtml.indexOf('data-testid="home-block-engage_pipeline"')).toBeLessThan(
      orderedHtml.indexOf('data-testid="home-block-finance_tax_deadlines"'),
    );
    expect(orderedHtml).not.toContain('data-testid="home-block-hr_pending"');
    expect(orderedHtml).not.toContain('data-testid="home-block-finance_approvals"');

    const allHidden: HomeLayoutView = {
      customized: true,
      blocks: [
        { id: 'finance_tax_deadlines', visible: false, moduleEnabled: true, permitted: true },
        { id: 'finance_approvals', visible: false, moduleEnabled: true, permitted: true },
        { id: 'teamwork_my_work', visible: false, moduleEnabled: true, permitted: true },
        { id: 'engage_pipeline', visible: false, moduleEnabled: true, permitted: true },
        { id: 'hr_pending', visible: false, moduleEnabled: true, permitted: true },
        { id: 'esign_pending', visible: false, moduleEnabled: true, permitted: true },
      ],
      defaults: [],
    };
    const hiddenHtml = renderOverview({ overview: ACTIVE_OVERVIEW, homeLayout: allHidden });
    expect(hiddenHtml).toContain('data-testid="home-all-blocks-hidden"');
    expect(hiddenHtml).toContain('Tất cả khối ứng dụng đang ẩn · Nhấn Tùy chỉnh để bật lại');
  });

  it('does not mount TodayWeekly or HomeActions before initial queries settle', () => {
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
    expect(loadingHtml).not.toContain('data-testid="home-actions"');
    expect(loadingHtml).toContain('data-testid="home-customize-btn"');
    // Loading spinner inside AppCards link is wrapped aria-hidden so link accessible text stays clean.
    expect(loadingHtml).toMatch(/<span aria-hidden="true"[^>]*><svg[^>]*data-slot="spinner"/);
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

  it('contains no em dashes, en dashes, or forbidden assistant copy in overview/quickstart messages', () => {
    for (const [locale, catalogTree] of [
      ['vi', viMessages],
      ['en', en],
    ] as const) {
      const slice = JSON.stringify({ overview: catalogTree.overview, quickstart: catalogTree.today.quickstart });
      expect(slice, locale).not.toMatch(/[\u2013\u2014]/);
      expect(slice, locale).not.toMatch(/assistant|trợ lý/i);
    }
  });

  it('shows the day-1 start card until the first invoice is approved, and not after it or after it is closed (#4783)', () => {
    const empty = renderOverview({ overview: EMPTY_OVERVIEW, todayItems: [] });
    expect(empty).toContain('data-testid="overview-quickstart"');
    expect(empty.indexOf('data-testid="overview-quickstart"')).toBeGreaterThan(empty.indexOf('id="overview-today"'));

    const noInvoiceYet = renderOverview({ overview: ACTIVE_OVERVIEW, todayItems: TODAY_ITEMS, documents: [] });
    expect(noInvoiceYet).toContain('data-testid="overview-quickstart"');

    const approved = renderOverview({ overview: EMPTY_OVERVIEW, todayItems: [], documents: [APPROVED_DOC] });
    expect(approved).not.toContain('data-testid="overview-quickstart"');
    const voided = renderOverview({ overview: EMPTY_OVERVIEW, todayItems: [], documents: [{ id: 'doc-2', voided: { reversalEntryId: 'e1' } }] });
    expect(voided).toContain('data-testid="overview-quickstart"');

    storage.set('ludy.home.start.acme', 'dismissed');
    expect(renderOverview({ overview: EMPTY_OVERVIEW, todayItems: [] })).not.toContain('data-testid="overview-quickstart"');
  });

  it('does not show the start card before the invoice read answers, so it never flashes', () => {
    vi.setSystemTime(MONDAY);
    const qc = state.client;
    qc.clear();
    qc.setQueryData(['me', 'get'], { userId: 'u', email: 'o@example.com', orgs: [{ orgId: 'org-1', slug: 'acme', name: 'A', role: 'owner' }] });
    qc.setQueryData(['org', 'overview'], EMPTY_OVERVIEW);
    qc.setQueryData(['today', 'list'], { items: [], coworkers: COWORKERS, dropped: 0, truncated: 0, failed: 0 });
    const html = renderWithProviders('vi', <OverviewPage />);
    expect(html).not.toContain('data-testid="overview-quickstart"');
  });
});

describe('HomeVyBar & HomeCustomizePanel SSR (#4928)', () => {
  it('renders HomeVyBar states (ready, aiOff, budgetStop, noPermission) and honors custom gmName', () => {
    const ready = renderWithProviders(
      'vi',
      <HomeVyBar
        slug="acme"
        gmName="Linh"
        canUseVy
        permissionsLoaded
        canApproveFinance
        canViewAiBudgets
        aiMeter={METER_READY}
        role="owner"
        modules={['kernel', 'finance', 'notes']}
      />,
    );
    expect(ready).toContain('data-testid="home-vy-bar"');
    expect(ready).toContain('data-testid="home-vy-input"');
    expect(ready).toContain('Hỏi Linh');
    expect(ready).toContain('data-testid="home-vy-chip-pendingApprovals"');
    expect(ready).toContain('data-testid="home-vy-chip-planToday"');
    expect(ready).not.toMatch(/data-testid="home-vy-submit"[^>]*aria-label=/);

    const aiOff = renderWithProviders(
      'vi',
      <HomeVyBar
        slug="acme"
        gmName="Vy"
        canUseVy
        permissionsLoaded
        canApproveFinance
        canViewAiBudgets
        aiMeter={METER_OFF}
        role="owner"
        modules={['kernel', 'finance']}
      />,
    );
    expect(aiOff).toContain('data-testid="home-vy-status"');
    expect(aiOff).toContain('data-vy-status="aiOff"');
    expect(aiOff).not.toContain('data-testid="home-vy-input"');

    const budgetStop = renderWithProviders(
      'en',
      <HomeVyBar
        slug="acme"
        gmName="Vy"
        canUseVy
        permissionsLoaded
        canApproveFinance
        canViewAiBudgets
        aiMeter={METER_STOP}
        role="owner"
        modules={['kernel']}
      />,
    );
    expect(budgetStop).toContain('data-testid="home-vy-status"');
    expect(budgetStop).toContain('data-vy-status="budgetStop"');
    expect(budgetStop).toContain('href="/o/acme/ai-usage"');

    const noPerm = renderWithProviders(
      'vi',
      <HomeVyBar
        slug="acme"
        gmName="Vy"
        canUseVy={false}
        permissionsLoaded
        canApproveFinance={false}
        canViewAiBudgets={false}
        aiMeter={METER_READY}
        role="member"
        modules={['kernel']}
      />,
    );
    expect(noPerm).toBe('');

    const meterPending = renderWithProviders(
      'vi',
      <HomeVyBar
        slug="acme"
        gmName="Vy"
        canUseVy
        permissionsLoaded
        canApproveFinance
        canViewAiBudgets
        aiMeter={undefined}
        role="owner"
        modules={['kernel', 'finance']}
      />,
    );
    expect(meterPending).toBe('');

    const drawerWithPrompt = renderWithProviders(
      'vi',
      <VyDrawerBody
        slug="acme"
        open
        onClose={() => undefined}
        gmName="Vy"
        canUseVy
        permissionsLoaded
        canViewAiBudgets
        aiMeter={METER_READY}
        todayItems={TODAY_ITEMS}
        role="owner"
        modules={['kernel', 'finance']}
        prompt="Tôi có bao nhiêu hóa đơn chờ duyệt?"
        canApproveFinance
      />,
    );
    expect(drawerWithPrompt).toContain('data-testid="vy-drawer-prompt"');
    expect(drawerWithPrompt).toContain('data-testid="vy-drawer-prompt-summary"');
    expect(drawerWithPrompt).toContain('Tìm thấy 2 đầu việc liên quan trong Hôm nay cần bạn.');
  });

  it('renders HomeCustomizePanel with Switch, Move Up / Move Down bounds, drag handles, live region, Reset, Cancel, Save', () => {
    const blocks: HomeLayoutBlock[] = [
      { id: 'finance_tax_deadlines', visible: true },
      { id: 'teamwork_my_work', visible: false },
      { id: 'esign_pending', visible: true },
    ];
    const html = renderWithProviders(
      'vi',
      <HomeCustomizePanel
        initialBlocks={blocks}
        isPending={false}
        error={new Error('Network offline')}
        onSave={() => undefined}
        onReset={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="home-customize-panel"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-testid="home-customize-announcement"');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('data-testid="home-customize-drag-finance_tax_deadlines"');
    expect(html).toContain('data-testid="home-customize-switch-finance_tax_deadlines"');
    expect(html).toContain('data-testid="home-customize-switch-teamwork_my_work"');
    // First row Move Up is disabled, middle row both enabled, last row Move Down is disabled.
    expect(html).toMatch(/disabled=""[^>]*data-testid="home-customize-up-finance_tax_deadlines"|data-testid="home-customize-up-finance_tax_deadlines"[^>]*disabled=""/);
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="home-customize-down-finance_tax_deadlines"|data-testid="home-customize-down-finance_tax_deadlines"[^>]*disabled=""/);
    expect(html).toMatch(/disabled=""[^>]*data-testid="home-customize-down-esign_pending"|data-testid="home-customize-down-esign_pending"[^>]*disabled=""/);
    expect(html).toContain('min-h-11 min-w-11');
    expect(html).toContain('data-testid="home-customize-reset"');
    expect(html).toContain('data-testid="home-customize-cancel"');
    expect(html).toContain('data-testid="home-customize-save"');
    expect(html).toContain('data-testid="home-customize-error"');
    expect(html).not.toMatch(/shadow-(md|lg|xl|2xl)/);
  });
});
