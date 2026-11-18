// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR tests for Notes v2 T3 & T4a UI helpers, recurrence badge/selector, overdue reschedule bar, and Sap toi agenda (#3557).
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIME_ZONE, type MyWork, type MyWorkTask, type TodoSummary } from '@crove/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import {
  chunkTodoIds,
  formatDayBucketShort,
  formatDayBucketWeekday,
  groupUpcomingAgenda,
  localDueDayOfTask,
  todoRecurrenceEqual,
  todoRecurrencePreset,
  upcomingDates,
} from '../src/lib/my-work.ts';

const testState = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['kernel', 'notes', 'projects'] }),
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  testState.client = new QC({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input ?? {}], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  const api = node([]);
  return { orpc: api, client: api, clientForOrg: () => api, queryClient: testState.client, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) };
});

vi.mock('../src/i18n/provider.tsx', () => ({
  useFormat: () => ({
    date: (v: string) => `date:${v.slice(0, 10)}`,
    dateTime: (v: string) => v,
    number: (v: number | bigint | string) => String(v),
  }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string> } & Record<string, unknown>) =>
      createElement('a', { href: to.replace('$slug', params?.slug ?? '').replace('$id', params?.id ?? ''), ...rest }, children),
    useNavigate: () => () => undefined,
    useParams: () => ({ slug: 'acme' }),
  };
});

const { MyWorkPage, TodoRecurrenceBadge, TodoRecurrenceField } = await import('../src/routes/my-work.tsx');
const { browserTimeZone } = await import('../src/lib/my-work.ts');
const { orpc } = await import('../src/lib/api.ts');

const TODO_1 = '11111111-1111-4111-8111-111111111111';
const TODO_2 = '22222222-2222-4222-8222-222222222222';
const TODO_3 = '33333333-3333-4333-8333-333333333333';
const TASK_1 = '44444444-4444-4444-8444-444444444444';
const TASK_2 = '55555555-5555-4555-8555-555555555555';

