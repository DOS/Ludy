// SPDX-License-Identifier: AGPL-3.0-only
// UI and helper tests for custom project board columns (#2605, ADR-0056) in English and Vietnamese.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectBoard, ProjectColumn, ProjectTaskCard, ProjectWeeklyStatus as ProjectWeeklyStatusData } from '@ludy/kernel-contract';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { activeLocale, catalog } from '../src/i18n/runtime.ts';
import {
  commitBoardColumnMove,
  groupBoardTasksByColumn,
  optimisticMoveColumn,
  projectWeeklyStatusQueryKey,
  resolveBoardColumnId,
  type BoardOrderClient,
} from '../src/lib/projects.ts';

const authState = vi.hoisted(() => ({ modules: ['projects', 'notes'] as string[] }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: authState.modules }),
}));

const queryClientState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC();
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
  return {
    client: node([]),
    clientForOrg: () => node([]),
    orpc: node([]),
    queryClient: queryClientState.current,
    errorMessage: String,
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'demo-org', id: '00000000-0000-4000-8000-000000000001' }),
    useNavigate: () => () => Promise.resolve(),
    Link: ({ children, to, ...rest }: { children?: ReactNode; to: string; 'data-testid'?: string; className?: string }) =>
      createElement('a', { href: to, 'data-testid': rest['data-testid'], className: rest.className }, children),
  };
});

const { ProjectBoardView } = await import('../src/components/project-board.tsx');
const { ProjectColumnsDialogBody } = await import('../src/components/project-columns-dialog.tsx');
const { ProjectWeeklyStatus } = await import('../src/components/project-weekly-status.tsx');
const { ProjectDetailPage } = await import('../src/routes/projects.tsx');

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

