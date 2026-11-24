// SPDX-License-Identifier: AGPL-3.0-only
// SSR and UI contract checks for #4492 omnichannel roadmap signals modal and moderation panel.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'use-intl';
import type { DealCursor } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const { rpcCalls, capturedButtons } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ path: string; args: unknown }>,
  capturedButtons: new Map<string, { onClick?: (() => void) | undefined }>(),
}));

function makeProxy(path: string[] = []): unknown {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'queryOptions') {
        return (opts: { input?: unknown } = {}) => ({
          queryKey: ['orpc', ...path, opts.input ?? null],
          queryFn: async () => {
            const joined = path.join('.');
            rpcCalls.push({ path: joined, args: opts.input ?? null });
            if (joined === 'projects.roadmap.boards') {
              return { orgSlug: 'acme', boards: [], projects: [], seats: [], canWrite: true, canManageBoard: true };
            }
            return null;
          },
        });
      }
      if (prop === 'infiniteOptions') {
        return (opts: { input?: unknown; initialPageParam?: unknown; getNextPageParam?: unknown } = {}) => ({
          queryKey: ['orpc', ...path],
          queryFn: async () => {
            rpcCalls.push({ path: path.join('.'), args: opts.input ?? null });
            return { items: [], next: null };
          },
          initialPageParam: opts.initialPageParam,
          getNextPageParam: opts.getNextPageParam,
        });
      }
      if (prop === 'key') {
        return () => ['orpc', ...path];
      }
      if (prop === 'mutationOptions') {
        return (opts: Record<string, unknown> = {}) => ({ ...opts });
      }
      if (prop === 'call') {
        return async (args: unknown) => {
          rpcCalls.push({ path: path.join('.'), args });
          return null;
        };
      }
      return makeProxy([...path, String(prop)]);
    },
  });
}

vi.mock('../src/lib/api.ts', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  return {
    orpc: makeProxy(),
    queryClient,
    client: {},
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    apiFetch: async () => ({ ok: true, json: async () => ({}) }),
  };
});

vi.mock('../src/lib/org-modules.ts', () => ({
  installedModules: () => ['projects', 'crm', 'meetings'],
  useModulesVersion: () => 0,
}));

vi.mock('@ludy/ui/components/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@ludy/ui/components/button', async () => {
  const actual = await vi.importActual<typeof import('@ludy/ui/components/button')>('@ludy/ui/components/button');
  const ActualButton = actual.Button;
  return {
    ...actual,
    Button: (props: React.ComponentProps<typeof ActualButton> & { 'data-testid'?: string }) => {
      if (props['data-testid']) {
        capturedButtons.set(
          props['data-testid'],
          props.onClick ? { onClick: props.onClick as () => void } : {},
        );
      }
      return <ActualButton {...props} />;
    },
  };
});

import { ExpandedItemSignals, ProjectRoadmapPanel } from '../src/components/project-roadmap-panel.tsx';
import {
  buildRoadmapSignalAttempt,
  buildRoadmapSignalCreatePayload,
  RoadmapSignalModal,
} from '../src/components/roadmap-signal-modal.tsx';
import { orpc, queryClient } from '../src/lib/api.ts';

