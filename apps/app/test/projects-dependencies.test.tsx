// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR/accessibility tests for project task dependencies UI (#2601).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectDependencyEdge, ProjectSeat, ProjectTaskCard, ProjectWeeklyStatus as ProjectWeeklyStatusData } from '@ludy/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

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

const {
  ProjectDependenciesPanel,
  availableDependencyCandidates,
  shouldConfirmBlockedStatusMove,
  splitTaskDependencies,
} = await import('../src/components/project-dependencies.tsx');
const { ProjectBoardView } = await import('../src/components/project-board.tsx');
const { ProjectWeeklyStatus, projectWeeklyStatusQueryKey } = await import('../src/components/project-weekly-status.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => {
  setActiveLocale(locale);
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClientState.current}>
        <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
          {node}
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
};

const TASK_A = '10000000-0000-4000-8000-000000000001';
const TASK_B = '10000000-0000-4000-8000-000000000002';
const TASK_C = '10000000-0000-4000-8000-000000000003';
const TASK_D = '10000000-0000-4000-8000-000000000004';
const PROJECT_ID = '20000000-0000-4000-8000-000000000001';

const sampleEdges: ProjectDependencyEdge[] = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    projectId: PROJECT_ID,
    blockerTaskId: TASK_A,
    blockedTaskId: TASK_B,
    createdBy: null,
    createdAt: '2026-11-10T01:00:00.000Z',
    blocker: { id: TASK_A, title: 'Khảo sát yêu cầu', status: 'in_progress', due: null },
    blocked: { id: TASK_B, title: 'Thiết kế màn hình', status: 'todo', due: null },
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    projectId: PROJECT_ID,
    blockerTaskId: TASK_D,
    blockedTaskId: TASK_B,
    createdBy: null,
    createdAt: '2026-11-10T02:00:00.000Z',
    blocker: { id: TASK_D, title: 'Ký hợp đồng', status: 'done', due: null },
    blocked: { id: TASK_B, title: 'Thiết kế màn hình', status: 'todo', due: null },
  },
  {
    id: '30000000-0000-4000-8000-000000000003',
    projectId: PROJECT_ID,
    blockerTaskId: TASK_B,
    blockedTaskId: TASK_C,
    createdBy: null,
    createdAt: '2026-11-10T03:00:00.000Z',
    blocker: { id: TASK_B, title: 'Thiết kế màn hình', status: 'todo', due: null },
    blocked: { id: TASK_C, title: 'Triển khai API', status: 'todo', due: null },
  },
];

