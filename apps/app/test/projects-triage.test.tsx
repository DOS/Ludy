// SPDX-License-Identifier: AGPL-3.0-only
// SSR and UI contract checks for Projects Triage Inbox & SendToTriageDialog (#4493, ADR-0058):
// covers EN/VI labels, External / Tainted badge & notice, Snooze elapsed badge, >= 44px touch targets,
// AI-off graceful degradation (core actions enabled), and Vy AI proposal card when available.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import type { ProjectTriageListResult } from '@ludy/kernel-contract';
import { ProjectTriagePanel, mergeTriagePages } from '../src/components/project-triage-panel.tsx';
import { SendToTriageDialog, resolveSendDialogProjectSelection } from '../src/components/send-to-triage-dialog.tsx';
import { catalog } from '../src/i18n/runtime.ts';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const PROJECT_1 = '00000000-0000-4000-8000-000000000011';
const ITEM_1 = '00000000-0000-4000-8000-000000000101';
const ITEM_2 = '00000000-0000-4000-8000-000000000102';
const SEAT_1 = '00000000-0000-4000-8000-000000000201';
const TASK_1 = '00000000-0000-4000-8000-000000000301';

const TRIAGE_LIST_DATA: ProjectTriageListResult = {
  items: [
    {
      id: ITEM_1,
      projectId: PROJECT_1,
      projectName: 'Kho vận Q4',
      projectVisibility: 'org',
      sourceType: 'roadmap.item',
      sourceId: '00000000-0000-4000-8000-000000000401',
      sourceLabel: 'Xuất báo cáo thuế tự động',
      status: 'pending',
      priority: 'high',
      title: 'Khách yêu cầu xuất hóa đơn hàng loạt',
      description: 'Cần xuất hóa đơn theo lô cuối ngày.',
      tainted: true,
      snoozedUntil: null,
      snoozeElapsed: false,
      acceptedTaskId: null,
      mergedIntoTaskId: null,
      declineReason: null,
      triagedBy: null,
      triagedByName: null,
      triagedAt: null,
      createdBy: '00000000-0000-4000-8000-000000000501',
      createdByName: 'Minh',
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-20T09:00:00.000Z',
    },
    {
      id: ITEM_2,
      projectId: PROJECT_1,
      projectName: 'Kho vận Q4',
      projectVisibility: 'org',
      sourceType: 'manual',
      sourceId: null,
      sourceLabel: null,
      status: 'snoozed',
      priority: 'medium',
      title: 'Kiểm tra lại tốc độ tải bảng lương',
      description: null,
      tainted: false,
      snoozedUntil: '2026-11-19T02:00:00.000Z',
      snoozeElapsed: true,
      acceptedTaskId: null,
      mergedIntoTaskId: null,
      declineReason: null,
      triagedBy: null,
      triagedByName: null,
      triagedAt: null,
      createdBy: '00000000-0000-4000-8000-000000000501',
      createdByName: 'Minh',
      createdAt: '2026-11-18T09:00:00.000Z',
      updatedAt: '2026-11-18T09:00:00.000Z',
    },
  ],
  nextCursor: null,
  counts: {
    pending: 1,
    snoozed: 1,
    accepted: 0,
    merged: 0,
    declined: 0,
    snoozeElapsed: 1,
  },
  projects: [{ id: PROJECT_1, name: 'Kho vận Q4', visibility: 'org', status: 'active', canWrite: true }],
  seats: [
    {
      id: SEAT_1,
      title: 'Kế toán trưởng',
      status: 'active',
      onProject: true,
      holder: { type: 'user', userId: '00000000-0000-4000-8000-000000000501', displayName: 'Minh', email: 'minh@demo.test' },
      projectIds: [PROJECT_1],
    },
  ],
  columns: [],
  cycles: [],
  openTasks: [{ id: TASK_1, projectId: PROJECT_1, title: 'Tối ưu xuất PDF', status: 'in_progress' }],
  aiStatus: { available: false, reason: 'off', resetOn: null },
};

