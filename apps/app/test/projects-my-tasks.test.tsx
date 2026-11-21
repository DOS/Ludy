// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR checks for Projects P3 (#2593): My work project chips, filter, no-seat hint, and Tasks screen project column/filter + MODULE_OFF degradation.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_TASK_MAP_LIMIT, zProjectTaskProjectsInput, type MyWork, type ProjectListResult, type ProjectTaskProjectEntry } from '@crove/kernel-contract';
import { TASK_LIST_LIMIT } from '../src/lib/agents.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { isModuleOff } from '../src/lib/errors.ts';
import { browserTimeZone } from '../src/lib/my-work.ts';
import { filterTasksByProject, taskProjectMap, taskProjectOptions } from '../src/lib/projects.ts';

const authState = vi.hoisted(() => ({ modules: ['projects', 'notes'] as string[] }));
const routerState = vi.hoisted(() => ({ search: {} as { filter?: 'open' | 'mine' | 'all'; project?: string } }));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: authState.modules }),
}));

const queryClientState = vi.hoisted(() => ({
  current: null as unknown as QueryClient,
  taskProjectQueries: [] as Array<{ taskIds: string[] }>,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => {
            if (path.join('.') === 'projects.taskProjects' && args?.input) {
              queryClientState.taskProjectQueries.push(args.input as { taskIds: string[] });
            }
            return {
              queryKey: [...path, args?.input ?? {}],
              queryFn: () => Promise.reject(new Error('not fetched in unit test')),
            };
          };
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'call') return () => Promise.resolve({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { client: node([]), clientForOrg: () => node([]), orpc: node([]), queryClient: queryClientState.current, errorMessage: String };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'demo-org' }),
    useSearch: () => routerState.search,
    useNavigate: () => () => Promise.resolve(),
    Link: ({
      children,
      to,
      params,
      ...rest
    }: {
      children?: ReactNode;
      to: string;
      params?: Record<string, string>;
      'data-testid'?: string;
      className?: string;
    }) => {
      const href = params
        ? Object.entries(params).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to)
        : to;
      return createElement('a', { href, 'data-testid': rest['data-testid'], className: rest.className }, children);
    },
  };
});

