// SPDX-License-Identifier: AGPL-3.0-only
// UI tests for ProjectTemplateDialog, TaskRecurrenceControl, repeat badges, and Projects/Tasks pages (#2607).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type {
  ProjectBoard,
  ProjectListResult,
  ProjectSeat,
  ProjectTaskCard,
  ProjectTaskRecurrenceView,
} from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

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
  return { clientForOrg: () => node([]), orpc: node([]), queryClient: queryClientState.current, errorMessage: String };
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
const { TaskRecurrenceControl, formatRecurrenceBadgeLabel } = await import('../src/components/task-recurrence-control.tsx');
const { ProjectsPage, ProjectDetailPage } = await import('../src/routes/projects.tsx');
const { TaskDetailPage } = await import('../src/routes/tasks.tsx');

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
  checklist: [],
  tainted: false,
  checkedOut: false,
  commentCount: 0,
  createdAt: '2026-11-10T01:00:00.000Z',
  addedAt: '2026-11-10T01:00:00.000Z',
  ...over,
});

const seat: ProjectSeat = {
  id: '20000000-0000-4000-8000-000000000001',
  title: 'Kế toán trưởng',
  status: 'active',
  onProject: true,
  holder: null,
};

describe('projects templates & recurring UI (#2607)', () => {
  it('renders create-from-template button on ProjectsPage and save-as-template button on ProjectDetailPage', () => {
    authState.modules = ['projects'];
    const qc = queryClientState.current;
    qc.clear();

    const listData: ProjectListResult = {
      projects: [],
      canWrite: true,
      truncated: false,
    };
    qc.setQueryData(['projects', 'list', { status: ['active', 'on_hold', 'done'] }], listData);

    const listHtml = renderToStaticMarkup(wrap('vi', <ProjectsPage />));
    expect(listHtml).toContain('create-from-template-button');
    expect(listHtml).toContain('Tạo từ mẫu');

    const boardData: ProjectBoard = {
      project: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Khóa sổ tháng 11',
        description: null,
        ownerUserId: null,
        ownerName: null,
        status: 'active',
        visibility: 'org',
        canManage: true,
        canWrite: true,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
      members: [],
      seats: [seat],
      isTeamOrg: false,
      viewerHasSeat: false,
      tasks: [
        card({
          recurrence: {
            cadence: 'monthly',
            interval: 1,
            monthDay: -1,
            timeZone: 'Asia/Ho_Chi_Minh',
          },
          recurrenceCount: 2,
          recurrenceNextAt: '2026-12-31T00:00:00.000Z',
        }),
      ],
      totalVisible: 1,
      hiddenByEntityCount: 0,
      truncated: false,
    };
    qc.setQueryData(['projects', 'board', { projectId: '00000000-0000-4000-8000-000000000001' }], boardData);

    const detailHtml = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(detailHtml).toContain('save-as-template-button');
    expect(detailHtml).toContain('Lưu làm mẫu');
    expect(detailHtml).toContain('task-recurrence-badge');
    expect(detailHtml).toContain('Hàng tháng');

    qc.setQueryData(
      ['projects', 'board', { projectId: '00000000-0000-4000-8000-000000000001' }],
      { ...boardData, project: { ...boardData.project, visibility: 'private' } },
    );
    const privateDetailHtml = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(privateDetailHtml).not.toContain('save-as-template-button');
  });

  it('renders repeat badge on both board and list views and renders recurrence control on TaskDetailPage', () => {
    const recurringTask = card({
      recurrence: {
        cadence: 'weekly',
        interval: 2,
        weekday: 1,
        timeZone: 'Asia/Ho_Chi_Minh',
      },
    });
    const noop = () => {};

    const boardHtml = renderToStaticMarkup(
      wrap(
        'en',
        <ProjectBoardView
          slug="demo-org"
          view="board"
          tasks={[recurringTask]}
          seats={[seat]}
          canEdit
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={noop}
          onCreateTask={noop}
          onEditTask={noop}
          onRemoveTask={noop}
        />,
      ),
    );
    expect(boardHtml).toContain('task-recurrence-badge');
    expect(boardHtml).toContain('Every 2 weeks');

    const listHtml = renderToStaticMarkup(
      wrap(
        'en',
        <ProjectBoardView
          slug="demo-org"
          view="list"
          tasks={[recurringTask]}
          seats={[seat]}
          canEdit
          includeCancelled={false}
          creatingTask={false}
          onMoveStatus={noop}
          onCreateTask={noop}
          onEditTask={noop}
          onRemoveTask={noop}
        />,
      ),
    );
    expect(listHtml).toContain('task-recurrence-badge');
    expect(listHtml).toContain('Every 2 weeks');

    const qc = queryClientState.current;
    qc.clear();
    qc.setQueryData(['org', 'get', {}], { role: 'owner', members: [] });
    qc.setQueryData(['chart', 'get', {}], { root: [], positions: [], agents: [], killSwitches: [] });
    qc.setQueryData(['tasks', 'get', { id: '00000000-0000-4000-8000-000000000001' }], {
      task: {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Khóa sổ cuối tháng',
        status: 'todo',
        description: null,
        due: null,
        checklist: [],
        createdAt: '2026-11-16T00:00:00.000Z',
        tainted: false,
        checkedOut: false,
        assigneePositionId: null,
        sourceRef: null,
      },
      comments: [],
      proposal: null,
    });
    const recurrenceView: ProjectTaskRecurrenceView = {
      projectId: '30000000-0000-4000-8000-000000000001',
      taskId: '00000000-0000-4000-8000-000000000001',
      recurrence: {
        cadence: 'monthly',
        interval: 1,
        monthDay: -1,
        timeZone: 'Asia/Ho_Chi_Minh',
      },
      recurrenceCount: 1,
      recurrenceLastDue: '2026-11-30',
      recurrenceNextAt: '2026-12-31T00:00:00.000Z',
      recurrenceSourceTaskId: null,
    };
    qc.setQueryData(
      ['projects', 'getTaskRecurrence', { taskId: '00000000-0000-4000-8000-000000000001' }],
      recurrenceView,
    );

    const taskDetailHtml = renderToStaticMarkup(wrap('vi', <TaskDetailPage />));
    expect(taskDetailHtml).toContain('task-recurrence-badge');
    expect(taskDetailHtml).toContain('task-recurrence-control');
    expect(taskDetailHtml).toContain('Ngày cuối tháng');

    const copyHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <TaskRecurrenceControl
          projectId={recurrenceView.projectId}
          taskId={recurrenceView.taskId}
          canEdit
          view={{
            ...recurrenceView,
            recurrence: null,
            recurrenceNextAt: null,
            recurrenceSourceTaskId: '90000000-0000-4000-8000-000000000001',
          }}
        />,
      ),
    );
    expect(copyHtml).toContain('task-recurrence-generated-hint');

    expect(
      formatRecurrenceBadgeLabel(
        { cadence: 'weekly', interval: 1, weekday: 1, timeZone: 'Asia/Ho_Chi_Minh' },
        (k) => (k === 'recurrence.badgeWeeklySingle' ? 'Hàng tuần' : 'other'),
      ),
    ).toBe('Hàng tuần');
  });
});
