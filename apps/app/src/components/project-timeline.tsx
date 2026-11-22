// SPDX-License-Identifier: AGPL-3.0-only

import {
  isCalendarDate,
  vietnamToday,
  type ProjectTimeline,
  type ProjectTimelineTask,
} from '@ludy/kernel-contract';
import { Alert, AlertDescription, AlertTitle } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ludy/ui/components/table';
import { cn } from '@ludy/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage } from '../lib/api.ts';
import { taskStatusVariant } from '../lib/projects.ts';
import {
  TIMELINE_ROW_HEIGHT_PX,
  computeCycleBands,
  computeDependencyConnectors,
  computeTimelineBars,
  computeTimelineHeaderBuckets,
  computeTimelineWindow,
  defaultQuickScheduleDates,
  partitionTimelineTasks,
  shiftTaskSchedule,
  taskDueDayVietnam,
  taskDueIsoFromVietnamDay,
  timelineBarKeyDelta,
  timelineDaysBetween,
  type TimelineShiftMode,
  type TimelineZoom,
} from '../lib/project-timeline.ts';
import { taskTitleText } from '../lib/task-title.ts';
import { DateInput } from './date-input.tsx';
import { Empty, ErrorText, FieldError, fieldErrorId } from './ui.tsx';

export interface ProjectTimelineProps {
  slug: string;
  timeline: ProjectTimeline;
  canWrite: boolean;
  savingTaskId: string | null;
  saveError: unknown;
  searchQuery?: string;
  todayOverride?: string;
  onResetSaveError?: () => void;
  onSetTaskDates: (
    input: { taskId: string; startOn: string | null; due: string | null },
    onSuccess?: () => void,
  ) => void;
}

interface TimelineDragState {
  taskId: string;
  mode: TimelineShiftMode;
  startClientX: number;
  deltaDays: number;
}