const { MyWorkPage } = await import('../src/routes/my-work.tsx');
const { TasksPage } = await import('../src/routes/tasks.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => (
  <QueryClientProvider client={queryClientState.current}>
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

const P1 = '10000000-0000-4000-8000-000000000001';
const P2 = '10000000-0000-4000-8000-000000000002';
const P3 = '10000000-0000-4000-8000-000000000003';
const T1 = '20000000-0000-4000-8000-000000000001';
const T2 = '20000000-0000-4000-8000-000000000002';
const T3 = '20000000-0000-4000-8000-000000000003';
const T4 = '20000000-0000-4000-8000-000000000004';

describe('projects P3 helpers (#2593)', () => {
  it('maps and filters tasks by project cleanly, and detects MODULE_OFF', () => {
    const entries: ProjectTaskProjectEntry[] = [
      { taskId: T1, project: { id: P1, name: 'Chốt thuế Q4' } },
      { taskId: T2, project: { id: P2, name: 'Khai trương' } },
    ];
    const map = taskProjectMap(entries);
    const tasks = [{ id: T1 }, { id: T2 }, { id: T3 }];

    expect(filterTasksByProject(tasks, map, '').map((t) => t.id)).toEqual([T1, T2, T3]);
    expect(filterTasksByProject(tasks, map, P1).map((t) => t.id)).toEqual([T1]);
    expect(filterTasksByProject(tasks, map, 'none').map((t) => t.id)).toEqual([T3]);

    const options = taskProjectOptions(
      [
        { id: P2, name: 'Khai trương' },
        { id: P3, name: 'Báo cáo năm' },
      ],
      entries,
    );
    expect(options.map((o) => o.id)).toEqual([P3, P1, P2]);

    expect(isModuleOff({ code: 'MODULE_OFF', data: { module: 'projects' } })).toBe(true);
    expect(isModuleOff({ code: 'MODULE_OFF', data: { module: 'projects' } }, 'projects')).toBe(true);
    expect(isModuleOff({ code: 'MODULE_OFF', data: { module: 'finance' } }, 'projects')).toBe(false);
    expect(isModuleOff({ code: 'FORBIDDEN' })).toBe(false);
    expect(TASK_LIST_LIMIT).toBeLessThanOrEqual(PROJECT_TASK_MAP_LIMIT);
  });
});

describe('MyWorkPage P3 SSR (#2593)', () => {
  it('renders project chips linking to /o/$slug/projects/$id, project filter, and no-seat hint for unseated team member', () => {
    authState.modules = ['projects', 'notes'];
    queryClientState.current.clear();

    const myWork: MyWork = {
      todos: [],
      tasks: [
        { id: T1, title: 'Nộp tờ khai', status: 'todo', positionId: null, due: null, group: 'today', overdue: false, tainted: false, project: { id: P1, name: 'Thuế Q4' } },
        { id: T2, title: 'Đặt bảng hiệu', status: 'in_progress', positionId: null, due: null, group: 'today', overdue: false, tainted: false, project: { id: P2, name: 'Mở tiệm' } },
        { id: T3, title: 'Soạn hợp đồng', status: 'todo', positionId: null, due: null, group: 'next7', overdue: false, tainted: false, project: { id: P3, name: 'Khách hàng mới' } },
        { id: T4, title: 'Việc chung', status: 'todo', positionId: null, due: null, group: 'none', overdue: false, tainted: false, project: null },
      ],
      tasksTruncated: false,
      projectsAvailable: true,
      noSeatHint: true,
    };
    queryClientState.current.setQueryData(['notes', 'todos', 'myWork', { timeZone: browserTimeZone() }], myWork);
    queryClientState.current.setQueryData(['chart', 'get', {}], { root: [], positions: [], agents: [], killSwitches: [] });

    const htmlVi = renderToStaticMarkup(wrap('vi', <MyWorkPage />));
    expect(htmlVi).toContain('data-testid="my-work-no-seat-hint"');
    expect(htmlVi).toContain('/o/demo-org/agents');
    expect(htmlVi).toContain('data-testid="my-work-project-filter"');
    expect(htmlVi).toContain(`/o/demo-org/projects/${P1}`);
    expect(htmlVi).toContain(`/o/demo-org/projects/${P2}`);
    expect(htmlVi).toContain(`/o/demo-org/projects/${P3}`);
    expect(htmlVi).toContain('Thuế Q4');
    expect(htmlVi).toContain('Mở tiệm');
    expect(htmlVi).toContain('Khách hàng mới');

    const htmlEn = renderToStaticMarkup(wrap('en', <MyWorkPage />));
    expect(htmlEn).toContain('Open organization chart');
    expect(htmlEn).toContain('Filter by project');
  });

  it('hides no-seat hint for solo owner and hides project chips/filter when projects module is off', () => {
    authState.modules = ['notes'];
    queryClientState.current.clear();

    const myWork: MyWork = {
      todos: [],
      tasks: [
        { id: T1, title: 'Việc một mình', status: 'todo', positionId: null, due: null, group: 'today', overdue: false, tainted: false, project: null },
      ],
      tasksTruncated: false,
      projectsAvailable: false,
      noSeatHint: false,
    };
    queryClientState.current.setQueryData(['notes', 'todos', 'myWork', { timeZone: browserTimeZone() }], myWork);
    queryClientState.current.setQueryData(['chart', 'get', {}], { root: [], positions: [], agents: [], killSwitches: [] });

    const html = renderToStaticMarkup(wrap('vi', <MyWorkPage />));
    expect(html).not.toContain('data-testid="my-work-no-seat-hint"');
    expect(html).not.toContain('data-testid="my-work-project-filter"');
    expect(html).not.toContain('data-testid="my-work-task-project"');

    // Also verifies personal to-dos stay visible when projects module is on but no tasks have a project
    authState.modules = ['projects', 'notes'];
    queryClientState.current.clear();
    queryClientState.current.setQueryData(['notes', 'todos', 'myWork', { timeZone: browserTimeZone() }], {
      todos: [
        {
          id: '30000000-0000-4000-8000-000000000001',
          title: 'Gọi cho khách hàng',
          status: 'open',
          priority: 4,
          tags: [],
          listId: null,
          sectionId: null,
          dueOn: null,
          dueAt: null,
          dueTime: null,
          timeZone: 'Asia/Ho_Chi_Minh',
          remindAt: null,
          group: 'none',
          overdue: false,
          steps: { done: 0, total: 0 },
          sourceNoteId: null,
          sourceNote: null,
          taskId: null,
          recurrence: null,
          seriesId: null,
          tainted: false,
          revision: 1,
          createdAt: '2026-11-03T00:00:00.000Z',
          updatedAt: '2026-11-03T00:00:00.000Z',
          doneAt: null,
          deletedAt: null,
        },
      ],
      tasks: [
        { id: T1, title: 'Việc chưa gắn dự án', status: 'todo', positionId: null, due: null, group: 'today', overdue: false, tainted: false, project: null },
      ],
      tasksTruncated: false,
      projectsAvailable: true,
      noSeatHint: false,
    } satisfies MyWork);
    queryClientState.current.setQueryData(['chart', 'get', {}], { root: [], positions: [], agents: [], killSwitches: [] });

    const htmlTodosOnly = renderToStaticMarkup(wrap('vi', <MyWorkPage />));
    expect(htmlTodosOnly).toContain('Gọi cho khách hàng');
    expect(htmlTodosOnly).toContain('Việc chưa gắn dự án');
    expect(htmlTodosOnly).not.toContain('data-testid="my-work-project-filter"');
  });
});

describe('TasksPage P3 SSR (#2593)', () => {
  function seedTasksBase() {
    queryClientState.current.clear();
    queryClientState.current.setQueryData(['org', 'get', {}], {
      orgId: '00000000-0000-4000-8000-000000000001',
      slug: 'demo-org',
      name: 'Demo',
      role: 'owner',
      taxCode: null,
      vatFilingPeriod: null,
      address: null,
      contactEmail: null,
      inboundAddress: null,
      inboundDroppedCount: null,
      members: [],
      permissions: [],
      approvalPreset: 'founder',
      approvalPolicyVersion: 1,
    });
    queryClientState.current.setQueryData(['chart', 'get', {}], { root: [], positions: [], agents: [], killSwitches: [] });
    queryClientState.current.setQueryData(
      ['tasks', 'list', { status: ['todo', 'in_progress', 'waiting', 'in_review'] }],
      [
        {
          id: T1,
          title: 'Kiểm tra sổ sách',
          kind: 'human',
          status: 'todo',
          assigneePositionId: null,
          parentTaskId: null,
          source: 'human',
          sourceRef: null,
          requestDepth: 0,
          tainted: false,
          createdByType: 'user',
          due: null,
          checklist: [],
          createdAt: '2026-11-10T01:00:00.000Z',
        },
        {
          id: T2,
          title: 'Việc độc lập',
          kind: 'human',
          status: 'in_progress',
          assigneePositionId: null,
          parentTaskId: null,
          source: 'human',
          sourceRef: null,
          requestDepth: 0,
          tainted: false,
          createdByType: 'user',
          due: null,
          checklist: [],
          createdAt: '2026-11-10T02:00:00.000Z',
        },
      ],
    );
  }

  it('renders Project column and filter, and filters tasks by project when projects module is active', () => {
    authState.modules = ['projects', 'notes'];
    routerState.search = {};
    seedTasksBase();

    const listResult: ProjectListResult = {
      canWrite: true,
      truncated: false,
      projects: [
        {
          id: P1,
          name: 'Quyết toán 2026',
          description: null,
          ownerUserId: null,
          ownerName: null,
          status: 'active',
          memberCount: 1,
          openTaskCount: 1,
          doneTaskCount: 0,
          canManage: true,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-10T00:00:00.000Z',
        },
      ],
    };
    queryClientState.current.setQueryData(['projects', 'list', {}], listResult);
    queryClientState.current.setQueryData(['projects', 'taskProjects', { taskIds: [T1, T2] }], [
      { taskId: T1, project: { id: P1, name: 'Quyết toán 2026' } },
    ] satisfies ProjectTaskProjectEntry[]);

    const htmlAll = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(htmlAll).toContain('data-testid="tasks-project-filter"');
    expect(htmlAll).toContain('Dự án');
    expect(htmlAll).toContain('data-testid="task-project-chip"');
    expect(htmlAll).toContain(`/o/demo-org/projects/${P1}`);
    expect(htmlAll).toContain('Kiểm tra sổ sách');
    expect(htmlAll).toContain('Việc độc lập');

    routerState.search = { project: P1 };
    const htmlFiltered = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(htmlFiltered).toContain('Kiểm tra sổ sách');
    expect(htmlFiltered).not.toContain('Việc độc lập');
  });

  it('degrades smoothly when projects is omitted from modules OR returns MODULE_OFF (ADR-0053)', async () => {
    // 1) CROVE_MODULES omits projects
    authState.modules = ['notes'];
    routerState.search = { project: P1 };
    seedTasksBase();
    const htmlNotInstalled = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(htmlNotInstalled).not.toContain('data-testid="tasks-project-filter"');
    expect(htmlNotInstalled).not.toContain('data-testid="task-project-cell"');
    expect(htmlNotInstalled).toContain('Kiểm tra sổ sách');
    expect(htmlNotInstalled).toContain('Việc độc lập');

    // 2) CROVE_MODULES includes projects, but org switched projects off -> MODULE_OFF
    authState.modules = ['projects', 'notes'];
    routerState.search = { project: P1 };
    seedTasksBase();
    await queryClientState.current
      .fetchQuery({
        queryKey: ['projects', 'list', {}],
        queryFn: () =>
          Promise.reject(Object.assign(new Error('MODULE_OFF'), { code: 'MODULE_OFF', status: 404, data: { module: 'projects' } })),
      })
      .catch(() => undefined);

    const htmlModuleOff = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(htmlModuleOff).not.toContain('data-testid="tasks-project-filter"');
    expect(htmlModuleOff).not.toContain('data-testid="task-project-cell"');
    expect(htmlModuleOff).not.toContain('MODULE_OFF');
    expect(htmlModuleOff).toContain('Kiểm tra sổ sách');
    expect(htmlModuleOff).toContain('Việc độc lập');

    // 3) projects.taskProjects returns MODULE_OFF cleanly too
    authState.modules = ['projects', 'notes'];
    routerState.search = { project: P1 };
    seedTasksBase();
    queryClientState.current.setQueryData(['projects', 'list', {}], {
      canWrite: false,
      truncated: false,
      projects: [],
    } satisfies ProjectListResult);
    await queryClientState.current
      .fetchQuery({
        queryKey: ['projects', 'taskProjects', { taskIds: [T1, T2] }],
        queryFn: () =>
          Promise.reject(Object.assign(new Error('MODULE_OFF'), { code: 'MODULE_OFF', status: 404, data: { module: 'projects' } })),
      })
      .catch(() => undefined);

    const htmlTaskProjectsModuleOff = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(htmlTaskProjectsModuleOff).not.toContain('data-testid="tasks-project-filter"');
    expect(htmlTaskProjectsModuleOff).not.toContain('data-testid="task-project-cell"');
    expect(htmlTaskProjectsModuleOff).not.toContain('MODULE_OFF');
    expect(htmlTaskProjectsModuleOff).toContain('Kiểm tra sổ sách');
  });

  it('surfaces non-MODULE_OFF errors, keeps unlisted ?project= selectable, and retains truncation warning on empty filtered results', async () => {
    authState.modules = ['projects', 'notes'];
    routerState.search = {};
    seedTasksBase();

    const listResult: ProjectListResult = {
      canWrite: true,
      truncated: false,
      projects: [
        {
          id: P1,
          name: 'Quyết toán 2026',
          description: null,
          ownerUserId: null,
          ownerName: null,
          status: 'active',
          memberCount: 1,
          openTaskCount: 1,
          doneTaskCount: 0,
          canManage: true,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-10T00:00:00.000Z',
        },
      ],
    };
    queryClientState.current.setQueryData(['projects', 'list', {}], listResult);
    await queryClientState.current
      .fetchQuery({
        queryKey: ['projects', 'taskProjects', { taskIds: [T1, T2] }],
        queryFn: () => Promise.reject(new Error('Project map failed')),
      })
      .catch(() => undefined);

    const htmlError = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(htmlError).toContain('Project map failed');
    expect(htmlError).toContain('Kiểm tra sổ sách');
    expect(htmlError).toContain('...');
    expect(htmlError).not.toContain('>-<');

    // Unlisted ?project= keeps a matching option and shows empty state + truncated hint when tasks hit TASK_LIST_LIMIT
    routerState.search = { project: P2 };
    seedTasksBase();
    const manyTasks = Array.from({ length: TASK_LIST_LIMIT }, (_, idx) => ({
      id: `20000000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
      title: `Task ${idx + 1}`,
      kind: 'human' as const,
      status: 'todo' as const,
      assigneePositionId: null,
      parentTaskId: null,
      source: 'human' as const,
      sourceRef: null,
      requestDepth: 0,
      tainted: false,
      createdByType: 'user' as const,
      due: null,
      checklist: [],
      createdAt: '2026-11-10T01:00:00.000Z',
    }));
    queryClientState.current.setQueryData(['tasks', 'list', { status: ['todo', 'in_progress', 'waiting', 'in_review'] }], manyTasks);
    queryClientState.current.setQueryData(['projects', 'list', {}], listResult);
    queryClientState.current.setQueryData(
      ['projects', 'taskProjects', { taskIds: manyTasks.map((t) => t.id) }],
      [] satisfies ProjectTaskProjectEntry[],
    );

    const htmlUnlistedTruncated = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(htmlUnlistedTruncated).toContain(`value="${P2}"`);
    expect(htmlUnlistedTruncated).toContain(catalog('vi').tasks.selectedProject);
    expect(htmlUnlistedTruncated).toContain(catalog('vi').tasks.emptyProjectFilter);
    expect(htmlUnlistedTruncated).toContain(catalog('vi').tasks.truncated.replace('{count}', String(TASK_LIST_LIMIT)));

    // Even if more than PROJECT_TASK_MAP_LIMIT tasks are returned, TasksPage slices taskIds cleanly
    routerState.search = {};
    queryClientState.taskProjectQueries.length = 0;
    const oversizedTasks = Array.from({ length: PROJECT_TASK_MAP_LIMIT + 10 }, (_, idx) => ({
      id: `20000000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
      title: `Task ${idx + 1}`,
      kind: 'human' as const,
      status: 'todo' as const,
      assigneePositionId: null,
      parentTaskId: null,
      source: 'human' as const,
      sourceRef: null,
      requestDepth: 0,
      tainted: false,
      createdByType: 'user' as const,
      due: null,
      checklist: [],
      createdAt: '2026-11-10T01:00:00.000Z',
    }));
    queryClientState.current.setQueryData(['tasks', 'list', { status: ['todo', 'in_progress', 'waiting', 'in_review'] }], oversizedTasks);
    queryClientState.current.setQueryData(
      ['projects', 'taskProjects', { taskIds: oversizedTasks.slice(0, PROJECT_TASK_MAP_LIMIT).map((t) => t.id) }],
      [] satisfies ProjectTaskProjectEntry[],
    );
    renderToStaticMarkup(wrap('vi', <TasksPage />));
    const lastTaskProjectInput = queryClientState.taskProjectQueries.at(-1);
    expect(lastTaskProjectInput?.taskIds).toHaveLength(PROJECT_TASK_MAP_LIMIT);
    expect(zProjectTaskProjectsInput.safeParse(lastTaskProjectInput).success).toBe(true);

    const tasksFilterHtml = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(tasksFilterHtml).toContain('data-testid="task-filter-search"');
    // The status, assignee, due, origin and sort controls sit in one popover behind a button (#3597).
    expect(tasksFilterHtml).toContain('data-testid="task-filter-button"');
    expect(tasksFilterHtml).toContain(catalog('vi').savedViews.all);
  });
  it('shows the list first: no form above it, an Add task button for a member who can give work, an edit button on each row (#3606)', () => {
    authState.modules = ['notes'];
    routerState.search = {};
    seedTasksBase();
    const html = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Giao việc mới');
    expect(html).toContain('data-testid="task-add"');
    expect(html).toContain('>Thêm việc<');
    expect(html).toContain('aria-label="Sửa việc: Kiểm tra sổ sách"');
    expect(html).toContain('aria-label="Sửa việc: Việc độc lập"');
    // The English screen says the same.
    const en = renderToStaticMarkup(wrap('en', <TasksPage />));
    expect(en).toContain('>Add task<');
    expect(en).toContain('aria-label="Edit task: Kiểm tra sổ sách"');
  });

  it('offers a viewer neither the Add task button nor the row edit buttons (#3606)', () => {
    authState.modules = ['notes'];
    routerState.search = {};
    seedTasksBase();
    const org = queryClientState.current.getQueryData<Record<string, unknown>>(['org', 'get', {}]);
    queryClientState.current.setQueryData(['org', 'get', {}], { ...org, role: 'viewer' });
    const html = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(html).toContain('Kiểm tra sổ sách');
    expect(html).not.toContain('data-testid="task-add"');
    expect(html).not.toContain('Sửa việc:');
    expect(html).not.toContain('Thao tác');
  });

  // One name, one filter popover, one hint, no second strip (#3597, audit TK-1 to TK-4).
  it('TK-1: the menu, the tab title and the H1 are one string in both languages, in plain words', () => {
    authState.modules = ['notes'];
    routerState.search = {};
    seedTasksBase();
    for (const locale of ['vi', 'en'] as const) {
      const messages = catalog(locale);
      expect(messages.tasks.title).toBe(messages.nav.tasks);
      const html = renderToStaticMarkup(wrap(locale, <TasksPage />));
      expect(html).toMatch(new RegExp(`<h1[^>]*>${messages.nav.tasks}</h1>`));
    }
    expect(catalog('vi').nav.tasks).toBe('Việc nhóm');
    expect(catalog('en').nav.tasks).toBe('Team tasks');
    // No org-chart words where the screen explains itself.
    const vi = catalog('vi').tasks;
    for (const text of [vi.subtitle, vi.emptyHint, vi.emptyHintReadOnly, vi.emptyMineHint]) expect(text).not.toMatch(/sơ đồ|vị trí|tác tử/);
    const en = catalog('en').tasks;
    for (const text of [en.subtitle, en.emptyHint, en.emptyHintReadOnly, en.emptyMineHint]) expect(text).not.toMatch(/org chart|position|agent/i);
  });

  it('TK-2: the list is not preceded by a row of filters: the search box and one Filters button are all that show', () => {
    authState.modules = ['notes'];
    routerState.search = {};
    seedTasksBase();
    const html = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(html).toContain('data-testid="task-filter-search"');
    expect(html).toContain('data-testid="task-filter-button"');
    expect(html).toContain('>Bộ lọc<');
    for (const control of ['status', 'assignee', 'due', 'tainted', 'sort']) expect(html).not.toContain(`data-testid="task-filter-${control}"`);
    expect(html).not.toContain('data-testid="task-filter-count"');
    // The English screen says the same.
    expect(renderToStaticMarkup(wrap('en', <TasksPage />))).toContain('>Filters<');
  });

  it('TK-4: the shortcut hint is on this screen as it is on My work, and a viewer is told only the keys that work for them', () => {
    authState.modules = ['notes'];
    routerState.search = {};
    seedTasksBase();
    const vi = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(vi).toContain('data-testid="tasks-shortcuts"');
    expect(vi).toContain(catalog('vi').tasks.shortcuts);
    expect(renderToStaticMarkup(wrap('en', <TasksPage />))).toContain(catalog('en').tasks.shortcuts);
    const org = queryClientState.current.getQueryData<Record<string, unknown>>(['org', 'get', {}]);
    queryClientState.current.setQueryData(['org', 'get', {}], { ...org, role: 'viewer' });
    const viewer = renderToStaticMarkup(wrap('vi', <TasksPage />));
    expect(viewer).toContain(catalog('vi').tasks.shortcutsReadOnly);
    expect(viewer).not.toContain(catalog('vi').tasks.shortcuts);
  });

  it('TK-3: My work draws no second tab strip: the menu is the one place that lists the five Cộng tác screens', () => {
    authState.modules = ['projects', 'notes', 'meetings'];
    queryClientState.current.clear();
    queryClientState.current.setQueryData(['notes', 'todos', 'myWork', { timeZone: browserTimeZone() }], {
      todos: [],
      tasks: [],
      tasksTruncated: false,
      projectsAvailable: true,
      noSeatHint: false,
    } satisfies MyWork);
    queryClientState.current.setQueryData(['chart', 'get', {}], { root: [], positions: [], agents: [], killSwitches: [] });
    const html = renderToStaticMarkup(wrap('vi', <MyWorkPage />));
    expect(html).not.toContain('href="/o/demo-org/notes"');
    expect(html).not.toContain('href="/o/demo-org/meetings"');
    expect(html).not.toContain('href="/o/demo-org/projects"');
    expect(html).not.toContain('href="/o/demo-org/tasks"');
    // The hint line of My work stays.
    expect(html).toContain(catalog('vi').myWork.shortcuts);
  });
});
