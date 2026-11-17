// SPDX-License-Identifier: AGPL-3.0-only
// Recurrence selector and summary control for project tasks (#2607).
import { useMutation } from '@tanstack/react-query';
import {
  PROJECT_TASK_RECURRENCE_INTERVAL_MAX,
  PROJECT_TASK_RECURRENCE_TIMES_MAX,
  type ProjectTaskRecurrence,
  type ProjectTaskRecurrenceCadence,
  type ProjectTaskRecurrenceView,
} from '@crove/kernel-contract';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ProjectIcon } from '@crove/ui/components/project-icon';
import { DateInput } from './date-input.tsx';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';

type CadenceChoice = 'none' | ProjectTaskRecurrenceCadence;
type EndChoice = 'never' | 'until' | 'times';

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

export type RecurrenceBadgeTranslator = ((
  key: 'recurrence.badgeWeeklySingle' | 'recurrence.badgeMonthlySingle',
) => string) &
  ((
    key: 'recurrence.badgeWeeklyMultiple' | 'recurrence.badgeMonthlyMultiple',
    values: { interval: number },
  ) => string);

export function formatRecurrenceBadgeLabel(
  rule: ProjectTaskRecurrence,
  t: RecurrenceBadgeTranslator,
): string {
  if (rule.cadence === 'weekly') {
    return rule.interval === 1
      ? t('recurrence.badgeWeeklySingle')
      : t('recurrence.badgeWeeklyMultiple', { interval: rule.interval });
  }
  return rule.interval === 1
    ? t('recurrence.badgeMonthlySingle')
    : t('recurrence.badgeMonthlyMultiple', { interval: rule.interval });
}

