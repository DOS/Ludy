// SPDX-License-Identifier: AGPL-3.0-only
// Lean time tracking and billable hours UI for project tasks and the Project Time tab (#2600).
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  PROJECT_TIME_DURATION_MAX,
  PROJECT_TIME_DURATION_MIN,
  PROJECT_TIME_ENTRIES_PAGE_LIMIT,
  PROJECT_TIME_NOTE_MAX,
  type ProjectBoard,
  type ProjectTaskCard,
  type ProjectTimeEntry,
  type ProjectTimeSummaryResult,
} from '@ludy/kernel-contract';
import { useEffect, useId, useReducer, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { Textarea } from '@ludy/ui/components/textarea';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput } from './date-input.tsx';
import { ErrorText, RowsSkeleton, focusFirstInvalid } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import { PROJECT_WEEKLY_STATUS_QUERY_PREFIX } from '../lib/projects.ts';
import {
  EMPTY_PROJECT_TIME_FILTER,
  beginTimeEntriesLoadMore,
  buildStopAndSwitchTimerInput,
  buildTimeEntrySubmitPayload,
  closeMatchingTimeFormSession,
  createPendingTimerSwitch,
  createTimeEntriesPaginationState,
  createTimeEntryIdempotencyTracker,
  currentLocalDateTimeInput,
  formatDecimalHours,
  formatDecimalMoney,
  formatMinutesAsHours,
  localDateTimeInputToIso,
  mergeTimeSummaryEntries,
  previewBillableAmount,
  resetTimeEntriesPagination,
  resolveTimeEntriesLoadMoreError,
  resolveTimeEntriesLoadMoreSuccess,
  saveTimeCsvFile,
  timeSummaryPageSignature,
  toLocalDateTimeInput,
  type PendingTimerSwitch,
  type ProjectTimeFilterState,
  type TimeEntriesPaginationState,
  type TimeEntryFormDraft,
  type TimeEntryValidationErrorKey,
  type TimeFormSession,
} from '../lib/projects-time.ts';
import { taskTitleText } from '../lib/task-title.ts';

function refreshTimeQueries() {
  void queryClient.invalidateQueries({ queryKey: orpc.projects.timeSummary.key() });
  void queryClient.invalidateQueries({ queryKey: PROJECT_WEEKLY_STATUS_QUERY_PREFIX });
}

function isTimerConflictError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('code' in err && (err as { code?: unknown }).code === 'TIMER_ALREADY_RUNNING') return true;
  if ('data' in err && typeof (err as { data?: unknown }).data === 'object' && (err as { data?: unknown }).data !== null) {
    return (err as { data: { domainCode?: unknown } }).data.domainCode === 'TIMER_ALREADY_RUNNING';
  }
  return false;
}

function RetryErrorBanner({
  title,
  error,
  retryLabel,
  testId,
  retryTestId,
  disabled,
  onRetry,
}: {
  title: string;
  error: unknown;
  retryLabel: string;
  testId: string;
  retryTestId: string;
  disabled?: boolean;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <ErrorText>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid={testId}>
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium">{title}</p>
          <p>{errorMessage(error)}</p>
        </div>
        {onRetry && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 shrink-0 text-xs text-foreground"
            disabled={disabled}
            onClick={onRetry}
            data-testid={retryTestId}
          >
            {retryLabel}
          </Button>
        )}
      </div>
    </ErrorText>
  );
}