const wrap = (locale: 'vi' | 'en', node: ReactNode) => (
  <QueryClientProvider client={queryClientState.current}>
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

const col = (id: string, name: string, taskStatus: ProjectColumn['taskStatus'], overrides: Partial<ProjectColumn> = {}): ProjectColumn => ({
  id,
  projectId: PROJECT_ID,
  name,
  taskStatus,
  color: 'neutral',
  wipLimit: null,
  sortKey: 'a0',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

const task = (id: string, title: string, overrides: Partial<ProjectTaskCard> = {}): ProjectTaskCard => ({
  id,
  title,
  description: null,
  status: 'todo',
  columnId: null,
  assigneePositionId: null,
  due: null,
  checklist: [],
  tainted: false,
  checkedOut: false,
  commentCount: 0,
  createdAt: '2026-11-10T01:00:00.000Z',
  addedAt: '2026-11-10T01:00:00.000Z',
  ...overrides,
});

describe('projects custom board columns helpers & UI (#2605)', () => {
  it('resolves column assignment deterministically with zero-setup fallback and stale-column agent status fallback', () => {
    const cTodo = col('col-todo', 'Tồn đọng', 'todo', { sortKey: 'a0' });
    const cDesign = col('col-design', 'Thiết kế', 'in_progress', { color: 'primary', wipLimit: 1, sortKey: 'a1' });
    const cQa = col('col-qa', 'QA', 'in_progress', { color: 'warning', wipLimit: 2, sortKey: 'a2' });
    const cDone = col('col-done', 'Hoàn tất', 'done', { color: 'success', sortKey: 'a3' });
    const customCols = [cTodo, cDesign, cQa, cDone];

    // v1 unconfigured mode keeps 5 canonical buckets.
    expect(groupBoardTasksByColumn([task('t1', 'Việc A')], [], false).map((b) => b.key)).toEqual([
      'todo',
      'in_progress',
      'waiting',
      'in_review',
      'done',
    ]);

    // Task assigned to second in_progress column (cQa) stays in cQa; stale columnId (cTodo) with status in_progress
    // falls back deterministically to the first matching column (cDesign); task with unmapped status (in_review)
    // still renders in a fallback canonical bucket so nothing disappears.
    const tExact = task('t-exact', 'Test UI', { status: 'in_progress', columnId: cQa.id });
    const tAgentMoved = task('t-agent', 'Agent updated status', { status: 'in_progress', columnId: cTodo.id });
    const tUnmapped = task('t-unmapped', 'Chờ duyệt ngoài luồng', { status: 'in_review', columnId: null });
    expect(resolveBoardColumnId(customCols, tExact)).toBe(cQa.id);
    expect(resolveBoardColumnId(customCols, tAgentMoved)).toBe(cDesign.id);
    expect(resolveBoardColumnId(customCols, tUnmapped)).toBeNull();

    const buckets = groupBoardTasksByColumn([tExact, tAgentMoved, tUnmapped], customCols, false);
    expect(buckets.map((b) => b.key)).toEqual([cTodo.id, cDesign.id, cQa.id, cDone.id, 'in_review']);
    expect(buckets.find((b) => b.key === cQa.id)?.tasks.map((x) => x.id)).toEqual(['t-exact']);
    expect(buckets.find((b) => b.key === cDesign.id)?.tasks.map((x) => x.id)).toEqual(['t-agent']);
    expect(buckets.find((b) => b.key === 'in_review')?.tasks.map((x) => x.id)).toEqual(['t-unmapped']);

    // Optimistic column move sets both columnId and canonical status.
    const moved = optimisticMoveColumn([tExact], 't-exact', cDone);
    expect(moved[0]).toMatchObject({ id: 't-exact', status: 'done', columnId: cDone.id });
  });

  it('commits cross-column moves atomically through moveTaskColumn with fallback for legacy clients', async () => {
    const calls: string[] = [];
    let committed = false;
    const modernClient: BoardOrderClient = {
      setTaskStatus: async () => {
        calls.push('setTaskStatus');
      },
      reorderTask: async () => {
        calls.push('reorderTask');
      },
      moveTaskColumn: async (input) => {
        calls.push(`moveTaskColumn:${input.columnId}:${input.place ?? 'none'}:${input.anchorId ?? 'none'}`);
      },
    };
    const cQa = col('col-qa', 'QA', 'in_progress');
    await commitBoardColumnMove(
      modernClient,
      { projectId: PROJECT_ID, taskId: 'task-1', column: cQa, placement: { place: 'before', anchorId: 'task-2' } },
      () => {
        committed = true;
      },
      () => '00000000-0000-4000-8000-000000000099',
    );
    expect(committed).toBe(true);
    expect(calls).toEqual([`moveTaskColumn:${cQa.id}:before:task-2`]);

    const legacyCalls: string[] = [];
    const legacyClient: BoardOrderClient = {
      setTaskStatus: async (i) => {
        legacyCalls.push(`setTaskStatus:${i.status}`);
      },
      reorderTask: async () => {
        legacyCalls.push('reorderTask');
      },
    };
    await commitBoardColumnMove(
      legacyClient,
      { projectId: PROJECT_ID, taskId: 'task-1', column: cQa },
      () => {},
      () => '00000000-0000-4000-8000-000000000099',
    );
    expect(legacyCalls).toEqual(['setTaskStatus:in_progress']);
  });

  it('renders custom columns, semantic color dots, soft WIP warnings, QuickAdd column buttons, and >=44px switchers', () => {
    const cTodo = col('col-1', 'Tồn đọng', 'todo', { color: 'neutral', sortKey: 'a0' });
    const cDev = col('col-2', 'Đang làm', 'in_progress', { color: 'primary', wipLimit: 1, sortKey: 'a1' });
    const cDone = col('col-3', 'Xong', 'done', { color: 'success', wipLimit: 5, sortKey: 'a2' });
    const customCols = [cTodo, cDev, cDone];

    const tasks = [
      task('t-1', 'Thiết kế bảng', { status: 'in_progress', columnId: cDev.id }),
      task('t-2', 'Viết API cột', { status: 'in_progress', columnId: cDev.id, checkedOut: true }),
      task('t-3', 'Chốt tài liệu', { status: 'done', columnId: cDone.id }),
    ];
    const noop = () => {};

    const boardHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <ProjectBoardView
          slug="demo-org"
          view="board"
          tasks={tasks}
          seats={[]}
          columns={customCols}
          canEdit
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={noop}
          onMoveColumn={noop}
          onCreateTask={noop}
          onEditTask={noop}
          onRemoveTask={noop}
        />,
      ),
    );
    expect(boardHtml).toContain(`data-column-id="${cDev.id}"`);
    expect(boardHtml).toContain('bg-primary');
    expect(boardHtml).toContain('bg-success');
    expect(boardHtml).toContain('column-wip-exceeded');
    expect(boardHtml).toContain('Vượt mức (2/1)');
    expect(boardHtml).toContain('column-wip-count');
    expect(boardHtml).toContain('1/5');
    expect(boardHtml).toContain(`quick-add-column-${cDev.id}`);
    expect(boardHtml).toContain('card-column-switcher');
    expect(boardHtml).toContain('min-h-11');
    expect(boardHtml).toContain('Chuyển Thiết kế bảng sang cột');
    expect(boardHtml).toContain('disabled=""');

    const listHtml = renderToStaticMarkup(
      wrap(
        'en',
        <ProjectBoardView
          slug="demo-org"
          view="list"
          tasks={tasks}
          seats={[]}
          columns={customCols}
          canEdit
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={noop}
          onMoveColumn={noop}
          onCreateTask={noop}
          onEditTask={noop}
          onRemoveTask={noop}
        />,
      ),
    );
    expect(listHtml).toContain('Move Thiết kế bảng to column');
    expect(listHtml).toContain('min-h-11');
  });

  it('renders ProjectColumnsDialogBody opt-in, editing, delete guard, and max-12 states plus ProjectDetailPage button and WeeklyStatus breakdown', () => {
    const emptyVi = renderToStaticMarkup(
      wrap('vi', <ProjectColumnsDialogBody projectId={PROJECT_ID} columns={[]} canManage />),
    );
    expect(emptyVi).toContain('project-columns-empty-state');
    expect(emptyVi).toContain('init-default-columns-button');
    expect(emptyVi).toContain('Bật cột tùy chỉnh');

    const cTodo = col('col-1', 'To do', 'todo', { sortKey: 'a0' });
    const cDev = col('col-2', 'Review UI', 'in_review', { color: 'proposal', wipLimit: 3, sortKey: 'a1' });
    const cDone = col('col-3', 'Done', 'done', { color: 'success', sortKey: 'a2' });
    const configuredEn = renderToStaticMarkup(
      wrap('en', <ProjectColumnsDialogBody projectId={PROJECT_ID} columns={[cTodo, cDev, cDone]} canManage />),
    );
    expect(configuredEn).toContain('project-columns-list');
    expect(configuredEn).toContain('WIP 3');
    expect(configuredEn).toContain('add-column-form');
    expect(configuredEn).toContain('create-column-button');
    expect(configuredEn).toContain('Keep at least one To do column and one Done column.');

    // When 12 columns exist, hides add form and renders max-12 notice.
    const twelveCols = Array.from({ length: 12 }, (_, idx) =>
      col(`col-${idx}`, `Column ${idx}`, idx === 0 ? 'todo' : idx === 11 ? 'done' : 'in_progress', { sortKey: `a${idx}` }),
    );
    const maxHtml = renderToStaticMarkup(
      wrap('en', <ProjectColumnsDialogBody projectId={PROJECT_ID} columns={twelveCols} canManage />),
    );
    expect(maxHtml).toContain('project-columns-max-notice');
    expect(maxHtml).toContain('maximum of 12 columns.');
    expect(maxHtml).not.toContain('add-column-form');

    // Detail page button renders for managers only on non-archived projects; WeeklyStatus renders custom column chips.
    const qc = queryClientState.current;
    qc.clear();
    const boardData: ProjectBoard = {
      project: {
        id: PROJECT_ID,
        name: 'Khai triển Q4',
        description: null,
        ownerUserId: null,
        ownerName: null,
        status: 'active',
        canManage: true,
        canWrite: true,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
      members: [],
      seats: [],
      isTeamOrg: false,
      viewerHasSeat: false,
      columns: [cTodo, cDev, cDone],
      tasks: [],
      totalVisible: 0,
      hiddenByEntityCount: 0,
      truncated: false,
    };
    qc.setQueryData(['projects', 'board', { projectId: PROJECT_ID }], boardData);

    const detailHtml = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(detailHtml).toContain('customize-columns-button');
    expect(detailHtml).toContain('Tùy chỉnh cột');

    const weeklyData: ProjectWeeklyStatusData = {
      ai: 'off',
      project: { id: PROJECT_ID, name: 'Khai triển Q4', status: 'active' },
      window: { from: '2026-11-10', to: '2026-11-16', nextFrom: '2026-11-17', nextTo: '2026-11-23', timeZone: 'Asia/Ho_Chi_Minh' },
      counts: { totalVisible: 4, doneThisWeek: 1, overdue: 0, waiting: 0, dueNextWeek: 1 },
      columns: [
        { id: cTodo.id, name: 'Tồn đọng', taskStatus: 'todo', color: 'neutral', wipLimit: null, taskCount: 1 },
        { id: cDev.id, name: 'Review UI', taskStatus: 'in_review', color: 'proposal', wipLimit: 1, taskCount: 3 },
      ],
      tasks: { doneThisWeek: [], overdue: [], waiting: [], dueNextWeek: [] },
      hiddenByEntityCount: 0,
      sentences: [],
      truncated: false,
    };
    qc.setQueryData(projectWeeklyStatusQueryKey('demo-org', PROJECT_ID, activeLocale()), weeklyData);
    const weeklyHtml = renderToStaticMarkup(
      wrap('vi', <ProjectWeeklyStatus slug="demo-org" projectId={PROJECT_ID} projectStatus="active" canManage defaultOpen />),
    );
    expect(weeklyHtml).toContain('project-weekly-status-columns');
    expect(weeklyHtml).toContain('Review UI');
    expect(weeklyHtml).toContain('3/1 (vượt mức)');
  });
});
