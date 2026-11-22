// SPDX-License-Identifier: AGPL-3.0-only
// SSR & accessibility tests for opt-in Cycles, Story points, Burndown/Velocity table fallback, and Vy Cycle Summary (#4361).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectBoard,
  ProjectCycle,
  ProjectCycleListResult,
  ProjectCycleMetrics,
  ProjectTaskCard,
} from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const authState = vi.hoisted(() => ({ modules: ['projects', 'notes'] as string[] }));
vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: authState.modules }),
}));

const queryClientState = vi.hoisted(() => ({ current: null as unknown as QueryClient }));
const rpcData = vi.hoisted(() => ({
  board: null as ProjectBoard | null,
  cycles: null as ProjectCycleListResult | null,
  metrics: null as ProjectCycleMetrics | null,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  queryClientState.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (args?: { input?: unknown }) => ({
            queryKey: [...path, args?.input ?? {}],
            queryFn: () => {
              const name = path.join('.');
              if (name === 'projects.board' && rpcData.board) return Promise.resolve(rpcData.board);
              if (name === 'projects.listCycles' && rpcData.cycles) return Promise.resolve(rpcData.cycles);
              if (name === 'projects.cycleMetrics' && rpcData.metrics) return Promise.resolve(rpcData.metrics);
              return Promise.reject(new Error('not mocked'));
            },
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

const { ProjectDetailPage } = await import('../src/routes/projects.tsx');
const { buildBurndownPolylinePoints } = await import('../src/components/project-cycles.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => (
  <QueryClientProvider client={queryClientState.current}>
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const CYCLE_ID = '00000000-0000-4000-8000-000000000011';

const sampleTask = (over: Partial<ProjectTaskCard> = {}): ProjectTaskCard => ({
  id: '10000000-0000-4000-8000-000000000001',
  title: 'Rà soát chứng từ Sprint',
  description: null,
  status: 'todo',
  assigneePositionId: null,
  due: null,
  checklist: [],
  tainted: false,
  checkedOut: false,
  commentCount: 0,
  createdAt: '2027-02-01T01:00:00.000Z',
  addedAt: '2027-02-01T01:00:00.000Z',
  cycleId: CYCLE_ID,
  storyPoints: 5,
  ...over,
});

const sampleCycle = (over: Partial<ProjectCycle> = {}): ProjectCycle => ({
  id: CYCLE_ID,
  projectId: PROJECT_ID,
  number: 1,
  name: 'Sprint 1',
  goal: 'Chốt quy trình thanh toán',
  status: 'active',
  startsOn: '2027-02-01',
  endsOn: '2027-02-14',
  startedAt: '2027-02-01T01:00:00.000Z',
  completedAt: null,
  createdAt: '2027-02-01T01:00:00.000Z',
  updatedAt: '2027-02-01T01:00:00.000Z',
  totalTasks: 4,
  openTasks: 2,
  doneTasks: 2,
  cancelledTasks: 0,
  totalPoints: 13,
  donePoints: 8,
  ...over,
});

describe('Projects cycles UI & accessibility (#4361)', () => {
  beforeEach(() => {
    queryClientState.current.clear();
  });

  it('hides cycle panel, cycle filter tabs, and story-point chips when cyclesEnabled=false and pointsEnabled=false', () => {
    const board: ProjectBoard = {
      project: {
        id: PROJECT_ID,
        name: 'Dự án mặc định',
        description: null,
        ownerUserId: null,
        ownerName: null,
        status: 'active',
        cyclesEnabled: false,
        cycleDurationWeeks: 2,
        pointsEnabled: false,
        canManage: true,
        canWrite: true,
        createdAt: '2027-02-01T01:00:00.000Z',
        updatedAt: '2027-02-01T01:00:00.000Z',
      },
      members: [],
      seats: [],
      isTeamOrg: false,
      viewerHasSeat: false,
      tasks: [sampleTask({ cycleId: null, storyPoints: 5 })],
      activeCycle: null,
      totalVisible: 1,
      hiddenByEntityCount: 0,
      truncated: false,
    };
    queryClientState.current.setQueryData(
      ['projects', 'board', { projectId: PROJECT_ID }],
      board,
    );

    const html = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(html).not.toContain('project-cycles-panel');
    expect(html).not.toContain('task-points-trigger');
    expect(html).not.toContain('cycle-burndown-svg');
  });

  it('renders cycles panel, progress bar, accessible burndown/velocity semantic tables, Vy button, and story-point chips when opted in', () => {
    const active = sampleCycle();
    const board: ProjectBoard = {
      project: {
        id: PROJECT_ID,
        name: 'Dự án Sprint',
        description: null,
        ownerUserId: null,
        ownerName: null,
        status: 'active',
        cyclesEnabled: true,
        cycleDurationWeeks: 2,
        pointsEnabled: true,
        canManage: true,
        canWrite: true,
        createdAt: '2027-02-01T01:00:00.000Z',
        updatedAt: '2027-02-01T01:00:00.000Z',
      },
      members: [],
      seats: [],
      isTeamOrg: true,
      viewerHasSeat: true,
      tasks: [sampleTask()],
      activeCycle: active,
      totalVisible: 1,
      hiddenByEntityCount: 0,
      truncated: false,
    };
    const cyclesRes: ProjectCycleListResult = {
      cycles: [active],
      backlogTaskCount: 3,
      backlogPoints: 8,
      hiddenByEntityCount: 0,
      truncated: false,
    };
    const metricsRes: ProjectCycleMetrics = {
      projectId: PROJECT_ID,
      selectedCycle: active,
      burndown: [
        { date: '2027-02-01', idealRemainingTasks: 4, idealRemainingPoints: 13, remainingTasks: 4, remainingPoints: 13 },
        { date: '2027-02-02', idealRemainingTasks: 2, idealRemainingPoints: 6.5, remainingTasks: 2, remainingPoints: 5 },
      ],
      velocity: [
        {
          cycleId: '00000000-0000-4000-8000-000000000099',
          number: 0,
          name: 'Pre-sprint',
          startsOn: '2027-01-15',
          endsOn: '2027-01-28',
          completedTasks: 3,
          totalTasks: 4,
          completedPoints: 8,
          committedPoints: 10,
        },
      ],
      averageVelocityTasks: 3,
      averageVelocityPoints: 8,
      hiddenByEntityCount: 0,
    };

    queryClientState.current.setQueryData(['projects', 'board', { projectId: PROJECT_ID }], board);
    queryClientState.current.setQueryData(['projects', 'listCycles', { projectId: PROJECT_ID }], cyclesRes);
    queryClientState.current.setQueryData(['projects', 'cycleMetrics', { projectId: PROJECT_ID }], metricsRes);

    const html = renderToStaticMarkup(wrap('en', <ProjectDetailPage />));
    expect(html).toContain('project-cycles-panel');
    expect(html).toContain('active-cycle-card');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('cycle-burndown-svg');
    expect(html).toContain('cycle-velocity-chart');
    expect(html).toContain('cycle-metrics-tables');
    expect(html).toContain('<caption class="sr-only">Cycle burndown</caption>');
    expect(html).toContain('ask-vy-cycle-summary');
    expect(html).toContain('task-points-trigger');
    expect(html).toContain('5 pt');
    // Touch target >= 44px on mobile via min-h-11.
    expect(html).toContain('min-h-11');
  });

  it('computes SVG polyline coordinates cleanly without NaN', () => {
    const pts = buildBurndownPolylinePoints(
      [
        { date: '2027-02-01', idealRemainingTasks: 4, idealRemainingPoints: 10, remainingTasks: 4, remainingPoints: 10 },
        { date: '2027-02-02', idealRemainingTasks: 0, idealRemainingPoints: 0, remainingTasks: null, remainingPoints: null },
      ],
      true,
      'ideal',
      320,
      110,
    );
    expect(pts).toBe('8.0,8.0 312.0,102.0');
  });

  it('hides Vy cycle summary trigger until at least one cycle exists', () => {
    const board: ProjectBoard = {
      project: {
        id: PROJECT_ID,
        name: 'Dự án trống chu kỳ',
        description: null,
        ownerUserId: null,
        ownerName: null,
        status: 'active',
        cyclesEnabled: true,
        cycleDurationWeeks: 2,
        pointsEnabled: false,
        canManage: true,
        canWrite: true,
        createdAt: '2027-02-01T01:00:00.000Z',
        updatedAt: '2027-02-01T01:00:00.000Z',
      },
      members: [],
      seats: [],
      isTeamOrg: true,
      viewerHasSeat: true,
      tasks: [],
      activeCycle: null,
      totalVisible: 0,
      hiddenByEntityCount: 0,
      truncated: false,
    };
    queryClientState.current.setQueryData(['projects', 'board', { projectId: PROJECT_ID }], board);
    queryClientState.current.setQueryData(['projects', 'listCycles', { projectId: PROJECT_ID }], {
      cycles: [],
      backlogTaskCount: 0,
      backlogPoints: 0,
      hiddenByEntityCount: 0,
      truncated: false,
    });
    const html = renderToStaticMarkup(wrap('en', <ProjectDetailPage />));
    expect(html).toContain('project-cycles-panel');
    expect(html).not.toContain('ask-vy-cycle-summary');
  });
});
