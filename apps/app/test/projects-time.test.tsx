// SPDX-License-Identifier: AGPL-3.0-only
// Client-side helper and SSR rendering tests for lean project time tracking & billable hours (#2600).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectTimeSummaryResult } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import {
  createTimeEntryIdempotencyTracker,
  formatDecimalHours,
  formatDecimalMoney,
  formatMinutesAsHours,
  isValidHourlyRateInput,
  previewBillableAmount,
} from '../src/lib/projects-time.ts';

const PROJECT_ID = '01900000-0000-7000-8000-000000000001';
const OTHER_PROJECT_ID = '01900000-0000-7000-8000-000000000002';
const TASK_ID = '01900000-0000-7000-8000-000000000011';
const USER_ID = '01900000-0000-7000-8000-000000000021';

const summaryState = vi.hoisted(() => ({ current: null as ProjectTimeSummaryResult | null }));
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
            queryFn: () => Promise.resolve(summaryState.current),
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

const { orpc } = await import('../src/lib/api.ts');
const { browserTimeZone } = await import('../src/lib/my-work.ts');
const { ProjectTimeTab, TaskTimeTrackingPanel } = await import('../src/components/project-time-panel.tsx');

const wrap = (locale: 'vi' | 'en', node: ReactNode) => (
  <QueryClientProvider client={queryClientState.current}>
    <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
      {node}
    </IntlProvider>
  </QueryClientProvider>
);

const sampleSummary: ProjectTimeSummaryResult = {
  projectId: PROJECT_ID,
  timeZone: 'Asia/Ho_Chi_Minh',
  canWrite: true,
  canManageProject: true,
  activeTimer: {
    projectName: 'Chiến dịch Q4',
    entry: {
      id: '01900000-0000-7000-8000-000000000101',
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      taskTitle: 'Hoàn thiện báo giá',
      userId: USER_ID,
      userDisplayName: 'Lan Anh',
      startedAt: '2026-11-22T02:00:00.000Z',
      endedAt: null,
      durationMinutes: null,
      billable: true,
      hourlyRate: '500000.00',
      billableAmount: null,
      note: 'Đang kiểm tra số liệu',
      running: true,
      canManage: true,
      createdAt: '2026-11-22T02:00:00.000Z',
      updatedAt: '2026-11-22T02:00:00.000Z',
    },
  },
  totals: {
    entryCount: 2,
    totalMinutes: 90,
    billableMinutes: 60,
    nonBillableMinutes: 30,
    totalHours: '1.50',
    billableHours: '1.00',
    nonBillableHours: '0.50',
    billableAmount: '500000.00',
  },
  byTask: [
    {
      taskId: TASK_ID,
      taskTitle: 'Hoàn thiện báo giá',
      totals: {
        entryCount: 2,
        totalMinutes: 90,
        billableMinutes: 60,
        nonBillableMinutes: 30,
        totalHours: '1.50',
        billableHours: '1.00',
        nonBillableHours: '0.50',
        billableAmount: '500000.00',
      },
    },
  ],
  byMember: [
    {
      userId: null,
      displayName: null,
      totals: {
        entryCount: 1,
        totalMinutes: 60,
        billableMinutes: 60,
        nonBillableMinutes: 0,
        totalHours: '1.00',
        billableHours: '1.00',
        nonBillableHours: '0.00',
        billableAmount: '500000.00',
      },
    },
  ],
  entries: [
    {
      id: '01900000-0000-7000-8000-000000000102',
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      taskTitle: 'Hoàn thiện báo giá',
      userId: null,
      userDisplayName: null,
      startedAt: '2026-11-21T08:00:00.000Z',
      endedAt: '2026-11-21T09:00:00.000Z',
      durationMinutes: 60,
      billable: true,
      hourlyRate: '500000.00',
      billableAmount: '500000.00',
      note: 'Tư vấn khách hàng',
      running: false,
      canManage: true,
      createdAt: '2026-11-21T09:00:00.000Z',
      updatedAt: '2026-11-21T09:00:00.000Z',
    },
  ],
  totalEntries: 1,
  hasMore: false,
};