function TimerSwitchConflictBanner({
  projectName,
  startedAt,
  targetLabel,
  isPending,
  alertTestId,
  targetTestId,
  confirmTestId,
  onConfirm,
  onDismiss,
}: {
  projectName: string;
  startedAt: string;
  targetLabel: string | null;
  isPending: boolean;
  alertTestId: string;
  targetTestId: string;
  confirmTestId: string;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('projects.time');
  const f = useFormat();

  return (
    <Alert className="border-warning/40 bg-warning/10" data-testid={alertTestId}>
      <AlertDescription className="space-y-2 text-xs text-foreground">
        <p>
          {t('switchTimerBanner', {
            project: projectName,
            time: f.dateTime(startedAt),
          })}
        </p>
        {targetLabel && (
          <p className="font-medium" data-testid={targetTestId}>
            {t('switchTimerTarget', { target: targetLabel })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="min-h-11"
            loading={isPending}
            onClick={onConfirm}
            data-testid={confirmTestId}
          >
            {t('stopExistingAndStart')}
          </Button>
          <Button type="button" variant="outline" className="min-h-11" onClick={onDismiss}>
            {t('keepExistingTimer')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

type PaginationAction =
  | { type: 'RESET'; filterKey?: string }
  | { type: 'BEGIN'; requestId: number }
  | { type: 'RESOLVE_SUCCESS'; requestEpoch: number; requestId: number; entries: readonly ProjectTimeEntry[] }
  | { type: 'RESOLVE_ERROR'; requestEpoch: number; requestId: number; error: unknown };

function paginationReducer(state: TimeEntriesPaginationState, action: PaginationAction): TimeEntriesPaginationState {
  switch (action.type) {
    case 'RESET':
      return resetTimeEntriesPagination(state, action.filterKey);
    case 'BEGIN':
      return beginTimeEntriesLoadMore(state, action.requestId);
    case 'RESOLVE_SUCCESS':
      return resolveTimeEntriesLoadMoreSuccess(state, action.requestEpoch, action.requestId, action.entries);
    case 'RESOLVE_ERROR':
      return resolveTimeEntriesLoadMoreError(state, action.requestEpoch, action.requestId, action.error);
  }
}

function useTimeEntriesPagination(
  filterKey: string,
  summary: ProjectTimeSummaryResult | undefined,
) {
  const [pagination, dispatch] = useReducer(paginationReducer, filterKey, createTimeEntriesPaginationState);
  const nextRequestIdRef = useRef(0);
  const latestRequestIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const prevFilterKeyRef = useRef(filterKey);
  const pageOneSignature = timeSummaryPageSignature(summary);
  const prevPageOneSigRef = useRef<string | null>(pageOneSignature);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (prevFilterKeyRef.current !== filterKey) {
      prevFilterKeyRef.current = filterKey;
      prevPageOneSigRef.current = pageOneSignature;
      latestRequestIdRef.current = 0;
      inFlightRef.current = false;
      dispatch({ type: 'RESET', filterKey });
      return;
    }
    if (pageOneSignature !== null) {
      if (prevPageOneSigRef.current !== null && prevPageOneSigRef.current !== pageOneSignature) {
        latestRequestIdRef.current = 0;
        inFlightRef.current = false;
        dispatch({ type: 'RESET', filterKey });
      }
      prevPageOneSigRef.current = pageOneSignature;
    }
  }, [filterKey, pageOneSignature]);

  const reset = () => {
    latestRequestIdRef.current = 0;
    inFlightRef.current = false;
    if (mountedRef.current) {
      dispatch({ type: 'RESET', filterKey: prevFilterKeyRef.current });
    }
  };

  const filterMatches = pagination.filterKey === filterKey;
  const activeLoadingMore = filterMatches ? pagination.loadingMore : false;

  const loadMore = async (fetchPage: (offset: number) => Promise<ProjectTimeSummaryResult>, offset: number) => {
    if (!summary || !filterMatches || activeLoadingMore || inFlightRef.current) return;
    const requestEpoch = pagination.epoch;
    const requestId = ++nextRequestIdRef.current;
    latestRequestIdRef.current = requestId;
    inFlightRef.current = true;
    dispatch({ type: 'BEGIN', requestId });
    try {
      const nextPage = await fetchPage(offset);
      if (latestRequestIdRef.current === requestId) {
        inFlightRef.current = false;
      }
      dispatch({ type: 'RESOLVE_SUCCESS', requestEpoch, requestId, entries: nextPage.entries });
    } catch (err) {
      if (latestRequestIdRef.current === requestId) {
        inFlightRef.current = false;
      }
      dispatch({ type: 'RESOLVE_ERROR', requestEpoch, requestId, error: err });
    }
  };

  return {
    extraEntries: filterMatches ? pagination.extraEntries : [],
    loadingMore: activeLoadingMore,
    loadMoreError: filterMatches ? pagination.loadMoreError : null,
    reset,
    loadMore,
  };
}

function addMinutesLocalInput(startedLocal: string, minutes: number): string {
  const startedIso = localDateTimeInputToIso(startedLocal);
  if (!startedIso || !Number.isInteger(minutes) || minutes < PROJECT_TIME_DURATION_MIN || minutes > PROJECT_TIME_DURATION_MAX) {
    return '';
  }
  return toLocalDateTimeInput(new Date(Date.parse(startedIso) + minutes * 60_000).toISOString());
}

function computeMinutesDelta(startedLocal: string, endedLocal: string): string {
  const startedIso = localDateTimeInputToIso(startedLocal);
  const endedIso = localDateTimeInputToIso(endedLocal);
  if (!startedIso || !endedIso) return '';
  const diffMs = Date.parse(endedIso) - Date.parse(startedIso);
  if (diffMs < 0) return '';
  return String(Math.max(PROJECT_TIME_DURATION_MIN, Math.round(diffMs / 60_000)));
}

function initialFormState(entry: ProjectTimeEntry | null, fixedTaskId?: string): TimeEntryFormDraft {
  if (entry) {
    return {
      taskId: entry.taskId ?? '',
      startedAt: toLocalDateTimeInput(entry.startedAt),
      endedAt: entry.endedAt ? toLocalDateTimeInput(entry.endedAt) : '',
      durationMinutes: entry.durationMinutes === null ? '' : String(entry.durationMinutes),
      timingMode: 'duration',
      billable: entry.billable,
      hourlyRate: entry.hourlyRate ?? '',
      note: entry.note ?? '',
    };
  }
  const nowLocal = currentLocalDateTimeInput();
  return {
    taskId: fixedTaskId ?? '',
    startedAt: nowLocal,
    endedAt: addMinutesLocalInput(nowLocal, 30),
    durationMinutes: '30',
    timingMode: 'duration',
    billable: false,
    hourlyRate: '',
    note: '',
  };
}

function ProjectTimeEntryForm({
  projectId,
  fixedTaskId,
  projectTasks,
  editingEntry,
  canWrite = true,
  onSaved,
  onDone,
  onCancel,
}: {
  projectId: string;
  fixedTaskId?: string;
  projectTasks?: readonly ProjectTaskCard[];
  editingEntry: ProjectTimeEntry | null;
  canWrite?: boolean;
  onSaved?: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('projects.time');
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const idPrefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<TimeEntryFormDraft>(() => initialFormState(editingEntry, fixedTaskId));
  const [validationError, setValidationError] = useState<{ key: TimeEntryValidationErrorKey; seq: number } | null>(null);
  const validationSeqRef = useRef(0);
  const idempotencyTrackerRef = useRef(createTimeEntryIdempotencyTracker());
  const mountedRef = useRef(true);
  const activeSessionRef = useRef(0);

  const updateForm = (updater: (prev: TimeEntryFormDraft) => TimeEntryFormDraft) => {
    idempotencyTrackerRef.current.rotate();
    setValidationError(null);
    setForm(updater);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeSessionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    activeSessionRef.current += 1;
    idempotencyTrackerRef.current.rotate();
    setForm(initialFormState(editingEntry, fixedTaskId));
    setValidationError(null);
  }, [projectId, editingEntry, fixedTaskId]);

  useEffect(() => {
    if (validationError) {
      focusFirstInvalid(formRef.current);
    }
  }, [validationError]);

  const logTime = useMutation(
    orpc.projects.logTime.mutationOptions({
      onSuccess: () => {
        refreshTimeQueries();
        onSaved?.();
      },
    }),
  );

  const updateTime = useMutation(
    orpc.projects.updateTimeEntry.mutationOptions({
      onSuccess: () => {
        refreshTimeQueries();
        onSaved?.();
      },
    }),
  );

  const isEditingRunning = editingEntry?.running === true;
  const parsedMinutes = form.durationMinutes.trim() === '' ? null : Number(form.durationMinutes);
  const effectiveMinutes =
    parsedMinutes !== null && Number.isInteger(parsedMinutes)
      ? parsedMinutes
      : (() => {
          const s = localDateTimeInputToIso(form.startedAt);
          const e = localDateTimeInputToIso(form.endedAt);
          if (!s || !e) return null;
          const diff = Math.round((Date.parse(e) - Date.parse(s)) / 60_000);
          return diff > 0 ? diff : null;
        })();

  const livePreviewAmount = previewBillableAmount(effectiveMinutes, form.hourlyRate, form.billable);
  const mutationError = logTime.error ?? updateTime.error;
  const submitting = logTime.isPending || updateTime.isPending;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || submitting) return;
    setValidationError(null);

    const result = buildTimeEntrySubmitPayload(form, editingEntry, fixedTaskId);
    if (!result.ok) {
      setValidationError({ key: result.errorKey, seq: ++validationSeqRef.current });
      return;
    }

    const submittedSession = activeSessionRef.current;
    const onSubmittedSessionSuccess = () => {
      if (!mountedRef.current || activeSessionRef.current !== submittedSession) return;
      idempotencyTrackerRef.current.rotate();
      onDone();
    };

    if (result.mode === 'update' && editingEntry) {
      updateTime.mutate(
        {
          projectId,
          entryId: editingEntry.id,
          ...result.payload,
          idempotencyKey: idempotencyTrackerRef.current.current(),
        },
        { onSuccess: onSubmittedSessionSuccess },
      );
    } else if (result.mode === 'create') {
      logTime.mutate(
        {
          projectId,
          ...result.payload,
          idempotencyKey: idempotencyTrackerRef.current.current(),
        },
        { onSuccess: onSubmittedSessionSuccess },
      );
    }
  };

  const validationErrorId = `${idPrefix}-validation-error`;
  const validationErrorKey = validationError?.key ?? null;
  const startInvalid = validationErrorKey === 'invalidStartRequired';
  const durationInvalid = validationErrorKey === 'invalidDurationError';
  const endInvalid = validationErrorKey === 'invalidRangeError';
  const rateInvalid = validationErrorKey === 'invalidRateError';

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={handleSubmit}
      className="space-y-3 rounded-lg border border-border bg-muted/20 p-3"
      data-testid="project-time-entry-form"
    >
      {!fixedTaskId && projectTasks && (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-task`} className="text-xs">
            {t('taskSelectLabel')}
          </Label>
          <NativeSelect
            id={`${idPrefix}-task`}
            value={form.taskId}
            onChange={(e) => updateForm((prev) => ({ ...prev, taskId: e.target.value }))}
            className="w-full text-sm [&>select]:min-h-11"
          >
            <NativeSelectOption value="">{t('projectGeneralOption')}</NativeSelectOption>
            {projectTasks.map((task) => (
              <NativeSelectOption key={task.id} value={task.id}>
                {taskTitleText(task)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-start`} className="text-xs">
            {t('startedAtLabel')}
          </Label>
          <Input
            id={`${idPrefix}-start`}
            type="datetime-local"
            value={form.startedAt}
            aria-invalid={startInvalid || undefined}
            aria-describedby={startInvalid ? validationErrorId : undefined}
            onChange={(e) => {
              const nextStarted = e.target.value;
              updateForm((prev) => {
                if (isEditingRunning) return { ...prev, startedAt: nextStarted };
                if (prev.timingMode === 'duration') {
                  const mins = prev.durationMinutes.trim() === '' ? Number.NaN : Number(prev.durationMinutes);
                  const nextEnded = Number.isInteger(mins) ? addMinutesLocalInput(nextStarted, mins) : prev.endedAt;
                  return { ...prev, startedAt: nextStarted, endedAt: nextEnded };
                }
                const nextMins = computeMinutesDelta(nextStarted, prev.endedAt);
                return { ...prev, startedAt: nextStarted, durationMinutes: nextMins };
              });
            }}
            className="min-h-11 text-xs"
            required
          />
        </div>
        {!isEditingRunning && (
          <>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-minutes`} className="text-xs">
                {t('durationMinutesLabel')}
              </Label>
              <Input
                id={`${idPrefix}-minutes`}
                type="number"
                min={PROJECT_TIME_DURATION_MIN}
                max={PROJECT_TIME_DURATION_MAX}
                step={1}
                value={form.durationMinutes}
                aria-invalid={durationInvalid || undefined}
                aria-describedby={durationInvalid ? validationErrorId : undefined}
                onChange={(e) => {
                  const nextMinutes = e.target.value;
                  updateForm((prev) => {
                    if (nextMinutes.trim() === '') {
                      return { ...prev, timingMode: 'duration', durationMinutes: '', endedAt: '' };
                    }
                    const parsed = Number(nextMinutes);
                    const nextEnded = addMinutesLocalInput(prev.startedAt, parsed);
                    return {
                      ...prev,
                      timingMode: 'duration',
                      durationMinutes: nextMinutes,
                      endedAt: nextEnded,
                    };
                  });
                }}
                className="min-h-11 text-xs tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-end`} className="text-xs">
                {t('endedAtLabel')}
              </Label>
              <Input
                id={`${idPrefix}-end`}
                type="datetime-local"
                value={form.endedAt}
                aria-invalid={endInvalid || undefined}
                aria-describedby={endInvalid ? validationErrorId : undefined}
                onChange={(e) => {
                  const nextEnded = e.target.value;
                  updateForm((prev) => {
                    if (nextEnded.trim() === '') {
                      return { ...prev, timingMode: 'endedAt', endedAt: '', durationMinutes: '' };
                    }
                    const nextMins = computeMinutesDelta(prev.startedAt, nextEnded);
                    return {
                      ...prev,
                      timingMode: 'endedAt',
                      endedAt: nextEnded,
                      durationMinutes: nextMins,
                    };
                  });
                }}
                className="min-h-11 text-xs"
              />
            </div>
          </>
        )}
      </div>

      {!isEditingRunning && <p className="text-[11px] text-subtle-foreground">{t('durationOrEndHint')}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs text-foreground">
          <Checkbox
            checked={form.billable}
            onCheckedChange={(checked) => updateForm((prev) => ({ ...prev, billable: checked === true }))}
          />
          <span>{t('billableLabel')}</span>
        </label>

        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-rate`} className="text-xs">
            {t('hourlyRateLabel')}
          </Label>
          <Input
            id={`${idPrefix}-rate`}
            type="text"
            inputMode="decimal"
            value={form.hourlyRate}
            placeholder={t('hourlyRatePlaceholder')}
            aria-invalid={rateInvalid || undefined}
            aria-describedby={rateInvalid ? validationErrorId : undefined}
            onChange={(e) => updateForm((prev) => ({ ...prev, hourlyRate: e.target.value }))}
            className="min-h-11 text-xs tabular-nums"
          />
        </div>
      </div>

      {livePreviewAmount !== null && (
        <p className="text-xs font-medium text-foreground tabular-nums" data-testid="project-time-preview-amount">
          {t('summaryBillableAmount')}: {formatDecimalMoney(livePreviewAmount, locale)} {t('currencyUnit')}
        </p>
      )}

      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-note`} className="text-xs">
          {t('noteLabel')}
        </Label>
        <Textarea
          id={`${idPrefix}-note`}
          rows={2}
          maxLength={PROJECT_TIME_NOTE_MAX}
          value={form.note}
          placeholder={t('notePlaceholder')}
          onChange={(e) => updateForm((prev) => ({ ...prev, note: e.target.value }))}
          className="text-xs"
        />
      </div>

      {validationErrorKey && <ErrorText id={validationErrorId}>{t(validationErrorKey)}</ErrorText>}
      {mutationError && <ErrorText>{errorMessage(mutationError)}</ErrorText>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={onCancel}>
          {t('cancelBtn')}
        </Button>
        <Button type="submit" className="min-h-11" disabled={submitting || !canWrite} loading={submitting}>
          {submitting ? t('savingEntryBtn') : t('saveEntryBtn')}
        </Button>
      </div>
    </form>
  );
}

function TimeEntryRow({
  entry,
  allowActions = true,
  onEdit,
  onDelete,
}: {
  entry: ProjectTimeEntry;
  allowActions?: boolean;
  onEdit: (entry: ProjectTimeEntry) => void;
  onDelete: (entry: ProjectTimeEntry) => void;
}) {
  const t = useTranslations('projects.time');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';

  const durationText =
    entry.durationMinutes === null
      ? t('runningLabel')
      : t('minutesShort', {
          minutes: entry.durationMinutes,
          hours: formatMinutesAsHours(entry.durationMinutes, locale),
        });

  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-start sm:justify-between"
      data-testid="time-entry-row"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant={entry.running ? 'brand' : 'outline'} className="h-5 px-1.5 text-[11px] tabular-nums">
            {durationText}
          </Badge>
          {entry.billable ? (
            <Badge variant="success" className="h-5 px-1.5 text-[11px]">
              {t('billableBadge')}
            </Badge>
          ) : (
            <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
              {t('nonBillableBadge')}
            </Badge>
          )}
          {entry.billableAmount !== null && (
            <span className="font-semibold text-foreground tabular-nums">
              {formatDecimalMoney(entry.billableAmount, locale)} {t('currencyUnit')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{entry.taskTitle ?? t('projectGeneralOption')}</span>
          <span>·</span>
          <span>{entry.userDisplayName ?? t('formerMember')}</span>
          <span>·</span>
          <span className="tabular-nums">{f.dateTime(entry.startedAt)}</span>
        </div>
        {entry.note && <p className="text-xs text-foreground">{entry.note}</p>}
      </div>

      {allowActions && entry.canManage && (
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-3 text-xs"
            onClick={() => onEdit(entry)}
            data-testid={`edit-time-entry-${entry.id}`}
          >
            <ProjectIcon name="edit" className="size-3.5" />
            <span>{t('editEntryBtn')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 px-3 text-xs text-destructive hover:text-destructive"
            onClick={() => onDelete(entry)}
            data-testid={`delete-time-entry-${entry.id}`}
          >
            {t('deleteEntryBtn')}
          </Button>
        </div>
      )}
    </li>
  );
}

/** Task-scoped time tracking section used in EditProjectTaskDialog and TaskDetailPage (#2600). */
export function TaskTimeTrackingPanel({
  projectId,
  taskId,
  taskTitle,
  canWrite,
}: {
  projectId: string;
  taskId: string;
  taskTitle?: string;
  canWrite: boolean;
}) {
  const t = useTranslations('projects.time');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const nextFormSessionIdRef = useRef(0);
  const [formSession, setFormSession] = useState<TimeFormSession | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<ProjectTimeEntry | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<PendingTimerSwitch | null>(null);
  const [clampedNotice, setClampedNotice] = useState(false);
  const timeZone = browserTimeZone();

  const summaryQuery = useQuery(
    orpc.projects.timeSummary.queryOptions({
      input: { projectId, taskId, timeZone },
    }),
  );

  const data = summaryQuery.data;
  const effectiveCanWrite = canWrite && (data?.canWrite ?? true);
  const pagination = useTimeEntriesPagination(JSON.stringify([projectId, taskId, timeZone]), data);

  useEffect(() => {
    setFormSession(null);
    setDeletingEntry(null);
    setClampedNotice(false);
  }, [projectId, taskId]);

  useEffect(() => {
    setPendingSwitch(null);
  }, [projectId]);

  useEffect(() => {
    if (!effectiveCanWrite) {
      setFormSession(null);
      setDeletingEntry(null);
      setPendingSwitch(null);
    }
  }, [effectiveCanWrite]);

  const startTimer = useMutation(
    orpc.projects.startTime.mutationOptions({
      onSuccess: () => {
        setPendingSwitch(null);
        setClampedNotice(false);
        pagination.reset();
        refreshTimeQueries();
      },
      onError: (err, variables) => {
        if (isTimerConflictError(err) && !variables.stopExisting) {
          setPendingSwitch(
            createPendingTimerSwitch(
              variables.projectId,
              variables.taskId ?? null,
              variables.taskId === taskId ? (taskTitle ?? null) : null,
            ),
          );
          refreshTimeQueries();
        }
      },
    }),
  );

  const stopTimer = useMutation(
    orpc.projects.stopTime.mutationOptions({
      onSuccess: (res) => {
        setPendingSwitch(null);
        setClampedNotice(res.clampedToMax);
        pagination.reset();
        refreshTimeQueries();
      },
    }),
  );

  const deleteEntry = useMutation(
    orpc.projects.deleteTimeEntry.mutationOptions({
      onSuccess: () => {
        setDeletingEntry(null);
        pagination.reset();
        refreshTimeQueries();
      },
    }),
  );

  const activeTimer = data?.activeTimer ?? null;
  const runningHere = activeTimer?.entry.taskId === taskId && activeTimer.entry.projectId === projectId;
  const runningElsewhere = activeTimer !== null && !runningHere;
  const combinedEntries = data ? mergeTimeSummaryEntries(data.entries, pagination.extraEntries) : [];
  const hasMore = data ? combinedEntries.length < data.totalEntries : false;

  const handleLoadMore = () =>
    pagination.loadMore(
      (offset) =>
        queryClient.fetchQuery(
          orpc.projects.timeSummary.queryOptions({
            input: { projectId, taskId, timeZone, limit: PROJECT_TIME_ENTRIES_PAGE_LIMIT, offset },
          }),
        ),
      combinedEntries.length,
    );

  const handleStartClick = () => {
    if (!effectiveCanWrite) return;
    if (runningElsewhere) {
      setPendingSwitch(createPendingTimerSwitch(projectId, taskId, taskTitle ?? null));
      return;
    }
    startTimer.mutate({
      projectId,
      taskId,
      stopExisting: false,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const handleStopAndSwitch = () => {
    if (!effectiveCanWrite || !pendingSwitch) return;
    startTimer.mutate(buildStopAndSwitchTimerInput(pendingSwitch, crypto.randomUUID()));
  };

  return (
    <section className="space-y-3 border-t border-border pt-3" data-testid="task-time-tracking-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ProjectIcon name="clock" className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{t('taskSectionTitle')}</h3>
          {data && (
            <span className="text-xs text-subtle-foreground tabular-nums">
              {t('taskEntriesCount', {
                count: data.totals.entryCount,
                hours: formatDecimalHours(data.totals.totalHours, locale),
              })}
            </span>
          )}
        </div>

        {effectiveCanWrite && (
          <div className="flex flex-wrap items-center gap-2">
            {runningHere && activeTimer ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 gap-1.5 border-destructive/40 text-destructive"
                loading={stopTimer.isPending}
                onClick={() => {
                  if (!effectiveCanWrite) return;
                  stopTimer.mutate({
                    projectId,
                    entryId: activeTimer.entry.id,
                    idempotencyKey: crypto.randomUUID(),
                  });
                }}
                data-testid="task-timer-stop"
              >
                <ProjectIcon name="square" className="size-3.5" />
                <span>{t('stopTimer')}</span>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 gap-1.5"
                loading={startTimer.isPending}
                onClick={handleStartClick}
                data-testid="task-timer-start"
              >
                <ProjectIcon name="play" className="size-3.5" />
                <span>{t('startTimer')}</span>
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setFormSession((curr) =>
                  curr !== null && curr.editingEntry === null
                    ? null
                    : { id: ++nextFormSessionIdRef.current, editingEntry: null },
                );
              }}
              data-testid="task-time-log-toggle"
            >
              {formSession !== null && formSession.editingEntry === null ? t('hideFormBtn') : t('logManualBtn')}
            </Button>
          </div>
        )}
      </div>

      {runningHere && activeTimer && (
        <div
          aria-live="off"
          className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground"
          data-testid="task-timer-running-banner"
        >
          {t('runningSince', { time: f.dateTime(activeTimer.entry.startedAt) })}
        </div>
      )}

      {effectiveCanWrite && pendingSwitch && pendingSwitch.projectId === projectId && activeTimer && (
        <TimerSwitchConflictBanner
          projectName={activeTimer.projectName}
          startedAt={activeTimer.entry.startedAt}
          targetLabel={pendingSwitch.taskTitle}
          isPending={startTimer.isPending}
          alertTestId="timer-switch-conflict-alert"
          targetTestId="task-timer-switch-target"
          confirmTestId="timer-stop-existing-and-start"
          onConfirm={handleStopAndSwitch}
          onDismiss={() => setPendingSwitch(null)}
        />
      )}

      {clampedNotice && (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertDescription className="text-xs text-foreground">{t('clampedMaxNotice')}</AlertDescription>
        </Alert>
      )}

      {(startTimer.error && !isTimerConflictError(startTimer.error)) && <ErrorText>{errorMessage(startTimer.error)}</ErrorText>}
      {stopTimer.error && <ErrorText>{errorMessage(stopTimer.error)}</ErrorText>}
      {deleteEntry.error && <ErrorText>{errorMessage(deleteEntry.error)}</ErrorText>}

      {effectiveCanWrite && formSession !== null && (
        <ProjectTimeEntryForm
          key={formSession.id}
          projectId={projectId}
          fixedTaskId={taskId}
          editingEntry={formSession.editingEntry}
          canWrite={effectiveCanWrite}
          onSaved={pagination.reset}
          onDone={() => {
            const submittedSessionId = formSession.id;
            setFormSession((curr) => closeMatchingTimeFormSession(curr, submittedSessionId));
          }}
          onCancel={() => setFormSession(null)}
        />
      )}

      {summaryQuery.error && (
        <RetryErrorBanner
          title={t('summaryLoadError')}
          error={summaryQuery.error}
          retryLabel={t('retryLoadBtn')}
          testId="task-time-summary-error"
          retryTestId="task-time-summary-retry"
          onRetry={() => void summaryQuery.refetch()}
        />
      )}

      {summaryQuery.isPending && !data ? (
        <RowsSkeleton rows={2} />
      ) : combinedEntries.length > 0 ? (
        <div className="space-y-2">
          <ul className="space-y-2">
            {combinedEntries.map((entry) => (
              <TimeEntryRow
                key={entry.id}
                entry={entry}
                allowActions={effectiveCanWrite}
                onEdit={(target) => {
                  if (!effectiveCanWrite) return;
                  setFormSession({ id: ++nextFormSessionIdRef.current, editingEntry: target });
                }}
                onDelete={(target) => {
                  if (!effectiveCanWrite) return;
                  setDeletingEntry(target);
                }}
              />
            ))}
          </ul>
          {pagination.loadMoreError !== null && (
            <RetryErrorBanner
              title={t('loadMoreError')}
              error={pagination.loadMoreError}
              retryLabel={t('retryLoadBtn')}
              testId="task-time-load-more-error"
              retryTestId="task-time-load-more-retry"
              disabled={pagination.loadingMore}
              onRetry={() => void handleLoadMore()}
            />
          )}
          {hasMore && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full text-xs"
              loading={pagination.loadingMore}
              onClick={() => void handleLoadMore()}
              data-testid="task-time-load-more"
            >
              {pagination.loadingMore ? t('loadingEntries') : t('loadMoreEntries')}
            </Button>
          )}
        </div>
      ) : data ? (
        <p className="text-xs text-muted-foreground" data-testid="task-time-empty">
          {t('noTaskEntries')}
        </p>
      ) : null}

      <ConfirmDialog
        open={effectiveCanWrite && deletingEntry !== null}
        onOpenChange={(next) => {
          if (!next) setDeletingEntry(null);
        }}
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirmDesc')}
        confirm={t('deleteEntryBtn')}
        destructive
        onConfirm={() => {
          if (!effectiveCanWrite || !deletingEntry) return;
          deleteEntry.mutate({
            projectId,
            entryId: deletingEntry.id,
            idempotencyKey: crypto.randomUUID(),
          });
        }}
      />
    </section>
  );
}

/** Full project-level time tracking, summary cards, breakdowns, and CSV export tab (#2600). */
export function ProjectTimeTab({
  projectId,
  canWrite,
  tasks,
  tasksError,
  onRetryTasks,
  members,
  filters,
  onFiltersChange,
}: {
  slug?: string;
  projectId: string;
  canWrite: boolean;
  tasks: readonly ProjectTaskCard[];
  tasksError?: unknown;
  onRetryTasks?: (() => void) | undefined;
  members: ProjectBoard['members'];
  filters?: ProjectTimeFilterState | undefined;
  onFiltersChange?: ((next: ProjectTimeFilterState) => void) | undefined;
}) {
  const t = useTranslations('projects.time');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const idPrefix = useId();
  const timeZone = browserTimeZone();

  const [internalFilters, setInternalFilters] = useState<ProjectTimeFilterState>(EMPTY_PROJECT_TIME_FILTER);
  const activeFilters = filters ?? internalFilters;
  const setFilters = (updater: (prev: ProjectTimeFilterState) => ProjectTimeFilterState) => {
    if (filters && onFiltersChange) {
      onFiltersChange(updater(filters));
    } else {
      setInternalFilters(updater);
    }
  };
  const { from, to, taskId: taskIdFilter, userId: userIdFilter, billableOnly } = activeFilters;

  const nextFormSessionIdRef = useRef(0);
  const [formSession, setFormSession] = useState<TimeFormSession | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<ProjectTimeEntry | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<PendingTimerSwitch | null>(null);
  const [exportStatus, setExportStatus] = useState<{ count: number; truncated: boolean } | null>(null);
  const [clampedNotice, setClampedNotice] = useState(false);

  const filterInput = {
    projectId,
    ...(taskIdFilter ? { taskId: taskIdFilter } : {}),
    ...(userIdFilter ? { userId: userIdFilter } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(billableOnly ? { billableOnly: true } : {}),
    timeZone,
  };

  const summaryQuery = useQuery(
    orpc.projects.timeSummary.queryOptions({
      input: { ...filterInput, limit: PROJECT_TIME_ENTRIES_PAGE_LIMIT, offset: 0 },
    }),
  );

  const summary: ProjectTimeSummaryResult | undefined = summaryQuery.data;
  const effectiveCanWrite = canWrite && (summary?.canWrite ?? true);
  const pagination = useTimeEntriesPagination(
    JSON.stringify([projectId, from, to, taskIdFilter, userIdFilter, billableOnly, timeZone]),
    summary,
  );

  useEffect(() => {
    setFormSession(null);
    setDeletingEntry(null);
    setPendingSwitch(null);
    setExportStatus(null);
    setClampedNotice(false);
  }, [projectId]);

  useEffect(() => {
    if (!effectiveCanWrite) {
      setFormSession(null);
      setDeletingEntry(null);
      setPendingSwitch(null);
    }
  }, [effectiveCanWrite]);

  const resolveTaskTitle = (targetTaskId: string | null): string | null => {
    if (!targetTaskId) return null;
    const found = tasks.find((item) => item.id === targetTaskId);
    return found ? taskTitleText(found) : null;
  };

  const startTimer = useMutation(
    orpc.projects.startTime.mutationOptions({
      onSuccess: () => {
        setPendingSwitch(null);
        setClampedNotice(false);
        pagination.reset();
        refreshTimeQueries();
      },
      onError: (err, variables) => {
        if (isTimerConflictError(err) && !variables.stopExisting) {
          const requestedTaskId = variables.taskId ?? null;
          setPendingSwitch(
            createPendingTimerSwitch(variables.projectId, requestedTaskId, resolveTaskTitle(requestedTaskId)),
          );
          refreshTimeQueries();
        }
      },
    }),
  );

  const stopTimer = useMutation(
    orpc.projects.stopTime.mutationOptions({
      onSuccess: (res) => {
        setPendingSwitch(null);
        setClampedNotice(res.clampedToMax);
        pagination.reset();
        refreshTimeQueries();
      },
    }),
  );

  const deleteEntry = useMutation(
    orpc.projects.deleteTimeEntry.mutationOptions({
      onSuccess: () => {
        setDeletingEntry(null);
        pagination.reset();
        refreshTimeQueries();
      },
    }),
  );

  const exportCsv = useMutation(
    orpc.projects.exportTimeCsv.mutationOptions({
      onSuccess: (file) => {
        saveTimeCsvFile(file.filename, file.csv);
        setExportStatus({ count: file.rowCount, truncated: file.truncated });
      },
    }),
  );

  const activeTimer = summary?.activeTimer ?? null;
  const runningInCurrentProject = activeTimer?.entry.projectId === projectId;
  const runningInOtherProject = activeTimer !== null && !runningInCurrentProject;

  const combinedEntries = summary ? mergeTimeSummaryEntries(summary.entries, pagination.extraEntries) : [];
  const hasMore = summary ? combinedEntries.length < summary.totalEntries : false;

  const handleLoadMore = () =>
    pagination.loadMore(
      (offset) =>
        queryClient.fetchQuery(
          orpc.projects.timeSummary.queryOptions({
            input: { ...filterInput, limit: PROJECT_TIME_ENTRIES_PAGE_LIMIT, offset },
          }),
        ),
      combinedEntries.length,
    );

  return (
    <div className="space-y-4" data-testid="project-time-tab">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {effectiveCanWrite && (
            <>
              {runningInCurrentProject && activeTimer ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 gap-1.5 border-destructive/40 text-destructive"
                  loading={stopTimer.isPending}
                  onClick={() => {
                    if (!effectiveCanWrite) return;
                    stopTimer.mutate({
                      projectId,
                      entryId: activeTimer.entry.id,
                      idempotencyKey: crypto.randomUUID(),
                    });
                  }}
                  data-testid="project-timer-stop"
                >
                  <ProjectIcon name="square" className="size-3.5" />
                  <span>{t('stopTimer')}</span>
                </Button>
              ) : (
                <Button
                  type="button"
                  className="min-h-11 gap-1.5"
                  loading={startTimer.isPending}
                  onClick={() => {
                    if (!effectiveCanWrite) return;
                    const requestedTaskId = taskIdFilter || null;
                    if (runningInOtherProject) {
                      setPendingSwitch(
                        createPendingTimerSwitch(projectId, requestedTaskId, resolveTaskTitle(requestedTaskId)),
                      );
                      return;
                    }
                    startTimer.mutate({
                      projectId,
                      taskId: requestedTaskId,
                      stopExisting: false,
                      idempotencyKey: crypto.randomUUID(),
                    });
                  }}
                  data-testid="project-timer-start"
                >
                  <ProjectIcon name="play" className="size-3.5" />
                  <span>{t('startTimer')}</span>
                </Button>
              )}

              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setFormSession((curr) =>
                    curr !== null && curr.editingEntry === null
                      ? null
                      : { id: ++nextFormSessionIdRef.current, editingEntry: null },
                  );
                }}
                data-testid="project-time-log-toggle"
              >
                {formSession !== null && formSession.editingEntry === null ? t('hideFormBtn') : t('logManualBtn')}
              </Button>
            </>
          )}

          <Button
            type="button"
            variant="outline"
            className="min-h-11 gap-1.5"
            loading={exportCsv.isPending}
            onClick={() => exportCsv.mutate(filterInput)}
            data-testid="project-time-export-csv"
          >
            <ProjectIcon name="download" className="size-3.5" />
            <span>{exportCsv.isPending ? t('exportingCsvBtn') : t('exportCsvBtn')}</span>
          </Button>
        </div>
      </div>

      {!effectiveCanWrite && (
        <p className="text-xs text-muted-foreground">{t('readOnlyHint')}</p>
      )}

      {tasksError !== undefined && tasksError !== null && (
        <RetryErrorBanner
          title={t('tasksLoadError')}
          error={tasksError}
          retryLabel={t('retryLoadBtn')}
          testId="project-time-tasks-error"
          retryTestId="project-time-tasks-retry"
          onRetry={onRetryTasks}
        />
      )}

      {activeTimer && (
        <Alert className="border-primary/30 bg-primary/5" data-testid="project-active-timer-banner">
          <ProjectIcon name="clock" className="text-primary" />
          <AlertDescription aria-live="off" className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
            <span>
              {runningInCurrentProject
                ? t('runningInCurrentProject')
                : t('runningInOtherProject', { project: activeTimer.projectName })}
              {' · '}
              {t('runningSince', { time: f.dateTime(activeTimer.entry.startedAt) })}
            </span>
            {effectiveCanWrite && runningInCurrentProject && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                loading={stopTimer.isPending}
                onClick={() => {
                  if (!effectiveCanWrite) return;
                  stopTimer.mutate({
                    projectId,
                    entryId: activeTimer.entry.id,
                    idempotencyKey: crypto.randomUUID(),
                  });
                }}
              >
                {t('stopTimer')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {effectiveCanWrite && pendingSwitch && pendingSwitch.projectId === projectId && activeTimer && (
        <TimerSwitchConflictBanner
          projectName={activeTimer.projectName}
          startedAt={activeTimer.entry.startedAt}
          targetLabel={pendingSwitch.taskId === null ? t('projectGeneralOption') : pendingSwitch.taskTitle}
          isPending={startTimer.isPending}
          alertTestId="project-timer-conflict-alert"
          targetTestId="project-timer-switch-target"
          confirmTestId="project-timer-stop-existing-and-start"
          onConfirm={() => {
            if (!effectiveCanWrite || !pendingSwitch) return;
            startTimer.mutate(buildStopAndSwitchTimerInput(pendingSwitch, crypto.randomUUID()));
          }}
          onDismiss={() => setPendingSwitch(null)}
        />
      )}

      {clampedNotice && (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertDescription className="text-xs text-foreground">{t('clampedMaxNotice')}</AlertDescription>
        </Alert>
      )}

      {exportStatus && (
        <Alert className="border-border bg-muted/30" data-testid="project-time-export-status">
          <AlertDescription className="text-xs text-foreground">
            {exportStatus.truncated
              ? t('exportTruncatedNotice', { count: exportStatus.count })
              : t('exportSuccess', { count: exportStatus.count })}
          </AlertDescription>
        </Alert>
      )}

      {startTimer.error && !isTimerConflictError(startTimer.error) && <ErrorText>{errorMessage(startTimer.error)}</ErrorText>}
      {stopTimer.error && <ErrorText>{errorMessage(stopTimer.error)}</ErrorText>}
      {deleteEntry.error && <ErrorText>{errorMessage(deleteEntry.error)}</ErrorText>}
      {exportCsv.error && <ErrorText>{errorMessage(exportCsv.error)}</ErrorText>}

      {effectiveCanWrite && formSession !== null && (
        <ProjectTimeEntryForm
          key={formSession.id}
          projectId={projectId}
          projectTasks={tasks}
          editingEntry={formSession.editingEntry}
          canWrite={effectiveCanWrite}
          onSaved={pagination.reset}
          onDone={() => {
            const submittedSessionId = formSession.id;
            setFormSession((curr) => closeMatchingTimeFormSession(curr, submittedSessionId));
          }}
          onCancel={() => setFormSession(null)}
        />
      )}

      <div className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-from`} className="text-xs">
            {t('filterFrom')}
          </Label>
          <DateInput
            id={`${idPrefix}-from`}
            value={from}
            inputClassName="min-h-11"
            onChange={(nextFrom) => setFilters((prev) => ({ ...prev, from: nextFrom }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-to`} className="text-xs">
            {t('filterTo')}
          </Label>
          <DateInput
            id={`${idPrefix}-to`}
            value={to}
            inputClassName="min-h-11"
            onChange={(nextTo) => setFilters((prev) => ({ ...prev, to: nextTo }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-task`} className="text-xs">
            {t('filterTask')}
          </Label>
          <NativeSelect
            id={`${idPrefix}-task`}
            value={taskIdFilter}
            onChange={(e) => setFilters((prev) => ({ ...prev, taskId: e.target.value }))}
            className="w-full text-xs [&>select]:min-h-11"
          >
            <NativeSelectOption value="">{t('filterAllTasks')}</NativeSelectOption>
            {tasks.map((task) => (
              <NativeSelectOption key={task.id} value={task.id}>
                {taskTitleText(task)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-member`} className="text-xs">
            {t('filterMember')}
          </Label>
          <NativeSelect
            id={`${idPrefix}-member`}
            value={userIdFilter}
            onChange={(e) => setFilters((prev) => ({ ...prev, userId: e.target.value }))}
            className="w-full text-xs [&>select]:min-h-11"
          >
            <NativeSelectOption value="">{t('filterAllMembers')}</NativeSelectOption>
            {members.map((m) => (
              <NativeSelectOption key={m.userId} value={m.userId}>
                {m.displayName ?? m.email}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs text-foreground">
            <Checkbox
              checked={billableOnly}
              onCheckedChange={(c) => setFilters((prev) => ({ ...prev, billableOnly: c === true }))}
            />
            <span>{t('filterBillableOnly')}</span>
          </label>
          {(from || to || taskIdFilter || userIdFilter || billableOnly) && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 text-xs"
              onClick={() => setFilters(() => EMPTY_PROJECT_TIME_FILTER)}
            >
              {t('clearFilters')}
            </Button>
          )}
        </div>
      </div>

      {summaryQuery.error && (
        <RetryErrorBanner
          title={t('summaryLoadError')}
          error={summaryQuery.error}
          retryLabel={t('retryLoadBtn')}
          testId="project-time-summary-error"
          retryTestId="project-time-summary-retry"
          onRetry={() => void summaryQuery.refetch()}
        />
      )}

      {summaryQuery.isPending && !summary ? (
        <RowsSkeleton rows={3} />
      ) : summary ? (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="project-time-summary-cards">
            <Card className="p-3">
              <dt className="text-xs text-subtle-foreground">{t('summaryTotalHours')}</dt>
              <dd className="mt-1 text-xl font-semibold text-foreground tabular-nums">
                {formatDecimalHours(summary.totals.totalHours, locale)} h
              </dd>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t('summaryEntryCount', { count: summary.totals.entryCount })}
              </p>
            </Card>
            <Card className="p-3">
              <dt className="text-xs text-subtle-foreground">{t('summaryBillableHours')}</dt>
              <dd className="mt-1 text-xl font-semibold text-foreground tabular-nums">
                {formatDecimalHours(summary.totals.billableHours, locale)} h
              </dd>
            </Card>
            <Card className="p-3">
              <dt className="text-xs text-subtle-foreground">{t('summaryNonBillableHours')}</dt>
              <dd className="mt-1 text-xl font-semibold text-foreground tabular-nums">
                {formatDecimalHours(summary.totals.nonBillableHours, locale)} h
              </dd>
            </Card>
            <Card className="p-3">
              <dt className="text-xs text-subtle-foreground">{t('summaryBillableAmount')}</dt>
              <dd className="mt-1 text-xl font-semibold text-primary tabular-nums">
                {formatDecimalMoney(summary.totals.billableAmount, locale)} {t('currencyUnit')}
              </dd>
            </Card>
          </dl>

          {(summary.byTask.length > 0 || summary.byMember.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              <Card className="space-y-2 p-3">
                <h3 className="text-xs font-semibold text-foreground">{t('breakdownByTask')}</h3>
                <ul className="space-y-1.5 text-xs">
                  {summary.byTask.map((row) => (
                    <li
                      key={row.taskId ?? '__project__'}
                      className="flex items-center justify-between gap-2 border-b border-border/50 pb-1 last:border-b-0 last:pb-0"
                    >
                      <span className="truncate font-medium text-foreground">
                        {row.taskTitle ?? t('projectGeneralOption')}
                      </span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {formatDecimalHours(row.totals.totalHours, locale)} h · {formatDecimalMoney(row.totals.billableAmount, locale)} {t('currencyUnit')}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card className="space-y-2 p-3">
                <h3 className="text-xs font-semibold text-foreground">{t('breakdownByMember')}</h3>
                <ul className="space-y-1.5 text-xs">
                  {summary.byMember.map((row) => (
                    <li
                      key={row.userId ?? '__former__'}
                      className="flex items-center justify-between gap-2 border-b border-border/50 pb-1 last:border-b-0 last:pb-0"
                    >
                      <span className="truncate font-medium text-foreground">
                        {row.displayName ?? t('formerMember')}
                      </span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {formatDecimalHours(row.totals.totalHours, locale)} h · {formatDecimalMoney(row.totals.billableAmount, locale)} {t('currencyUnit')}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t('entriesTitle', { count: summary.totalEntries })}
            </h3>
            {combinedEntries.length === 0 ? (
              <p className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
                {t('noEntries')}
              </p>
            ) : (
              <ul className="space-y-2">
                {combinedEntries.map((entry) => (
                  <TimeEntryRow
                    key={entry.id}
                    entry={entry}
                    allowActions={effectiveCanWrite}
                    onEdit={(target) => {
                      if (!effectiveCanWrite) return;
                      setFormSession({ id: ++nextFormSessionIdRef.current, editingEntry: target });
                    }}
                    onDelete={(target) => {
                      if (!effectiveCanWrite) return;
                      setDeletingEntry(target);
                    }}
                  />
                ))}
              </ul>
            )}

            {pagination.loadMoreError !== null && (
              <RetryErrorBanner
                title={t('loadMoreError')}
                error={pagination.loadMoreError}
                retryLabel={t('retryLoadBtn')}
                testId="project-time-load-more-error"
                retryTestId="project-time-load-more-retry"
                disabled={pagination.loadingMore}
                onRetry={() => void handleLoadMore()}
              />
            )}

            {hasMore && (
              <div className="flex justify-center pt-1">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  loading={pagination.loadingMore}
                  onClick={() => void handleLoadMore()}
                  data-testid="project-time-load-more"
                >
                  {pagination.loadingMore ? t('loadingEntries') : t('loadMoreEntries')}
                </Button>
              </div>
            )}
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={effectiveCanWrite && deletingEntry !== null}
        onOpenChange={(next) => {
          if (!next) setDeletingEntry(null);
        }}
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirmDesc')}
        confirm={t('deleteEntryBtn')}
        destructive
        onConfirm={() => {
          if (!effectiveCanWrite || !deletingEntry) return;
          deleteEntry.mutate({
            projectId,
            entryId: deletingEntry.id,
            idempotencyKey: crypto.randomUUID(),
          });
        }}
      />
    </div>
  );
}