const apiState = vi.hoisted(() => ({ data: null as ProjectTriageListResult | null }));
const modulesState = vi.hoisted(() => ({ modules: ['projects', 'meetings', 'crm'] as string[] }));

vi.mock('../src/lib/org-modules.ts', () => ({
  installedModules: () => modulesState.modules,
  useModulesVersion: () => 0,
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'demo-org', id: PROJECT_1 }),
    useNavigate: () => () => Promise.resolve(),
    Link: ({ children, to, params: _p, search: _s, ...props }: Record<string, unknown>) =>
      createElement('a', { href: String(to ?? '#'), ...props }, children as never),
  };
});

vi.mock('../src/lib/api.ts', () => {
  const proxy = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get(_target, prop: string) {
        if (prop === 'queryOptions') {
          return ({ input }: { input?: unknown } = {}) => ({
            queryKey: ['orpc', ...path, input ?? {}],
            queryFn: async () => apiState.data,
          });
        }
        if (prop === 'mutationOptions') {
          return (opts: Record<string, unknown> = {}) => opts;
        }
        if (prop === 'key') {
          return () => ['orpc', ...path];
        }
        return proxy([...path, prop]);
      },
      apply() {
        return Promise.resolve(undefined);
      },
    });
  return {
    client: proxy([]),
    orpc: proxy([]),
    queryClient: new QueryClient(),
    errorMessage: (e: unknown) => String(e),
  };
});

function renderWithIntl(locale: 'vi' | 'en', data: ProjectTriageListResult, node: React.ReactElement): string {
  apiState.data = data;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(
    ['orpc', 'projects', 'triage', 'list', { projectId: PROJECT_1, statuses: ['pending'], limit: 100 }],
    data,
  );
  qc.setQueryData(['orpc', 'projects', 'triage', 'list', { statuses: ['pending'], limit: 100 }], data);

  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </IntlProvider>,
  );
}

