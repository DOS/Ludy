// SPDX-License-Identifier: AGPL-3.0-only
// Client helpers and SSR checks for Projects screens and board/list views (#2591, ADR-0048).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectBoard, ProjectListResult, ProjectSeat, ProjectTaskCard } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import {
  boardColumns,
  defaultProjectView,
  filterProjects,
  groupBoardTasks,
  hasUnseatedTeamMembers,
  isTaskOverdue,
  optimisticMoveTask,
  optimisticReorderTask,
  projectCompletionPct,
  sortBoardTasks,
  statusFilterIncludesCancelled,
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
  return { orpc: node([]), queryClient: queryClientState.current, errorMessage: String };
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
const { ProjectsPage, ProjectDetailPage, countOtherProjectMembers } = await import('../src/routes/projects.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => (
  <QueryClientProvider client={queryClientState.current}>
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

const card = (over: Partial<ProjectTaskCard>): ProjectTaskCard => ({
  id: '10000000-0000-4000-8000-000000000001',
  title: 'Kiểm tra chứng từ',
  description: null,
  status: 'todo',
  assigneePositionId: null,
  due: null,
  tainted: false,
  checkedOut: false,
  commentCount: 0,
  createdAt: '2026-11-10T01:00:00.000Z',
  addedAt: '2026-11-10T01:00:00.000Z',
  ...over,
});

const seat = (over: Partial<ProjectSeat>): ProjectSeat => ({
  id: '20000000-0000-4000-8000-000000000001',
  title: 'Kế toán trưởng',
  status: 'active',
  onProject: true,
  holder: { type: 'agent', agentId: '30000000-0000-4000-8000-000000000001', name: 'Kế toán AI' },
  ...over,
});

describe('projects helpers (#2591)', () => {
  it('defaults to list view on phone widths (<768px) and board view on wider screens', () => {
    expect(defaultProjectView(360)).toBe('list');
    expect(defaultProjectView(767)).toBe('list');
    expect(defaultProjectView(768)).toBe('board');
    expect(defaultProjectView(1280)).toBe('board');
  });

  it('keeps cancelled behind a filter in boardColumns', () => {
    expect(boardColumns(false)).toEqual(['todo', 'in_progress', 'waiting', 'in_review', 'done']);
    expect(boardColumns(true)).toEqual(['todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled']);
  });

  it('orders tasks by due ASC NULLS LAST, then createdAt ASC, then id ASC', () => {
    const tNullEarly = card({ id: 'b', due: null, createdAt: '2026-11-01T00:00:00.000Z' });
    const tNullLate = card({ id: 'a', due: null, createdAt: '2026-11-02T00:00:00.000Z' });
    const tDueLater = card({ id: 'c', due: '2026-11-20T00:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' });
    const tDueEarlier = card({ id: 'd', due: '2026-11-12T00:00:00.000Z', createdAt: '2026-11-05T00:00:00.000Z' });

    const sorted = sortBoardTasks([tNullLate, tDueLater, tNullEarly, tDueEarlier]);
    expect(sorted.map((t) => t.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('groups into status columns preserving manual order, omits cancelled unless asked, and moves/reorders optimistically', () => {
    const tFirst = card({ id: 't1', status: 'todo', due: '2026-11-25T00:00:00.000Z' });
    const tSecond = card({ id: 't2', status: 'todo', due: '2026-11-01T00:00:00.000Z' });
    const cancelled = card({ id: 't3', status: 'cancelled' });

    // Preserves input order (server sort_key or saved-view sort) instead of overriding with due date.
    expect(groupBoardTasks([tFirst, tSecond, cancelled], false).todo.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(groupBoardTasks([tFirst, tSecond, cancelled], false).cancelled).toEqual([]);
    expect(groupBoardTasks([tFirst, tSecond, cancelled], true).cancelled).toHaveLength(1);

    const moved = optimisticMoveTask([tFirst, cancelled], 't1', 'done');
    expect(moved.find((t) => t.id === 't1')?.status).toBe('done');

    expect(optimisticReorderTask([tFirst, tSecond], 't2', { place: 'before', anchorId: 't1' }).map((t) => t.id)).toEqual(['t2', 't1']);
    expect(optimisticReorderTask([tFirst, tSecond], 't1', { place: 'after', anchorId: 't2' }).map((t) => t.id)).toEqual(['t2', 't1']);

    const movedAndPlaced = optimisticMoveTask([tFirst, tSecond, cancelled], 't3', 'todo', { place: 'before', anchorId: 't2' });
    expect(movedAndPlaced.find((t) => t.id === 't3')?.status).toBe('todo');
    expect(movedAndPlaced.map((t) => t.id)).toEqual(['t1', 't3', 't2']);

    expect(statusFilterIncludesCancelled({ v: 1, all: [{ field: 'status', op: 'is', value: 'cancelled' }] })).toBe(true);
    expect(statusFilterIncludesCancelled({ v: 1, all: [{ field: 'status', op: 'in', value: ['todo', 'cancelled'] }] })).toBe(true);
    expect(statusFilterIncludesCancelled({ v: 1, all: [{ field: 'status', op: 'is', value: 'todo' }] })).toBe(false);
  });

  it('detects overdue only for non-done/non-cancelled tasks past due date, and computes completion %', () => {
    const now = Date.parse('2026-11-15T12:00:00.000Z');
    expect(isTaskOverdue({ due: '2026-11-15T11:00:00.000Z', status: 'todo' }, now)).toBe(true);
    expect(isTaskOverdue({ due: '2026-11-15T11:00:00.000Z', status: 'done' }, now)).toBe(false);
    expect(isTaskOverdue({ due: '2026-11-15T11:00:00.000Z', status: 'cancelled' }, now)).toBe(false);
    expect(isTaskOverdue({ due: '2026-11-16T00:00:00.000Z', status: 'todo' }, now)).toBe(false);
    expect(isTaskOverdue({ due: null, status: 'todo' }, now)).toBe(false);

    expect(projectCompletionPct(0, 0)).toBe(0);
    expect(projectCompletionPct(3, 1)).toBe(25);
    expect(projectCompletionPct(0, 5)).toBe(100);
  });

  it('detects unseated team members only for multi-member team orgs', () => {
    expect(hasUnseatedTeamMembers({ isTeamOrg: false, viewerHasSeat: false, members: [], seats: [] })).toBe(false);
    expect(hasUnseatedTeamMembers({ isTeamOrg: true, viewerHasSeat: false, members: [], seats: [] })).toBe(true);
    expect(
      hasUnseatedTeamMembers({
        isTeamOrg: true,
        viewerHasSeat: true,
        members: [
          { userId: 'u1', role: 'owner', displayName: 'Lan', email: null, onProject: true },
          { userId: 'u2', role: 'member', displayName: 'Minh', email: null, onProject: false },
          { userId: 'u3', role: 'viewer', displayName: 'Khách', email: null, onProject: false },
        ],
        seats: [{ id: 's1', title: 'Giám đốc', status: 'active', onProject: true, holder: { type: 'user', userId: 'u1', displayName: 'Lan', email: null } }],
      }),
    ).toBe(true);
    expect(
      hasUnseatedTeamMembers({
        isTeamOrg: true,
        viewerHasSeat: true,
        members: [{ userId: 'u1', role: 'owner', displayName: 'Lan', email: null, onProject: true }],
        seats: [{ id: 's1', title: 'Giám đốc', status: 'active', onProject: true, holder: { type: 'user', userId: 'u1', displayName: 'Lan', email: null } }],
      }),
    ).toBe(false);
  });

  it('filters projects by name, description or owner name', () => {
    const items = [
      { name: 'Quyết toán quý IV', description: 'Chốt hóa đơn', ownerName: 'Nguyễn An' },
      { name: 'Ra mắt cửa hàng', description: 'Đóng gói đơn', ownerName: 'Trần Bình' },
    ];
    expect(filterProjects(items, '')).toHaveLength(2);
    expect(filterProjects(items, 'hóa đơn')).toHaveLength(1);
    expect(filterProjects(items, 'BÌNH')).toHaveLength(1);
  });
});

describe('projects SSR screens & board (#2591)', () => {
  it('renders board columns, AI/human seat badges, taint indicator, overdue tag and disabled checkedOut status select', () => {
    const seats = [seat({})];
    const tasks = [
      card({
        id: 't1',
        title: 'Rà soát hóa đơn AI gửi',
        status: 'in_review',
        assigneePositionId: seats[0]!.id,
        due: '2020-01-01T00:00:00.000Z',
        tainted: true,
        checkedOut: true,
        commentCount: 3,
      }),
      card({
        id: 't2',
        title: 'Nộp tờ khai',
        status: 'todo',
        assigneePositionId: null,
      }),
    ];
    const boardHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <ProjectBoardView
          slug="demo-org"
          view="board"
          tasks={tasks}
          seats={seats}
          canEdit
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={() => undefined}
          onCreateTask={() => undefined}
          onEditTask={() => undefined}
          onRemoveTask={() => undefined}
        />,
      ),
    );
    expect(boardHtml).toContain('data-testid="project-board"');
    expect(boardHtml).toContain('data-status="todo"');
    expect(boardHtml).toContain('data-status="done"');
    expect(boardHtml).toContain('Rà soát hóa đơn AI gửi');
    expect(boardHtml).toContain('Nội dung bên ngoài');
    expect(boardHtml).toContain('Tác tử AI đang xử lý');
    expect(boardHtml).toContain('Quá hạn');
    expect(boardHtml).toContain('3');
    // Checked-out task locks status switch so only t2 select is enabled and t1 is disabled.
    expect(boardHtml).toContain('disabled=""');

    const listHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <ProjectBoardView
          slug="demo-org"
          view="list"
          tasks={tasks}
          seats={seats}
          canEdit
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={() => undefined}
          onCreateTask={() => undefined}
          onEditTask={() => undefined}
          onRemoveTask={() => undefined}
        />,
      ),
    );
    expect(listHtml).toContain('data-testid="project-list"');
    expect(listHtml).toContain('data-testid="project-list-row"');
  });

  it('renders ProjectsPage list and ProjectDetailPage entity-hidden banner + seat hint banner', () => {
    queryClientState.current.clear();
    const listData: ProjectListResult = {
      canWrite: true,
      truncated: false,
      projects: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Chiến dịch Tết',
          description: 'Chuẩn bị hàng hóa',
          ownerUserId: 'u1',
          ownerName: 'Minh',
          status: 'active',
          memberCount: 2,
          openTaskCount: 4,
          doneTaskCount: 1,
          canManage: true,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-10T00:00:00.000Z',
        },
      ],
    };
    queryClientState.current.setQueryData(['projects', 'list', { status: ['active', 'on_hold', 'done'] }], listData);

    const listPageHtml = renderToStaticMarkup(wrap('vi', <ProjectsPage />));
    expect(listPageHtml).toContain('data-testid="new-project-button"');
    expect(listPageHtml).toContain('data-testid="projects-list"');
    expect(listPageHtml).toContain('Chiến dịch Tết');
    expect(listPageHtml).toContain('20%');

    const boardData: ProjectBoard = {
      project: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Chiến dịch Tết',
        description: null,
        ownerUserId: 'u1',
        ownerName: 'Minh',
        status: 'active',
        canManage: true,
        canWrite: true,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-10T00:00:00.000Z',
      },
      members: [
        { userId: 'u1', role: 'owner', displayName: 'Minh', email: null, onProject: true },
        { userId: 'u2', role: 'member', displayName: 'Hoa', email: null, onProject: false },
      ],
      seats: [],
      isTeamOrg: true,
      viewerHasSeat: false,
      tasks: [card({ id: 't1', title: 'Kiểm kho chi nhánh HN' })],
      totalVisible: 1,
      hiddenByEntityCount: 2,
      truncated: false,
    };
    queryClientState.current.setQueryData(
      ['projects', 'board', { projectId: '00000000-0000-4000-8000-000000000001' }],
      boardData,
    );

    queryClientState.current.setQueryData(['notes', 'panel', { targetType: 'projects.project', targetId: '00000000-0000-4000-8000-000000000001' }], {
      pinned: [],
      latest: [],
      todos: [
        {
          id: 'todo-1',
          title: 'Check vendor contract',
          status: 'open',
          position: 1,
          dueOn: '2026-11-20',
          dueAt: '2026-11-20T16:59:59.000Z',
          dueTime: null,
          timeZone: 'Asia/Ho_Chi_Minh',
          remindAt: null,
          group: 'week',
          overdue: false,
          steps: { done: 0, total: 0 },
          taskId: null,
          revision: 1,
          createdAt: '2026-11-10T00:00:00.000Z',
          updatedAt: '2026-11-10T00:00:00.000Z',
          doneAt: null,
          deletedAt: null,
        },
      ],
    });

    const detailHtml = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(detailHtml).toContain('data-testid="hidden-entity-banner"');
    expect(detailHtml).toContain('2');
    expect(detailHtml).toContain('data-testid="seat-hint-banner"');
    expect(detailHtml).toContain('data-testid="view-toggle-board"');
    expect(detailHtml).toContain('data-testid="view-toggle-list"');
    expect(detailHtml).toContain('data-testid="task-filter-tainted"');
    expect(detailHtml).toContain('data-testid="task-filter-sort"');
    expect(detailHtml).toContain('data-testid="move-task-up"');
    expect(detailHtml).toContain('data-testid="move-task-down"');
    expect(detailHtml).toContain('Kiểm kho chi nhánh HN');
    expect(detailHtml).toContain('data-testid="panel-todos"');
    expect(detailHtml).toContain('Check vendor contract');

    const customSortHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <ProjectBoardView
          slug="demo-org"
          view="board"
          tasks={[card({ id: 't1' }), card({ id: 't2' })]}
          seats={[]}
          canEdit
          includeCancelled={false}
          creatingTask={false}
          customSortActive
          onMoveStatus={() => undefined}
          onReorderTask={() => undefined}
          onCreateTask={() => undefined}
          onEditTask={() => undefined}
          onRemoveTask={() => undefined}
        />,
      ),
    );
    expect(customSortHtml).toContain('data-testid="reorder-disabled-hint"');

    authState.modules = ['projects'];
    const withoutNotesHtml = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(withoutNotesHtml).not.toContain('data-testid="panel-todos"');
    authState.modules = ['projects', 'notes'];
  });

  it('excludes org members not assigned to the project from otherMemberCount and renders AI badge on tainted project notes (#2609)', () => {
    expect(
      countOtherProjectMembers(
        [
          { userId: 'u1', onProject: true },
          { userId: 'u2', onProject: false },
          { userId: 'u3', onProject: false },
        ],
        'u1',
      ),
    ).toBe(0);
    expect(
      countOtherProjectMembers(
        [
          { userId: 'u1', onProject: true },
          { userId: 'u2', onProject: true },
          { userId: 'u3', onProject: false },
        ],
        'u1',
      ),
    ).toBe(1);
    expect(countOtherProjectMembers([{ userId: 'u2', onProject: true }], null)).toBeUndefined();

    queryClientState.current.setQueryData(
      ['notes', 'panel', { targetType: 'projects.project', targetId: '00000000-0000-4000-8000-000000000001' }],
      {
        pinned: [],
        latest: [
          {
            id: '40000000-0000-4000-8000-000000000001',
            authorUserId: 'u1',
            mine: true,
            visibility: 'org',
            title: 'Báo cáo tuần từ AI',
            tags: ['bao-cao-tuan'],
            pinned: false,
            tainted: true,
            revision: 1,
            createdAt: '2026-11-16T00:00:00.000Z',
            updatedAt: '2026-11-16T00:00:00.000Z',
            archivedAt: null,
            deletedAt: null,
          },
          {
            id: '40000000-0000-4000-8000-000000000002',
            authorUserId: 'u1',
            mine: true,
            visibility: 'org',
            title: 'Ghi chú thủ công',
            tags: ['bao-cao-tuan'],
            pinned: false,
            tainted: false,
            revision: 1,
            createdAt: '2026-11-15T00:00:00.000Z',
            updatedAt: '2026-11-15T00:00:00.000Z',
            archivedAt: null,
            deletedAt: null,
          },
        ],
        todos: [],
      },
    );

    const html = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(html).toContain('data-testid="note-ai-badge"');
    expect(html).toContain('data-tainted="true"');
    expect(html).toContain('data-tainted="false"');
    expect(html).toContain('border-proposal');
  });
});