function TimelineDateDialog({
  task,
  canWrite,
  saving,
  error,
  onClose,
  onSave,
}: {
  task: ProjectTimelineTask;
  canWrite: boolean;
  saving: boolean;
  error: unknown;
  onClose: () => void;
  onSave: (input: { taskId: string; startOn: string | null; due: string | null }) => void;
}) {
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const baseId = useId();
  const startId = `${baseId}-start`;
  const dueId = `${baseId}-due`;
  const rangeErrorId = `${baseId}-range`;

  const taskDueDay = taskDueDayVietnam(task.due) ?? '';
  const [startOn, setStartOn] = useState(() => task.startOn ?? '');
  const [dueDay, setDueDay] = useState(() => taskDueDay);
  const [validationError, setValidationError] = useState<string | null>(null);

  const safeTitle = taskTitleText(task);
  const lockedByAgent = Boolean(task.checkedOut);
  const editable = canWrite && !lockedByAgent && !saving;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite || lockedByAgent) return;
    const cleanStart = startOn.trim();
    const cleanDue = dueDay.trim();

    if ((cleanStart && !isCalendarDate(cleanStart)) || (cleanDue && !isCalendarDate(cleanDue))) {
      setValidationError(t('timeline.invalidDateFormatError'));
      return;
    }
    if (cleanStart && cleanDue && cleanStart > cleanDue) {
      setValidationError(t('timeline.invalidRangeError'));
      return;
    }

    const nextDue =
      cleanDue === ''
        ? null
        : cleanDue === taskDueDay && task.due
          ? task.due
          : taskDueIsoFromVietnamDay(cleanDue);

    setValidationError(null);
    onSave({
      taskId: task.id,
      startOn: cleanStart || null,
      due: nextDue,
    });
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={tc('close')} data-testid="timeline-date-dialog">
        <DialogHeader>
          <DialogTitle>
            {canWrite && !lockedByAgent ? t('timeline.dialogTitle') : t('timeline.viewDialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {canWrite && !lockedByAgent
              ? t('timeline.dialogDescription', { title: safeTitle })
              : t('timeline.viewDialogDescription', { title: safeTitle })}
          </DialogDescription>
        </DialogHeader>

        {lockedByAgent && (
          <Alert className="border-warning/40 bg-warning/10">
            <AlertDescription>{t('timeline.checkedOutNotice')}</AlertDescription>
          </Alert>
        )}

        {!canWrite && (
          <Alert className="border-border bg-muted/40">
            <AlertDescription>{t('timeline.readOnlyNotice')}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={startId}>{t('timeline.startOnLabel')}</Label>
            <DateInput
              id={startId}
              disabled={!editable}
              value={startOn}
              onChange={(next) => {
                setStartOn(next);
                setValidationError(null);
              }}
              aria-invalid={Boolean(validationError) || undefined}
              aria-describedby={validationError ? fieldErrorId(rangeErrorId) : undefined}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={dueId}>{t('timeline.dueLabel')}</Label>
            <DateInput
              id={dueId}
              disabled={!editable}
              value={dueDay}
              onChange={(next) => {
                setDueDay(next);
                setValidationError(null);
              }}
              aria-invalid={Boolean(validationError) || undefined}
              aria-describedby={validationError ? fieldErrorId(rangeErrorId) : undefined}
            />
          </div>

          <FieldError id={rangeErrorId}>{validationError}</FieldError>
          {error !== null && error !== undefined && <ErrorText>{errorMessage(error)}</ErrorText>}

          <DialogFooter className="flex-wrap gap-2">
            {canWrite && !lockedByAgent && (task.startOn !== null || task.due !== null) && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:mr-auto"
                disabled={saving}
                data-testid="timeline-dialog-clear"
                onClick={() => onSave({ taskId: task.id, startOn: null, due: null })}
              >
                {t('timeline.clearDates')}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onClose}
            >
              {t('timeline.cancel')}
            </Button>
            {canWrite && !lockedByAgent && (
              <Button
                type="submit"
                className="min-h-11"
                disabled={saving}
                data-testid="timeline-dialog-save"
              >
                {saving ? t('timeline.savingDates') : t('timeline.saveDates')}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UnscheduledTasksPanel({
  slug,
  tasks,
  canWrite,
  savingTaskId,
  onQuickSchedule,
  onPickDates,
}: {
  slug: string;
  tasks: readonly ProjectTimelineTask[];
  canWrite: boolean;
  savingTaskId: string | null;
  onQuickSchedule: (task: ProjectTimelineTask) => void;
  onPickDates: (task: ProjectTimelineTask) => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');

  if (tasks.length === 0) return null;

  return (
    <section
      aria-labelledby="timeline-unscheduled-heading"
      data-testid="timeline-unscheduled-panel"
      className="rounded-xl border border-border bg-card p-4"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="timeline-unscheduled-heading" className="text-sm font-semibold text-foreground">
            {t('timeline.unscheduledTitle')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('timeline.unscheduledHint')}</p>
        </div>
        <Badge variant="outline">{tasks.length}</Badge>
      </div>

      <ul className="divide-y divide-border">
        {tasks.map((task) => {
          const safeTitle = taskTitleText(task);
          const lockedByAgent = Boolean(task.checkedOut);
          const isSaving = savingTaskId === task.id;
          return (
            <li
              key={task.id}
              data-testid={`timeline-unscheduled-row-${task.id}`}
              className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/o/$slug/tasks/$id"
                    params={{ slug, id: task.id }}
                    className="truncate text-sm font-medium text-foreground hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {safeTitle}
                  </Link>
                  <Badge variant={taskStatusVariant(task.status)}>{tt(`status.${task.status}`)}</Badge>
                  {lockedByAgent && (
                    <Badge variant="warning" className="gap-1">
                      <ProjectIcon name="bot" className="size-3" />
                      <span>{t('timeline.checkedOutTag')}</span>
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {task.assigneeTitle ?? t('timeline.unassigned')}
                </p>
              </div>

              {canWrite && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11 px-3"
                    disabled={lockedByAgent || isSaving}
                    data-testid={`timeline-quick-schedule-${task.id}`}
                    aria-label={t('timeline.quickScheduleOf', { title: safeTitle })}
                    onClick={() => onQuickSchedule(task)}
                  >
                    <ProjectIcon name="calendar" className="mr-1.5 size-3.5" />
                    <span>{t('timeline.quickSchedule')}</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11 px-3"
                    disabled={lockedByAgent || isSaving}
                    data-testid={`timeline-pick-dates-${task.id}`}
                    aria-label={t('timeline.pickDatesOf', { title: safeTitle })}
                    onClick={() => onPickDates(task)}
                  >
                    <ProjectIcon name="edit" className="mr-1.5 size-3.5" />
                    <span>{t('timeline.pickDates')}</span>
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MobileScheduleTable({
  slug,
  tasks,
  conflictTaskIds,
  criticalTaskIds,
  showCriticalPath,
  canWrite,
  savingTaskId,
  onEditDates,
  onQuickSchedule,
}: {
  slug: string;
  tasks: readonly ProjectTimelineTask[];
  conflictTaskIds: ReadonlySet<string>;
  criticalTaskIds: ReadonlySet<string>;
  showCriticalPath: boolean;
  canWrite: boolean;
  savingTaskId: string | null;
  onEditDates: (task: ProjectTimelineTask) => void;
  onQuickSchedule: (task: ProjectTimelineTask) => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const format = useFormat();

  return (
    <div className="md:hidden" data-testid="timeline-mobile-table">
      <Table>
        <caption className="sr-only">{t('timeline.tableCaption')}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('timeline.colTask')}</TableHead>
            <TableHead scope="col">{t('timeline.colStatus')}</TableHead>
            <TableHead scope="col">{t('timeline.colStart')}</TableHead>
            <TableHead scope="col">{t('timeline.colDue')}</TableHead>
            <TableHead scope="col">{t('timeline.colFlags')}</TableHead>
            <TableHead scope="col">{t('timeline.colActions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => {
            const safeTitle = taskTitleText(task);
            const dueDay = taskDueDayVietnam(task.due);
            const isConflict = conflictTaskIds.has(task.id);
            const isCritical = showCriticalPath && criticalTaskIds.has(task.id);
            const isUnscheduled = !task.startOn && !dueDay;
            const lockedByAgent = Boolean(task.checkedOut);
            const isSaving = savingTaskId === task.id;

            return (
              <TableRow key={task.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/o/$slug/tasks/$id"
                    params={{ slug, id: task.id }}
                    className="rounded text-foreground hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {safeTitle}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {task.assigneeTitle ?? t('timeline.unassigned')}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={taskStatusVariant(task.status)}>{tt(`status.${task.status}`)}</Badge>
                </TableCell>
                <TableCell>{task.startOn ? format.date(task.startOn) : t('timeline.noDate')}</TableCell>
                <TableCell>{dueDay ? format.date(dueDay) : t('timeline.noDate')}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {isConflict && <Badge variant="destructive">{t('timeline.conflictTag')}</Badge>}
                    {isCritical && <Badge variant="warning">{t('timeline.criticalTag')}</Badge>}
                    {lockedByAgent && <Badge variant="warning">{t('timeline.checkedOutTag')}</Badge>}
                  </div>
                </TableCell>
                <TableCell>
                  {canWrite ? (
                    <div className="flex flex-wrap gap-1.5">
                      {isUnscheduled && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="min-h-11 px-3"
                          disabled={lockedByAgent || isSaving}
                          aria-label={t('timeline.quickScheduleOf', { title: safeTitle })}
                          onClick={() => onQuickSchedule(task)}
                        >
                          {t('timeline.quickSchedule')}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-11 px-3"
                        disabled={lockedByAgent || isSaving}
                        aria-label={t('timeline.pickDatesOf', { title: safeTitle })}
                        onClick={() => onEditDates(task)}
                      >
                        {t('timeline.editDates')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-h-11 px-3"
                      aria-label={t('timeline.viewDatesOf', { title: safeTitle })}
                      onClick={() => onEditDates(task)}
                    >
                      {t('timeline.viewDates')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function ProjectTimelineView({
  slug,
  timeline,
  canWrite,
  savingTaskId,
  saveError,
  searchQuery = '',
  todayOverride,
  onResetSaveError,
  onSetTaskDates,
}: ProjectTimelineProps) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const format = useFormat();
  const rawLocale = useLocale();
  const locale: 'vi' | 'en' = rawLocale.startsWith('vi') ? 'vi' : 'en';
  const arrowIdBase = useId();

  const [zoom, setZoom] = useState<TimelineZoom>('week');
  const [showCriticalPath, setShowCriticalPath] = useState(true);
  const [unscheduledOpen, setUnscheduledOpen] = useState(true);
  const [localSearch, setLocalSearch] = useState('');
  const [editingTask, setEditingTask] = useState<ProjectTimelineTask | null>(null);
  const [dragState, setDragState] = useState<TimelineDragState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const didDragRef = useRef(false);

  const today =
    todayOverride && isCalendarDate(todayOverride)
      ? todayOverride
      : isCalendarDate(timeline.today)
        ? timeline.today
        : vietnamToday();
  const cycles = timeline.cycles ?? [];
  const effectiveSearch = searchQuery.trim() ? searchQuery : localSearch;

  const { filtered, scheduled, unscheduled } = useMemo(
    () => partitionTimelineTasks(timeline.tasks, effectiveSearch),
    [timeline.tasks, effectiveSearch],
  );

  const visibleTaskIds = useMemo(() => new Set(filtered.map((task) => task.id)), [filtered]);
  const taskById = useMemo(() => {
    const map = new Map<string, ProjectTimelineTask>();
    for (const task of filtered) map.set(task.id, task);
    return map;
  }, [filtered]);

  const visibleEdges = useMemo(
    () =>
      timeline.edges.filter(
        (edge) => visibleTaskIds.has(edge.blockerTaskId) && visibleTaskIds.has(edge.blockedTaskId),
      ),
    [timeline.edges, visibleTaskIds],
  );

  const visibleConflicts = useMemo(
    () =>
      timeline.conflicts.filter(
        (conflict) =>
          visibleTaskIds.has(conflict.blockerTaskId) && visibleTaskIds.has(conflict.blockedTaskId),
      ),
    [timeline.conflicts, visibleTaskIds],
  );

  const conflictTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const conflict of visibleConflicts) {
      ids.add(conflict.blockerTaskId);
      ids.add(conflict.blockedTaskId);
    }
    return ids;
  }, [visibleConflicts]);

  const criticalTaskIds = useMemo(
    () => new Set(timeline.criticalPathTaskIds),
    [timeline.criticalPathTaskIds],
  );

  const window = useMemo(
    () => computeTimelineWindow(scheduled, cycles, today, zoom),
    [scheduled, cycles, today, zoom],
  );

  const buckets = useMemo(
    () => computeTimelineHeaderBuckets(window, zoom, locale),
    [window, zoom, locale],
  );

  const bars = useMemo(
    () => computeTimelineBars(scheduled, window, visibleConflicts, timeline.criticalPathTaskIds),
    [scheduled, window, visibleConflicts, timeline.criticalPathTaskIds],
  );

  const cycleBands = useMemo(
    () => computeCycleBands(cycles, window),
    [cycles, window],
  );

  const connectors = useMemo(
    () =>
      computeDependencyConnectors(
        bars,
        visibleEdges,
        visibleConflicts,
        timeline.criticalPathTaskIds,
      ),
    [bars, visibleEdges, visibleConflicts, timeline.criticalPathTaskIds],
  );

  const bodyHeightPx = Math.max(TIMELINE_ROW_HEIGHT_PX, bars.length * TIMELINE_ROW_HEIGHT_PX);

  const commitQuickSchedule = (task: ProjectTimelineTask) => {
    const dates = defaultQuickScheduleDates(today);
    const safeTitle = taskTitleText(task);
    onSetTaskDates({ taskId: task.id, ...dates }, () => {
      setAnnouncement(
        t('timeline.movedAnnouncement', {
          title: safeTitle,
          start: format.date(dates.startOn),
          end: format.date(today),
        }),
      );
    });
  };

  const commitShiftedSchedule = (
    task: ProjectTimelineTask,
    mode: TimelineShiftMode,
    deltaDays: number,
  ) => {
    if (deltaDays === 0) return;
    const next = shiftTaskSchedule(task, mode, deltaDays);
    const safeTitle = taskTitleText(task);
    const startLabel = next.startOn
      ? format.date(next.startOn)
      : format.date(taskDueDayVietnam(next.due));
    const endLabel = format.date(taskDueDayVietnam(next.due) ?? next.startOn);

    onSetTaskDates({ taskId: task.id, ...next }, () => {
      setAnnouncement(
        t('timeline.movedAnnouncement', {
          title: safeTitle,
          start: startLabel,
          end: endLabel,
        }),
      );
    });
  };

  const syncedEditingTask = useMemo(() => {
    if (!editingTask) return null;
    return timeline.tasks.find((item) => item.id === editingTask.id) ?? editingTask;
  }, [editingTask, timeline.tasks]);

  const normalMarkerId = `${arrowIdBase}-arrow-normal`;
  const criticalMarkerId = `${arrowIdBase}-arrow-critical`;
  const conflictMarkerId = `${arrowIdBase}-arrow-conflict`;

  return (
    <div className="space-y-4" data-testid="project-timeline-view">
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {/* Controls toolbar */}
      <div
        role="toolbar"
        aria-label={t('timeline.ganttRegionLabel')}
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
      >
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t('timeline.zoomLabel')}
            className="inline-flex rounded-lg border border-border bg-muted/40 p-1"
          >
            <Button
              type="button"
              size="sm"
              variant={zoom === 'week' ? 'default' : 'ghost'}
              className="min-h-11 px-3"
              aria-pressed={zoom === 'week'}
              data-testid="timeline-zoom-week"
              onClick={() => setZoom('week')}
            >
              {t('timeline.zoomWeek')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={zoom === 'month' ? 'default' : 'ghost'}
              className="min-h-11 px-3"
              aria-pressed={zoom === 'month'}
              data-testid="timeline-zoom-month"
              onClick={() => setZoom('month')}
            >
              {t('timeline.zoomMonth')}
            </Button>
          </div>

          <Button
            type="button"
            size="sm"
            variant={showCriticalPath ? 'default' : 'outline'}
            className="min-h-11 gap-2 px-3"
            aria-pressed={showCriticalPath}
            data-testid="timeline-critical-path-toggle"
            onClick={() => setShowCriticalPath((prev) => !prev)}
          >
            <span>{t('timeline.criticalPathToggle')}</span>
            {timeline.criticalPathLength > 0 && (
              <Badge variant={showCriticalPath ? 'secondary' : 'outline'}>
                {timeline.criticalPathLength}
              </Badge>
            )}
          </Button>

          <Button
            type="button"
            size="sm"
            variant={unscheduledOpen ? 'secondary' : 'outline'}
            className="min-h-11 gap-2 px-3"
            aria-expanded={unscheduledOpen}
            data-testid="timeline-unscheduled-toggle"
            onClick={() => setUnscheduledOpen((prev) => !prev)}
          >
            <span>{t('timeline.unscheduledToggle', { count: String(unscheduled.length) })}</span>
          </Button>

          {!searchQuery.trim() && (
            <Input
              type="search"
              data-testid="timeline-search-input"
              aria-label={t('timeline.searchLabel')}
              placeholder={t('timeline.searchLabel')}
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              className="min-h-11 w-full text-xs sm:min-h-9 sm:w-56"
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {timeline.criticalPathLength > 0 ? (
            <Badge variant="warning" data-testid="timeline-critical-summary">
              {t('timeline.criticalPathSummary', {
                count: timeline.criticalPathTaskIds.length,
                days: String(timeline.criticalPathSpanDays),
              })}
            </Badge>
          ) : (
            <span>{t('timeline.criticalPathEmpty')}</span>
          )}
          {visibleConflicts.length > 0 && (
            <Badge variant="destructive" data-testid="timeline-conflict-count-badge">
              {t('timeline.conflictsSummary', { count: visibleConflicts.length })}
            </Badge>
          )}
        </div>
      </div>

      {!canWrite && (
        <Alert className="border-border bg-muted/40">
          <AlertDescription>{t('timeline.readOnlyNotice')}</AlertDescription>
        </Alert>
      )}

      {timeline.truncated && (
        <p className="text-xs text-muted-foreground">
          {t('timeline.truncated', { count: String(timeline.tasks.length) })}
        </p>
      )}

      {saveError !== null && saveError !== undefined && <ErrorText>{errorMessage(saveError)}</ErrorText>}

      {visibleConflicts.length > 0 && (
        <Alert
          variant="destructive"
          className="border-destructive/30 bg-destructive/10"
          data-testid="timeline-conflicts-alert"
        >
          <AlertTitle>
            {t('timeline.conflictsSummary', { count: visibleConflicts.length })}
          </AlertTitle>
          <AlertDescription>
            <p className="mb-1.5">{t('timeline.conflictHint')}</p>
            <ul className="list-disc space-y-1 pl-4 text-xs">
              {visibleConflicts.slice(0, 5).map((conflict) => {
                const blocker = taskById.get(conflict.blockerTaskId);
                const blocked = taskById.get(conflict.blockedTaskId);
                return (
                  <li key={conflict.dependencyId}>
                    {t('timeline.conflictEdgeLabel', {
                      blocker: blocker ? taskTitleText(blocker) : conflict.blockerTaskId,
                      blockerEnd: format.date(conflict.blockerDueDate),
                      blocked: blocked ? taskTitleText(blocked) : conflict.blockedTaskId,
                      blockedStart: format.date(conflict.blockedTargetDate),
                    })}
                  </li>
                );
              })}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {cycles.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-testid="timeline-cycles-legend"
        >
          <span className="font-medium text-foreground">{t('timeline.cyclesHeading')}:</span>
          {cycles.map((cycle) => (
            <Badge key={cycle.id} variant="outline">
              {t('timeline.cycleBandLabel', {
                name: cycle.name,
                start: format.date(cycle.startsOn),
                end: format.date(cycle.endsOn),
              })}
            </Badge>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <Empty title={t('timeline.noTasks')} />
      ) : (
        <>
          {scheduled.length === 0 ? (
            <Empty title={t('timeline.noScheduledTasks')} />
          ) : (
            <>
              {/* Desktop Gantt canvas */}
              <section
                aria-label={t('timeline.ganttRegionLabel')}
                data-testid="timeline-gantt-canvas"
                className="hidden overflow-hidden rounded-xl border border-border bg-card md:block"
              >
                <div className="flex">
                  {/* Left task list column */}
                  <div className="w-64 shrink-0 border-r border-border bg-card">
                    <div className="flex h-11 items-center border-b border-border px-3 text-xs font-semibold text-muted-foreground">
                      <span>{t('timeline.colTask')}</span>
                    </div>
                    {bars.map((bar) => {
                      const safeTitle = taskTitleText(bar.task);
                      const isCritical = showCriticalPath && bar.isCritical;
                      return (
                        <div
                          key={bar.task.id}
                          style={{ height: `${TIMELINE_ROW_HEIGHT_PX}px` }}
                          className="flex items-center justify-between gap-2 border-b border-border/60 px-3 last:border-b-0"
                        >
                          <div className="min-w-0 flex-1">
                            <Link
                              to="/o/$slug/tasks/$id"
                              params={{ slug, id: bar.task.id }}
                              className="block truncate text-sm font-medium text-foreground hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            >
                              {safeTitle}
                            </Link>
                            <div className="truncate text-xs text-muted-foreground">
                              {bar.task.assigneeTitle ?? t('timeline.unassigned')}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {bar.hasConflict && (
                              <Badge variant="destructive">{t('timeline.conflictTag')}</Badge>
                            )}
                            {!bar.hasConflict && isCritical && (
                              <Badge variant="warning">{t('timeline.criticalTag')}</Badge>
                            )}
                            {bar.task.checkedOut && (
                              <Badge variant="warning">{t('timeline.checkedOutTag')}</Badge>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Right scrollable timeline canvas */}
                  <div className="min-w-0 flex-1 overflow-x-auto">
                    <div style={{ width: `${window.totalWidthPx}px` }}>
                      {/* Scale header */}
                      <div className="relative h-11 border-b border-border bg-muted/40">
                        {buckets.map((bucket) => (
                          <div
                            key={bucket.key}
                            style={{ left: `${bucket.leftPx}px`, width: `${bucket.widthPx}px` }}
                            className="absolute inset-y-0 flex items-center border-l border-border/60 px-2 text-xs font-medium text-muted-foreground first:border-l-0"
                          >
                            {bucket.label}
                          </div>
                        ))}
                        <div
                          style={{ left: `${window.todayOffsetPx}px` }}
                          className="pointer-events-none absolute top-1 -translate-x-1/2"
                        >
                          <Badge variant="default" className="h-5 px-1.5 text-xs">
                            {t('timeline.todayMarker')}
                          </Badge>
                        </div>
                      </div>

                      {/* Grid body: cycle bands + today line + SVG dependency connectors + task bars */}
                      <div
                        className="relative"
                        style={{
                          width: `${window.totalWidthPx}px`,
                          height: `${bodyHeightPx}px`,
                        }}
                      >
                        {/* Bucket grid lines */}
                        {buckets.map((bucket) => (
                          <div
                            key={bucket.key}
                            aria-hidden="true"
                            style={{ left: `${bucket.leftPx}px`, width: `${bucket.widthPx}px` }}
                            className="pointer-events-none absolute inset-y-0 border-l border-border/40 first:border-l-0"
                          />
                        ))}

                        {/* Cycle bands (#4361 compatible) */}
                        {cycleBands.map((band) => (
                          <div
                            key={band.cycle.id}
                            aria-hidden="true"
                            data-testid={`timeline-cycle-band-${band.cycle.id}`}
                            style={{ left: `${band.leftPx}px`, width: `${band.widthPx}px` }}
                            className="pointer-events-none absolute inset-y-0 border-x border-primary/20 bg-primary/5"
                          />
                        ))}

                        {/* Row horizontal dividers */}
                        {bars.map((bar) => (
                          <div
                            key={`divider-${bar.task.id}`}
                            aria-hidden="true"
                            style={{
                              top: `${bar.rowIndex * TIMELINE_ROW_HEIGHT_PX}px`,
                              height: `${TIMELINE_ROW_HEIGHT_PX}px`,
                            }}
                            className="pointer-events-none absolute inset-x-0 border-b border-border/40 last:border-b-0"
                          />
                        ))}

                        {/* Today vertical marker */}
                        <div
                          aria-hidden="true"
                          data-testid="timeline-today-marker"
                          style={{ left: `${window.todayOffsetPx}px` }}
                          className="pointer-events-none absolute inset-y-0 z-10 border-l-2 border-primary"
                        />

                        {/* SVG dependency connectors (#2601) */}
                        <svg
                          data-testid="timeline-dependency-svg"
                          role="img"
                          aria-label={t('timeline.dependencyGroupLabel')}
                          width={window.totalWidthPx}
                          height={bodyHeightPx}
                          viewBox={`0 0 ${window.totalWidthPx} ${bodyHeightPx}`}
                          className="pointer-events-none absolute inset-0 z-10 overflow-visible"
                        >
                          <defs>
                            <marker
                              id={normalMarkerId}
                              viewBox="0 0 10 10"
                              refX="8"
                              refY="5"
                              markerWidth="6"
                              markerHeight="6"
                              orient="auto-start-reverse"
                              className="text-muted-foreground"
                            >
                              <path d="M 0 1 L 10 5 L 0 9 z" fill="currentColor" />
                            </marker>
                            <marker
                              id={criticalMarkerId}
                              viewBox="0 0 10 10"
                              refX="8"
                              refY="5"
                              markerWidth="6"
                              markerHeight="6"
                              orient="auto-start-reverse"
                              className="text-warning"
                            >
                              <path d="M 0 1 L 10 5 L 0 9 z" fill="currentColor" />
                            </marker>
                            <marker
                              id={conflictMarkerId}
                              viewBox="0 0 10 10"
                              refX="8"
                              refY="5"
                              markerWidth="6"
                              markerHeight="6"
                              orient="auto-start-reverse"
                              className="text-destructive"
                            >
                              <path d="M 0 1 L 10 5 L 0 9 z" fill="currentColor" />
                            </marker>
                          </defs>
                          {connectors.map((connector) => {
                            const isCritical = showCriticalPath && connector.isCritical;
                            const strokeClass = connector.isConflict
                              ? 'text-destructive'
                              : isCritical
                                ? 'text-warning'
                                : 'text-muted-foreground';
                            const markerUrl = connector.isConflict
                              ? `url(#${conflictMarkerId})`
                              : isCritical
                                ? `url(#${criticalMarkerId})`
                                : `url(#${normalMarkerId})`;
                            return (
                              <path
                                key={connector.edge.id}
                                data-testid={`timeline-connector-${connector.edge.id}`}
                                data-conflict={connector.isConflict ? 'true' : undefined}
                                data-critical={isCritical ? 'true' : undefined}
                                d={connector.path}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={connector.isConflict || isCritical ? 2 : 1.5}
                                markerEnd={markerUrl}
                                className={strokeClass}
                              />
                            );
                          })}
                        </svg>

                        {/* Interactive task bars */}
                        {bars.map((bar) => {
                          const safeTitle = taskTitleText(bar.task);
                          const isCritical = showCriticalPath && bar.isCritical;
                          const isDone = bar.task.status === 'done' || bar.task.status === 'cancelled';
                          const lockedByAgent = Boolean(bar.task.checkedOut);
                          const canDragOrKeyEdit =
                            canWrite && !lockedByAgent && savingTaskId !== bar.task.id;

                          const activeDrag =
                            dragState && dragState.taskId === bar.task.id ? dragState : null;
                          let previewLeftPx = bar.leftPx;
                          let previewWidthPx = bar.widthPx;
                          if (activeDrag && activeDrag.deltaDays !== 0) {
                            const preview = shiftTaskSchedule(
                              bar.task,
                              activeDrag.mode,
                              activeDrag.deltaDays,
                            );
                            const pStart =
                              preview.startOn ??
                              taskDueDayVietnam(preview.due) ??
                              bar.span.start;
                            const pEnd = taskDueDayVietnam(preview.due) ?? preview.startOn ?? bar.span.end;
                            const pStartDays = timelineDaysBetween(window.start, pStart);
                            const pSpanDays = Math.max(1, timelineDaysBetween(pStart, pEnd) + 1);
                            previewLeftPx = pStartDays * window.dayWidthPx;
                            previewWidthPx = Math.max(window.dayWidthPx, pSpanDays * window.dayWidthPx);
                          }

                          const barToneClass = bar.hasConflict
                            ? 'border-destructive bg-destructive/15 text-foreground'
                            : isCritical
                              ? 'border-warning bg-warning/15 text-foreground ring-1 ring-warning/40'
                              : isDone
                                ? 'border-border bg-muted text-muted-foreground'
                                : 'border-primary/40 bg-primary/15 text-foreground hover:bg-primary/20';

                          const startFormatted = format.date(bar.span.start);
                          const endFormatted = format.date(bar.span.end);
                          const statusText = tt(`status.${bar.task.status}`);
                          const baseBarAriaLabel =
                            bar.span.start === bar.span.end
                              ? t('timeline.taskSingleDateLabel', {
                                  title: safeTitle,
                                  status: statusText,
                                  date: startFormatted,
                                })
                              : t('timeline.taskBarLabel', {
                                  title: safeTitle,
                                  status: statusText,
                                  start: startFormatted,
                                  end: endFormatted,
                                });
                          const accessSuffix = lockedByAgent
                            ? `, ${t('timeline.checkedOutTag')}`
                            : !canWrite
                              ? `, ${t('timeline.readOnlyTag')}`
                              : '';
                          const barAriaLabel = `${baseBarAriaLabel}${accessSuffix}`;

                          return (
                            <div
                              key={bar.task.id}
                              style={{
                                top: `${bar.rowIndex * TIMELINE_ROW_HEIGHT_PX + 4}px`,
                                left: `${previewLeftPx}px`,
                                width: `${previewWidthPx}px`,
                              }}
                              className="absolute z-20 flex items-center"
                            >
                              <button
                                type="button"
                                data-testid={`timeline-bar-${bar.task.id}`}
                                data-conflict={bar.hasConflict ? 'true' : undefined}
                                data-critical={isCritical ? 'true' : undefined}
                                aria-label={barAriaLabel}
                                onClick={() => {
                                  if (didDragRef.current) {
                                    didDragRef.current = false;
                                    return;
                                  }
                                  setEditingTask(bar.task);
                                }}
                                onKeyDown={(e) => {
                                  const delta = timelineBarKeyDelta(e.key, e.shiftKey);
                                  if (delta === null) return;
                                  e.preventDefault();
                                  if (!canDragOrKeyEdit) return;
                                  commitShiftedSchedule(bar.task, 'move', delta);
                                }}
                                onPointerDown={(e) => {
                                  if (!canDragOrKeyEdit || e.button !== 0) return;
                                  const target = e.target as HTMLElement | null;
                                  const edgeAttr = target?.dataset?.resizeEdge;
                                  const mode: TimelineShiftMode =
                                    edgeAttr === 'start'
                                      ? 'resize-start'
                                      : edgeAttr === 'end'
                                        ? 'resize-end'
                                        : 'move';
                                  didDragRef.current = false;
                                  e.currentTarget.setPointerCapture?.(e.pointerId);
                                  setDragState({
                                    taskId: bar.task.id,
                                    mode,
                                    startClientX: e.clientX,
                                    deltaDays: 0,
                                  });
                                }}
                                onPointerMove={(e) => {
                                  if (!dragState || dragState.taskId !== bar.task.id) return;
                                  const nextDelta = Math.round(
                                    (e.clientX - dragState.startClientX) / window.dayWidthPx,
                                  );
                                  if (nextDelta !== 0) {
                                    didDragRef.current = true;
                                  }
                                  if (nextDelta !== dragState.deltaDays) {
                                    setDragState({ ...dragState, deltaDays: nextDelta });
                                  }
                                }}
                                onPointerUp={(e) => {
                                  if (!dragState || dragState.taskId !== bar.task.id) return;
                                  const finalDelta = Math.round(
                                    (e.clientX - dragState.startClientX) / window.dayWidthPx,
                                  );
                                  const finalMode = dragState.mode;
                                  setDragState(null);
                                  if (finalDelta !== 0) {
                                    commitShiftedSchedule(bar.task, finalMode, finalDelta);
                                  }
                                }}
                                onPointerCancel={() => {
                                  didDragRef.current = false;
                                  if (dragState?.taskId === bar.task.id) {
                                    setDragState(null);
                                  }
                                }}
                                className={cn(
                                  'group relative flex min-h-11 w-full items-center justify-between gap-1.5 overflow-hidden rounded-md border px-2 text-left text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                                  canDragOrKeyEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                                  barToneClass,
                                )}
                              >
                                {canDragOrKeyEdit && previewWidthPx >= 36 && (
                                  <span
                                    aria-hidden="true"
                                    data-resize-edge="start"
                                    title={t('timeline.dragHandleStart', { title: safeTitle })}
                                    className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-transparent group-hover:bg-foreground/10"
                                  />
                                )}
                                <span className="truncate">{safeTitle}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {bar.span.start === bar.span.end
                                    ? startFormatted
                                    : `${startFormatted} / ${endFormatted}`}
                                </span>
                                {canDragOrKeyEdit && previewWidthPx >= 36 && (
                                  <span
                                    aria-hidden="true"
                                    data-resize-edge="end"
                                    title={t('timeline.dragHandleEnd', { title: safeTitle })}
                                    className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-transparent group-hover:bg-foreground/10"
                                  />
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="border-t border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {t('timeline.keyboardHint')}
                </div>
              </section>
            </>
          )}

          {/* Mobile (< 768 px) & screen-reader semantic schedule table */}
          <MobileScheduleTable
            slug={slug}
            tasks={filtered}
            conflictTaskIds={conflictTaskIds}
            criticalTaskIds={criticalTaskIds}
            showCriticalPath={showCriticalPath}
            canWrite={canWrite}
            savingTaskId={savingTaskId}
            onEditDates={setEditingTask}
            onQuickSchedule={commitQuickSchedule}
          />
        </>
      )}

      {unscheduledOpen && (
        <UnscheduledTasksPanel
          slug={slug}
          tasks={unscheduled}
          canWrite={canWrite}
          savingTaskId={savingTaskId}
          onQuickSchedule={commitQuickSchedule}
          onPickDates={setEditingTask}
        />
      )}

      {syncedEditingTask && (
        <TimelineDateDialog
          key={syncedEditingTask.id}
          task={syncedEditingTask}
          canWrite={canWrite}
          saving={savingTaskId === syncedEditingTask.id}
          error={saveError}
          onClose={() => {
            onResetSaveError?.();
            setEditingTask(null);
          }}
          onSave={(input) => {
            const targetTask = syncedEditingTask;
            onSetTaskDates(input, () => {
              const safeTitle = taskTitleText(targetTask);
              if (!input.startOn && !input.due) {
                setAnnouncement(t('timeline.datesClearedAnnouncement', { title: safeTitle }));
              } else {
                const startText = format.date(input.startOn ?? taskDueDayVietnam(input.due));
                const endText = format.date(taskDueDayVietnam(input.due) ?? input.startOn);
                setAnnouncement(
                  t('timeline.movedAnnouncement', {
                    title: safeTitle,
                    start: startText,
                    end: endText,
                  }),
                );
              }
              setEditingTask(null);
            });
          }}
        />
      )}
    </div>
  );
}