const card = (over: Partial<ProjectTaskCard>): ProjectTaskCard => ({
  id: TASK_A,
  title: 'Khảo sát yêu cầu',
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

const seats: ProjectSeat[] = [];

describe('project dependencies helpers & UI (#2601)', () => {
  it('splits blocker/blocking edges, counts only open blockers, and filters candidates', () => {
    const split = splitTaskDependencies(sampleEdges, TASK_B);
    expect(split.blockedBy).toHaveLength(2);
    expect(split.blocking).toHaveLength(1);
    // TASK_A is in_progress (open), TASK_D is done (resolved), so openBlockerCount === 1.
    expect(split.openBlockerCount).toBe(1);

    const options = [
      { id: TASK_A, title: 'Khảo sát yêu cầu', status: 'in_progress' },
      { id: TASK_B, title: 'Thiết kế màn hình', status: 'todo' },
      { id: TASK_C, title: 'Triển khai API', status: 'todo' },
      { id: TASK_D, title: 'Ký hợp đồng', status: 'done' },
    ];
    // For blocked_by on B: A and D already block B, B is self -> only C remains.
    expect(availableDependencyCandidates(options, sampleEdges, TASK_B, 'blocked_by').map((t) => t.id)).toEqual([TASK_C]);
    // For blocking on B: B already blocks C, B is self -> A and D remain.
    expect(availableDependencyCandidates(options, sampleEdges, TASK_B, 'blocking').map((t) => t.id)).toEqual([TASK_A, TASK_D]);
  });

  it('requires confirmation only when moving a task with open blockers to in_progress or done', () => {
    expect(shouldConfirmBlockedStatusMove('todo', 'in_progress', 2)).toBe(true);
    expect(shouldConfirmBlockedStatusMove('in_progress', 'done', 1)).toBe(true);
    expect(shouldConfirmBlockedStatusMove('todo', 'waiting', 2)).toBe(false);
    expect(shouldConfirmBlockedStatusMove('todo', 'in_progress', 0)).toBe(false);
    expect(shouldConfirmBlockedStatusMove('in_progress', 'in_progress', 2)).toBe(false);
  });

  it('renders ProjectDependenciesPanel with >=44px touch targets and read-only guard', () => {
    const options = [
      { id: TASK_A, title: 'Khảo sát yêu cầu', status: 'in_progress' },
      { id: TASK_B, title: 'Thiết kế màn hình', status: 'todo' },
      { id: TASK_C, title: 'Triển khai API', status: 'todo' },
    ];
    const writableVi = renderToStaticMarkup(
      wrap(
        'vi',
        <ProjectDependenciesPanel
          taskId={TASK_B}
          edges={sampleEdges}
          projectTasks={options}
          canWrite
          onAdd={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    expect(writableVi).toContain('Khảo sát yêu cầu');
    expect(writableVi).toContain('Triển khai API');
    expect(writableVi).toContain('[&amp;_select]:min-h-11');
    expect(writableVi).toContain('min-h-11');
    expect(writableVi).toContain('add-dependency-btn');
    expect(writableVi).toContain('remove-dependency-btn');

    const writableEn = renderToStaticMarkup(
      wrap(
        'en',
        <ProjectDependenciesPanel
          taskId={TASK_B}
          edges={sampleEdges}
          projectTasks={options}
          canWrite
          onAdd={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    expect(writableEn).toContain('Blocked by');
    expect(writableEn).toContain('Blocking');
    expect(writableEn).toContain('Add dependency');

    const readOnlyHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <ProjectDependenciesPanel
          taskId={TASK_B}
          edges={sampleEdges}
          projectTasks={options}
          canWrite={false}
          onAdd={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    expect(readOnlyHtml).not.toContain('add-dependency-btn');
    expect(readOnlyHtml).not.toContain('remove-dependency-btn');
  });

  it('renders open-blocker and blocking badges on board cards and list rows in vi and en', () => {
    const tasks = [
      card({ id: TASK_A, title: 'Khảo sát yêu cầu', openBlockerCount: 0, blockingCount: 3 }),
      card({ id: TASK_B, title: 'Thiết kế màn hình', openBlockerCount: 2, blockingCount: 1 }),
    ];

    for (const view of ['board', 'list'] as const) {
      const viHtml = renderToStaticMarkup(
        wrap(
          'vi',
          <ProjectBoardView
            slug="demo"
            view={view}
            tasks={tasks}
            seats={seats}
            canEdit
            includeCancelled={false}
            creatingTask={false}
            onMoveStatus={() => {}}
            onCreateTask={() => {}}
            onEditTask={() => {}}
            onRemoveTask={() => {}}
          />,
        ),
      );
      expect(viHtml).toContain('Bị chặn: 2');
      expect(viHtml).toContain('Chặn 3 việc');

      const enHtml = renderToStaticMarkup(
        wrap(
          'en',
          <ProjectBoardView
            slug="demo"
            view={view}
            tasks={tasks}
            seats={seats}
            canEdit
            includeCancelled={false}
            creatingTask={false}
            onMoveStatus={() => {}}
            onCreateTask={() => {}}
            onEditTask={() => {}}
            onRemoveTask={() => {}}
          />,
        ),
      );
      expect(enHtml).toContain('Blocked by 2');
      expect(enHtml).toContain('Blocking 3');
    }
  });

  it('renders deterministic bottlenecks in ProjectWeeklyStatus even with AI off', () => {
    const data: ProjectWeeklyStatusData = {
      ai: 'off',
      project: { id: PROJECT_ID, name: 'Ra mắt Q4', status: 'active' },
      window: { from: '2026-11-10', to: '2026-11-16', nextFrom: '2026-11-17', nextTo: '2026-11-23', timeZone: 'Asia/Ho_Chi_Minh' },
      counts: { totalVisible: 4, doneThisWeek: 1, overdue: 1, waiting: 0, dueNextWeek: 1 },
      tasks: {
        doneThisWeek: [],
        overdue: [],
        waiting: [],
        dueNextWeek: [],
      },
      bottlenecks: [
        { id: TASK_A, title: 'Chốt hợp đồng\u202E khung', tainted: true, status: 'in_progress', due: null, blockedCount: 3 },
      ],
      hiddenByEntityCount: 0,
      sentences: [],
      truncated: false,
    };

    queryClientState.current.clear();
    queryClientState.current.setQueryData(projectWeeklyStatusQueryKey('demo', PROJECT_ID, 'vi'), data);

    const viHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <ProjectWeeklyStatus
          slug="demo"
          projectId={PROJECT_ID}
          projectStatus="active"
          canManage={false}
          defaultOpen
        />,
      ),
    );
    expect(viHtml).toContain('project-weekly-status-bottlenecks');
    expect(viHtml).toContain('Chốt hợp đồng⟨U+202E⟩ khung');
    expect(viHtml).toContain('Chặn 3 việc mở');
  });
});
