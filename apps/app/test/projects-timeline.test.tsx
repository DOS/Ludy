// SPDX-License-Identifier: AGPL-3.0-only
import { VIETNAM_TIME_ZONE, todoDueInstant, type ProjectBoard, type ProjectTimeline, type ProjectTimelineTask } from '@ludy/kernel-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import {
  addLocalDateDays,
  computeCycleBands,
  computeDependencyConnectors,
  computeTimelineBars,
  computeTimelineHeaderBuckets,
  computeTimelineWindow,
  defaultQuickScheduleDates,
  partitionTimelineTasks,
  shiftTaskSchedule,
  taskDueDayVietnam,
  taskScheduleSpan,
  timelineBarKeyDelta,
  timelineDaysBetween,
} from '../src/lib/project-timeline.ts';
import { ProjectDetailPage } from '../src/routes/projects.tsx';

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
    Link: ({
      children,
      to,
      ...rest
    }: {
      children?: ReactNode;
      to: string;
      'data-testid'?: string;
      className?: string;
    }) => createElement('a', { href: to, 'data-testid': rest['data-testid'], className: rest.className }, children),
  };
});

const { ProjectTimelineView } = await import('../src/components/project-timeline.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => (
  <QueryClientProvider client={queryClientState.current}>
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

function makeTask(over: Partial<ProjectTimelineTask>): ProjectTimelineTask {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    title: 'Kiểm tra hóa đơn đầu vào',
    description: null,
    tainted: false,
    status: 'todo',
    startOn: null,
    due: null,
    assigneePositionId: null,
    assigneeTitle: 'Kế toán',
    checkedOut: false,
    commentCount: 0,
    openBlockerCount: 0,
    blockingCount: 0,
    createdAt: '2027-03-01T00:00:00.000Z',
    updatedAt: '2027-03-01T00:00:00.000Z',
    ...over,
  };
}