export function TaskRecurrenceControl({
  projectId,
  taskId,
  canEdit,
  view,
  onUpdated,
}: {
  projectId: string;
  taskId: string;
  canEdit: boolean;
  view: ProjectTaskRecurrenceView | null;
  onUpdated?: (next: ProjectTaskRecurrenceView) => void;
}) {
  const t = useTranslations('projects');
  const f = useFormat();
  const tz = browserTimeZone();

  const existing = view?.recurrence ?? null;
  const isGeneratedCopy = view?.recurrenceSourceTaskId !== null && view?.recurrenceSourceTaskId !== undefined;

  const [cadence, setCadence] = useState<CadenceChoice>(() => existing?.cadence ?? 'none');
  const [interval, setInterval] = useState<string>(() => String(existing?.interval ?? 1));
  const [weekday, setWeekday] = useState<string>(() => String(existing?.weekday ?? 1));
  const [monthDay, setMonthDay] = useState<string>(() => String(existing?.monthDay ?? -1));
  const [endMode, setEndMode] = useState<EndChoice>(() =>
    existing?.until ? 'until' : existing?.times ? 'times' : 'never',
  );
  const [until, setUntil] = useState<string>(() => existing?.until ?? '');
  const [times, setTimes] = useState<string>(() => String(existing?.times ?? 12));
  const [validationError, setValidationError] = useState<string | null>(null);

  const setRecurrence = useMutation(orpc.projects.setTaskRecurrence.mutationOptions());
  const clearRecurrence = useMutation(orpc.projects.clearTaskRecurrence.mutationOptions());

  useEffect(() => {
    const r = view?.recurrence ?? null;
    setCadence(r?.cadence ?? 'none');
    setInterval(String(r?.interval ?? 1));
    setWeekday(String(r?.weekday ?? 1));
    setMonthDay(String(r?.monthDay ?? -1));
    setEndMode(r?.until ? 'until' : r?.times ? 'times' : 'never');
    setUntil(r?.until ?? '');
    setTimes(String(r?.times ?? 12));
    setValidationError(null);
    setRecurrence.reset();
    clearRecurrence.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, existing?.cadence, existing?.interval, existing?.weekday, existing?.monthDay, existing?.until, existing?.times]);

  if (isGeneratedCopy) {
    return (
      <div
        className="rounded-lg border border-border bg-muted/35 p-3 text-xs text-muted-foreground"
        data-testid="task-recurrence-generated-hint"
      >
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <ProjectIcon name="repeat" className="size-3.5" />
          <span>{t('recurrence.title')}</span>
        </div>
        <p className="mt-1">{t('recurrence.generatedCopyHint')}</p>
      </div>
    );
  }

  const clearedView = (): ProjectTaskRecurrenceView => ({
    projectId,
    taskId,
    recurrence: null,
    recurrenceCount: view?.recurrenceCount ?? 0,
    recurrenceLastDue: view?.recurrenceLastDue ?? null,
    recurrenceNextAt: null,
    recurrenceSourceTaskId: view?.recurrenceSourceTaskId ?? null,
  });

  const handleSave = () => {
    setValidationError(null);
    if (cadence === 'none') {
      clearRecurrence.mutate(
        { projectId, taskId, idempotencyKey: crypto.randomUUID() },
        { onSuccess: () => onUpdated?.(clearedView()) },
      );
      return;
    }

    if (endMode === 'until' && typeof document !== 'undefined') {
      const untilInput = document.getElementById(`recurrence-until-${taskId}`);
      if (untilInput instanceof HTMLInputElement && !untilInput.checkValidity()) {
        untilInput.reportValidity();
        return;
      }
    }

    const parsedInterval = Number.parseInt(interval, 10);
    const boundedInterval = Number.isNaN(parsedInterval)
      ? 1
      : Math.max(1, Math.min(PROJECT_TASK_RECURRENCE_INTERVAL_MAX, parsedInterval));

    let parsedTimes: number | undefined;
    if (endMode === 'until' && !until.trim()) {
      setValidationError(t('recurrence.untilRequired'));
      return;
    }
    if (endMode === 'times') {
      const n = Number.parseInt(times, 10);
      if (Number.isNaN(n) || n < 1 || n > PROJECT_TASK_RECURRENCE_TIMES_MAX) {
        setValidationError(t('recurrence.timesInvalid'));
        return;
      }
      parsedTimes = n;
    }

    const rule: ProjectTaskRecurrence =
      cadence === 'weekly'
        ? {
            cadence: 'weekly',
            interval: boundedInterval,
            weekday: Number.parseInt(weekday, 10) || 0,
            timeZone: existing?.timeZone ?? tz,
            ...(endMode === 'until' ? { until: until.trim() } : {}),
            ...(parsedTimes !== undefined ? { times: parsedTimes } : {}),
          }
        : {
            cadence: 'monthly',
            interval: boundedInterval,
            monthDay: Number.parseInt(monthDay, 10) || -1,
            timeZone: existing?.timeZone ?? tz,
            ...(endMode === 'until' ? { until: until.trim() } : {}),
            ...(parsedTimes !== undefined ? { times: parsedTimes } : {}),
          };

    setRecurrence.mutate(
      { projectId, taskId, recurrence: rule, idempotencyKey: crypto.randomUUID() },
      { onSuccess: (next) => onUpdated?.(next) },
    );
  };

  const handleClear = () => {
    setValidationError(null);
    clearRecurrence.mutate(
      { projectId, taskId, idempotencyKey: crypto.randomUUID() },
      { onSuccess: () => onUpdated?.(clearedView()) },
    );
  };

  const busy = setRecurrence.isPending || clearRecurrence.isPending;
  const mutationError = setRecurrence.error ?? clearRecurrence.error;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3" data-testid="task-recurrence-control">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <ProjectIcon name="repeat" className="size-3.5 text-muted-foreground" />
          <span>{t('recurrence.title')}</span>
        </div>
        {existing && view?.recurrenceNextAt && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('recurrence.statusSummary', {
              count: view.recurrenceCount,
              next: f.date(view.recurrenceNextAt),
            })}
          </span>
        )}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`recurrence-cadence-${taskId}`} className="text-xs">
            {t('recurrence.cadenceLabel')}
          </Label>
          <NativeSelect
            id={`recurrence-cadence-${taskId}`}
            disabled={!canEdit || busy}
            value={cadence}
            onChange={(e) => setCadence(e.target.value as CadenceChoice)}
            className="w-full text-xs"
          >
            <NativeSelectOption value="none">{t('recurrence.none')}</NativeSelectOption>
            <NativeSelectOption value="weekly">{t('recurrence.weekly')}</NativeSelectOption>
            <NativeSelectOption value="monthly">{t('recurrence.monthly')}</NativeSelectOption>
          </NativeSelect>
        </div>

        {cadence !== 'none' && (
          <div className="space-y-1">
            <Label htmlFor={`recurrence-interval-${taskId}`} className="text-xs">
              {t('recurrence.intervalLabel')}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={`recurrence-interval-${taskId}`}
                type="number"
                min={1}
                max={PROJECT_TASK_RECURRENCE_INTERVAL_MAX}
                disabled={!canEdit || busy}
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                className="w-20 text-xs tabular-nums"
              />
              <span className="text-xs text-muted-foreground">
                {cadence === 'weekly' ? t('recurrence.weeksUnit') : t('recurrence.monthsUnit')}
              </span>
            </div>
          </div>
        )}
      </div>

      {cadence === 'weekly' && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`recurrence-weekday-${taskId}`} className="text-xs">
              {t('recurrence.weekdayLabel')}
            </Label>
            <NativeSelect
              id={`recurrence-weekday-${taskId}`}
              disabled={!canEdit || busy}
              value={weekday}
              onChange={(e) => setWeekday(e.target.value)}
              className="w-full text-xs"
            >
              {WEEKDAY_KEYS.map((key, idx) => (
                <NativeSelectOption key={key} value={String(idx)}>
                  {t(`recurrence.weekdays.${key}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
      )}

      {cadence === 'monthly' && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`recurrence-monthday-${taskId}`} className="text-xs">
              {t('recurrence.monthDayLabel')}
            </Label>
            <NativeSelect
              id={`recurrence-monthday-${taskId}`}
              disabled={!canEdit || busy}
              value={monthDay}
              onChange={(e) => setMonthDay(e.target.value)}
              className="w-full text-xs"
            >
              <NativeSelectOption value="-1">{t('recurrence.lastDayOfMonth')}</NativeSelectOption>
              {MONTH_DAYS.map((day) => (
                <NativeSelectOption key={day} value={String(day)}>
                  {t('recurrence.dayNumber', { day })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
      )}

      {cadence !== 'none' && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`recurrence-end-${taskId}`} className="text-xs">
              {t('recurrence.endLabel')}
            </Label>
            <NativeSelect
              id={`recurrence-end-${taskId}`}
              disabled={!canEdit || busy}
              value={endMode}
              onChange={(e) => setEndMode(e.target.value as EndChoice)}
              className="w-full text-xs"
            >
              <NativeSelectOption value="never">{t('recurrence.endNever')}</NativeSelectOption>
              <NativeSelectOption value="until">{t('recurrence.endUntil')}</NativeSelectOption>
              <NativeSelectOption value="times">{t('recurrence.endTimes')}</NativeSelectOption>
            </NativeSelect>
          </div>

          {endMode === 'until' && (
            <div className="space-y-1">
              <Label htmlFor={`recurrence-until-${taskId}`} className="text-xs">
                {t('recurrence.endUntil')}
              </Label>
              <DateInput
                id={`recurrence-until-${taskId}`}
                disabled={!canEdit || busy}
                value={until}
                onChange={setUntil}
                aria-label={t('recurrence.endUntil')}
              />
            </div>
          )}

          {endMode === 'times' && (
            <div className="space-y-1">
              <Label htmlFor={`recurrence-times-${taskId}`} className="text-xs">
                {t('recurrence.endTimes')}
              </Label>
              <Input
                id={`recurrence-times-${taskId}`}
                type="number"
                min={1}
                max={PROJECT_TASK_RECURRENCE_TIMES_MAX}
                disabled={!canEdit || busy}
                placeholder={t('recurrence.timesPlaceholder')}
                value={times}
                onChange={(e) => setTimes(e.target.value)}
                className="text-xs tabular-nums"
              />
            </div>
          )}
        </div>
      )}

      {validationError && <ErrorText>{validationError}</ErrorText>}
      {mutationError && <ErrorText>{errorMessage(mutationError)}</ErrorText>}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || (cadence === 'none' && !existing)}
            loading={setRecurrence.isPending}
            onClick={handleSave}
            data-testid="save-recurrence-button"
          >
            {t('recurrence.saveBtn')}
          </Button>
          {existing && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              loading={clearRecurrence.isPending}
              onClick={handleClear}
              data-testid="clear-recurrence-button"
            >
              {t('recurrence.clearBtn')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