async function renderWithProviders(element: React.ReactElement, locale: 'vi' | 'en' = 'en') {
  const rootRoute = createRootRoute({ component: () => element });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => element });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <RouterProvider router={router} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('Omnichannel roadmap signals UI (#4492)', () => {
  afterEach(() => {
    queryClient.clear();
    rpcCalls.length = 0;
    capturedButtons.clear();
  });

  it('renders board-level and item-level stacked per-currency demand rollup pills with Add Signal button in moderation panel', async () => {
    const boardId = '00000000-0000-4000-8000-000000000001';
    const itemId = '00000000-0000-4000-8000-000000000010';
    const signalId = '00000000-0000-4000-8000-000000000020';

    queryClient.setQueryData(orpc.projects.roadmap.boards.queryOptions({ input: {} }).queryKey, {
      orgSlug: 'acme',
      boards: [
        {
          id: boardId,
          title: 'Product Roadmap',
          slug: 'roadmap',
          description: null,
          projectId: null,
          projectName: null,
          pendingCount: 0,
          publishedCount: 1,
          enabled: true,
          allowSubmissions: true,
          allowVoting: true,
          requireModeration: true,
          embedAllowedOrigins: [],
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      projects: [],
      seats: [],
      canWrite: true,
      canManageBoard: true,
    });

    queryClient.setQueryData(orpc.projects.roadmap.boardDetail.queryOptions({ input: { boardId } }).queryKey, {
      board: {
        id: boardId,
        title: 'Product Roadmap',
        slug: 'roadmap',
        description: null,
        projectId: null,
        projectName: null,
        pendingCount: 0,
        publishedCount: 1,
        enabled: true,
        allowSubmissions: true,
        allowVoting: true,
        requireModeration: true,
        embedAllowedOrigins: [],
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
      items: [
        {
          id: itemId,
          boardId,
          linkedTaskId: null,
          linkedProjectId: null,
          linkedProjectName: null,
          linkedTaskStatus: null,
          source: 'internal',
          moderationStatus: 'published',
          mergedIntoItemId: null,
          stage: 'planned',
          category: 'Billing',
          publicTitle: 'Batch e-invoice export',
          publicSummary: 'Generate monthly VAT files cleanly',
          voteCount: 4,
          tainted: false,
          submitterDisplayName: null,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      announcements: [],
      activeSubscriberCount: 0,
      canWrite: true,
      canManageBoard: true,
    });

    queryClient.setQueryData(orpc.projects.roadmap.signalRollup.queryOptions({ input: { boardId } }).queryKey, {
      boardId,
      totalSignals: 3,
      distinctAccountCount: 2,
      sourceCounts: { crmDeal: 2, conversation: 1, meeting: 0 },
      valueByCurrency: [
        { currency: 'USD', totalAmount: '1500.00', signalCount: 1 },
        { currency: 'VND', totalAmount: '25000000.00', signalCount: 1 },
      ],
      byItem: [
        {
          roadmapItemId: itemId,
          totalSignals: 3,
          distinctAccountCount: 2,
          sourceCounts: { crmDeal: 2, conversation: 1, meeting: 0 },
          valueByCurrency: [
            { currency: 'USD', totalAmount: '1500.00', signalCount: 1 },
            { currency: 'VND', totalAmount: '25000000.00', signalCount: 1 },
          ],
        },
      ],
    });

    queryClient.setQueryData(orpc.projects.roadmap.signalList.queryOptions({ input: { boardId } }).queryKey, {
      signals: [
        {
          id: signalId,
          boardId,
          roadmapItemId: itemId,
          sourceType: 'crm.deal',
          sourceId: '00000000-0000-4000-8000-000000000099',
          accountLabel: 'Cong ty Minh Anh',
          quoteExcerpt: 'Need batch XML invoice export',
          dealValue: '25000000.00',
          dealCurrency: 'VND',
          tainted: true,
          createdBy: '00000000-0000-4000-8000-000000000002',
          createdAt: '2026-11-02T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
        },
      ],
    });

    const html = await renderWithProviders(<ProjectRoadmapPanel orgSlug="acme" />, 'en');

    expect(html).toContain(`data-testid="roadmap-admin-board-signal-rollup"`);
    expect(html).toContain(`data-testid="roadmap-admin-item-currency-${itemId}-USD"`);
    expect(html).toContain(`data-testid="roadmap-admin-item-currency-${itemId}-VND"`);
    expect(html).toContain(`data-testid="roadmap-admin-add-signal-${itemId}"`);
    expect(html).toContain(`data-testid="roadmap-admin-toggle-signals-${itemId}"`);
    expect(html).toContain(catalog('en').projects.roadmap.admin.signalsAddBtn);
    expect(html).toContain('USD');
    expect(html).toContain('VND');
  });

  it('defines all #4492 i18n keys cleanly for source-to-roadmap capture modal without em/en dashes', () => {
    const en = catalog('en');
    const vi = catalog('vi');
    expect(en.aiMeter.features.projects_roadmap_signal_match).toBeTruthy();
    expect(en.projects.roadmap.admin.linkToRoadmapBtn).toBe('Link to Roadmap');
    expect(en.projects.roadmap.admin.signalsAddBtn).toBe('Add Signal');
    expect(en.projects.roadmap.admin.signalLoadMoreDeals).toBe('Load more deals');
    expect(en.projects.roadmap.admin.signalRollupError).toBe('Could not load signal totals.');
    expect(en.projects.roadmap.admin.signalShowListFallback).toBe('Signals');
    expect(en.projects.roadmap.admin.signalHideListFallback).toBe('Hide signals');
    expect(en.projects.roadmap.admin.signalRetryBtn).toBe('Try again');
    expect(vi.projects.roadmap.admin.signalRollupError).toBe('Không thể tải tổng hợp tín hiệu.');
    expect(vi.projects.roadmap.admin.signalShowListFallback).toBe('Tín hiệu');
    expect(vi.projects.roadmap.admin.signalHideListFallback).toBe('Ẩn tín hiệu');
    expect(vi.projects.roadmap.admin.signalRetryBtn).toBe('Thử lại');
    for (const val of [
      en.projects.roadmap.admin.signalRollupError,
      en.projects.roadmap.admin.signalShowListFallback,
      en.projects.roadmap.admin.signalHideListFallback,
      en.projects.roadmap.admin.signalRetryBtn,
      vi.projects.roadmap.admin.signalRollupError,
      vi.projects.roadmap.admin.signalShowListFallback,
      vi.projects.roadmap.admin.signalHideListFallback,
      vi.projects.roadmap.admin.signalRetryBtn,
    ]) {
      expect(val).not.toMatch(/[—–]/);
    }
    expect(RoadmapSignalModal).toBeTypeOf('function');
  });

  it('omits unchanged CRM deal prefilled accountLabel on submit so server hydrates fresh under FOR KEY SHARE', () => {
    const base = {
      idempotencyKey: '00000000-0000-4000-8000-000000000099',
      boardId: '00000000-0000-4000-8000-000000000001',
      roadmapItemId: '00000000-0000-4000-8000-000000000010',
      sourceType: 'crm.deal' as const,
      sourceId: '00000000-0000-4000-8000-000000000020',
      prefillAccountLabel: 'Cong ty Minh Anh',
      quoteExcerpt: 'Need export',
      dealValue: '1000',
      dealCurrency: 'vnd',
    };

    const unchanged = buildRoadmapSignalCreatePayload({ ...base, accountLabel: ' Cong ty Minh Anh ' });
    expect('accountLabel' in unchanged).toBe(false);
    expect(unchanged.dealCurrency).toBe('VND');

    const cleared = buildRoadmapSignalCreatePayload({ ...base, accountLabel: '' });
    expect(cleared.accountLabel).toBeNull();

    const edited = buildRoadmapSignalCreatePayload({ ...base, accountLabel: 'Ten moi' });
    expect(edited.accountLabel).toBe('Ten moi');
  });

  it('reuses idempotency key on retries with identical fields and mints a fresh key when quoteExcerpt or accountLabel changes', () => {
    let seq = 0;
    const mintKey = () => `key-${++seq}`;
    const base = {
      boardId: '00000000-0000-4000-8000-000000000001',
      roadmapItemId: '00000000-0000-4000-8000-000000000010',
      sourceType: 'crm.deal' as const,
      sourceId: '00000000-0000-4000-8000-000000000020',
      accountLabel: 'Cong ty Minh Anh',
      prefillAccountLabel: 'Cong ty Minh Anh',
      quoteExcerpt: 'Need export',
      dealValue: '1000',
      dealCurrency: 'vnd',
      mintKey,
    };

    const first = buildRoadmapSignalAttempt({ ...base, previousAttempt: null });
    expect(first.payload.idempotencyKey).toBe('key-1');

    // Retry with identical normalized values (whitespace differences only) reuses key-1
    const retry = buildRoadmapSignalAttempt({
      ...base,
      accountLabel: ' Cong ty Minh Anh ',
      quoteExcerpt: '  Need export  ',
      dealCurrency: 'VND',
      previousAttempt: first.attempt,
    });
    expect(retry.payload.idempotencyKey).toBe('key-1');

    // Editing quoteExcerpt mints key-2
    const quoteEdited = buildRoadmapSignalAttempt({
      ...base,
      quoteExcerpt: 'Updated customer quote',
      previousAttempt: retry.attempt,
    });
    expect(quoteEdited.payload.idempotencyKey).toBe('key-2');
    expect(quoteEdited.attempt.sig).not.toBe(retry.attempt.sig);

    // Editing accountLabel (including overriding prefilled CRM account) mints key-3
    const accountEdited = buildRoadmapSignalAttempt({
      ...base,
      quoteExcerpt: 'Updated customer quote',
      accountLabel: 'Cong ty Khac',
      previousAttempt: quoteEdited.attempt,
    });
    expect(accountEdited.payload.idempotencyKey).toBe('key-3');
    expect(accountEdited.attempt.sig).not.toBe(quoteEdited.attempt.sig);
  });

  it('renders rollup error alert with retry button, fallback signal toggles, and empty signal state message when rollup fails', async () => {
    const boardId = '00000000-0000-4000-8000-000000000001';
    const itemId = '00000000-0000-4000-8000-000000000010';

    queryClient.setQueryData(orpc.projects.roadmap.boards.queryOptions({ input: {} }).queryKey, {
      orgSlug: 'acme',
      boards: [
        {
          id: boardId,
          title: 'Product Roadmap',
          slug: 'roadmap',
          description: null,
          projectId: null,
          projectName: null,
          pendingCount: 0,
          publishedCount: 1,
          enabled: true,
          allowSubmissions: true,
          allowVoting: true,
          requireModeration: true,
          embedAllowedOrigins: [],
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      projects: [],
      seats: [],
      canWrite: true,
      canManageBoard: true,
    });

    queryClient.setQueryData(orpc.projects.roadmap.boardDetail.queryOptions({ input: { boardId } }).queryKey, {
      board: {
        id: boardId,
        title: 'Product Roadmap',
        slug: 'roadmap',
        description: null,
        projectId: null,
        projectName: null,
        pendingCount: 0,
        publishedCount: 1,
        enabled: true,
        allowSubmissions: true,
        allowVoting: true,
        requireModeration: true,
        embedAllowedOrigins: [],
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
      items: [
        {
          id: itemId,
          boardId,
          linkedTaskId: null,
          linkedProjectId: null,
          linkedProjectName: null,
          linkedTaskStatus: null,
          source: 'internal',
          moderationStatus: 'published',
          mergedIntoItemId: null,
          stage: 'planned',
          category: 'Billing',
          publicTitle: 'Batch e-invoice export',
          publicSummary: 'Generate monthly VAT files cleanly',
          voteCount: 4,
          tainted: false,
          submitterDisplayName: null,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      announcements: [],
      activeSubscriberCount: 0,
      canWrite: true,
      canManageBoard: true,
    });

    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: orpc.projects.roadmap.signalRollup.queryOptions({ input: { boardId } }).queryKey })
      .setState({
        status: 'error',
        error: new Error('Rollup unavailable'),
        fetchStatus: 'idle',
        data: undefined,
        errorUpdateCount: 1,
      });

    const errorHtml = await renderWithProviders(<ProjectRoadmapPanel orgSlug="acme" />, 'en');
    expect(errorHtml).toContain(`data-testid="roadmap-admin-signal-rollup-error"`);
    expect(errorHtml).toContain(`data-testid="roadmap-admin-signal-rollup-retry"`);
    expect(errorHtml).toContain('min-h-11');
    expect(errorHtml).toContain('Rollup unavailable');
    expect(errorHtml).toContain(catalog('en').projects.roadmap.admin.signalRollupError);
    expect(errorHtml).toContain(catalog('en').projects.roadmap.admin.signalRetryBtn);
    expect(errorHtml).toContain(`data-testid="roadmap-admin-toggle-signals-${itemId}"`);
    expect(errorHtml).toContain(`>${catalog('en').projects.roadmap.admin.signalShowListFallback}<`);
    expect(errorHtml).not.toContain(`data-testid="roadmap-admin-board-signal-rollup"`);

    const errorHtmlVi = await renderWithProviders(<ProjectRoadmapPanel orgSlug="acme" />, 'vi');
    expect(errorHtmlVi).toContain(catalog('vi').projects.roadmap.admin.signalRollupError);
    expect(errorHtmlVi).toContain(catalog('vi').projects.roadmap.admin.signalRetryBtn);
    expect(errorHtmlVi).toContain(`>${catalog('vi').projects.roadmap.admin.signalShowListFallback}<`);

    queryClient.setQueryData(
      orpc.projects.roadmap.signalList.queryOptions({ input: { boardId, roadmapItemId: itemId, limit: 200 } }).queryKey,
      { signals: [] },
    );
    const emptySignalsHtml = await renderWithProviders(
      <ExpandedItemSignals
        boardId={boardId}
        roadmapItemId={itemId}
        canWrite={true}
        deletePending={false}
        onDeleteSignal={() => undefined}
      />,
      'en',
    );
    expect(emptySignalsHtml).toContain(catalog('en').projects.roadmap.admin.signalEmptyList);

    // When rollup succeeds with 0 signals, neither error alert nor per-item toggle renders
    queryClient.setQueryData(orpc.projects.roadmap.signalRollup.queryOptions({ input: { boardId } }).queryKey, {
      boardId,
      totalSignals: 0,
      distinctAccountCount: 0,
      sourceCounts: { crmDeal: 0, conversation: 0, meeting: 0 },
      valueByCurrency: [],
      byItem: [],
    });
    const zeroHtml = await renderWithProviders(<ProjectRoadmapPanel orgSlug="acme" />, 'en');
    expect(zeroHtml).not.toContain(`data-testid="roadmap-admin-signal-rollup-error"`);
    expect(zeroHtml).not.toContain(`data-testid="roadmap-admin-toggle-signals-${itemId}"`);
  });

  it('renders board load error with retry action instead of empty board notice when boardsQuery fails', async () => {
    const en = catalog('en').projects.roadmap.admin;
    const vi = catalog('vi').projects.roadmap.admin;
    expect(en.signalBoardsLoadError).not.toMatch(/[—–]/);
    expect(vi.signalBoardsLoadError).not.toMatch(/[—–]/);

    const boardsOpts = orpc.projects.roadmap.boards.queryOptions({ input: {} });
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: boardsOpts.queryKey, queryFn: boardsOpts.queryFn })
      .setState({
        status: 'error',
        error: new Error('Boards network error'),
        fetchStatus: 'idle',
        data: undefined,
        errorUpdateCount: 1,
      });

    const html = await renderWithProviders(
      <RoadmapSignalModal
        open={true}
        onOpenChange={() => undefined}
        prefillSource={{ sourceType: 'crm.deal', sourceId: '00000000-0000-4000-8000-000000000030' }}
      />,
      'en',
    );

    expect(html).toContain(`data-testid="roadmap-signal-boards-error"`);
    expect(html).toContain(`data-testid="roadmap-signal-boards-retry"`);
    expect(html).toContain('min-h-11');
    expect(html).toContain(en.signalBoardsLoadError);
    expect(html).toContain(en.signalRetryBtn);
    expect(html).not.toContain(en.signalBoardEmpty);
    expect(html).not.toContain(en.signalSubmitBtn);

    const htmlVi = await renderWithProviders(
      <RoadmapSignalModal
        open={true}
        onOpenChange={() => undefined}
        prefillSource={{ sourceType: 'crm.deal', sourceId: '00000000-0000-4000-8000-000000000030' }}
      />,
      'vi',
    );
    expect(htmlVi).toContain(vi.signalBoardsLoadError);
    expect(htmlVi).toContain(vi.signalRetryBtn);

    const retryBtn = capturedButtons.get('roadmap-signal-boards-retry');
    expect(retryBtn?.onClick).toBeTypeOf('function');
    const callsBefore = rpcCalls.length;
    retryBtn?.onClick?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(rpcCalls.slice(callsBefore).some((c) => c.path === 'projects.roadmap.boards')).toBe(true);
  });

  it('renders source load error with retry action and suppresses empty state when active source query fails without cached data', async () => {
    const en = catalog('en').projects.roadmap.admin;
    const vi = catalog('vi').projects.roadmap.admin;
    expect(en.signalSourcesLoadError).not.toMatch(/[—–]/);
    expect(vi.signalSourcesLoadError).not.toMatch(/[—–]/);

    const dealsOpts = orpc.crm.deals.list.infiniteOptions({
      input: (cursor: DealCursor | undefined) => ({ limit: 50, ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined as DealCursor | undefined,
      getNextPageParam: () => undefined,
    });
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: dealsOpts.queryKey, queryFn: dealsOpts.queryFn })
      .setState({
        status: 'error',
        error: new Error('Deals network error'),
        fetchStatus: 'idle',
        data: undefined,
        errorUpdateCount: 1,
      });

    const html = await renderWithProviders(
      <RoadmapSignalModal
        open={true}
        onOpenChange={() => undefined}
        fixedBoardId="00000000-0000-4000-8000-000000000001"
        fixedItem={{ id: '00000000-0000-4000-8000-000000000010', title: 'Export XML' }}
      />,
      'en',
    );

    expect(html).toContain(`data-testid="roadmap-signal-sources-error"`);
    expect(html).toContain(`data-testid="roadmap-signal-sources-retry"`);
    expect(html).toContain('min-h-11');
    expect(html).toContain(en.signalSourcesLoadError);
    expect(html).toContain(en.signalRetryBtn);
    expect(html).not.toContain(`data-testid="roadmap-signal-sources-empty"`);
    expect(html).not.toContain(en.signalSourcesEmpty);

    const htmlVi = await renderWithProviders(
      <RoadmapSignalModal
        open={true}
        onOpenChange={() => undefined}
        fixedBoardId="00000000-0000-4000-8000-000000000001"
        fixedItem={{ id: '00000000-0000-4000-8000-000000000010', title: 'Xuat XML' }}
      />,
      'vi',
    );
    expect(htmlVi).toContain(vi.signalSourcesLoadError);
    expect(htmlVi).toContain(vi.signalRetryBtn);

    const retryBtn = capturedButtons.get('roadmap-signal-sources-retry');
    expect(retryBtn?.onClick).toBeTypeOf('function');
    const callsBefore = rpcCalls.length;
    retryBtn?.onClick?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(rpcCalls.slice(callsBefore).some((c) => c.path === 'crm.deals.list')).toBe(true);
  });
});