function makeTodo(overrides: Partial<TodoSummary> & { id: string; title: string }): TodoSummary {
  return {
    status: 'open',
    priority: 4,
    tags: [],
    listId: null,
    sectionId: null,
    dueOn: null,
    dueAt: null,
    dueTime: null,
    timeZone: DEFAULT_TIME_ZONE,
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
    createdAt: '2026-11-17T01:00:00.000Z',
    updatedAt: '2026-11-17T01:00:00.000Z',
    doneAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<MyWorkTask> & { id: string; title: string }): MyWorkTask {
  return {
    status: 'todo',
    positionId: null,
    due: null,
    group: 'none',
    overdue: false,
    tainted: false,
    project: null,
    ...overrides,
  };
}

function wrap(locale: 'vi' | 'en', node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={testState.client}>
      <IntlProvider locale={locale} timeZone={DEFAULT_TIME_ZONE} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('upcoming agenda and recurrence UI helpers (#3557)', () => {
  it('generates sequential local dates and groups overdue + day buckets across 7 and 30 day horizons', () => {
    const dates7 = upcomingDates('2026-11-17', 7);
    expect(dates7).toHaveLength(7);
    expect(dates7[0]).toBe('2026-11-17');
    expect(dates7[6]).toBe('2026-11-23');
    expect(upcomingDates('2026-11-17', 30)).toHaveLength(30);

    const tOverdue = makeTodo({ id: TODO_1, title: 'Quá hạn', dueOn: '2026-11-15', group: 'overdue', overdue: true });
    const tToday = makeTodo({ id: TODO_2, title: 'Hôm nay', dueOn: '2026-11-17', group: 'today' });
    const tDay20 = makeTodo({ id: TODO_3, title: 'Ngày 20', dueOn: '2026-12-07', group: 'later' });
    const taskOverdue = makeTask({ id: TASK_1, title: 'Việc nhóm trễ', due: '2026-11-16T03:00:00.000Z', group: 'overdue', overdue: true });
    const taskDay2 = makeTask({ id: TASK_2, title: 'Việc nhóm ngày mai', due: '2026-11-18T10:00:00.000Z', group: 'next7' });

    expect(localDueDayOfTask(taskDay2, DEFAULT_TIME_ZONE)).toBe('2026-11-18');

    const agenda7 = groupUpcomingAgenda([tOverdue, tToday, tDay20], [taskOverdue, taskDay2], '2026-11-17', 7, DEFAULT_TIME_ZONE);
    expect(agenda7.overdueTodos.map((x) => x.id)).toEqual([TODO_1]);
    expect(agenda7.overdueTasks.map((x) => x.id)).toEqual([TASK_1]);
    expect(agenda7.days.find((d) => d.date === '2026-11-17')?.todos.map((x) => x.id)).toEqual([TODO_2]);
    expect(agenda7.days.find((d) => d.date === '2026-11-18')?.tasks.map((x) => x.id)).toEqual([TASK_2]);
    expect(agenda7.days.some((d) => d.date === '2026-12-07')).toBe(false);

    const agenda30 = groupUpcomingAgenda([tOverdue, tToday, tDay20], [taskOverdue, taskDay2], '2026-11-17', 30, DEFAULT_TIME_ZONE);
    expect(agenda30.days.find((d) => d.date === '2026-12-07')?.todos.map((x) => x.id)).toEqual([TODO_3]);

    // A to-do due yesterday in browser TZ that is still today in its own time zone (group: 'today', overdue: false)
    // must NOT be pushed into Overdue; it stays in Today's bucket.
    const tWesternToday = makeTodo({
      id: TODO_2,
      title: 'US Pacific today',
      dueOn: '2026-11-17',
      timeZone: 'America/Los_Angeles',
      group: 'today',
      overdue: false,
    });
    const crossZone = groupUpcomingAgenda([tWesternToday], [], '2026-11-18', 7, DEFAULT_TIME_ZONE);
    expect(crossZone.overdueTodos).toEqual([]);
    expect(crossZone.days.find((d) => d.date === '2026-11-18')?.todos.map((x) => x.id)).toEqual([TODO_2]);
  });

  it('formats day bucket short date and weekday consistently without shifting bare YYYY-MM-DD', () => {
    expect(formatDayBucketShort('2026-11-17', 'vi')).toBe('17/11');
    expect(formatDayBucketShort('2026-11-17', 'en')).toBe('17/11');
    expect(formatDayBucketWeekday('2026-11-17', 'en')).toBe('Tue');
  });

  it('chunks reschedule batches cleanly and compares recurrence presets/equality', () => {
    expect(chunkTodoIds(['1', '2', '3', '4', '5'], 2)).toEqual([['1', '2'], ['3', '4'], ['5']]);
    expect(todoRecurrencePreset(null)).toBe('none');
    expect(todoRecurrencePreset({ freq: 'daily', interval: 1 })).toBe('daily');
    expect(todoRecurrencePreset({ freq: 'weekly', interval: 1 })).toBe('weekly');
    expect(todoRecurrencePreset({ freq: 'monthly', interval: 1 })).toBe('monthly');
    expect(todoRecurrencePreset({ freq: 'monthly', interval: 1, byMonthDay: -1 })).toBe('monthEnd');
    expect(todoRecurrencePreset({ freq: 'weekly', interval: 2, byWeekday: 1 })).toBe('custom');
    expect(todoRecurrenceEqual({ freq: 'daily', interval: 1 }, { freq: 'daily', interval: 1, byWeekday: null })).toBe(true);
    expect(todoRecurrenceEqual({ freq: 'daily', interval: 1 }, { freq: 'daily', interval: 2 })).toBe(false);
  });
});

describe('My work recurring & overdue SSR UI (#3557)', () => {
  it('renders recurrence badges and selector presets/custom controls in both vi and en', () => {
    const viBadge = wrap('vi', <TodoRecurrenceBadge recurrence={{ freq: 'monthly', interval: 1, byMonthDay: -1 }} />);
    const enBadge = wrap('en', <TodoRecurrenceBadge recurrence={{ freq: 'daily', interval: 3 }} />);
    expect(viBadge).toContain('Cuối tháng');
    expect(enBadge).toContain('Every 3 days');

    const viCustom = wrap('vi', <TodoRecurrenceField value={{ freq: 'weekly', interval: 2, byWeekday: 1 }} onChange={() => undefined} />);
    const enCustom = wrap('en', <TodoRecurrenceField value={{ freq: 'monthly', interval: 1, byMonthDay: 15 }} onChange={() => undefined} />);
    expect(viCustom).toContain('data-testid="todo-recurrence-custom"');
    expect(viCustom).toContain('Thứ 2');
    expect(enCustom).toContain('Monthly');
    expect(enCustom).toContain('Repeat');
  });

  it('renders Sap toi tab, recurrence badge, 1-click overdue reschedule buttons and bulk overdue action bar', () => {
    const workData: MyWork = {
      todos: [
        makeTodo({
          id: TODO_1,
          title: 'Gửi báo cáo thuế',
          dueOn: '2026-10-01',
          group: 'overdue',
          overdue: true,
          recurrence: { freq: 'monthly', interval: 1, byMonthDay: -1 },
          seriesId: TODO_1,
        }),
      ],
      tasks: [],
      tasksTruncated: false,
      projectsAvailable: true,
      noSeatHint: false,
    };
    const q = orpc.notes.todos.myWork.queryOptions({ input: { timeZone: browserTimeZone() } });
    testState.client.setQueryData(q.queryKey, workData);

    const viHtml = wrap('vi', <MyWorkPage />);
    expect(viHtml).toContain('data-testid="my-work-tab-upcoming"');
    expect(viHtml).toContain('Sắp tới');
    expect(viHtml).toContain('data-testid="todo-recurrence-badge"');
    expect(viHtml).toContain('Cuối tháng');
    expect(viHtml).toContain('data-testid="overdue-bulk-bar"');
    expect(viHtml).toContain('Đổi lịch việc quá hạn');
    expect(viHtml).toContain('data-testid="todo-reschedule-tomorrow"');
    expect(viHtml).toContain('Ngày mai');
    expect(viHtml).toContain('Đầu tuần sau');
    expect(viHtml).toContain('Chọn ngày');

    const enHtml = wrap('en', <MyWorkPage />);
    expect(enHtml).toContain('Upcoming');
    expect(enHtml).toContain('Reschedule overdue');
    expect(enHtml).toContain('Next Monday');
    expect(enHtml).toContain('End of month');

    // A to-do due today whose due time already passed (group: 'today', overdue: true) still shows the bulk overdue bar.
    testState.client.setQueryData(q.queryKey, {
      ...workData,
      todos: [makeTodo({ id: TODO_2, title: 'Trễ giờ hôm nay', dueOn: '2026-11-17', dueTime: '09:00', group: 'today', overdue: true })],
    });
    const todayLateHtml = wrap('vi', <MyWorkPage />);
    expect(todayLateHtml).toContain('data-testid="overdue-bulk-bar"');
    expect(todayLateHtml).toContain('data-testid="todo-overdue-actions"');
  });
});
