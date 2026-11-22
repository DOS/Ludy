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
import { useEffect, useId, useState, type FormEvent } from 'react';
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
import { ErrorText, RowsSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import { PROJECT_WEEKLY_STATUS_QUERY_PREFIX } from '../lib/projects.ts';
import {
  currentLocalDateTimeInput,
  formatDecimalHours,
  formatDecimalMoney,
  formatMinutesAsHours,
  isValidHourlyRateInput,
  localDateTimeInputToIso,
  previewBillableAmount,
  saveTimeCsvFile,
  toLocalDateTimeInput,
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

interface EntryFormState {
  taskId: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: string;
  timingMode: 'duration' | 'endedAt';
  billable: boolean;
  hourlyRate: string;
  note: string;
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

function initialFormState(entry: ProjectTimeEntry | null, fixedTaskId?: string): EntryFormState {
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
  onDone,
  onCancel,
}: {
  projectId: string;
  fixedTaskId?: string;
  projectTasks?: readonly ProjectTaskCard[];
  editingEntry: ProjectTimeEntry | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('projects.time');
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const idPrefix = useId();
  const [form, setForm] = useState<EntryFormState>(() => initialFormState(editingEntry, fixedTaskId));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setForm(initialFormState(editingEntry, fixedTaskId));
    setValidationError(null);
  }, [editingEntry, fixedTaskId]);

  const logTime = useMutation(
    orpc.projects.logTime.mutationOptions({
      onSuccess: () => {
        refreshTimeQueries();
        onDone();
      },
    }),
  );

  const updateTime = useMutation(
    orpc.projects.updateTimeEntry.mutationOptions({
      onSuccess: () => {
        refreshTimeQueries();
        onDone();
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
    setValidationError(null);

    const startedIso = localDateTimeInputToIso(form.startedAt);
    if (!startedIso) {
      setValidationError(t('invalidStartRequired'));
      return;
    }

    if (!isValidHourlyRateInput(form.hourlyRate)) {
      setValidationError(t('invalidRateError'));
      return;
    }

    const rateValue = form.hourlyRate.trim() === '' ? null : form.hourlyRate.trim();
    const noteValue = form.note.trim() === '' ? null : form.note.trim();
    const chosenTaskId = fixedTaskId ?? (form.taskId === '' ? null : form.taskId);

    if (isEditingRunning && editingEntry) {
      const startUnchanged = form.startedAt === toLocalDateTimeInput(editingEntry.startedAt);
      updateTime.mutate({
        projectId,
        entryId: editingEntry.id,
        taskId: chosenTaskId,
        ...(startUnchanged ? {} : { startedAt: startedIso }),
        billable: form.billable,
        hourlyRate: rateValue,
        note: noteValue,
        idempotencyKey: crypto.randomUUID(),
      });
      return;
    }

    const endedIso = form.endedAt.trim() === '' ? undefined : localDateTimeInputToIso(form.endedAt) ?? undefined;
    if (form.endedAt.trim() !== '' && (!endedIso || Date.parse(endedIso) < Date.parse(startedIso))) {
      setValidationError(t('invalidRangeError'));
      return;
    }

    const rawDuration = form.durationMinutes.trim();
    let durationVal: number | undefined;
    if (rawDuration !== '') {
      const parsed = Number(rawDuration);
      if (!Number.isInteger(parsed) || parsed < PROJECT_TIME_DURATION_MIN || parsed > PROJECT_TIME_DURATION_MAX) {
        setValidationError(t('invalidDurationError'));
        return;
      }
      durationVal = parsed;
    }

    if (durationVal === undefined && endedIso === undefined) {
      setValidationError(t('invalidDurationError'));
      return;
    }

    if (editingEntry) {
      const startUnchanged = form.startedAt === toLocalDateTimeInput(editingEntry.startedAt);
      const originalEndedLocal = editingEntry.endedAt ? toLocalDateTimeInput(editingEntry.endedAt) : '';
      const originalDuration = editingEntry.durationMinutes === null ? '' : String(editingEntry.durationMinutes);
      const timingUnchanged =
        startUnchanged && form.endedAt === originalEndedLocal && form.durationMinutes === originalDuration;
      const sendEndedOnly = !timingUnchanged && form.timingMode === 'endedAt' && endedIso !== undefined;
      const sendDurationOnly = !timingUnchanged && !sendEndedOnly && durationVal !== undefined;

      updateTime.mutate({
        projectId,
        entryId: editingEntry.id,
        taskId: chosenTaskId,
        ...(startUnchanged ? {} : { startedAt: startedIso }),
        ...(sendEndedOnly ? { endedAt: endedIso } : {}),
        ...(sendDurationOnly ? { durationMinutes: durationVal } : {}),
        billable: form.billable,
        hourlyRate: rateValue,
        note: noteValue,
        idempotencyKey: crypto.randomUUID(),
      });
    } else {
      const sendEndedOnly = form.timingMode === 'endedAt' && endedIso !== undefined;
      logTime.mutate({
        projectId,
        taskId: chosenTaskId,
        startedAt: startedIso,
        ...(sendEndedOnly ? { endedAt: endedIso } : { durationMinutes: durationVal }),
        billable: form.billable,
        hourlyRate: rateValue,
        note: noteValue,
        idempotencyKey: crypto.randomUUID(),
      });
    }
  };

  return (
    <form
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
            onChange={(e) => setForm((prev) => ({ ...prev, taskId: e.target.value }))}
            className="min-h-11 text-sm"
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
            onChange={(e) => {
              const nextStarted = e.target.value;
              setForm((prev) => {
                if (isEditingRunning) return { ...prev, startedAt: nextStarted };
                if (prev.timingMode === 'duration') {
                  const mins = Number(prev.durationMinutes);
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
                onChange={(e) => {
                  const nextMinutes = e.target.value;
                  setForm((prev) => {
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
                onChange={(e) => {
                  const nextEnded = e.target.value;
                  setForm((prev) => {
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
            onCheckedChange={(checked) => setForm((prev) => ({ ...prev, billable: checked === true }))}
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
            onChange={(e) => setForm((prev) => ({ ...prev, hourlyRate: e.target.value }))}
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
          onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))}
          className="text-xs"
        />
      </div>

      {validationError && <ErrorText>{validationError}</ErrorText>}
      {mutationError && <ErrorText>{errorMessage(mutationError)}</ErrorText>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={onCancel}>
          {t('cancelBtn')}
        </Button>
        <Button type="submit" className="min-h-11" loading={submitting}>
          {submitting ? t('savingEntryBtn') : t('saveEntryBtn')}
        </Button>
      </div>
    </form>
  );
}

function TimeEntryRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: ProjectTimeEntry;
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

      {entry.canManage && (
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
  const [formOpen, setFormOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<ProjectTimeEntry | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<ProjectTimeEntry | null>(null);
  const [switchConflict, setSwitchConflict] = useState(false);
  const [clampedNotice, setClampedNotice] = useState(false);
  const [extraEntries, setExtraEntries] = useState<ProjectTimeEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const timeZone = browserTimeZone();

  useEffect(() => {
    setExtraEntries([]);
  }, [projectId, taskId]);

  const summaryQuery = useQuery(
    orpc.projects.timeSummary.queryOptions({
      input: { projectId, taskId, timeZone },
    }),
  );

  const startTimer = useMutation(
    orpc.projects.startTime.mutationOptions({
      onSuccess: () => {
        setSwitchConflict(false);
        setClampedNotice(false);
        setExtraEntries([]);
        refreshTimeQueries();
      },
      onError: (err) => {
        if (isTimerConflictError(err)) {
          setSwitchConflict(true);
          refreshTimeQueries();
        }
      },
    }),
  );

  const stopTimer = useMutation(
    orpc.projects.stopTime.mutationOptions({
      onSuccess: (res) => {
        setSwitchConflict(false);
        setClampedNotice(res.clampedToMax);
        setExtraEntries([]);
        refreshTimeQueries();
      },
    }),
  );

  const deleteEntry = useMutation(
    orpc.projects.deleteTimeEntry.mutationOptions({
      onSuccess: () => {
        setDeletingEntry(null);
        setExtraEntries([]);
        refreshTimeQueries();
      },
    }),
  );

  const data = summaryQuery.data;
  const effectiveCanWrite = canWrite && (data?.canWrite ?? true);
  const activeTimer = data?.activeTimer ?? null;
  const runningHere = activeTimer?.entry.taskId === taskId && activeTimer.entry.projectId === projectId;
  const runningElsewhere = activeTimer !== null && !runningHere;
  const combinedEntries = data
    ? [...data.entries, ...extraEntries.filter((e) => !data.entries.some((first) => first.id === e.id))]
    : [];
  const hasMore = data ? combinedEntries.length < data.totalEntries : false;

  const handleLoadMore = async () => {
    if (!data || loadingMore) return;
    setLoadingMore(true);
    try {
      const nextPage = await queryClient.fetchQuery(
        orpc.projects.timeSummary.queryOptions({
          input: { projectId, taskId, timeZone, limit: PROJECT_TIME_ENTRIES_PAGE_LIMIT, offset: combinedEntries.length },
        }),
      );
      setExtraEntries((prev) => [...prev, ...nextPage.entries]);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleStartClick = () => {
    if (runningElsewhere) {
      setSwitchConflict(true);
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
    startTimer.mutate({
      projectId,
      taskId,
      stopExisting: true,
      idempotencyKey: crypto.randomUUID(),
    });
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
                onClick={() =>
                  stopTimer.mutate({
                    projectId,
                    entryId: activeTimer.entry.id,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
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
                setEditingEntry(null);
                setFormOpen((v) => !v);
              }}
              data-testid="task-time-log-toggle"
            >
              {formOpen && !editingEntry ? t('hideFormBtn') : t('logManualBtn')}
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

      {switchConflict && activeTimer && (
        <Alert className="border-warning/40 bg-warning/10" data-testid="timer-switch-conflict-alert">
          <AlertDescription className="space-y-2 text-xs text-foreground">
            <p>
              {t('switchTimerBanner', {
                project: activeTimer.projectName,
                time: f.dateTime(activeTimer.entry.startedAt),
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                className="min-h-11"
                loading={startTimer.isPending}
                onClick={handleStopAndSwitch}
                data-testid="timer-stop-existing-and-start"
              >
                {t('stopExistingAndStart')}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setSwitchConflict(false)}
              >
                {t('keepExistingTimer')}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {clampedNotice && (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertDescription className="text-xs text-foreground">{t('clampedMaxNotice')}</AlertDescription>
        </Alert>
      )}

      {(startTimer.error && !isTimerConflictError(startTimer.error)) && <ErrorText>{errorMessage(startTimer.error)}</ErrorText>}
      {stopTimer.error && <ErrorText>{errorMessage(stopTimer.error)}</ErrorText>}
      {deleteEntry.error && <ErrorText>{errorMessage(deleteEntry.error)}</ErrorText>}

      {(formOpen || editingEntry !== null) && (
        <ProjectTimeEntryForm
          projectId={projectId}
          fixedTaskId={taskId}
          editingEntry={editingEntry}
          onDone={() => {
            setFormOpen(false);
            setEditingEntry(null);
            setExtraEntries([]);
          }}
          onCancel={() => {
            setFormOpen(false);
            setEditingEntry(null);
          }}
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
                onEdit={(target) => {
                  setFormOpen(false);
                  setEditingEntry(target);
                }}
                onDelete={setDeletingEntry}
              />
            ))}
          </ul>
          {hasMore && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full text-xs"
              loading={loadingMore}
              onClick={() => void handleLoadMore()}
            >
              {loadingMore ? t('loadingEntries') : t('loadMoreEntries')}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('noTaskEntries')}</p>
      )}

      <ConfirmDialog
        open={deletingEntry !== null}
        onOpenChange={(next) => {
          if (!next) setDeletingEntry(null);
        }}
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirmDesc')}
        confirm={t('deleteEntryBtn')}
        destructive
        onConfirm={() => {
          if (!deletingEntry) return;
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
  members,
}: {
  slug?: string;
  projectId: string;
  canWrite: boolean;
  tasks: readonly ProjectTaskCard[];
  members: ProjectBoard['members'];
}) {
  const t = useTranslations('projects.time');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const idPrefix = useId();
  const timeZone = browserTimeZone();

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [taskIdFilter, setTaskIdFilter] = useState('');
  const [userIdFilter, setUserIdFilter] = useState('');
  const [billableOnly, setBillableOnly] = useState(false);

  const [extraEntries, setExtraEntries] = useState<ProjectTimeEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<ProjectTimeEntry | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<ProjectTimeEntry | null>(null);
  const [switchConflict, setSwitchConflict] = useState(false);
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

  useEffect(() => {
    setExtraEntries([]);
  }, [projectId, from, to, taskIdFilter, userIdFilter, billableOnly]);

  const summaryQuery = useQuery(
    orpc.projects.timeSummary.queryOptions({
      input: { ...filterInput, limit: PROJECT_TIME_ENTRIES_PAGE_LIMIT, offset: 0 },
    }),
  );

  const startTimer = useMutation(
    orpc.projects.startTime.mutationOptions({
      onSuccess: () => {
        setSwitchConflict(false);
        setClampedNotice(false);
        setExtraEntries([]);
        refreshTimeQueries();
      },
      onError: (err) => {
        if (isTimerConflictError(err)) {
          setSwitchConflict(true);
          refreshTimeQueries();
        }
      },
    }),
  );

  const stopTimer = useMutation(
    orpc.projects.stopTime.mutationOptions({
      onSuccess: (res) => {
        setSwitchConflict(false);
        setClampedNotice(res.clampedToMax);
        setExtraEntries([]);
        refreshTimeQueries();
      },
    }),
  );

  const deleteEntry = useMutation(
    orpc.projects.deleteTimeEntry.mutationOptions({
      onSuccess: () => {
        setDeletingEntry(null);
        setExtraEntries([]);
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

  const summary: ProjectTimeSummaryResult | undefined = summaryQuery.data;
  const activeTimer = summary?.activeTimer ?? null;
  const runningInCurrentProject = activeTimer?.entry.projectId === projectId;
  const runningInOtherProject = activeTimer !== null && !runningInCurrentProject;

  const combinedEntries = summary
    ? [
        ...summary.entries,
        ...extraEntries.filter((e) => !summary.entries.some((first) => first.id === e.id)),
      ]
    : [];
  const hasMore = summary ? combinedEntries.length < summary.totalEntries : false;

  const handleLoadMore = async () => {
    if (!summary || loadingMore) return;
    setLoadingMore(true);
    try {
      const nextPage = await queryClient.fetchQuery(
        orpc.projects.timeSummary.queryOptions({
          input: { ...filterInput, limit: PROJECT_TIME_ENTRIES_PAGE_LIMIT, offset: combinedEntries.length },
        }),
      );
      setExtraEntries((prev) => [...prev, ...nextPage.entries]);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="project-time-tab">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canWrite && (
            <>
              {runningInCurrentProject && activeTimer ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 gap-1.5 border-destructive/40 text-destructive"
                  loading={stopTimer.isPending}
                  onClick={() =>
                    stopTimer.mutate({
                      projectId,
                      entryId: activeTimer.entry.id,
                      idempotencyKey: crypto.randomUUID(),
                    })
                  }
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
                    if (runningInOtherProject) {
                      setSwitchConflict(true);
                      return;
                    }
                    startTimer.mutate({
                      projectId,
                      taskId: taskIdFilter || null,
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
                  setEditingEntry(null);
                  setFormOpen((v) => !v);
                }}
                data-testid="project-time-log-toggle"
              >
                {formOpen && !editingEntry ? t('hideFormBtn') : t('logManualBtn')}
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

      {!canWrite && (
        <p className="text-xs text-muted-foreground">{t('readOnlyHint')}</p>
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
            {canWrite && runningInCurrentProject && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                loading={stopTimer.isPending}
                onClick={() =>
                  stopTimer.mutate({
                    projectId,
                    entryId: activeTimer.entry.id,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
              >
                {t('stopTimer')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {switchConflict && activeTimer && (
        <Alert className="border-warning/40 bg-warning/10" data-testid="project-timer-conflict-alert">
          <AlertDescription className="space-y-2 text-xs text-foreground">
            <p>
              {t('switchTimerBanner', {
                project: activeTimer.projectName,
                time: f.dateTime(activeTimer.entry.startedAt),
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                className="min-h-11"
                loading={startTimer.isPending}
                onClick={() =>
                  startTimer.mutate({
                    projectId,
                    taskId: taskIdFilter || null,
                    stopExisting: true,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
                data-testid="project-timer-stop-existing-and-start"
              >
                {t('stopExistingAndStart')}
              </Button>
              <Button type="button" variant="outline" className="min-h-11" onClick={() => setSwitchConflict(false)}>
                {t('keepExistingTimer')}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
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

      {(formOpen || editingEntry !== null) && (
        <ProjectTimeEntryForm
          projectId={projectId}
          projectTasks={tasks}
          editingEntry={editingEntry}
          onDone={() => {
            setFormOpen(false);
            setEditingEntry(null);
            setExtraEntries([]);
          }}
          onCancel={() => {
            setFormOpen(false);
            setEditingEntry(null);
          }}
        />
      )}

      <div className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-from`} className="text-xs">
            {t('filterFrom')}
          </Label>
          <DateInput id={`${idPrefix}-from`} value={from} onChange={setFrom} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-to`} className="text-xs">
            {t('filterTo')}
          </Label>
          <DateInput id={`${idPrefix}-to`} value={to} onChange={setTo} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-task`} className="text-xs">
            {t('filterTask')}
          </Label>
          <NativeSelect
            id={`${idPrefix}-task`}
            value={taskIdFilter}
            onChange={(e) => setTaskIdFilter(e.target.value)}
            className="min-h-11 text-xs"
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
            onChange={(e) => setUserIdFilter(e.target.value)}
            className="min-h-11 text-xs"
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
            <Checkbox checked={billableOnly} onCheckedChange={(c) => setBillableOnly(c === true)} />
            <span>{t('filterBillableOnly')}</span>
          </label>
          {(from || to || taskIdFilter || userIdFilter || billableOnly) && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 text-xs"
              onClick={() => {
                setFrom('');
                setTo('');
                setTaskIdFilter('');
                setUserIdFilter('');
                setBillableOnly(false);
              }}
            >
              {t('clearFilters')}
            </Button>
          )}
        </div>
      </div>

      {summaryQuery.error && <ErrorText>{errorMessage(summaryQuery.error)}</ErrorText>}

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
                    onEdit={(target) => {
                      setFormOpen(false);
                      setEditingEntry(target);
                    }}
                    onDelete={setDeletingEntry}
                  />
                ))}
              </ul>
            )}

            {hasMore && (
              <div className="flex justify-center pt-1">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  loading={loadingMore}
                  onClick={() => void handleLoadMore()}
                >
                  {loadingMore ? t('loadingEntries') : t('loadMoreEntries')}
                </Button>
              </div>
            )}
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={deletingEntry !== null}
        onOpenChange={(next) => {
          if (!next) setDeletingEntry(null);
        }}
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirmDesc')}
        confirm={t('deleteEntryBtn')}
        destructive
        onConfirm={() => {
          if (!deletingEntry) return;
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