describe('Projects Triage Inbox SSR & accessibility (#4493)', () => {
  it('renders pending items, tainted notice, snooze elapsed badge, >= 44px touch targets, and AI-off fallback in Vietnamese', () => {
    const html = renderWithIntl('vi', TRIAGE_LIST_DATA, <ProjectTriagePanel orgSlug="demo-org" projectId={PROJECT_1} />);
    expect(html).toContain('Khách yêu cầu xuất hóa đơn hàng loạt');
    expect(html).toContain(viMessages.projects.triage.taintedBadge);
    expect(html).toContain(viMessages.projects.triage.taintedNotice);
    expect(html).toContain(viMessages.projects.triage.snoozeElapsedBadge);
    expect(html).toContain(viMessages.projects.triage.ai.unavailableOff);
    expect(html).toContain(viMessages.projects.triage.accept.submit);
    expect(html).toContain(viMessages.projects.triage.decline.openBtn);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('min-h-11');
  });

  it('renders cross-project mode and enabled Vy AI badge in English', () => {
    const withAi: ProjectTriageListResult = {
      ...TRIAGE_LIST_DATA,
      aiStatus: { available: true, reason: null, resetOn: null },
    };
    const html = renderWithIntl('en', withAi, <ProjectTriagePanel orgSlug="demo-org" />);
    expect(html).toContain('Kho vận Q4');
    expect(html).toContain(en.projects.triage.ai.badge);
    expect(html).toContain(en.projects.triage.ai.askBtn);
    expect(html).toContain(en.projects.triage.taintedBadge);
    expect(html).toContain(en.projects.triage.accept.submit);
  });

  it('renders 1-click SendToTriageDialog trigger with >= 44px touch target', () => {
    const html = renderWithIntl(
      'vi',
      TRIAGE_LIST_DATA,
      <SendToTriageDialog
        slug="demo-org"
        sourceType="kernel.conversation"
        sourceId="00000000-0000-4000-8000-000000000601"
        defaultTitle="Khách hỏi báo giá"
        buttonTestId="conversation-send-to-triage-btn"
      />,
    );
    expect(html).toContain('data-testid="conversation-send-to-triage-btn"');
    expect(html).toContain(viMessages.projects.triage.sendDialog.trigger);
    expect(html).toContain('min-h-11');

    modulesState.modules = ['meetings', 'crm'];
    try {
      const hiddenHtml = renderWithIntl(
        'vi',
        TRIAGE_LIST_DATA,
        <SendToTriageDialog
          slug="demo-org"
          sourceType="kernel.conversation"
          sourceId="00000000-0000-4000-8000-000000000601"
          defaultTitle="Khách hỏi báo giá"
          buttonTestId="conversation-send-to-triage-btn"
        />,
      );
      expect(hiddenHtml).toBe('');
    } finally {
      modulesState.modules = ['projects', 'meetings', 'crm'];
    }
  });

  it('renders Load more pagination button when nextCursor is present and deduplicates merged pages across scope switches', () => {
    const pagedData: ProjectTriageListResult = {
      ...TRIAGE_LIST_DATA,
      nextCursor: { createdAt: '2026-11-20T09:00:00.000Z', id: ITEM_1 },
    };
    const htmlVi = renderWithIntl('vi', pagedData, <ProjectTriagePanel orgSlug="demo-org" projectId={PROJECT_1} />);
    expect(htmlVi).toContain('data-testid="triage-load-more-btn"');
    expect(htmlVi).toContain(viMessages.projects.triage.loadMore);

    const htmlEn = renderWithIntl('en', pagedData, <ProjectTriagePanel orgSlug="demo-org" />);
    expect(htmlEn).toContain('data-testid="triage-load-more-btn"');
    expect(htmlEn).toContain(en.projects.triage.loadMore);

    const htmlDone = renderWithIntl('vi', TRIAGE_LIST_DATA, <ProjectTriagePanel orgSlug="demo-org" projectId={PROJECT_1} />);
    expect(htmlDone).not.toContain('data-testid="triage-load-more-btn"');

    // Accumulated extra pages match same scopeKey and deduplicate overlapping IDs, while dropping on filter change.
    const merged = mergeTriagePages(
      [TRIAGE_LIST_DATA.items[0]!],
      { scopeKey: `${PROJECT_1}:pending`, items: TRIAGE_LIST_DATA.items },
      `${PROJECT_1}:pending`,
    );
    expect(merged.map((i) => i.id)).toEqual([ITEM_1, ITEM_2]);
    const resetOnFilterChange = mergeTriagePages(
      [TRIAGE_LIST_DATA.items[0]!],
      { scopeKey: `${PROJECT_1}:pending`, items: TRIAGE_LIST_DATA.items },
      'all:snoozed',
    );
    expect(resetOnFilterChange.map((i) => i.id)).toEqual([ITEM_1]);
  });

  it('preserves valid user-selected project in SendToTriageDialog across re-renders and refetches', () => {
    const P1 = '00000000-0000-4000-8000-000000000011';
    const P2 = '00000000-0000-4000-8000-000000000012';
    // Initial open selects defaultProjectId.
    const onOpen = resolveSendDialogProjectSelection({
      initializedOnOpen: false,
      projectId: '',
      defaultProjectId: P1,
      writableProjectIds: [P1, P2],
    });
    expect(onOpen).toEqual({ nextProjectId: P1, initializedOnOpen: true });

    // User switches to P2; subsequent re-renders with defaultProjectId=P1 MUST preserve P2.
    const afterUserSelect = resolveSendDialogProjectSelection({
      initializedOnOpen: true,
      projectId: P2,
      defaultProjectId: P1,
      writableProjectIds: [P1, P2],
    });
    expect(afterUserSelect).toEqual({ nextProjectId: P2, initializedOnOpen: true });

    // If user's selection becomes archived/unwritable, safely falls back to valid project.
    const afterRemoved = resolveSendDialogProjectSelection({
      initializedOnOpen: true,
      projectId: P2,
      defaultProjectId: P1,
      writableProjectIds: [P1],
    });
    expect(afterRemoved).toEqual({ nextProjectId: P1, initializedOnOpen: true });
  });
});