describe('projects time tracking client helpers & UI (#2600)', () => {
  it('formats large decimal money and billable previews strictly without JS float drift', () => {
    expect(formatDecimalMoney('1250000.00', 'vi')).toBe('1.250.000');
    expect(formatDecimalMoney('1250000.00', 'en')).toBe('1,250,000');
    expect(formatDecimalMoney('999999999999999.75', 'vi')).toBe('999.999.999.999.999,75');
    expect(formatDecimalHours('1.50', 'vi')).toBe('1,5');
    expect(formatDecimalHours('1.50', 'en')).toBe('1.5');
    expect(formatMinutesAsHours(90, 'vi')).toBe('1,5');

    expect(previewBillableAmount(20, '100000.00', true)).toBe('33333.33');
    expect(previewBillableAmount(40, '100000.00', true)).toBe('66666.67');
    expect(previewBillableAmount(60, '100000.00', false)).toBeNull();
    expect(isValidHourlyRateInput('500000.25')).toBe(true);
    expect(isValidHourlyRateInput('-100')).toBe(false);
    expect(isValidHourlyRateInput('100.123')).toBe(false);
  });

  it('renders TaskTimeTrackingPanel with aria-live="off" on running timer and >= 44px touch targets', () => {
    summaryState.current = sampleSummary;
    const tz = browserTimeZone();
    const summaryQueryKey = orpc.projects.timeSummary.queryOptions({
      input: { projectId: PROJECT_ID, taskId: TASK_ID, timeZone: tz },
    }).queryKey;
    queryClientState.current.setQueryData(summaryQueryKey, sampleSummary);

    const html = renderToStaticMarkup(
      wrap('vi', <TaskTimeTrackingPanel projectId={PROJECT_ID} taskId={TASK_ID} canWrite />),
    );
    expect(html).toContain('aria-live="off"');
    expect(html).toContain('min-h-11');
    expect(html).toContain('Dừng bấm giờ');
    expect(html).toContain('500.000 VND');
    expect(html).toContain('Thành viên đã rời tổ chức');

    // Archived / read-only summary hides write controls even when route passes canWrite=true (#2600).
    const readOnlySummary: ProjectTimeSummaryResult = { ...sampleSummary, canWrite: false };
    queryClientState.current.setQueryData(summaryQueryKey, readOnlySummary);
    const readOnlyHtml = renderToStaticMarkup(
      wrap('vi', <TaskTimeTrackingPanel projectId={PROJECT_ID} taskId={TASK_ID} canWrite />),
    );
    expect(readOnlyHtml).not.toContain('task-timer-start');
    expect(readOnlyHtml).not.toContain('task-time-log-toggle');
  });

  it('renders ProjectTimeTab summary, breakdowns, and other-project timer indicator in vi and en', () => {
    const otherRunning: ProjectTimeSummaryResult = {
      ...sampleSummary,
      activeTimer: {
        ...sampleSummary.activeTimer!,
        projectName: 'Dự án khác',
        entry: { ...sampleSummary.activeTimer!.entry, projectId: OTHER_PROJECT_ID },
      },
    };
    const tz = browserTimeZone();
    const key = orpc.projects.timeSummary.queryOptions({
      input: { projectId: PROJECT_ID, timeZone: tz, limit: 50, offset: 0 },
    }).queryKey;
    queryClientState.current.setQueryData(key, otherRunning);

    const viHtml = renderToStaticMarkup(
      wrap(
        'vi',
        <ProjectTimeTab
          projectId={PROJECT_ID}
          canWrite
          tasks={[]}
          members={[]}
        />,
      ),
    );
    expect(viHtml).toContain('project-time-tab');
    expect(viHtml).toContain('project-active-timer-banner');
    expect(viHtml).toContain('aria-live="off"');
    expect(viHtml).toContain('Xuất CSV');
    expect(viHtml).toContain('1,5 h');
    expect(viHtml).toContain('500.000 VND');

    const enHtml = renderToStaticMarkup(
      wrap(
        'en',
        <ProjectTimeTab
          projectId={PROJECT_ID}
          canWrite
          tasks={[]}
          members={[]}
        />,
      ),
    );
    expect(enHtml).toContain('Export CSV');
    expect(enHtml).toContain('1.5 h');
    expect(enHtml).toContain('500,000 VND');
  });

  it('reuses a time-entry form idempotency key across retries and rotates on edit or completion', () => {
    let seq = 0;
    const tracker = createTimeEntryIdempotencyTracker(() => `key-${++seq}`);

    const firstAttemptKey = tracker.current();
    expect(firstAttemptKey).toBe('key-1');
    expect(tracker.current()).toBe('key-1');

    tracker.rotate();
    const afterEditKey = tracker.current();
    expect(afterEditKey).toBe('key-2');
    expect(tracker.current()).toBe('key-2');

    tracker.rotate();
    expect(tracker.current()).toBe('key-3');
  });
});
