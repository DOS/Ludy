// SPDX-License-Identifier: AGPL-3.0-only
// The bell's screen after #3592 (NT-1, NT-2) and Clarify-style 2-column master-detail (#4927), rendered on the server with
// the API's answers seeded in the cache: it holds the filter bar, list, "Mark all as read" and a link to preferences;
// a run of the same kind is one row with a count; desktop (>= lg) shows an inline detail pane while mobile (< lg) opens a Sheet.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';
import { hasBlockingOverlayForPeek, isPeekNavInputTarget } from '../src/lib/list-peek-nav.ts';
import {
  notificationFeedStepFromKey,
  notificationKinds,
  parseNotificationsSearch,
  restoreNotificationRowFocus,
} from '../src/lib/notifications.ts';

const state = vi.hoisted(() => ({
  qc: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['kernel', 'finance'] as string[],
  search: {} as Record<string, unknown>,
  desktop: false,
  navigated: [] as Array<{ search?: unknown; replace?: boolean; resetScroll?: boolean }>,
  readCalls: [] as Array<{ ids?: string[]; all?: boolean }>,
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'hoa-mai' }),
    useSearch: () => state.search,
    useNavigate: () => (opts: { search?: unknown; replace?: boolean; resetScroll?: boolean }) => {
      state.navigated.push(opts);
    },
    Link: ({
      children,
      to,
      params,
      search,
      hash,
      className,
      ...rest
    }: {
      children?: ReactNode;
      to: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
      hash?: string;
      className?: string;
      [k: string]: unknown;
    }) => {
      const base = to.replace(/\$(\w+)/g, (_m, name: string) => params?.[name] ?? '');
      const entries = search ? Object.entries(search).filter(([, v]) => v !== undefined && v !== '') : [];
      const query = entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : '';
      return createElement('a', { href: `${base}${query}${hash ? `#${hash}` : ''}`, className, ...rest }, children);
    },
  };
});
vi.mock('../src/lib/media.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/media.ts')>();
  return {
    ...actual,
    useMediaQuery: (query: string) => (query === '(min-width: 64rem)' ? state.desktop : actual.useMediaQuery(query)),
  };
});
vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement: h } = await import('react');
  return {
    Sheet: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? h('div', { 'data-slot': 'sheet' }, children) : null),
    SheetContent: ({
      children,
      closeLabel,
      ...rest
    }: {
      children?: ReactNode;
      closeLabel: string;
      [k: string]: unknown;
    }) => h('section', { role: 'dialog', 'data-slot': 'sheet-content', 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('header', { 'data-slot': 'sheet-header', className }, children),
    SheetTitle: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('h2', { 'data-slot': 'sheet-title', className }, children),
    SheetDescription: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('p', { 'data-slot': 'sheet-description', className }, children),
    SheetBody: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('div', { 'data-slot': 'sheet-body', className }, children),
    SheetFooter: ({ children, className }: { children?: ReactNode; className?: string }) =>
      h('footer', { 'data-slot': 'sheet-footer', className }, children),
  };
});
vi.mock('../src/lib/org-modules.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), installedModules: () => state.modules }));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: state.modules, mailEnabled: true }) }));
vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.qc = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (options?: { input?: unknown }) => ({ queryKey: options?.input === undefined ? path : [...path, options.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {
      notifications: {
        read: (input: { ids?: string[]; all?: boolean }) => {
          state.readCalls.push(input);
          return Promise.resolve({ read: 1 });
        },
      },
    },
    queryClient: state.qc,
    errorMessage: (e: unknown) => String(e),
  };
});

const { NotificationsPage } = await import('../src/routes/notifications.tsx');
const { NotificationPreferences } = await import('../src/routes/settings/notifications-card.tsx');

type Item = { id: string; kind: string; subjectId: string | null; detail: Record<string, string>; tainted?: boolean; read: boolean; createdAt: string };
const approvals = (count: number, read = false): Item[] =>
  Array.from({ length: count }, (_v, i) => ({ id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, kind: 'kernel.approval_waiting', subjectId: `00000000-0000-4000-9000-0000000000${String(i).padStart(2, '0')}`, detail: { title: `HĐ C26TFA-${1185 + i}` }, read, createdAt: '2026-11-18T08:00:00.000Z' }));
const bank = (n: number): Item => ({ id: `00000000-0000-4000-a000-00000000000${n}`, kind: 'finance.bank_attention', subjectId: null, detail: { bankAccount: '1121', lines: '3' }, read: false, createdAt: '2026-11-18T07:00:00.000Z' });

function render(node: ReactNode, seed: { items?: Item[]; muted?: string[] }, locale: 'en' | 'vi' = 'en'): string {
  state.qc.clear();
  state.qc.setQueryData(['notifications', 'list', {}], { items: seed.items ?? [], unread: (seed.items ?? []).filter((n) => !n.read).length, unreadWork: 0, muted: seed.muted ?? [] });
  state.qc.setQueryData(['today', 'mail', 'get'], { enabled: false });
  vi.stubGlobal('window', { location: { search: '' } });
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={state.qc}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale('vi');
  }
}
const page = (seed: Parameters<typeof render>[1], locale: 'en' | 'vi' = 'en') => render(<NotificationsPage />, seed, locale);

