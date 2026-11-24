// SPDX-License-Identifier: AGPL-3.0-only
// Client-side helper and SSR rendering tests for lean project time tracking & billable hours (#2600).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectTaskCard, ProjectTimeEntry, ProjectTimeSummaryResult } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';
import {
  beginTimeEntriesLoadMore,
  buildStopAndSwitchTimerInput,
  buildTimeEntrySubmitPayload,
  closeMatchingTimeFormSession,
  createPendingTimerSwitch,
  createTimeEntriesPaginationState,
  createTimeEntryIdempotencyTracker,
  formatDecimalHours,
  formatDecimalMoney,
  formatMinutesAsHours,
  isValidHourlyRateInput,
  mergeTimeSummaryEntries,
  previewBillableAmount,
  resetTimeEntriesPagination,
  resolveTimeEntriesLoadMoreError,
  resolveTimeEntriesLoadMoreSuccess,
  timeSummaryPageSignature,
  toLocalDateTimeInput,
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

  it('scopes draft form close callback strictly to the submitted form session (#4462)', () => {
    const entryA = sampleSummary.entries[0]!;
    const session1 = { id: 1, editingEntry: entryA };
    const session2 = { id: 2, editingEntry: null };

    // Close callback matches only the submitted form session.
    expect(closeMatchingTimeFormSession(session1, 1)).toBeNull();
    // Stale completion after cancel + reopen or switch to another draft never closes session 2.
    expect(closeMatchingTimeFormSession(session2, 1)).toBe(session2);
    expect(closeMatchingTimeFormSession(null, 1)).toBeNull();

    // Pending timer switch remains pinned to the initially requested task ID even if filter/active task changes.
    const TASK_B = '01900000-0000-7000-8000-000000000012';
    const pending = createPendingTimerSwitch(PROJECT_ID, TASK_ID, 'Công việc A');
    let activeFilterTaskId = TASK_ID;
    activeFilterTaskId = TASK_B;
    expect(activeFilterTaskId).toBe(TASK_B);
    expect(buildStopAndSwitchTimerInput(pending, 'idem-switch-1')).toEqual({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      stopExisting: true,
      idempotencyKey: 'idem-switch-1',
    });
  });

  it('retains loaded rows on Load more rejection, clears on retry, and discards stale pages across resets (#4462)', () => {
    const row1 = sampleSummary.entries[0]!;
    const row2: ProjectTimeEntry = { ...row1, id: '01900000-0000-7000-8000-000000000103', note: 'Trang 2' };
    const row3: ProjectTimeEntry = { ...row1, id: '01900000-0000-7000-8000-000000000104', note: 'Bo loc moi' };

    let state = createTimeEntriesPaginationState();
    state = beginTimeEntriesLoadMore(state, 1);
    expect(state.loadingMore).toBe(true);

    // Page 2 succeeds.
    state = resolveTimeEntriesLoadMoreSuccess(state, state.epoch, 1, [row2]);
    expect(state.loadingMore).toBe(false);
    expect(state.loadMoreError).toBeNull();
    expect(state.extraEntries.map((e) => e.id)).toEqual([row2.id]);

    // Next page fails -> retain row2, record error, stop spinner.
    const boom = new Error('load more network failure');
    state = beginTimeEntriesLoadMore(state, 2);
    state = resolveTimeEntriesLoadMoreError(state, state.epoch, 2, boom);
    expect(state.loadingMore).toBe(false);
    expect(state.loadMoreError).toBe(boom);
    expect(state.extraEntries.map((e) => e.id)).toEqual([row2.id]);

    // Retry clears error and prepares request 3.
    state = beginTimeEntriesLoadMore(state, 3);
    expect(state.loadingMore).toBe(true);
    expect(state.loadMoreError).toBeNull();
    const epochBeforeFilterToggle = state.epoch;

    // Filter toggle or page-1 refetch resets pagination while request 3 is in flight.
    state = resetTimeEntriesPagination(state);
    expect(state.loadingMore).toBe(false);
    expect(state.extraEntries).toEqual([]);
    expect(state.epoch).toBe(epochBeforeFilterToggle + 1);

    // Late resolution/error from request 3 under old epoch is discarded completely.
    const afterStaleSuccess = resolveTimeEntriesLoadMoreSuccess(state, epochBeforeFilterToggle, 3, [row3]);
    expect(afterStaleSuccess).toBe(state);
    const afterStaleError = resolveTimeEntriesLoadMoreError(state, epochBeforeFilterToggle, 3, boom);
    expect(afterStaleError).toBe(state);

    // Signature changes when page-1 updates or totalEntries changes; merge deduplicates cleanly.
    const sig1 = timeSummaryPageSignature({ entries: [row1], totalEntries: 2 });
    const sig2 = timeSummaryPageSignature({ entries: [{ ...row1, updatedAt: '2026-11-21T10:00:00.000Z' }], totalEntries: 2 });
    const sig3 = timeSummaryPageSignature({ entries: [row1], totalEntries: 3 });
    expect(sig1).not.toBeNull();
    expect(sig1).not.toBe(sig2);
    expect(sig1).not.toBe(sig3);
    expect(mergeTimeSummaryEntries([row1], [row1, row2]).map((e) => e.id)).toEqual([row1.id, row2.id]);
  });

  it('validates per active input mode across DST-like end times, note-only edits, and skips unchanged endedAt (#4462)', () => {
    // 1. Create in duration mode when endedAt wall-clock time appears before startedAt (DST fall-back case): passes.
    const createDurationRes = buildTimeEntrySubmitPayload(
      {
        taskId: TASK_ID,
        startedAt: '2026-11-01T01:45',
        endedAt: '2026-11-01T01:15',
        durationMinutes: '30',
        timingMode: 'duration',
        billable: false,
        hourlyRate: '',
        note: 'DST fall-back log',
      },
      null,
    );
    expect(createDurationRes.ok).toBe(true);
    if (createDurationRes.ok && createDurationRes.mode === 'create') {
      expect(createDurationRes.payload.durationMinutes).toBe(30);
      expect('endedAt' in createDurationRes.payload).toBe(false);
    }

    // 2. Create in endedAt mode with endedAt before startedAt fails range check, and ignores garbage durationMinutes.
    const createEndedBad = buildTimeEntrySubmitPayload(
      {
        taskId: TASK_ID,
        startedAt: '2026-11-01T01:45',
        endedAt: '2026-11-01T01:15',
        durationMinutes: '',
        timingMode: 'endedAt',
        billable: false,
        hourlyRate: '',
        note: '',
      },
      null,
    );
    expect(createEndedBad).toEqual({ ok: false, errorKey: 'invalidRangeError' });

    const createEndedValid = buildTimeEntrySubmitPayload(
      {
        taskId: TASK_ID,
        startedAt: '2026-11-21T08:00',
        endedAt: '2026-11-21T09:15',
        durationMinutes: '',
        timingMode: 'endedAt',
        billable: true,
        hourlyRate: '250000',
        note: 'Theo moc ket thuc',
      },
      null,
    );
    expect(createEndedValid.ok).toBe(true);
    if (createEndedValid.ok && createEndedValid.mode === 'create') {
      expect(createEndedValid.payload.endedAt).toBeDefined();
      expect('durationMinutes' in createEndedValid.payload).toBe(false);
    }

    // 3. Edit entry: note-only edit never re-validates or resends timing fields (even if endedAt looks before start).
    const dstCrossedEntry: ProjectTimeEntry = {
      ...sampleSummary.entries[0]!,
      startedAt: new Date('2026-11-01T01:45').toISOString(),
      endedAt: new Date('2026-11-01T01:15').toISOString(),
      durationMinutes: 30,
    };
    const noteOnlyRes = buildTimeEntrySubmitPayload(
      {
        taskId: TASK_ID,
        startedAt: '2026-11-01T01:45',
        endedAt: '2026-11-01T01:15',
        durationMinutes: '30',
        timingMode: 'endedAt',
        billable: true,
        hourlyRate: '500000.00',
        note: 'Cap nhat ghi chu',
      },
      dstCrossedEntry,
    );
    expect(noteOnlyRes.ok).toBe(true);
    if (noteOnlyRes.ok && noteOnlyRes.mode === 'update') {
      expect('startedAt' in noteOnlyRes.payload).toBe(false);
      expect('endedAt' in noteOnlyRes.payload).toBe(false);
      expect('durationMinutes' in noteOnlyRes.payload).toBe(false);
      expect(noteOnlyRes.payload.note).toBe('Cap nhat ghi chu');
    }

    // 4. Edit in endedAt mode when ONLY startedAt changed: preserves exact stored endedAt ISO
    // (never rebuilds minute-truncated local text) and validates startedAt <= stored endedAt.
    const existingWithSeconds: ProjectTimeEntry = {
      ...sampleSummary.entries[0]!,
      startedAt: '2026-11-21T08:00:45.000Z',
      endedAt: '2026-11-21T09:00:45.000Z',
      durationMinutes: 60,
    };
    const startOnlyInEndedMode = buildTimeEntrySubmitPayload(
      {
        taskId: TASK_ID,
        startedAt: toLocalDateTimeInput('2026-11-21T08:15:00.000Z'),
        endedAt: toLocalDateTimeInput(existingWithSeconds.endedAt!),
        durationMinutes: '45',
        timingMode: 'endedAt',
        billable: true,
        hourlyRate: '500000.00',
        note: 'Doi gio bat dau',
      },
      existingWithSeconds,
    );
    expect(startOnlyInEndedMode.ok).toBe(true);
    if (startOnlyInEndedMode.ok && startOnlyInEndedMode.mode === 'update') {
      expect(startOnlyInEndedMode.payload.startedAt).toBe('2026-11-21T08:15:00.000Z');
      expect(startOnlyInEndedMode.payload.endedAt).toBe(existingWithSeconds.endedAt);
      expect('durationMinutes' in startOnlyInEndedMode.payload).toBe(false);
    }

    const startAfterUnchangedEnd = buildTimeEntrySubmitPayload(
      {
        taskId: TASK_ID,
        startedAt: toLocalDateTimeInput('2026-11-21T10:00:00.000Z'),
        endedAt: toLocalDateTimeInput(existingWithSeconds.endedAt!),
        durationMinutes: '',
        timingMode: 'endedAt',
        billable: true,
        hourlyRate: '500000.00',
        note: 'Khoang thoi gian sai',
      },
      existingWithSeconds,
    );
    expect(startAfterUnchangedEnd).toEqual({ ok: false, errorKey: 'invalidRangeError' });

    // 4b. Edit in duration mode when ONLY startedAt changed: omits endedAt completely.
    const startOnlyInDurationMode = buildTimeEntrySubmitPayload(
      {
        taskId: TASK_ID,
        startedAt: toLocalDateTimeInput('2026-11-21T08:15:00.000Z'),
        endedAt: toLocalDateTimeInput('2026-11-21T09:15:00.000Z'),
        durationMinutes: '60',
        timingMode: 'duration',
        billable: true,
        hourlyRate: '500000.00',
        note: 'Dich gio bat dau',
      },
      existingWithSeconds,
    );
    expect(startOnlyInDurationMode.ok).toBe(true);
    if (startOnlyInDurationMode.ok && startOnlyInDurationMode.mode === 'update') {
      expect(startOnlyInDurationMode.payload.startedAt).toBe('2026-11-21T08:15:00.000Z');
      expect('endedAt' in startOnlyInDurationMode.payload).toBe(false);
      expect('durationMinutes' in startOnlyInDurationMode.payload).toBe(false);
    }

    // 5. Edit in endedAt mode when endedAt changed validates against exact stored startedAt (with seconds).
    const endedBeforeStoredStart = buildTimeEntrySubmitPayload(
      {
        taskId: TASK_ID,
        startedAt: toLocalDateTimeInput(existingWithSeconds.startedAt),
        endedAt: toLocalDateTimeInput('2026-11-21T08:00:00.000Z'),
        durationMinutes: '1',
        timingMode: 'endedAt',
        billable: true,
        hourlyRate: '500000.00',
        note: '',
      },
      existingWithSeconds,
    );
    expect(endedBeforeStoredStart).toEqual({ ok: false, errorKey: 'invalidRangeError' });
  });

  it('hides task row edit/delete actions immediately when checked out (canWrite=false) and shows explicit summary error state (#4462)', () => {
    const qc = queryClientState.current;
    qc.clear();
    const tz = browserTimeZone();
    const summaryQueryKey = orpc.projects.timeSummary.queryOptions({
      input: { projectId: PROJECT_ID, taskId: TASK_ID, timeZone: tz },
    }).queryKey;

    // Task is checked out -> canWrite=false passed by parent even while entry.canManage=true in summary payload.
    qc.setQueryData(summaryQueryKey, sampleSummary);
    const checkedOutHtml = renderToStaticMarkup(
      wrap('vi', <TaskTimeTrackingPanel projectId={PROJECT_ID} taskId={TASK_ID} taskTitle="Hoàn thiện báo giá" canWrite={false} />),
    );
    expect(checkedOutHtml).toContain('Hoàn thiện báo giá');
    expect(checkedOutHtml).toContain('Tư vấn khách hàng');
    expect(checkedOutHtml).not.toContain('task-timer-start');
    expect(checkedOutHtml).not.toContain('task-timer-stop');
    expect(checkedOutHtml).not.toContain('task-time-log-toggle');
    expect(checkedOutHtml).not.toContain(`edit-time-entry-${sampleSummary.entries[0]!.id}`);
    expect(checkedOutHtml).not.toContain(`delete-time-entry-${sampleSummary.entries[0]!.id}`);

    // Initial summary fetch error renders explicit retryable error state instead of empty log notice.
    qc.setDefaultOptions({ queries: { retryOnMount: false } });
    qc.removeQueries({ queryKey: summaryQueryKey });
    const failingQuery = qc.getQueryCache().build(qc, { queryKey: summaryQueryKey });
    failingQuery.setState({
      ...failingQuery.state,
      status: 'error',
      fetchStatus: 'idle',
      error: new Error('summary fetch failed'),
      data: undefined,
      errorUpdateCount: 1,
    } as never);

    const errorHtml = renderToStaticMarkup(
      wrap('vi', <TaskTimeTrackingPanel projectId={PROJECT_ID} taskId={TASK_ID} canWrite />),
    );
    expect(errorHtml).toContain('data-testid="task-time-summary-error"');
    expect(errorHtml).toContain('data-testid="task-time-summary-retry"');
    expect(errorHtml).toContain('min-h-11');
    expect(errorHtml).toContain('Không tải được nhật ký giờ làm.');
    expect(errorHtml).not.toContain('data-testid="task-time-empty"');

    // ProjectTimeTab error states (summary + task picker list) also expose explicit retry controls.
    const projectSummaryKey = orpc.projects.timeSummary.queryOptions({
      input: { projectId: PROJECT_ID, timeZone: tz, limit: 50, offset: 0 },
    }).queryKey;
    qc.removeQueries({ queryKey: projectSummaryKey });
    const projectFailingQuery = qc.getQueryCache().build(qc, { queryKey: projectSummaryKey });
    projectFailingQuery.setState({
      ...projectFailingQuery.state,
      status: 'error',
      fetchStatus: 'idle',
      error: new Error('project summary failed'),
      data: undefined,
      errorUpdateCount: 1,
    } as never);

    const taskItem: ProjectTaskCard = {
      id: TASK_ID,
      title: 'Hoàn thiện báo giá',
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
    };
    const projectErrorHtml = renderToStaticMarkup(
      wrap(
        'en',
        <ProjectTimeTab
          projectId={PROJECT_ID}
          canWrite
          tasks={[taskItem]}
          tasksError={new Error('task list failed')}
          onRetryTasks={() => undefined}
          members={[]}
        />,
      ),
    );
    expect(projectErrorHtml).toContain('data-testid="project-time-summary-error"');
    expect(projectErrorHtml).toContain('data-testid="project-time-summary-retry"');
    expect(projectErrorHtml).toContain('data-testid="project-time-tasks-error"');
    expect(projectErrorHtml).toContain('data-testid="project-time-tasks-retry"');
    expect(projectErrorHtml).toContain('Could not load time entries.');
    expect(projectErrorHtml).toContain('Hoàn thiện báo giá');

    qc.removeQueries({ queryKey: summaryQueryKey });
    qc.removeQueries({ queryKey: projectSummaryKey });
    qc.setDefaultOptions({});
  });
});
