// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in Sprints / Cycles management, deterministic burndown/velocity charts + semantic tables,
// human carryover completion modal, and Vy cycle summary card (#4361, docs/plan/projects-v2.md section 4.1).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectCycle,
  ProjectCycleBurndownPoint,
  ProjectCycleCarryover,
  ProjectCycleFilter,
  ProjectCycleMetrics,
  ProjectCycleSummary,
  ProjectCycleVelocityPoint,
  ProjectStatus,
} from '@ludy/kernel-contract';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { Textarea } from '@ludy/ui/components/textarea';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { projectCycleSummaryQueryKey } from '../lib/projects.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput, hasInvalidDate } from './date-input.tsx';
import { refreshProjectQueries } from './project-task-dialog.tsx';
import { ErrorText, FieldError, fieldControl } from './ui.tsx';

function pct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

function cycleStatusVariant(status: ProjectCycle['status']): 'default' | 'success' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'completed') return 'success';
  return 'outline';
}

export interface SvgCoord {
  x: number;
  y: number;
}

export function buildBurndownSeriesCoords(
  burndown: readonly ProjectCycleBurndownPoint[],
  usePoints: boolean,
  series: 'ideal' | 'actual',
  width: number,
  height: number,
): SvgCoord[] {
  if (burndown.length === 0) return [];
  const padX = 8;
  const padY = 8;
  const innerW = Math.max(1, width - padX * 2);
  const innerH = Math.max(1, height - padY * 2);
  const maxVal = Math.max(
    1,
    ...burndown.flatMap((p) => {
      const ideal = usePoints ? p.idealRemainingPoints : p.idealRemainingTasks;
      const actual = usePoints ? (p.remainingPoints ?? 0) : (p.remainingTasks ?? 0);
      return [ideal, actual];
    }),
  );

  const coords: SvgCoord[] = [];
  const stepX = burndown.length > 1 ? innerW / (burndown.length - 1) : 0;
  for (let i = 0; i < burndown.length; i += 1) {
    const point = burndown[i];
    if (!point) continue;
    const rawVal =
      series === 'ideal'
        ? usePoints
          ? point.idealRemainingPoints
          : point.idealRemainingTasks
        : usePoints
          ? point.remainingPoints
          : point.remainingTasks;
    if (rawVal === null) continue;
    const x = Number((padX + (burndown.length > 1 ? i * stepX : innerW / 2)).toFixed(1));
    const y = Number((padY + innerH - (rawVal / maxVal) * innerH).toFixed(1));
    coords.push({ x, y });
  }
  return coords;
}

export function buildBurndownPolylinePoints(
  burndown: readonly ProjectCycleBurndownPoint[],
  usePoints: boolean,
  series: 'ideal' | 'actual',
  width: number,
  height: number,
): string {
  return buildBurndownSeriesCoords(burndown, usePoints, series, width, height)
    .map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ');
}