beforeEach(() => {
  state.modules = ['kernel', 'finance'];
  state.search = {};
  state.desktop = false;
  state.navigated = [];
  state.readCalls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Engage reads notice (#4069)', () => {
  const notice = (grants: string, read = false): Item => ({ id: '00000000-0000-4000-b000-000000000001', kind: 'kernel.mcp_engage_reads', subjectId: null, detail: { grants }, read, createdAt: '2026-11-21T08:00:00.000Z' });
  it('names what a connected AI app can now read, in Vietnamese, and where to disconnect it', () => {
    const company = page({ items: [notice('company')] }, 'vi');
    for (const word of ['Hộp thư Engage', 'tin nhắn riêng và email', 'lịch hẹn', 'quảng cáo', 'Kết nối AI', 'ngắt kết nối']) expect(company, word).toContain(word);
    // A member's own connection reads what the member reads, and no bookings or ads.
    const member = page({ items: [notice('member')] }, 'vi');
    expect(member).toContain('những gì bạn đọc được trong Hộp thư Engage');
    expect(member).not.toContain('lịch hẹn');
    const both = page({ items: [notice('both')] }, 'vi');
    expect(both).toContain('Kết nối của công ty còn đọc lịch hẹn');
  });
  it('is shown in English too, and is not a kind a member can turn off in the settings', () => {
    expect(page({ items: [notice('company')] })).toContain('also reads the Engage Inbox');
    expect(notificationKinds(['finance', 'ads'])).not.toContain('kernel.mcp_engage_reads');
  });
});

describe('the list screen holds the list and "Mark all as read" only', () => {
  it('shows no preference and no daily-brief card under the list, in either language', () => {
    for (const locale of ['en', 'vi'] as const) {
      const messages = catalog(locale).notifications;
      const html = page({ items: approvals(2) }, locale);
      expect(html, locale).not.toContain('role="checkbox"');
      expect(html, locale).not.toContain(messages.settings);
      expect(html, locale).not.toContain(messages.todayMail.title);
      expect(html, locale).toContain(messages.readAll);
    }
  });

  it('links to the preferences, the Settings tab of the member\'s own notifications', () => {
    expect(page({ items: [] })).toContain('href="/o/hoa-mai/settings/notifications#notification-settings"');
    expect(page({ items: [] })).toContain(catalog('en').notifications.settingsLink);
    expect(page({ items: [] }, 'vi')).toContain('Cài đặt thông báo');
  });

  it('keeps the link and the empty state when there is nothing to list', () => {
    const html = page({ items: [] });
    expect(html).toContain(catalog('en').notifications.empty);
    expect(html).toContain('notification-settings');
  });

  it('has one name: the screen is titled as the rail names it', () => {
    for (const locale of ['en', 'vi'] as const) {
      const messages = catalog(locale);
      expect(messages.notifications.title).toBe(messages.nav.notifications);
      expect(page({ items: [] }, locale)).toContain(`>${messages.nav.notifications}</h1>`);
    }
    expect(catalog('vi').notifications.title).toBe('Thông báo');
  });
});

describe('a run of the same kind is one row', () => {
  it('shows seven pending proposals as one grouped row, not seven', () => {
    const html = page({ items: approvals(7) });
    expect(html.match(/data-testid="notification-group"/g)).toHaveLength(1);
    expect(html).toContain('7 proposals wait for your approval');
    expect(html).not.toContain('C26TFA-1185');
    expect(html).toContain(catalog('en').notifications.groupOpen);
    expect(html).toContain('(Unread)');
  });

  it('says it in Vietnamese with the count', () => {
    expect(page({ items: approvals(7) }, 'vi')).toContain('7 đề xuất chờ bạn duyệt');
  });

  it('keeps a row per event for a single notice and for kinds that name different things', () => {
    const one = page({ items: approvals(1) });
    expect(one).not.toContain('notification-group');
    expect(one).toContain('Waiting for your approval: HĐ C26TFA-1185');
    const mixed = page({ items: [bank(1), bank(2), ...approvals(3)] });
    expect(mixed.match(/data-testid="notification-group"/g)).toHaveLength(1);
    // Two bank notices between nothing and the proposals stay two rows of their own: different events are not merged.
    expect(mixed.match(/The statement of account 1121 has 3 lines to look at/g)).toHaveLength(2);
  });

  it('counts what still waits: decided proposals (read) stay plain rows and are not in the count', () => {
    const html = page({ items: [...approvals(3), ...approvals(4, true).map((n, i) => ({ ...n, id: `00000000-0000-4000-b000-00000000000${i}` }))] });
    expect(html).toContain('3 proposals wait for your approval');
    expect(html).not.toContain('7 proposals');
    expect(html.match(/Waiting for your approval: /g)).toHaveLength(4);
  });

  it('counts files, not notices: one file that failed twice is one file', () => {
    const twice = ['a', 'b'].map((n) => ({ id: `00000000-0000-4000-c000-00000000000${n === 'a' ? 1 : 2}`, kind: 'kernel.file_unreadable', subjectId: '00000000-0000-4000-d000-000000000001', detail: { filename: 'hd.pdf' }, read: false, createdAt: '2026-11-18T08:00:00.000Z' }));
    expect(page({ items: twice })).toContain('1 file could not be read');
  });

  it('shows no group for read notices', () => {
    const html = page({ items: approvals(3, true) });
    expect(html).not.toContain('notification-group');
    expect(html.match(/Waiting for your approval: /g)).toHaveLength(3);
  });

  it('reads "30+" where the list is full and the group runs to its end', () => {
    expect(page({ items: approvals(30) })).toContain('30+ proposals wait for your approval');
    expect(page({ items: approvals(29) })).toContain('29 proposals wait for your approval');
    expect(page({ items: approvals(30) }, 'vi')).toContain('30+ đề xuất chờ bạn duyệt');
  });
});

describe('the notifications tab of Settings', () => {
  it('lists the kinds of the installed apps, each switched on unless the member muted it, with the daily brief card after it', () => {
    const html = render(<NotificationPreferences />, { muted: ['kernel.task_assigned'] });
    const kinds = notificationKinds(state.modules);
    expect(html.match(/role="checkbox"/g)?.length).toBe(kinds.length + 1); // one per kind, one for the daily brief
    expect(html.match(/aria-checked="false"/g)?.length).toBe(2); // the muted kind and the daily brief (off by default)
    expect(html).toContain('id="notification-settings"');
    expect(html).toContain('id="daily-brief-mail"');
    expect(html).toContain(catalog('en').notifications.prefsTitle);
    expect(html).toContain(catalog('en').notifications.kinds.finance_bank_attention);
    expect(html).toContain(catalog('en').notifications.todayMail.title);
  });

  it('holds the morning notice of the meetings too, where the meetings app runs (#3955 moved here with the other preferences)', () => {
    state.modules = ['kernel', 'meetings'];
    const withMeetings = render(<NotificationPreferences />, {});
    expect(withMeetings).toContain('data-testid="morning-notice-setting"');
    expect(render(<NotificationsPage />, {})).not.toContain('morning-notice-setting');
    state.modules = ['kernel'];
    expect(render(<NotificationPreferences />, {})).not.toContain('morning-notice-setting');
  });

  it('leaves out the kinds of an app the org does not run', () => {
    state.modules = ['kernel'];
    expect(render(<NotificationPreferences />, {})).not.toContain(catalog('en').notifications.kinds.finance_bank_attention);
  });
});

describe('the title of a task an AI coworker wrote (#4421)', () => {
  const task = (n: number, kind: 'kernel.task_assigned' | 'kernel.task_rerouted', title: string, tainted?: boolean, read = false): Item => ({
    id: `00000000-0000-4000-e000-00000000000${n}`,
    kind,
    subjectId: `00000000-0000-4000-f000-00000000000${n}`,
    detail: { title },
    ...(tainted === undefined ? {} : { tainted }),
    read,
    createdAt: '2026-11-22T01:00:00.000Z',
  });

  it('marks the invisible and direction characters of a tainted title on both task notices, and leaves a person\'s title as typed', () => {
    const html = page({ items: [task(1, 'kernel.task_assigned', 'Gửi báo\u202e giá\u200b ngay', true, true), task(2, 'kernel.task_rerouted', 'Gọi\u202e lại', true), task(3, 'kernel.task_assigned', 'Việc\u202e của người', undefined, true), task(4, 'kernel.task_assigned', 'Việc\u202e người gõ', false, true)] });
    expect(html).toContain('Assigned to you: Gửi báo\u27e8U+202E\u27e9 giá\u27e8U+200B\u27e9 ngay');
    expect(html).toContain('A task moved to you: Gọi\u27e8U+202E\u27e9 lại');
    expect(html).not.toContain('Gửi báo\u202e');
    expect(html).not.toContain('Gọi\u202e');
    // A notice without the flag, or with it false, shows the title as it was typed.
    expect(html).toContain('Assigned to you: Việc\u202e của người');
    expect(html).toContain('Assigned to you: Việc\u202e người gõ');
  });
});

describe('Clarify-style 2-column Notifications master-detail (#4927)', () => {
  const richProposal = (read = false): Item => ({
    id: '00000000-0000-4000-8000-000000000101',
    kind: 'kernel.approval_waiting',
    subjectId: '00000000-0000-4000-9000-000000000101',
    detail: { title: 'HĐ 1C26TPT-00001284', amount: '32832000', rule: 'Bao bì' },
    read,
    createdAt: '2026-11-25T09:15:00.000Z',
  });
  const meetingSummary = (read = false): Item => ({
    id: '00000000-0000-4000-8000-000000000102',
    kind: 'meetings.summary_ready',
    subjectId: '00000000-0000-4000-9000-000000000102',
    detail: {},
    read,
    createdAt: '2026-11-25T08:40:00.000Z',
  });
  const portalNotice = (): Item => ({
    id: '00000000-0000-4000-8000-000000000103',
    kind: 'finance.portal_attention',
    subjectId: '00000000-0000-4000-9000-000000000103',
    detail: { period: '2026-11', direction: 'sale', missing: '2', amountMismatch: '1' },
    read: true,
    createdAt: '2026-11-24T14:20:00.000Z',
  });

  it('renders 2-column layout on desktop (>= lg) and auto-selects the first visible row without selected param', () => {
    state.desktop = true;
    const html = page({ items: [richProposal(), meetingSummary()] }, 'vi');
    expect(html).toContain('data-testid="notifications-master-detail"');
    expect(html).toContain('lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]');
    expect(html).toContain('data-testid="notifications-feed-pane"');
    expect(html).toContain('data-testid="notification-detail-pane"');
    expect(html).toContain('data-testid="notifications-shortcuts-hint"');
    // First row is auto-selected (`aria-current="true"`) and its detail renders inline with formatted money and primary CTA.
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="notification-detail-title"');
    expect(html).toContain('32.832.000');
    expect(html).toContain('href="/o/hoa-mai/inbox/00000000-0000-4000-9000-000000000101"');
    expect(html).toContain('data-testid="notification-mark-read"');
    expect(html).not.toContain('data-testid="notification-detail-sheet"');
  });

  it('syncs selected single item on desktop with CoworkerAttribution, money formatting in en, and no dead Mark unread button', () => {
    state.desktop = true;
    state.search = { selected: '00000000-0000-4000-8000-000000000102' };
    const html = page({ items: [richProposal(), meetingSummary(true)] }, 'en');
    expect(html).toContain('data-testid="coworker-attribution"');
    expect(html).toContain('Vy');
    expect(html).toContain('Minutes draft ready');
    expect(html).toContain('href="/o/hoa-mai/meetings/00000000-0000-4000-9000-000000000102"');
    // Read single notification hides Mark read and never renders a dead Mark unread button.
    expect(html).not.toContain('data-testid="notification-mark-read"');
    expect(html).not.toContain('Mark unread');

    // English money format uses format.ts (`₫32,832,000`).
    state.search = { selected: '00000000-0000-4000-8000-000000000101' };
    const proposalEn = page({ items: [richProposal(), meetingSummary()] }, 'en');
    expect(proposalEn).toContain('₫32,832,000');
    expect(proposalEn).toContain('data-testid="notification-detail-metadata"');
  });

  it('uses SegmentedControl for All/Unread and shows optional app filter pills only when notifications span >1 app', () => {
    state.desktop = true;
    const singleAppHtml = page({ items: [richProposal()] }, 'vi');
    expect(singleAppHtml).toContain('role="radiogroup"');
    expect(singleAppHtml).toContain('data-testid="notifications-filter-all"');
    expect(singleAppHtml).toContain('data-testid="notifications-filter-unread"');
    expect(singleAppHtml).not.toContain('data-testid="notifications-app-filters"');

    const multiAppHtml = page({ items: [richProposal(), meetingSummary(), portalNotice()] }, 'vi');
    expect(multiAppHtml).toContain('data-testid="notifications-app-filters"');
    expect(multiAppHtml).toContain('data-testid="notifications-app-finance"');
    expect(multiAppHtml).toContain('data-testid="notifications-app-teamwork"');
    expect(multiAppHtml).toContain('Tài chính');
    expect(multiAppHtml).toContain('Cộng tác');
  });

  it('filters by unread and app search params and offers Show all when filtered feed is empty', () => {
    state.desktop = true;
    state.search = { filter: 'unread', app: 'teamwork' };
    const filteredHtml = page({ items: [richProposal(false), meetingSummary(false), portalNotice()] }, 'vi');
    expect(filteredHtml.match(/data-testid="notification-row"/g)).toHaveLength(1);
    expect(filteredHtml).toContain('Bản nháp biên bản');
    expect(filteredHtml).not.toContain('1C26TPT-00001284');

    state.search = { filter: 'unread', app: 'engage' };
    const emptyFiltered = page({ items: [richProposal(false)] }, 'en');
    expect(emptyFiltered).toContain(catalog('en').notifications.filters.filteredEmpty);
    expect(emptyFiltered).toContain(catalog('en').notifications.filters.showAll);
  });

  it('displays grouped unread runs in the desktop detail pane with item links and Mark group read', () => {
    state.desktop = true;
    const html = page({ items: approvals(3) }, 'en');
    expect(html).toContain('data-testid="notification-group"');
    expect(html).toContain('data-testid="notification-group-items"');
    expect(html).toContain('HĐ C26TFA-1185');
    expect(html).toContain('HĐ C26TFA-1186');
    expect(html).toContain('HĐ C26TFA-1187');
    expect(html).toContain('data-testid="notification-mark-group-read"');
    expect(html).toContain('href="/o/hoa-mai/inbox"');
    expect(html).toContain('href="/o/hoa-mai/inbox/00000000-0000-4000-9000-000000000000"');
  });

  it('opens detail inside @ludy/ui Sheet on mobile (< lg) with 44px touch targets and keeps Sheet closed when nothing is selected', () => {
    state.desktop = false;
    const closedHtml = page({ items: [richProposal()] }, 'vi');
    expect(closedHtml).toContain('data-testid="notifications-mobile"');
    expect(closedHtml).not.toContain('data-testid="notification-detail-sheet"');
    expect(closedHtml).not.toContain('data-testid="notification-detail-pane"');

    state.search = { selected: '00000000-0000-4000-8000-000000000101' };
    const openHtml = page({ items: [richProposal()] }, 'vi');
    expect(openHtml).toContain('data-testid="notification-detail-sheet"');
    expect(openHtml).toContain('data-slot="sheet-header"');
    expect(openHtml).toContain('data-slot="sheet-body"');
    expect(openHtml).toContain('data-slot="sheet-footer"');
    expect(openHtml).toContain(`data-close-label="${catalog('vi').common.close}"`);
    expect(openHtml).toContain('max-md:min-h-11');
  });

  it('restores focus to the triggering feed row on mobile Sheet close and blocks J/K inside inputs/dialogs/sheets', () => {
    const fakeTrigger = {
      focused: false,
      isConnected: true,
      tabIndex: 0,
      focus() {
        this.focused = true;
      },
    };
    const fakeFeed = {
      querySelector: (selector: string) =>
        selector === '[data-notification-row="00000000-0000-4000-8000-000000000101"]' ? fakeTrigger : null,
    };
    expect(restoreNotificationRowFocus(fakeFeed, '00000000-0000-4000-8000-000000000101', false)).toBe(true);
    expect(fakeTrigger.focused).toBe(true);

    // Input, textarea, select, and open dialog/sheet guards block J/K shortcuts.
    const makeEl = (tag: string, attrs: Record<string, string> = {}) =>
      ({
        tagName: tag.toUpperCase(),
        isContentEditable: false,
        getAttribute: (name: string) => attrs[name] ?? null,
        closest: (sel: string) =>
          sel.split(',').some((tok) => {
            const t = tok.trim();
            if (t === tag.toLowerCase()) return true;
            const m = t.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
            return m ? (m[2] ? attrs[m[1]!] === m[2] : attrs[m[1]!] !== undefined) : false;
          })
            ? ({} as Element)
            : null,
      }) as unknown as Element;
    expect(isPeekNavInputTarget(makeEl('input'))).toBe(true);
    expect(isPeekNavInputTarget(makeEl('textarea'))).toBe(true);
    expect(isPeekNavInputTarget(makeEl('select'))).toBe(true);
    const openSheetDoc = {
      querySelectorAll: () => [makeEl('section', { 'data-slot': 'sheet-content' })] as unknown as NodeListOf<Element>,
    };
    expect(hasBlockingOverlayForPeek('', openSheetDoc)).toBe(true);
    expect(
      notificationFeedStepFromKey(
        { key: 'j', metaKey: false, ctrlKey: false, altKey: false },
        { blocked: true, insideFeed: true, plainPageFocus: false },
      ),
    ).toBeNull();
    expect(
      notificationFeedStepFromKey(
        { key: 'j', metaKey: false, ctrlKey: false, altKey: false },
        { blocked: false, insideFeed: true, plainPageFocus: false },
      ),
    ).toBe(1);
    expect(
      notificationFeedStepFromKey(
        { key: 'k', metaKey: false, ctrlKey: false, altKey: false },
        { blocked: false, insideFeed: true, plainPageFocus: false },
      ),
    ).toBe(-1);
  });

  it('validates search params cleanly and renders zero forbidden elements (<select>, <details>, border+shadow, em dashes)', () => {
    expect(parseNotificationsSearch({ selected: '00000000-0000-4000-8000-000000000101', filter: 'unread', app: 'finance' })).toEqual({
      selected: '00000000-0000-4000-8000-000000000101',
      filter: 'unread',
      app: 'finance',
    });
    expect(parseNotificationsSearch({ filter: 'other', app: 'unknown', selected: '   ' })).toEqual({});

    for (const desktop of [true, false]) {
      for (const locale of ['vi', 'en'] as const) {
        state.desktop = desktop;
        state.search = desktop ? {} : { selected: '00000000-0000-4000-8000-000000000101' };
        const html = page({ items: [richProposal(), meetingSummary(), portalNotice()] }, locale);
        expect(html, `${desktop}-${locale}`).not.toContain('<select');
        expect(html, `${desktop}-${locale}`).not.toContain('<details');
        expect(html, `${desktop}-${locale}`).not.toMatch(/shadow-(md|lg|xl|2xl)/);
        expect(html, `${desktop}-${locale}`).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });
});