describe('project-timeline pure layout and scheduling helpers', () => {
  it('computes calendar date offsets and Vietnam due dates without UTC drift', () => {
    expect(addLocalDateDays('2027-03-14', 3)).toBe('2027-03-17');
    expect(addLocalDateDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(timelineDaysBetween('2027-03-10', '2027-03-15')).toBe(5);
    // 17:00 UTC is 00:00 the next day in Asia/Ho_Chi_Minh (+07:00).
    expect(taskDueDayVietnam('2027-03-14T17:00:00.000Z')).toBe('2027-03-15');

    const quick = defaultQuickScheduleDates('2027-03-15');
    expect(quick.startOn).toBe('2027-03-15');
    expect(taskDueDayVietnam(quick.due)).toBe('2027-03-15');
  });

  it('derives spans, shifts schedules cleanly, and clamps resize bounds', () => {
    const both = makeTask({
      startOn: '2027-03-10',
      due: todoDueInstant('2027-03-14', '23:59', VIETNAM_TIME_ZONE).toISOString(),
    });
    expect(taskScheduleSpan(both)).toEqual({
      start: '2027-03-10',
      end: '2027-03-14',
      hasExplicitStart: true,
      hasExplicitDue: true,
    });

    const moved = shiftTaskSchedule(both, 'move', 2);
    expect(moved.startOn).toBe('2027-03-12');
    expect(taskDueDayVietnam(moved.due)).toBe('2027-03-16');

    const clampedStart = shiftTaskSchedule(both, 'resize-start', 10);
    expect(clampedStart.startOn).toBe('2027-03-14');

    const clampedEnd = shiftTaskSchedule(both, 'resize-end', -10);
    expect(taskDueDayVietnam(clampedEnd.due)).toBe('2027-03-10');

    const dueOnly = makeTask({
      startOn: null,
      due: todoDueInstant('2027-03-20', '23:59', VIETNAM_TIME_ZONE).toISOString(),
    });
    const dueOnlyMoved = shiftTaskSchedule(dueOnly, 'move', -3);
    expect(dueOnlyMoved.startOn).toBeNull();
    expect(taskDueDayVietnam(dueOnlyMoved.due)).toBe('2027-03-17');

    expect(timelineBarKeyDelta('ArrowLeft', false)).toBe(-1);
    expect(timelineBarKeyDelta('ArrowRight', false)).toBe(1);
    expect(timelineBarKeyDelta('ArrowLeft', true)).toBe(-7);
    expect(timelineBarKeyDelta('ArrowRight', true)).toBe(7);
    expect(timelineBarKeyDelta('Enter', false)).toBeNull();
  });

  it('computes timeline windows, zoom headers, cycle bands, and SVG dependency paths', () => {
    const taskA = makeTask({
      id: 't-a',
      title: 'Lập tờ khai',
      startOn: '2027-03-10',
      due: todoDueInstant('2027-03-15', '23:59', VIETNAM_TIME_ZONE).toISOString(),
    });
    const taskB = makeTask({
      id: 't-b',
      title: 'Duyệt chứng từ',
      startOn: '2027-03-13',
      due: todoDueInstant('2027-03-18', '23:59', VIETNAM_TIME_ZONE).toISOString(),
    });
    const unscheduled = makeTask({ id: 't-c', title: 'Lưu hồ sơ', startOn: null, due: null });

    const { scheduled, unscheduled: unscheduledOut } = partitionTimelineTasks(
      [taskA, taskB, unscheduled],
      '',
    );
    expect(scheduled.map((t) => t.id)).toEqual(['t-a', 't-b']);
    expect(unscheduledOut.map((t) => t.id)).toEqual(['t-c']);

    const cycles = [
      {
        id: 'cyc-1',
        number: 1,
        name: 'Chu kỳ 1',
        status: 'active' as const,
        startsOn: '2027-03-08',
        endsOn: '2027-03-22',
      },
    ];
    const window = computeTimelineWindow(scheduled, cycles, '2027-03-14', 'week');
    expect(window.totalDays).toBeGreaterThanOrEqual(21);
    const weekBuckets = computeTimelineHeaderBuckets(window, 'week', 'vi');
    expect(weekBuckets.length).toBeGreaterThanOrEqual(3);
    const monthBuckets = computeTimelineHeaderBuckets(
      computeTimelineWindow(scheduled, cycles, '2027-03-14', 'month'),
      'month',
      'vi',
    );
    expect(monthBuckets.some((b) => b.label.startsWith('Th'))).toBe(true);

    const conflicts = [
      {
        dependencyId: 'dep-1',
        blockerTaskId: 't-a',
        blockedTaskId: 't-b',
        blockerDueDate: '2027-03-15',
        blockedTargetDate: '2027-03-13',
        blockedField: 'start_on' as const,
      },
    ];
    const bars = computeTimelineBars(scheduled, window, conflicts, ['t-a', 't-b']);
    expect(bars).toHaveLength(2);
    expect(bars[0]?.hasConflict).toBe(true);
    expect(bars[0]?.isCritical).toBe(true);

    const bands = computeCycleBands(cycles, window);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.widthPx).toBe(15 * window.dayWidthPx);

    const connectors = computeDependencyConnectors(
      bars,
      [{ id: 'dep-1', blockerTaskId: 't-a', blockedTaskId: 't-b' }],
      conflicts,
      ['t-a', 't-b'],
    );
    expect(connectors).toHaveLength(1);
    expect(connectors[0]?.isConflict).toBe(true);
    expect(connectors[0]?.isCritical).toBe(true);

    // Extreme outlier spans clamp safely within TIMELINE_MAX_WINDOW_DAYS (366)
    const clampedWindow = computeTimelineWindow(
      [makeTask({ id: 'extreme', startOn: '2020-01-01', due: todoDueInstant('2035-12-31', '23:59', VIETNAM_TIME_ZONE).toISOString() })],
      [],
      '2027-03-14',
      'month',
    );
    expect(clampedWindow.totalDays).toBe(366);
    expect(connectors[0]?.path).toContain('M ');
  });
});

