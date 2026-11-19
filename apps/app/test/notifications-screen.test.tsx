// SPDX-License-Identifier: AGPL-3.0-only
// The bell's screen after #3592 (NT-1, NT-2), rendered on the server with the API's answers seeded in the cache: it holds the list, "Mark all as read" and a link to the
// preferences; a run of the same kind is one row with a count; the preferences are a card of Settings. The AI coworker here: none acts, this is a layout and copy fix.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import { notificationKinds } from '../src/lib/notifications.ts';

const state = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient, modules: ['kernel', 'finance'] as string[] }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'hoa-mai' }),
    useNavigate: () => () => undefined,
    Link: ({ children, to, params, hash, className }: { children?: ReactNode; to: string; params?: Record<string, string>; hash?: string; className?: string }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_m, name: string) => params?.[name] ?? '') + (hash ? `#${hash}` : ''), className }, children),
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
  return { orpc: node([]), client: {}, queryClient: state.qc, errorMessage: (e: unknown) => String(e) };
});

const { NotificationsPage } = await import('../src/routes/notifications.tsx');
const { NotificationPreferences } = await import('../src/routes/settings/notifications-card.tsx');

type Item = { id: string; kind: string; subjectId: string | null; detail: Record<string, string>; read: boolean; createdAt: string };
const approvals = (count: number, read = false): Item[] =>
  Array.from({ length: count }, (_v, i) => ({ id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, kind: 'kernel.approval_waiting', subjectId: `00000000-0000-4000-9000-0000000000${String(i).padStart(2, '0')}`, detail: { title: `HĐ C26TFA-${1185 + i}` }, read, createdAt: '2026-11-18T08:00:00.000Z' }));
const bank = (n: number): Item => ({ id: `00000000-0000-4000-a000-0000000000${n}`, kind: 'finance.bank_attention', subjectId: null, detail: { bankAccount: '1121', lines: '3' }, read: false, createdAt: '2026-11-18T07:00:00.000Z' });

function render(node: ReactNode, seed: { items?: Item[]; muted?: string[] }, locale: 'en' | 'vi' = 'en'): string {
  state.qc.clear();
  state.qc.setQueryData(['notifications', 'list', {}], { items: seed.items ?? [], unread: (seed.items ?? []).filter((n) => !n.read).length, unreadWork: 0, muted: seed.muted ?? [] });
  state.qc.setQueryData(['today', 'mail', 'get'], { enabled: false });
  vi.stubGlobal('window', { location: { search: '' } });
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}
const page = (seed: Parameters<typeof render>[1], locale: 'en' | 'vi' = 'en') => render(<NotificationsPage />, seed, locale);

beforeEach(() => {
  state.modules = ['kernel', 'finance'];
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

  it('links to the preferences card on the tab of the person\'s own settings', () => {
    expect(page({ items: [] })).toContain('href="/o/hoa-mai/settings/security#notification-settings"');
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
    expect(html).toContain('(7 unread)');
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

  it('does not mark a group of read notices unread', () => {
    const html = page({ items: approvals(3, true) });
    expect(html).toContain('3 proposals wait for your approval');
    expect(html).not.toContain('unread)');
  });
});

describe('the preferences card of Settings', () => {
  it('lists the kinds of the installed apps, each switched on unless the member muted it, with the daily brief card after it', () => {
    const html = render(<NotificationPreferences />, { muted: ['kernel.task_assigned'] });
    const kinds = notificationKinds(state.modules);
    expect(html.match(/role="checkbox"/g)?.length).toBe(kinds.length + 1); // one per kind, one for the daily brief
    expect(html.match(/aria-checked="false"/g)?.length).toBe(2); // the muted kind and the daily brief (off by default)
    expect(html).toContain('id="notification-settings"');
    expect(html).toContain(catalog('en').notifications.prefsTitle);
    expect(html).toContain(catalog('en').notifications.kinds.finance_bank_attention);
    expect(html).toContain(catalog('en').notifications.todayMail.title);
  });

  it('leaves out the kinds of an app the org does not run', () => {
    state.modules = ['kernel'];
    expect(render(<NotificationPreferences />, {})).not.toContain(catalog('en').notifications.kinds.finance_bank_attention);
  });
});