function CycleFormDialog({
  open,
  onOpenChange,
  projectId,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  editing: ProjectCycle | null;
}) {
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [nameError, setNameError] = useState(false);
  const [dateError, setDateError] = useState(false);

  const createCycle = useMutation(orpc.projects.createCycle.mutationOptions({ onSuccess: refreshProjectQueries }));
  const updateCycle = useMutation(orpc.projects.updateCycle.mutationOptions({ onSuccess: refreshProjectQueries }));

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setGoal(editing?.goal ?? '');
      setStartsOn(editing?.startsOn ?? '');
      setEndsOn(editing?.endsOn ?? '');
      setNameError(false);
      setDateError(false);
      createCycle.reset();
      updateCycle.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const busy = createCycle.isPending || updateCycle.isPending;
  const mutationError = createCycle.error ?? updateCycle.error;
  const nameField = fieldControl(`cycle-form-name-${projectId}`, { error: nameError });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (hasInvalidDate(e.currentTarget)) {
      setDateError(true);
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(true);
      return;
    }
    if (startsOn && endsOn) {
      const diffMs = Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`);
      const days = Math.round(diffMs / 86_400_000) + 1;
      if (Number.isNaN(days) || days < 1 || days > 90) {
        setDateError(true);
        return;
      }
    }
    const cleanGoal = goal.trim() ? goal.trim() : null;
    if (editing) {
      updateCycle.mutate(
        {
          projectId,
          cycleId: editing.id,
          name: trimmed,
          goal: cleanGoal,
          ...(startsOn ? { startsOn } : {}),
          ...(endsOn ? { endsOn } : {}),
          idempotencyKey: crypto.randomUUID(),
        },
        { onSuccess: () => onOpenChange(false) },
      );
      return;
    }
    createCycle.mutate(
      {
        projectId,
        name: trimmed,
        ...(cleanGoal !== null ? { goal: cleanGoal } : {}),
        ...(startsOn ? { startsOn } : {}),
        ...(endsOn ? { endsOn } : {}),
        idempotencyKey: crypto.randomUUID(),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc('close')} data-testid="cycle-form-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? t('cycles.form.editTitle') : t('cycles.form.createTitle')}</DialogTitle>
        </DialogHeader>
        <form noValidate onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={nameField.id}>{t('cycles.form.nameLabel')}</Label>
            <Input
              {...nameField}
              required
              maxLength={120}
              className="max-md:h-11"
              placeholder={t('cycles.form.namePlaceholder')}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError && e.target.value.trim()) setNameError(false);
              }}
            />
            <FieldError id={nameField.id}>{nameError ? t('cycles.form.nameRequired') : null}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`cycle-form-goal-${projectId}`}>{t('cycles.form.goalLabel')}</Label>
            <Textarea
              id={`cycle-form-goal-${projectId}`}
              rows={2}
              maxLength={1000}
              placeholder={t('cycles.form.goalPlaceholder')}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`cycle-form-start-${projectId}`}>{t('cycles.form.startsOnLabel')}</Label>
              <DateInput
                id={`cycle-form-start-${projectId}`}
                value={startsOn}
                inputClassName="max-md:h-11"
                onChange={(v) => {
                  setStartsOn(v);
                  if (dateError) setDateError(false);
                }}
                aria-label={t('cycles.form.startsOnLabel')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`cycle-form-end-${projectId}`}>{t('cycles.form.endsOnLabel')}</Label>
              <DateInput
                id={`cycle-form-end-${projectId}`}
                value={endsOn}
                inputClassName="max-md:h-11"
                onChange={(v) => {
                  setEndsOn(v);
                  if (dateError) setDateError(false);
                }}
                aria-label={t('cycles.form.endsOnLabel')}
              />
            </div>
          </div>
          {dateError && <ErrorText>{t('cycles.form.dateInvalid')}</ErrorText>}
          {mutationError && <ErrorText>{errorMessage(mutationError)}</ErrorText>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{tc('cancel')}</DialogClose>
            <Button type="submit" loading={busy}>
              {editing ? t('cycles.form.submitSave') : t('cycles.form.submitCreate')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type CycleCarryoverSelection = 'none' | 'backlog' | 'cycle';

export function initialCarryoverSelection(_openTasks: number): CycleCarryoverSelection {
  return 'none';
}

export function validateCompleteCycleCarryover(
  openTasks: number,
  mode: CycleCarryoverSelection,
  targetCycleId: string,
  upcomingCycles: readonly ProjectCycle[],
):
  | { ok: true; carryover: ProjectCycleCarryover }
  | { ok: false; reason: 'pickRequired' | 'pickAgain'; clearTarget: boolean } {
  if (openTasks === 0 && mode === 'none') {
    return { ok: true, carryover: { mode: 'none' } };
  }
  if (openTasks > 0 && mode === 'none') {
    return { ok: false, reason: 'pickRequired', clearTarget: false };
  }
  if (mode === 'cycle') {
    const exists = targetCycleId !== '' && upcomingCycles.some((u) => u.id === targetCycleId);
    if (!exists) {
      return { ok: false, reason: 'pickAgain', clearTarget: true };
    }
    return { ok: true, carryover: { mode: 'cycle', targetCycleId } };
  }
  return { ok: true, carryover: { mode: 'backlog' } };
}

function CompleteCycleDialog({
  open,
  onOpenChange,
  projectId,
  cycle,
  upcomingCycles,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  cycle: ProjectCycle | null;
  upcomingCycles: readonly ProjectCycle[];
  onCompleted: () => void;
}) {
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const [mode, setMode] = useState<CycleCarryoverSelection>('none');
  const [targetCycleId, setTargetCycleId] = useState('');
  const [selectionError, setSelectionError] = useState<'pickRequired' | 'pickAgain' | null>(null);

  const completeCycle = useMutation(orpc.projects.completeCycle.mutationOptions({ onSuccess: refreshProjectQueries }));

  useEffect(() => {
    if (open && cycle) {
      setMode(initialCarryoverSelection(cycle.openTasks));
      const nextUpcoming = upcomingCycles.reduce<ProjectCycle | null>(
        (best, c) => (!best || c.number < best.number ? c : best),
        null,
      );
      setTargetCycleId(nextUpcoming?.id ?? '');
      setSelectionError(null);
      completeCycle.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cycle?.id]);

  if (!cycle) return null;

  const canMoveToCycle = upcomingCycles.length > 0;
  const selectedTargetValid = upcomingCycles.some((u) => u.id === targetCycleId);
  const validation = validateCompleteCycleCarryover(cycle.openTasks, mode, targetCycleId, upcomingCycles);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const check = validateCompleteCycleCarryover(cycle.openTasks, mode, targetCycleId, upcomingCycles);
    if (!check.ok) {
      if (check.clearTarget) setTargetCycleId('');
      setSelectionError(check.reason);
      return;
    }
    setSelectionError(null);
    completeCycle.mutate(
      {
        projectId,
        cycleId: cycle.id,
        carryover: check.carryover,
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          onCompleted();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc('close')} data-testid="complete-cycle-dialog">
        <DialogHeader>
          <DialogTitle>{t('cycles.complete.title')}</DialogTitle>
          <DialogDescription>{t('cycles.complete.desc', { name: cycle.name })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1 rounded-lg border border-border bg-muted/35 p-3 text-xs text-foreground">
            <p className="font-medium tabular-nums">{t('cycles.complete.unfinishedCount', { count: cycle.openTasks })}</p>
            <p className="text-muted-foreground tabular-nums">{t('cycles.complete.doneKeptCount', { count: cycle.doneTasks })}</p>
          </div>

          {cycle.openTasks === 0 ? (
            <p className="text-xs text-muted-foreground">{t('cycles.complete.noUnfinishedNote')}</p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-foreground">{t('cycles.complete.choiceLabel')}</legend>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-foreground">
                <input
                  type="radio"
                  name={`carryover-mode-${cycle.id}`}
                  value="backlog"
                  checked={mode === 'backlog'}
                  onChange={() => {
                    setMode('backlog');
                    setSelectionError(null);
                  }}
                />
                <span>{t('cycles.complete.moveToBacklog')}</span>
              </label>
              <label
                className={`flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs ${
                  canMoveToCycle ? 'cursor-pointer text-foreground' : 'cursor-not-allowed text-muted-foreground opacity-60'
                }`}
              >
                <input
                  type="radio"
                  name={`carryover-mode-${cycle.id}`}
                  value="cycle"
                  disabled={!canMoveToCycle}
                  checked={mode === 'cycle'}
                  onChange={() => {
                    setMode('cycle');
                    setSelectionError(null);
                  }}
                />
                <span>{t('cycles.complete.moveToCycle')}</span>
              </label>
            </fieldset>
          )}

          {cycle.openTasks > 0 && mode === 'cycle' && canMoveToCycle && (
            <div className="space-y-1.5">
              <Label htmlFor={`carryover-target-${cycle.id}`}>{t('cycles.complete.targetCycleLabel')}</Label>
              <NativeSelect
                id={`carryover-target-${cycle.id}`}
                className="w-full max-md:[&>select]:h-11"
                value={selectedTargetValid ? targetCycleId : ''}
                onChange={(e) => {
                  setTargetCycleId(e.target.value);
                  setSelectionError(null);
                }}
              >
                {!selectedTargetValid && (
                  <NativeSelectOption value="">{t('cycles.complete.selectTargetPlaceholder')}</NativeSelectOption>
                )}
                {upcomingCycles.map((u) => (
                  <NativeSelectOption key={u.id} value={u.id}>
                    {t('cycles.cycleLabel', { number: u.number, name: u.name })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}

          {cycle.openTasks > 0 && !canMoveToCycle && (
            <p className="text-xs text-muted-foreground">{t('cycles.complete.noUpcomingForCarryover')}</p>
          )}
          {selectionError && <ErrorText>{t(`cycles.complete.${selectionError}`)}</ErrorText>}
          {completeCycle.error && <ErrorText>{errorMessage(completeCycle.error)}</ErrorText>}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{tc('cancel')}</DialogClose>
            <Button type="submit" loading={completeCycle.isPending} disabled={!validation.ok}>
              {t('cycles.complete.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CycleMetricsSection({
  metrics,
  cycles,
  selectedCycleId,
  onSelectCycleId,
  pointsEnabled,
}: {
  metrics: ProjectCycleMetrics;
  cycles: readonly ProjectCycle[];
  selectedCycleId: string;
  onSelectCycleId: (id: string) => void;
  pointsEnabled: boolean;
}) {
  const t = useTranslations('projects');
  const f = useFormat();
  const [showTable, setShowTable] = useState(false);

  const idealSeries = buildBurndownSeriesCoords(metrics.burndown, pointsEnabled, 'ideal', 320, 110);
  const actualSeries = buildBurndownSeriesCoords(metrics.burndown, pointsEnabled, 'actual', 320, 110);
  const idealCoords = idealSeries.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const actualCoords = actualSeries.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const maxVelocity = Math.max(
    1,
    ...metrics.velocity.map((v: ProjectCycleVelocityPoint) => (pointsEnabled ? v.committedPoints : v.totalTasks)),
  );

  return (
    <div className="space-y-3 border-t border-border/70 pt-3" data-testid="cycle-metrics-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-semibold text-foreground">{t('cycles.metrics.title')}</h4>
          {metrics.velocity.length > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {pointsEnabled
                ? t('cycles.metrics.avgVelocity', {
                    tasks: metrics.averageVelocityTasks,
                    points: metrics.averageVelocityPoints,
                  })
                : t('cycles.metrics.avgVelocityTasksOnly', {
                    tasks: metrics.averageVelocityTasks,
                  })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {cycles.length > 0 && (
            <NativeSelect
              aria-label={t('cycles.metrics.cycleSelectLabel')}
              value={selectedCycleId || metrics.selectedCycle?.id || ''}
              onChange={(e) => onSelectCycleId(e.target.value)}
              className="text-xs max-md:[&>select]:h-11"
            >
              {cycles.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {t('cycles.cycleLabel', { number: c.number, name: c.name })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={showTable}
            onClick={() => setShowTable((v) => !v)}
            className="min-h-11 md:min-h-8"
            data-testid="toggle-cycle-metrics-table"
          >
            {showTable ? t('cycles.metrics.hideTable') : t('cycles.metrics.showTable')}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-background/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">{t('cycles.metrics.burndownTitle')}</span>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span>{t('cycles.metrics.idealLegend')}</span>
              <span className="font-medium text-primary">{t('cycles.metrics.actualLegend')}</span>
            </div>
          </div>
          {metrics.burndown.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('cycles.metrics.emptyBurndown')}</p>
          ) : (
            <svg
              aria-hidden="true"
              viewBox="0 0 320 110"
              className="h-28 w-full overflow-visible"
              data-testid="cycle-burndown-svg"
            >
              <line x1="8" y1="102" x2="312" y2="102" stroke="currentColor" strokeWidth="1" className="text-border" />
              {idealSeries.length >= 2 && (
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                  className="text-muted-foreground"
                  points={idealCoords}
                />
              )}
              {idealSeries.length === 1 && idealSeries[0] && (
                <circle
                  cx={idealSeries[0].x}
                  cy={idealSeries[0].y}
                  r="3"
                  fill="currentColor"
                  className="text-muted-foreground"
                />
              )}
              {actualSeries.length >= 2 && (
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-primary"
                  points={actualCoords}
                />
              )}
              {actualSeries.length === 1 && actualSeries[0] && (
                <circle
                  cx={actualSeries[0].x}
                  cy={actualSeries[0].y}
                  r="3.5"
                  fill="currentColor"
                  className="text-primary"
                  data-testid="cycle-burndown-single-point"
                />
              )}
            </svg>
          )}
        </div>

        <div className="rounded-lg border border-border bg-background/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">{t('cycles.metrics.velocityTitle')}</span>
          </div>
          {metrics.velocity.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('cycles.metrics.emptyVelocity')}</p>
          ) : (
            <div aria-hidden="true" className="flex h-28 items-end gap-2 pt-2" data-testid="cycle-velocity-chart">
              {metrics.velocity.map((item) => {
                const value = pointsEnabled ? item.completedPoints : item.completedTasks;
                const ratio = Math.max(8, Math.round((value / maxVelocity) * 100));
                return (
                  <div key={item.cycleId} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                    <span className="text-[11px] font-medium text-foreground tabular-nums">{value}</span>
                    <div className="flex h-16 w-full items-end rounded bg-muted/60 p-0.5">
                      <div className="w-full rounded-sm bg-primary" style={{ height: `${ratio}%` }} />
                    </div>
                    <span className="truncate text-[11px] text-muted-foreground tabular-nums">{`#${item.number}`}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Unconditional semantic tables in the DOM (visually hidden unless expanded) so assistive tech always reaches all metrics. */}
      <div className={showTable ? 'space-y-3 overflow-x-auto' : 'sr-only'} data-testid="cycle-metrics-tables">
        {metrics.burndown.length > 0 && (
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">{t('cycles.metrics.burndownTitle')}</caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t('cycles.metrics.colDate')}
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t('cycles.metrics.colIdealTasks')}
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t('cycles.metrics.colActualTasks')}
                </th>
                {pointsEnabled && (
                  <>
                    <th scope="col" className="py-1.5 pr-3 font-medium">
                      {t('cycles.metrics.colIdealPoints')}
                    </th>
                    <th scope="col" className="py-1.5 font-medium">
                      {t('cycles.metrics.colActualPoints')}
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {metrics.burndown.map((row) => (
                <tr key={row.date} className="border-b border-border/50 tabular-nums">
                  <td className="py-1 pr-3 text-foreground">{f.date(row.date)}</td>
                  <td className="py-1 pr-3 text-muted-foreground">{row.idealRemainingTasks}</td>
                  <td className="py-1 pr-3 text-foreground">{row.remainingTasks ?? '-'}</td>
                  {pointsEnabled && (
                    <>
                      <td className="py-1 pr-3 text-muted-foreground">{row.idealRemainingPoints}</td>
                      <td className="py-1 text-foreground">{row.remainingPoints ?? '-'}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {metrics.velocity.length > 0 && (
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">{t('cycles.metrics.velocityTitle')}</caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t('cycles.metrics.colCycle')}
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t('cycles.metrics.colDoneTasks')}
                </th>
                {pointsEnabled && (
                  <th scope="col" className="py-1.5 font-medium">
                    {t('cycles.metrics.colDonePoints')}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {metrics.velocity.map((row) => (
                <tr key={row.cycleId} className="border-b border-border/50 tabular-nums">
                  <td className="py-1 pr-3 text-foreground">{t('cycles.cycleLabel', { number: row.number, name: row.name })}</td>
                  <td className="py-1 pr-3 text-foreground">{`${row.completedTasks}/${row.totalTasks}`}</td>
                  {pointsEnabled && <td className="py-1 text-foreground">{`${row.completedPoints}/${row.committedPoints}`}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function buildCycleSummaryQueryOptions<TOptions extends Record<string, unknown>>(
  baseOptions: TOptions,
  slug: string,
  projectId: string,
  cycleId: string | null,
  language: 'vi' | 'en',
) {
  return {
    ...baseOptions,
    queryKey: projectCycleSummaryQueryKey(slug, projectId, cycleId, language),
    enabled: false as const,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false as const,
    refetchOnReconnect: false as const,
    refetchOnMount: false as const,
    retry: false as const,
  };
}

export function shouldKeepSummaryStaleAfterFetch(invalidatedAtStart: number, latestInvalidation: number): boolean {
  return latestInvalidation > invalidatedAtStart;
}

function CycleSummaryBlock({
  slug,
  projectId,
  cycleId,
}: {
  slug: string;
  projectId: string;
  cycleId: string | null;
}) {
  const t = useTranslations('projects');
  const { locale } = useLocaleSetting();
  const language = locale === 'en' ? 'en' : 'vi';
  const queryClient = useQueryClient();
  const [requested, setRequested] = useState(false);

  const summaryKey = projectCycleSummaryQueryKey(slug, projectId, cycleId, language);
  const serializedKey = JSON.stringify(summaryKey);
  const [isSummaryStale, setIsSummaryStale] = useState(() =>
    Boolean(queryClient.getQueryState(summaryKey)?.isInvalidated),
  );
  const lastInvalidationSeqRef = useRef(0);
  const fetchStartSeqRef = useRef(0);
  const prevInvalidatedRef = useRef(Boolean(queryClient.getQueryState(summaryKey)?.isInvalidated));

  useEffect(() => {
    setRequested(false);
  }, [projectId, cycleId, language]);

  useEffect(() => {
    const initialInvalidated = Boolean(
      queryClient.getQueryState(JSON.parse(serializedKey) as typeof summaryKey)?.isInvalidated,
    );
    prevInvalidatedRef.current = initialInvalidated;
    setIsSummaryStale(initialInvalidated);

    return queryClient.getQueryCache().subscribe((event) => {
      const keyJson = JSON.stringify(event.query.queryKey);
      const isSummaryQuery = keyJson === serializedKey;
      const isProjectMutationInvalidation =
        event.type === 'updated' &&
        event.action.type === 'invalidate' &&
        Array.isArray(event.query.queryKey) &&
        event.query.queryKey[0] === 'projects';

      if (isSummaryQuery) {
        const nextInvalidated = Boolean(event.query.state.isInvalidated);
        if (nextInvalidated && !prevInvalidatedRef.current) {
          lastInvalidationSeqRef.current += 1;
          setIsSummaryStale(true);
        } else if (!nextInvalidated && prevInvalidatedRef.current) {
          setIsSummaryStale(shouldKeepSummaryStaleAfterFetch(fetchStartSeqRef.current, lastInvalidationSeqRef.current));
        }
        prevInvalidatedRef.current = nextInvalidated;
      } else if (isProjectMutationInvalidation) {
        lastInvalidationSeqRef.current += 1;
        setIsSummaryStale(true);
      }
    });
  }, [queryClient, serializedKey]);

  const summaryOptions = orpc.projects.cycleSummary.queryOptions({
    input: { projectId, ...(cycleId ? { cycleId } : {}), language },
  });
  const query = useQuery(buildCycleSummaryQueryOptions(summaryOptions, slug, projectId, cycleId, language));

  const data: ProjectCycleSummary | undefined =
    requested && !query.isPlaceholderData && !query.error ? query.data : undefined;

  const triggerSummary = () => {
    setRequested(true);
    const startSeq = lastInvalidationSeqRef.current;
    fetchStartSeqRef.current = startSeq;
    void query.refetch().then((res) => {
      if (!res.error) {
        setIsSummaryStale(shouldKeepSummaryStaleAfterFetch(startSeq, lastInvalidationSeqRef.current));
      }
    });
  };

  return (
    <div className="space-y-2 border-t border-border/70 pt-3" data-testid="cycle-summary-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={requested && query.isFetching}
            onClick={triggerSummary}
            className="min-h-11 gap-1.5 md:min-h-8"
            data-testid="ask-vy-cycle-summary"
          >
            <ProjectIcon name="bot" className="size-3.5 text-primary" />
            <span>{requested ? t('cycles.summary.refreshBtn') : t('cycles.summary.askBtn')}</span>
          </Button>
          {data?.ai === 'used' && (
            <Badge variant="proposal" data-testid="cycle-summary-ai-badge">
              {t('cycles.summary.aiBadge')}
            </Badge>
          )}
        </div>
      </div>

      {requested && query.isFetching && query.isPending && (
        <p className="text-xs text-muted-foreground">{t('cycles.summary.loading')}</p>
      )}
      {requested && query.error && (
        <Alert className="border-destructive/30 bg-destructive/5">
          <AlertDescription className="flex items-center justify-between gap-2 text-xs text-foreground">
            <span>{t('cycles.summary.loadError')}</span>
            <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={triggerSummary}>
              {t('cycles.summary.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {data && isSummaryStale && (
        <p className="text-[11px] text-warning" data-testid="cycle-summary-stale">
          {t('cycles.summary.staleNotice')}
        </p>
      )}
      {data && data.ai === 'used' && data.sentences.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-border bg-muted/25 p-3">
          <p className="text-[11px] text-muted-foreground">{t('cycles.summary.byVy')}</p>
          <p className="text-xs leading-relaxed text-foreground" data-testid="cycle-summary-text">
            {data.sentences.join(' ')}
          </p>
        </div>
      )}
      {data && data.ai !== 'used' && (
        <p className="text-xs text-muted-foreground" data-testid="cycle-summary-fallback">
          {t(`cycles.summary.unavailable.${data.ai}`)}
        </p>
      )}
      {data && data.hiddenByEntityCount > 0 && (
        <p className="text-[11px] text-muted-foreground">{t('cycles.summary.hiddenNotice', { count: data.hiddenByEntityCount })}</p>
      )}
      {data && data.truncated && (
        <p className="text-[11px] text-muted-foreground">{t('cycles.summary.truncatedNotice')}</p>
      )}
    </div>
  );
}

export function ProjectCyclesPanel({
  slug,
  projectId,
  projectStatus,
  canManage,
  pointsEnabled,
  cycles,
  backlogTaskCount,
  cyclesError,
  onRetryCycles,
  metrics,
  metricsError,
  onRetryMetrics,
  cycleFilter,
  selectedMetricsCycleId,
  onSelectMetricsCycleId,
  onCycleFilterChange,
}: {
  slug: string;
  projectId: string;
  projectStatus: ProjectStatus;
  canManage: boolean;
  pointsEnabled: boolean;
  cycles: readonly ProjectCycle[];
  backlogTaskCount: number;
  cyclesError?: unknown;
  onRetryCycles?: (() => void) | undefined;
  metrics: ProjectCycleMetrics | undefined;
  metricsError?: unknown;
  onRetryMetrics?: (() => void) | undefined;
  cycleFilter: ProjectCycleFilter;
  selectedMetricsCycleId: string;
  onSelectMetricsCycleId: (id: string) => void;
  onCycleFilterChange: (next: ProjectCycleFilter) => void;
}) {
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const f = useFormat();
  const headingId = useId();
  const [formOpen, setFormOpen] = useState(false);
  const [editingCycle, setEditingCycle] = useState<ProjectCycle | null>(null);
  const [completingCycle, setCompletingCycle] = useState<ProjectCycle | null>(null);
  const [deletingCycle, setDeletingCycle] = useState<ProjectCycle | null>(null);
  const [showAllCycles, setShowAllCycles] = useState(false);

  const startCycle = useMutation(orpc.projects.startCycle.mutationOptions({ onSuccess: refreshProjectQueries }));
  const deleteCycle = useMutation(orpc.projects.deleteCycle.mutationOptions({ onSuccess: refreshProjectQueries }));

  const editable = canManage && projectStatus !== 'archived';
  const activeCycle = cycles.find((c) => c.status === 'active') ?? null;
  const upcomingCycles = cycles.filter((c) => c.status === 'upcoming');
  const otherCycles = cycles.filter((c) => c.id !== activeCycle?.id);
  const visibleCycles = showAllCycles ? otherCycles : otherCycles.slice(0, 6);
  const summaryCycleId = selectedMetricsCycleId || metrics?.selectedCycle?.id || activeCycle?.id || null;
  const mutationError = startCycle.error ?? deleteCycle.error;

  const filterModes: Array<{ mode: 'active' | 'backlog' | 'upcoming' | 'all'; label: string }> = [
    { mode: 'active', label: t('cycles.filterActive') },
    { mode: 'backlog', label: t('cycles.filterBacklog', { count: backlogTaskCount }) },
    { mode: 'upcoming', label: t('cycles.filterUpcoming') },
    { mode: 'all', label: t('cycles.filterAll') },
  ];

  return (
    <Card className="space-y-3 p-4" aria-labelledby={headingId} data-testid="project-cycles-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="text-sm font-semibold text-foreground">
            {t('cycles.cycleListTitle')}
          </h3>
          <div role="group" aria-label={t('cycles.filterGroupLabel')} className="flex flex-wrap items-center gap-1.5">
            {filterModes.map((item) => {
              const pressed = cycleFilter.mode === item.mode;
              return (
                <Button
                  key={item.mode}
                  type="button"
                  size="sm"
                  variant={pressed ? 'default' : 'outline'}
                  aria-pressed={pressed}
                  onClick={() => onCycleFilterChange({ mode: item.mode })}
                  className="min-h-11 md:min-h-8"
                  data-testid={`cycle-filter-${item.mode}`}
                >
                  {item.label}
                </Button>
              );
            })}
          </div>
        </div>

        {editable && (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setEditingCycle(null);
              setFormOpen(true);
            }}
            className="min-h-11 gap-1.5 md:min-h-8"
            data-testid="create-cycle-button"
          >
            <ProjectIcon name="plus" className="size-3.5" />
            <span>{t('cycles.createBtn')}</span>
          </Button>
        )}
      </div>

      {mutationError && <ErrorText>{errorMessage(mutationError)}</ErrorText>}
      {cyclesError !== undefined && cyclesError !== null && (
        <Alert className="border-destructive/30 bg-destructive/5" data-testid="cycles-load-error">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
            <span>{t('cycles.cyclesLoadError')}</span>
            {onRetryCycles && (
              <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={onRetryCycles}>
                {t('cycles.retryLoad')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {activeCycle && (
        <div className="rounded-lg border border-border bg-muted/25 p-3" data-testid="active-cycle-card">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="default">{t('cycles.activeCardTitle')}</Badge>
                <span className="text-sm font-semibold text-foreground">
                  {t('cycles.cycleLabel', { number: activeCycle.number, name: activeCycle.name })}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t('cycles.cycleDateRange', { from: f.date(activeCycle.startsOn), to: f.date(activeCycle.endsOn) })}
                </span>
              </div>
              {activeCycle.goal && <p className="text-xs text-muted-foreground">{activeCycle.goal}</p>}
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground tabular-nums">
                <span>
                  {t('cycles.progressSummary', { done: activeCycle.doneTasks, total: activeCycle.totalTasks })}
                </span>
                {pointsEnabled && (
                  <span>
                    {t('cycles.pointsProgressSummary', { done: activeCycle.donePoints, total: activeCycle.totalPoints })}
                  </span>
                )}
              </div>
            </div>

            {editable && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingCycle(activeCycle);
                    setFormOpen(true);
                  }}
                  className="min-h-11 md:min-h-8"
                >
                  {t('cycles.editBtn')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setCompletingCycle(activeCycle)}
                  className="min-h-11 md:min-h-8"
                  data-testid="complete-cycle-button"
                >
                  {t('cycles.completeBtn')}
                </Button>
              </div>
            )}
          </div>

          <div
            role="progressbar"
            aria-label={t('cycles.activeCardTitle')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct(activeCycle.doneTasks, activeCycle.totalTasks)}
            className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct(activeCycle.doneTasks, activeCycle.totalTasks)}%` }}
            />
          </div>
        </div>
      )}

      {cycles.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('cycles.noCyclesEmpty')}</p>
      ) : (
        <div className="space-y-1.5">
          <ul className="space-y-1.5">
            {visibleCycles.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2 text-xs"
                data-testid={`cycle-row-${c.status}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={cycleStatusVariant(c.status)}>{t(`cycles.statusLabels.${c.status}`)}</Badge>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectMetricsCycleId(c.id);
                      onCycleFilterChange({ mode: 'cycle', cycleId: c.id });
                    }}
                    className="min-h-11 rounded text-left font-medium text-foreground hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:min-h-0"
                  >
                    {t('cycles.cycleLabel', { number: c.number, name: c.name })}
                  </button>
                  <span className="text-muted-foreground tabular-nums">
                    {t('cycles.cycleDateRange', { from: f.date(c.startsOn), to: f.date(c.endsOn) })}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {t('cycles.progressSummary', { done: c.doneTasks, total: c.totalTasks })}
                  </span>
                </div>

                {editable && c.status === 'upcoming' && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={activeCycle !== null || startCycle.isPending}
                      onClick={() =>
                        startCycle.mutate({
                          projectId,
                          cycleId: c.id,
                          idempotencyKey: crypto.randomUUID(),
                        })
                      }
                      className="min-h-11 md:min-h-7"
                      data-testid="start-cycle-button"
                    >
                      {t('cycles.startBtn')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingCycle(c);
                        setFormOpen(true);
                      }}
                      className="min-h-11 md:min-h-7"
                    >
                      {t('cycles.editBtn')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeletingCycle(c)}
                      className="min-h-11 text-destructive hover:text-destructive md:min-h-7"
                      data-testid="delete-cycle-button"
                    >
                      {t('cycles.deleteBtn')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {otherCycles.length > 6 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={showAllCycles}
              onClick={() => setShowAllCycles((v) => !v)}
              className="min-h-11 text-xs md:min-h-7"
            >
              {showAllCycles ? t('cycles.showFewerCycles') : t('cycles.showAllCycles', { count: otherCycles.length })}
            </Button>
          )}
        </div>
      )}

      {metricsError !== undefined && metricsError !== null && (
        <Alert className="border-destructive/30 bg-destructive/5" data-testid="cycle-metrics-load-error">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
            <span>{t('cycles.metrics.loadError')}</span>
            {onRetryMetrics && (
              <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={onRetryMetrics}>
                {t('cycles.retryLoad')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {metrics && (
        <CycleMetricsSection
          metrics={metrics}
          cycles={cycles}
          selectedCycleId={selectedMetricsCycleId}
          onSelectCycleId={onSelectMetricsCycleId}
          pointsEnabled={pointsEnabled}
        />
      )}

      {summaryCycleId !== null && (
        <CycleSummaryBlock slug={slug} projectId={projectId} cycleId={summaryCycleId} />
      )}

      <CycleFormDialog
        open={formOpen}
        onOpenChange={(next) => {
          setFormOpen(next);
          if (!next) setEditingCycle(null);
        }}
        projectId={projectId}
        editing={editingCycle}
      />

      <CompleteCycleDialog
        open={completingCycle !== null}
        onOpenChange={(next) => {
          if (!next) setCompletingCycle(null);
        }}
        projectId={projectId}
        cycle={completingCycle}
        upcomingCycles={upcomingCycles}
        onCompleted={() => {
          if (cycleFilter.mode === 'active') onCycleFilterChange({ mode: 'all' });
        }}
      />

      <ConfirmDialog
        open={deletingCycle !== null}
        onOpenChange={(next) => {
          if (!next) setDeletingCycle(null);
        }}
        title={t('cycles.deleteConfirm.title')}
        description={deletingCycle ? t('cycles.deleteConfirm.description', { name: deletingCycle.name }) : ''}
        confirm={t('cycles.deleteConfirm.confirm')}
        cancel={tc('cancel')}
        destructive
        disabled={deleteCycle.isPending}
        onConfirm={() => {
          if (!deletingCycle) return;
          const deletedId = deletingCycle.id;
          deleteCycle.mutate(
            { projectId, cycleId: deletedId, idempotencyKey: crypto.randomUUID() },
            {
              onSuccess: () => {
                setDeletingCycle(null);
                if (cycleFilter.mode === 'cycle' && cycleFilter.cycleId === deletedId) {
                  onCycleFilterChange({ mode: 'all' });
                }
              },
            },
          );
        }}
      />
    </Card>
  );
}