describe('ProjectTimelineView SSR and accessibility', () => {
  const sampleTimeline: ProjectTimeline = {
    project: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Quyết toán quý 1',
      description: null,
      ownerUserId: 'u1',
      ownerName: 'An',
      status: 'active',
      canManage: true,
      canWrite: true,
      createdAt: '2027-03-01T00:00:00.000Z',
      updatedAt: '2027-03-01T00:00:00.000Z',
    },
    today: '2027-03-15',
    seats: [],
    totalVisible: 3,
    truncated: false,
    hiddenByEntityCount: 0,
    tasks: [
      makeTask({
        id: 't-blocker',
        title: 'Tổng hợp sổ cái',
        status: 'in_progress',
        startOn: '2027-03-10',
        due: todoDueInstant('2027-03-16', '23:59', VIETNAM_TIME_ZONE).toISOString(),
        blockingCount: 1,
      }),
      makeTask({
        id: 't-blocked',
        // Tainted bidi override U+202E must be neutralized (#4422)
        title: 'Ký báo cáo \u202Eabc\u200B',
        tainted: true,
        status: 'todo',
        startOn: '2027-03-14',
        due: todoDueInstant('2027-03-20', '23:59', VIETNAM_TIME_ZONE).toISOString(),
        openBlockerCount: 1,
        checkedOut: true,
      }),
      makeTask({
        id: 't-unscheduled',
        title: 'Nộp tờ khai bổ sung',
        status: 'waiting',
        startOn: null,
        due: null,
      }),
    ],
    edges: [{ id: 'edge-1', blockerTaskId: 't-blocker', blockedTaskId: 't-blocked' }],
    conflicts: [
      {
        dependencyId: 'edge-1',
        blockerTaskId: 't-blocker',
        blockedTaskId: 't-blocked',
        blockerDueDate: '2027-03-16',
        blockedTargetDate: '2027-03-14',
        blockedField: 'start_on',
      },
    ],
    criticalPathTaskIds: ['t-blocker', 't-blocked'],
    criticalPathLength: 2,
    criticalPathSpanDays: 11,
    cycles: [
      {
        id: 'cycle-q1',
        number: 1,
        name: 'Sprint Q1',
        status: 'active',
        startsOn: '2027-03-09',
        endsOn: '2027-03-21',
      },
    ],
  };

  it('renders Gantt bars, SVG dependency connectors, Today marker, cycle bands, unscheduled drawer, mobile table, and safe tainted titles in Vietnamese and English', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = renderToStaticMarkup(
        wrap(
          locale,
          <ProjectTimelineView
            slug="demo-org"
            timeline={sampleTimeline}
            canWrite={true}
            savingTaskId={null}
            saveError={null}
            todayOverride="2027-03-15"
            onSetTaskDates={() => undefined}
          />,
        ),
      );

      expect(html).toContain('data-testid="timeline-zoom-week"');
      expect(html).toContain('data-testid="timeline-zoom-month"');
      expect(html).toContain('data-testid="timeline-search-input"');
      expect(html).toContain('data-testid="timeline-critical-path-toggle"');
      expect(html).toContain('data-testid="timeline-today-marker"');
      expect(html).toContain('data-testid="timeline-dependency-svg"');
      expect(html).toContain('data-testid="timeline-connector-edge-1"');
      expect(html).toContain('data-conflict="true"');
      expect(html).toContain('data-critical="true"');
      expect(html).toContain('data-testid="timeline-conflicts-alert"');
      expect(html).toContain('data-testid="timeline-cycle-band-cycle-q1"');
      expect(html).toContain('data-testid="timeline-unscheduled-panel"');
      expect(html).toContain('data-testid="timeline-quick-schedule-t-unscheduled"');
      expect(html).toContain('data-testid="timeline-mobile-table"');
      // Semantic table accessibility markers
      expect(html).toContain('<caption');
      expect(html).toContain('scope="col"');
      // >= 44px touch targets
      expect(html).toContain('min-h-11');
      // Bidi override U+202E / zero-width U+200B escaped visibly as ⟨U+...⟩ by taskTitleText (#4422)
      expect(html).not.toContain('\u202E');
      expect(html).not.toContain('\u200B');
      expect(html).toContain('Ký báo cáo \u27e8U+202E\u27e9abc\u27e8U+200B\u27e9');
      // No em or en dashes in rendered copy
      expect(html).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('shows read-only notice when project cannot be edited and preserves ProjectDetailPage Timeline tab trigger', () => {
    const readOnlyHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <ProjectTimelineView
          slug="demo-org"
          timeline={{ ...sampleTimeline, project: { ...sampleTimeline.project, canWrite: false } }}
          canWrite={false}
          savingTaskId={null}
          saveError={null}
          todayOverride="2027-03-15"
          onSetTaskDates={() => undefined}
        />,
      ),
    );
    expect(readOnlyHtml).toContain('chế độ chỉ đọc');
    expect(readOnlyHtml).toContain('Xem ngày');
    expect(readOnlyHtml).not.toContain('Chỉnh ngày</button>');
    expect(readOnlyHtml).not.toContain('aria-disabled="true"');
    expect(readOnlyHtml).not.toContain('data-testid="timeline-quick-schedule-t-unscheduled"');

    queryClientState.current.clear();
    const board: ProjectBoard = {
      project: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Chiến dịch Tết',
        description: null,
        ownerUserId: 'u1',
        status: 'active',
        canWrite: true,
        canManage: true,
        ownerName: 'An',
        createdAt: '2027-03-01T00:00:00.000Z',
        updatedAt: '2027-03-01T00:00:00.000Z',
      },
      seats: [],
      members: [],
      tasks: [],
      isTeamOrg: false,
      viewerHasSeat: true,
      totalVisible: 0,
      hiddenByEntityCount: 0,
      truncated: false,
    };
    queryClientState.current.setQueryData(
      ['projects', 'board', { projectId: '00000000-0000-4000-8000-000000000001' }],
      board,
    );
    queryClientState.current.setQueryData(['me', 'get', {}], {
      user: { id: 'u1', email: 'an@example.com', displayName: 'An' },
      orgs: [{ id: 'org-1', slug: 'demo-org', name: 'Demo Org', role: 'owner', status: 'active' }],
    });

    const pageHtml = renderToStaticMarkup(wrap('vi', <ProjectDetailPage />));
    expect(pageHtml).toContain('data-testid="view-toggle-timeline"');
    expect(pageHtml).toContain('Dòng thời gian');
  });
});
