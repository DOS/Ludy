// SPDX-License-Identifier: AGPL-3.0-only
// SSR and UI contract checks for Notes v2 Vy planner (T4b) and inbox organizer (E5b) (#3563):
// triggers, viewer hiding, ARIA regions, 44px mobile tap targets (max-md:min-h-11), "Đề xuất" badges, and blocked hints.
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { NotebookSummary, NoteOrganizeResult, TodoPlanResult } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement } = await import('react');
  return {
    Sheet: ({ open = true, children }: { open?: boolean; children?: ReactNode }) => (open ? createElement('div', { 'data-slot': 'sheet' }, children) : null),
    SheetContent: ({ closeLabel, children, ...rest }: { closeLabel: string; children?: ReactNode; [k: string]: unknown }) =>
      createElement('div', { role: 'dialog', 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'sheet-header' }, children),
    SheetBody: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'sheet-body' }, children),
    SheetFooter: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-slot': 'sheet-footer' }, children),
    SheetTitle: ({ children }: { children?: ReactNode }) => createElement('h2', { 'data-slot': 'sheet-title' }, children),
    SheetDescription: ({ children }: { children?: ReactNode }) => createElement('p', { 'data-slot': 'sheet-description' }, children),
  };
});

const queryClientState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => ({
            queryKey: [...path, args?.input ?? {}],
            queryFn: () => Promise.reject(new Error('not fetched in unit test')),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'call') return () => Promise.resolve({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { client: node([]), clientForOrg: () => node([]), orpc: node([]), queryClient: queryClientState.current, errorMessage: String };
});

import { MyWorkVyPlannerPanel, MyWorkVyPlannerTrigger } from '../src/components/my-work-vy-planner.tsx';
import { NotesVyOrganizerPanel, NotesVyOrganizerTrigger } from '../src/components/notes-vy-organizer.tsx';
import { orpc } from '../src/lib/api.ts';

function wrap(locale: 'vi' | 'en', node: ReactNode) {
  return (
    <QueryClientProvider client={queryClientState.current}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>
  );
}

const OK_METER = {
  aiOn: true,
  state: 'ok' as const,
  percent: 10,
  scope: null,
  resetAt: '2026-12-01',
};

describe('Notes v2 Vy UI components (#3563)', () => {
  it('renders MyWorkVyPlannerTrigger with >= 44px mobile target and hides it for viewers', () => {
    const qc = queryClientState.current;
    qc.clear();
    qc.setQueryData(orpc.me.get.queryOptions().queryKey, {
      userId: 'u1',
      email: 'u1@example.com',
      displayName: null,
      orgs: [{ orgId: 'o1', slug: 'demo-org', name: 'Demo', role: 'member' }],
    });
    const ref = createRef<HTMLButtonElement>();
    const memberHtml = renderToStaticMarkup(
      wrap('vi', <MyWorkVyPlannerTrigger slug="demo-org" open={false} onToggle={() => {}} buttonRef={ref} />),
    );
    expect(memberHtml).toContain('Vy sắp lịch hôm nay');
    expect(memberHtml).toContain('my-work-vy-plan-btn');
    expect(memberHtml).toContain('max-md:min-h-11');
    expect(memberHtml).not.toContain('trợ lý');

    qc.setQueryData(orpc.me.get.queryOptions().queryKey, {
      userId: 'u1',
      email: 'u1@example.com',
      displayName: null,
      orgs: [{ orgId: 'o1', slug: 'demo-org', name: 'Demo', role: 'viewer' }],
    });
    const viewerHtml = renderToStaticMarkup(
      wrap('vi', <MyWorkVyPlannerTrigger slug="demo-org" open={false} onToggle={() => {}} buttonRef={ref} />),
    );
    expect(viewerHtml).toBe('');
  });

  it('renders MyWorkVyPlannerPanel blocked state and ready focus/reschedule proposal rows with Đề xuất badge', () => {
    const qc = queryClientState.current;
    qc.clear();
    qc.setQueryData(orpc.me.get.queryOptions().queryKey, {
      userId: 'u1',
      email: 'u1@example.com',
      displayName: null,
      orgs: [{ orgId: 'o1', slug: 'demo-org', name: 'Demo', role: 'member' }],
    });
    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: false,
      reason: 'budget',
      resetOn: '2026-12-01',
    });
    qc.setQueryData(orpc.ai.meter.queryOptions({ input: { module: 'notes' } }).queryKey, OK_METER);

    const ref = createRef<HTMLButtonElement>();
    const blockedHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <MyWorkVyPlannerPanel slug="demo-org" open viewerTz="Asia/Ho_Chi_Minh" triggerRef={ref} onClose={() => {}} />,
      ),
    );
    expect(blockedHtml).toContain('my-work-vy-planner');
    expect(blockedHtml).toContain('role="region"');
    expect(blockedHtml).toContain('Vy đề xuất · AI');
    expect(blockedHtml).toContain('my-work-vy-blocked');
    expect(blockedHtml).toContain('max-md:min-h-11');

    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: true,
      reason: null,
      resetOn: null,
    });
    const samplePlan: TodoPlanResult = {
      state: 'ready',
      runId: '40000000-0000-4000-8000-000000000001',
      today: '2026-11-21',
      focus: [
        {
          todoId: '30000000-0000-4000-8000-000000000011',
          title: 'Nộp tờ khai thuế',
          priority: 1,
          dueOn: '2026-11-20',
          dueTime: null,
          overdue: true,
          reason: 'Quá hạn cần xử lý ngay',
          revision: 1,
        },
      ],
      reschedules: [
        {
          todoId: '30000000-0000-4000-8000-000000000011',
          title: 'Nộp tờ khai thuế',
          currentDueOn: '2026-11-20',
          dueOn: '2026-11-22',
          reason: 'Dời sang ngày mai',
          revision: 1,
        },
      ],
      dropped: 0,
      errorCode: null,
    };
    const readyHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <MyWorkVyPlannerPanel
          slug="demo-org"
          open
          viewerTz="Asia/Ho_Chi_Minh"
          triggerRef={ref}
          onClose={() => {}}
          initialResult={samplePlan}
        />,
      ),
    );
    expect(readyHtml).toContain('Nộp tờ khai thuế');
    expect(readyHtml).toContain('Đề xuất');
    expect(readyHtml).toContain('border-dashed border-proposal/60 bg-proposal/5');
    expect(readyHtml).toContain('data-testid="coworker-attribution"');
    expect(readyHtml).toContain('my-work-vy-focus-proposal-badge-30000000-0000-4000-8000-000000000011');
    expect(readyHtml).toContain('my-work-vy-reschedule-apply-30000000-0000-4000-8000-000000000011');
    expect(readyHtml).not.toContain('uppercase');
  });

  it('renders NotesVyOrganizerTrigger and NotesVyOrganizerPanel with AI badge, Đề xuất proposals, and paused hint', () => {
    const qc = queryClientState.current;
    qc.clear();
    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: false,
      reason: 'paused',
      resetOn: null,
    });
    qc.setQueryData(orpc.ai.meter.queryOptions({ input: { module: 'notes' } }).queryKey, OK_METER);

    const ref = createRef<HTMLButtonElement>();
    const triggerHtml = renderToStaticMarkup(
      wrap('vi', <NotesVyOrganizerTrigger open={false} onToggle={() => {}} buttonRef={ref} />),
    );
    expect(triggerHtml).toContain('Vy dọn hộp thư');
    expect(triggerHtml).toContain('notes-vy-organize-btn');
    expect(triggerHtml).toContain('max-md:min-h-11');

    const notebooks: NotebookSummary[] = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        authorUserId: 'u1',
        visibility: 'private',
        name: 'Tài chính cá nhân',
        stackName: null,
        pinned: false,
        sortKey: '000001',
        noteCount: 0,
        mine: true,
        editable: true,
        revision: 1,
        createdAt: '2026-11-21T00:00:00Z',
        updatedAt: '2026-11-21T00:00:00Z',
      },
    ];
    const pausedHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <NotesVyOrganizerPanel slug="demo-org" open notebooks={notebooks} triggerRef={ref} onClose={() => {}} />,
      ),
    );
    expect(pausedHtml).toContain('notes-vy-organizer');
    expect(pausedHtml).toContain('Vy đề xuất · AI');
    expect(pausedHtml).toContain('notes-vy-organize-blocked');
    expect(pausedHtml).not.toContain('trợ lý');

    qc.setQueryData(orpc.notes.vyStatus.queryOptions({ input: {} }).queryKey, {
      available: true,
      reason: null,
      resetOn: null,
    });
    const sampleOrganize: NoteOrganizeResult = {
      state: 'ready',
      runId: '40000000-0000-4000-8000-000000000002',
      suggestions: [
        {
          noteId: '20000000-0000-4000-8000-000000000021',
          title: 'Biên lai tiền điện',
          visibility: 'private',
          revision: 1,
          existingTags: [],
          notebookId: '10000000-0000-4000-8000-000000000001',
          notebookName: 'Tài chính cá nhân',
          tags: ['evn', 'hóa đơn'],
          reason: 'Thuộc chi phí hàng tháng',
          canEditTags: true,
        },
      ],
      dropped: 0,
      errorCode: null,
    };
    const readyHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <NotesVyOrganizerPanel
          slug="demo-org"
          open
          notebooks={notebooks}
          triggerRef={ref}
          onClose={() => {}}
          initialResult={sampleOrganize}
        />,
      ),
    );
    expect(readyHtml).toContain('Biên lai tiền điện');
    expect(readyHtml).toContain('Tài chính cá nhân');
    expect(readyHtml).toContain('#evn');
    expect(readyHtml).toContain('Đề xuất');
    expect(readyHtml).toContain('border-dashed border-proposal/60 bg-proposal/5');
    expect(readyHtml).toContain('data-testid="coworker-attribution"');
    expect(readyHtml).toContain('notes-vy-organize-apply-20000000-0000-4000-8000-000000000021');
  });

  it('mounts both Vy organizer panels inside right-hand Sheet drawers with focus return and no Vietnamese uppercase headings', () => {
    const plannerSource = readFileSync(new URL('../src/components/my-work-vy-planner.tsx', import.meta.url), 'utf8');
    const organizerSource = readFileSync(new URL('../src/components/notes-vy-organizer.tsx', import.meta.url), 'utf8');
    for (const [label, src] of [
      ['my-work-vy-planner', plannerSource],
      ['notes-vy-organizer', organizerSource],
    ] as const) {
      expect(src, label).toContain("@ludy/ui/components/sheet");
      expect(src, label).toContain('<SheetContent');
      expect(src, label).toContain('triggerRef.current');
      expect(src, label).toContain('<ProposalSurface');
      expect(src, label).toContain('<CoworkerAttribution');
      expect(src, label).not.toContain('uppercase');
    }
  });
});
