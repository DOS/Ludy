// SPDX-License-Identifier: AGPL-3.0-only
// Kanban board and responsive compact list view for a project (#2591, ADR-0048).
import {
  PROJECT_TASK_STORY_POINTS_MAX,
  PROJECT_TASK_STORY_POINTS_MIN,
  type ProjectColumn,
  type ProjectSeat,
  type ProjectTaskCard,
  type TaskChecklistStep,
} from '@ludy/kernel-contract';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput } from './date-input.tsx';
import { TaskChecklistBadge, TaskChecklistEditor, hasBlankChecklistStep, normalizeChecklistSteps } from './task-checklist.tsx';
import { Empty } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { TASK_STATUSES, taskDueFromDay, type TaskStatus } from '../lib/agents.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import {
  COLUMN_COLOR_DOT_CLASS,
  groupBoardTasksByColumn,
  isTaskOverdue,
  resolveBoardColumnId,
  taskStatusVariant,
  type BoardBucket,
  type ProjectViewMode,
  type TaskPlacement,
} from '../lib/projects.ts';
import { seatOptionLabel } from './project-task-dialog.tsx';
import { shouldConfirmBlockedStatusMove } from './project-dependencies.tsx';
import { formatRecurrenceBadgeLabel } from './task-recurrence-control.tsx';
import { taskTitleText } from '../lib/task-title.ts';

export type BoardColumnStatus = 'todo' | 'in_progress' | 'waiting' | 'in_review' | 'done';

const COLUMN_DOT_CLASS: Record<TaskStatus, string> = {
  todo: 'bg-muted-foreground/50',
  in_progress: 'bg-primary',
  waiting: 'bg-warning',
  in_review: 'bg-proposal',
  done: 'bg-success',
  cancelled: 'bg-muted-foreground/30',
};

function seatDisplay(
  assigneePositionId: string | null,
  seats: readonly ProjectSeat[],
  rootLabel: string,
  unknownLabel: string,
): { label: string; isAgent: boolean } {
  if (assigneePositionId === null) return { label: rootLabel, isAgent: false };
  const seat = seats.find((s) => s.id === assigneePositionId);
  if (!seat) return { label: unknownLabel, isAgent: false };
  if (seat.holder?.type === 'agent') {
    const who = seat.holder.name?.trim();
    return { label: who ? `${seat.title} · ${who}` : seat.title, isAgent: true };
  }
  if (seat.holder?.type === 'user') {
    const who = seat.holder.displayName?.trim() || seat.holder.email?.trim();
    return { label: who ? `${seat.title} · ${who}` : seat.title, isAgent: false };
  }
  return { label: seat.title, isAgent: false };
}

function QuickAddTask({
  status,
  columnId,
  seats,
  busy,
  onCreate,
}: {
  status: BoardColumnStatus;
  columnId?: string | undefined;
  seats: readonly ProjectSeat[];
  busy: boolean;
  onCreate: (
    input: { title: string; assigneePositionId: string | null; due?: string; checklist?: TaskChecklistStep[]; status: BoardColumnStatus; columnId?: string },
    done: () => void,
  ) => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [checklist, setChecklist] = useState<TaskChecklistStep[]>([]);
  const [stepError, setStepError] = useState(false);
  const [resetCount, setResetCount] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const reset = () => {
    setOpen(false);
    setTitle('');
    setAssignee('');
    setDueOn('');
    setChecklist([]);
    setStepError(false);
    setResetCount((n) => n + 1);
    setShowMore(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    if (hasBlankChecklistStep(checklist)) {
      setShowMore(true);
      setStepError(true);
      return;
    }
    const due = taskDueFromDay(dueOn, browserTimeZone());
    const nextChecklist = normalizeChecklistSteps(checklist);
    onCreate(
      {
        title: trimmed,
        assigneePositionId: assignee || null,
        ...(due ? { due } : {}),
        ...(nextChecklist.length > 0 ? { checklist: nextChecklist } : {}),
        status,
        ...(columnId ? { columnId } : {}),
      },
      () => {
        setTitle('');
        setDueOn('');
        setAssignee('');
        setChecklist([]);
        setStepError(false);
        setResetCount((n) => n + 1);
        setOpen(false);
        setShowMore(false);
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      reset();
    }
  };

  if (!open) {
    return (
      <button
        ref={triggerRef}
        type="button"
        data-testid={columnId ? `quick-add-column-${columnId}` : `quick-add-${status}`}
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-8"
      >
        <ProjectIcon name="plus" className="size-3.5" />
        <span>{t('board.quickAddTrigger')}</span>
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={onKeyDown}
      data-testid={columnId ? `quick-add-form-column-${columnId}` : `quick-add-form-${status}`}
      className="space-y-2 rounded-lg border border-primary/40 bg-card p-2.5"
    >
      <Input
        autoFocus
        required
        maxLength={300}
        aria-label={t('modals.taskTitleLabel')}
        placeholder={t('board.quickAddPlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="h-9 text-sm md:h-8"
      />
      {showMore && (
        <div className="grid gap-2">
          <NativeSelect
            aria-label={t('board.quickAddAssignee')}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="h-9 w-full text-xs md:h-8"
          >
            <NativeSelectOption value="">{tt('rootAssignee')}</NativeSelectOption>
            {seats
              .filter((s) => s.status !== 'archived')
              .map((seat) => (
                <NativeSelectOption key={seat.id} value={seat.id}>
                  {seatOptionLabel(seat, t('modals.aiSeatSuffix'), t('modals.openSeatSuffix'))}
                </NativeSelectOption>
              ))}
          </NativeSelect>
          <DateInput
            value={dueOn}
            onChange={setDueOn}
            aria-label={t('board.quickAddDue')}
            className="text-xs"
          />
          <TaskChecklistEditor
            key={resetCount}
            idPrefix={columnId ? `quick-add-${columnId}` : `quick-add-${status}`}
            label={t('modals.taskChecklistLabel')}
            value={checklist}
            stepError={stepError}
            onChange={(next) => {
              setChecklist(next);
              if (stepError && !hasBlankChecklistStep(next)) setStepError(false);
            }}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <button
          type="button"
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
          className="inline-flex min-h-8 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ProjectIcon name="filters" className="size-3.5" />
          <span>{showMore ? t('board.quickAddHideOptions') : t('board.quickAddDue')}</span>
        </button>
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={reset}>
            {t('board.quickAddCancel')}
          </Button>
          <Button type="submit" size="sm" loading={busy} disabled={!title.trim()}>
            {t('board.quickAddSubmit')}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function parseStoryPointsDraft(
  draft: string,
  badInput: boolean,
): { valid: true; value: number | null } | { valid: false } {
  if (badInput) return { valid: false };
  const trimmed = draft.trim();
  if (trimmed === '') return { valid: true, value: null };
  const parsed = Number(trimmed);
  if (
    Number.isInteger(parsed) &&
    parsed >= PROJECT_TASK_STORY_POINTS_MIN &&
    parsed <= PROJECT_TASK_STORY_POINTS_MAX
  ) {
    return { valid: true, value: parsed };
  }
  return { valid: false };
}

function StoryPointsChip({
  task,
  pointsEnabled,
  canEdit,
  onSetTaskPoints,
}: {
  task: ProjectTaskCard;
  pointsEnabled: boolean;
  canEdit: boolean;
  onSetTaskPoints?: ((taskId: string, storyPoints: number | null) => void) | undefined;
}) {
  const t = useTranslations('projects');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  const editable = pointsEnabled && canEdit && !task.checkedOut && onSetTaskPoints !== undefined;
  const hasPoints = task.storyPoints !== null && task.storyPoints !== undefined;
  const label = hasPoints ? t('cycles.pointsChip', { points: task.storyPoints! }) : t('cycles.setPointsShort');

  useEffect(() => {
    if (!editable) {
      restoreFocusRef.current = false;
      setEditing(false);
      setDraft('');
      setInvalid(false);
    }
  }, [editable]);

  useEffect(() => {
    if (!editing && editable && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [editing, editable]);

  if (!pointsEnabled) return null;

  if (!editable) {
    if (!hasPoints) return null;
    return (
      <Badge variant="outline" className="h-5 px-1.5 text-[11px] tabular-nums" data-testid="task-points-badge">
        {label}
      </Badge>
    );
  }

  if (!editing) {
    return (
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setDraft(hasPoints ? String(task.storyPoints) : '');
          setInvalid(false);
          setEditing(true);
        }}
        aria-label={`${t('cycles.pointsInputLabel')}: ${label}`}
        data-testid="task-points-trigger"
        className="inline-flex min-h-11 items-center rounded-md border border-border bg-muted/40 px-2 text-[11px] font-medium text-foreground tabular-nums hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:min-h-6"
      >
        {label}
      </button>
    );
  }

  const commit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const badInput = Boolean(e.currentTarget.querySelector('input')?.validity.badInput);
    const parsed = parseStoryPointsDraft(draft, badInput);
    if (!parsed.valid) {
      setInvalid(true);
      return;
    }
    restoreFocusRef.current = true;
    setInvalid(false);
    onSetTaskPoints(task.id, parsed.value);
    setEditing(false);
  };

  return (
    <form
      noValidate
      onSubmit={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e: KeyboardEvent<HTMLFormElement>) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          restoreFocusRef.current = true;
          setInvalid(false);
          setEditing(false);
        }
      }}
      className="inline-flex flex-wrap items-center gap-1"
      data-testid="task-points-editor"
    >
      <Input
        type="number"
        min={PROJECT_TASK_STORY_POINTS_MIN}
        max={PROJECT_TASK_STORY_POINTS_MAX}
        step={1}
        inputMode="numeric"
        autoFocus
        aria-label={t('cycles.pointsInputLabel')}
        aria-invalid={invalid || undefined}
        placeholder={t('cycles.pointsPlaceholder')}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (invalid) setInvalid(false);
        }}
        className="h-11 w-16 px-2 text-xs md:h-7"
      />
      <Button type="submit" size="sm" variant="outline" className="min-h-11 px-2 text-xs md:min-h-7">
        {t('cycles.pointsSave')}
      </Button>
      {invalid && (
        <span role="alert" className="text-[11px] text-destructive">
          {t('cycles.pointsPlaceholder')}
        </span>
      )}
    </form>
  );
}

function TaskMetaBadges({
  task,
  seats,
  pointsEnabled = false,
  cyclesEnabled = false,
  githubEnabled = false,
  cycleName,
  canEdit = false,
  onSetTaskPoints,
}: {
  task: ProjectTaskCard;
  seats: readonly ProjectSeat[];
  pointsEnabled?: boolean;
  cyclesEnabled?: boolean;
  githubEnabled?: boolean;
  cycleName?: string | undefined;
  canEdit?: boolean;
  onSetTaskPoints?: ((taskId: string, storyPoints: number | null) => void) | undefined;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const f = useFormat();
  const seat = seatDisplay(task.assigneePositionId, seats, tt('rootAssignee'), tt('unknownPosition'));
  const overdue = isTaskOverdue(task);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
        {seat.isAgent ? <ProjectIcon name="bot" className="size-3 text-primary" /> : <ProjectIcon name="user" className="size-3 text-muted-foreground" />}
        <span className="truncate">{seat.label}</span>
      </span>
      {cyclesEnabled && cycleName && (
        <Badge variant="outline" className="h-5 px-1.5 text-[11px]" data-testid="task-cycle-badge">
          {cycleName}
        </Badge>
      )}
      <StoryPointsChip task={task} pointsEnabled={pointsEnabled} canEdit={canEdit} onSetTaskPoints={onSetTaskPoints} />
      {task.due && (
        <Badge variant={overdue ? 'destructive' : 'outline'} className="h-5 gap-1 px-1.5 text-[11px] tabular-nums">
          <ProjectIcon name="calendar" className="size-3" />
          <span>{overdue ? `${t('task.overdue')} · ${f.date(task.due)}` : f.date(task.due)}</span>
        </Badge>
      )}
      {task.recurrence && (
        <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[11px]" data-testid="task-recurrence-badge">
          <ProjectIcon name="repeat" className="size-3" />
          <span>{formatRecurrenceBadgeLabel(task.recurrence, t)}</span>
        </Badge>
      )}
      {task.tainted && (
        <Badge variant="warning" className="h-5 px-1.5 text-[11px]" title={t('task.taintedHint')}>
          {t('task.tainted')}
        </Badge>
      )}
      {task.checkedOut && (
        <Badge variant="brand" className="h-5 gap-1 px-1.5 text-[11px]" title={t('task.checkedOutLocked')}>
          <ProjectIcon name="bot" className="size-3" />
          <span>{t('task.checkedOut')}</span>
        </Badge>
      )}
      <TaskChecklistBadge steps={task.checklist ?? []} />
      {(task.openBlockerCount ?? 0) > 0 && (
        <Badge variant="warning" className="h-5 gap-1 px-1.5 text-[11px] tabular-nums" data-testid="task-blocked-by-badge">
          <ProjectIcon name="link" className="size-3" />
          <span>{t('dependencies.cardBlockedByBadge', { count: task.openBlockerCount ?? 0 })}</span>
        </Badge>
      )}
      {(task.blockingCount ?? 0) > 0 && (
        <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[11px] tabular-nums" data-testid="task-blocking-badge">
          <ProjectIcon name="arrowUp" className="size-3" />
          <span>{t('dependencies.cardBlockingBadge', { count: task.blockingCount ?? 0 })}</span>
        </Badge>
      )}
      {task.commentCount > 0 && (
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          <NavIcon name="comments" className="size-3" />
          <span>{task.commentCount}</span>
        </span>
      )}
      {githubEnabled && (task.githubLinkCount ?? 0) > 0 && (
        <Badge
          variant="outline"
          className="h-5 gap-1 px-1.5 text-[11px] tabular-nums"
          data-testid="task-github-link-count"
        >
          <ProjectIcon name="link" className="size-3" />
          <span>{t('github.cardLinksBadge', { count: task.githubLinkCount ?? 0 })}</span>
        </Badge>
      )}
    </div>
  );
}

function focusSiblingAfterBoundaryMove(button: HTMLButtonElement, direction: 'up' | 'down'): void {
  const sibling = direction === 'up' ? button.nextElementSibling : button.previousElementSibling;
  if (sibling instanceof HTMLButtonElement) {
    requestAnimationFrame(() => sibling.focus());
  }
}

function dropPlaceForCard(
  e: DragEvent<HTMLElement>,
  sameColumn: boolean,
  draggingIndex: number,
  targetIndex: number,
): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
  if (ratio < 0.35) return 'before';
  if (ratio > 0.65) return 'after';
  if (sameColumn && draggingIndex >= 0 && targetIndex >= 0) {
    return draggingIndex > targetIndex ? 'before' : 'after';
  }
  return ratio < 0.5 ? 'before' : 'after';
}

function TaskBoardCard({
  slug,
  task,
  seats,
  customColumns,
  canEdit,
  pointsEnabled,
  cyclesEnabled,
  githubEnabled,
  cycleName,
  dragging,
  dropEdge,
  canMoveUp,
  canMoveDown,
  isSecondInColumn,
  isSecondToLastInColumn,
  customSortActive,
  showReorder,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onDropOnCard,
  onMoveUp,
  onMoveDown,
  onMoveStatus,
  onMoveColumn,
  onSetTaskPoints,
  onEdit,
  onRemove,
}: {
  slug: string;
  task: ProjectTaskCard;
  seats: readonly ProjectSeat[];
  customColumns: readonly ProjectColumn[];
  canEdit: boolean;
  pointsEnabled: boolean;
  cyclesEnabled: boolean;
  githubEnabled: boolean;
  cycleName?: string | undefined;
  dragging: boolean;
  dropEdge: 'before' | 'after' | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  isSecondInColumn: boolean;
  isSecondToLastInColumn: boolean;
  customSortActive: boolean;
  showReorder: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: (e: DragEvent<HTMLLIElement>) => void;
  onDropOnCard: (e: DragEvent<HTMLLIElement>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveStatus: (taskId: string, nextStatus: TaskStatus) => void;
  onMoveColumn?: ((taskId: string, column: ProjectColumn) => void) | undefined;
  onSetTaskPoints?: ((taskId: string, storyPoints: number | null) => void) | undefined;
  onEdit: (task: ProjectTaskCard) => void;
  onRemove: (task: ProjectTaskCard) => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const draggable = canEdit && !task.checkedOut;
  const resolvedColumnId = resolveBoardColumnId(customColumns, task);
  const dropRing =
    dropEdge === 'before'
      ? 'border-t-2 border-t-primary ring-1 ring-primary/25'
      : dropEdge === 'after'
        ? 'border-b-2 border-b-primary ring-1 ring-primary/25'
        : '';

  return (
    <li
      data-testid="project-task-card"
      data-task-id={task.id}
      data-task-status={task.status}
      data-column-id={resolvedColumnId ?? undefined}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOverCard}
      onDrop={onDropOnCard}
      className={`group rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/25 ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${dragging ? 'opacity-40' : ''} ${dropRing}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {githubEnabled && task.taskKey && (
            <Badge
              variant="outline"
              className="h-5 shrink-0 px-1.5 font-mono text-[11px]"
              data-testid="task-github-key"
            >
              {task.taskKey}
            </Badge>
          )}
          <Link
            to="/o/$slug/tasks/$id"
            params={{ slug, id: task.id }}
            draggable={false}
            className="min-w-0 break-words rounded text-sm leading-snug font-medium text-foreground hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {taskTitleText(task)}
          </Link>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-0.5">
            {showReorder && (
              <>
                <button
                  type="button"
                  disabled={!canMoveUp}
                  onClick={(e) => {
                    if (isSecondInColumn) focusSiblingAfterBoundaryMove(e.currentTarget, 'up');
                    onMoveUp();
                  }}
                  aria-label={t('task.moveUpOf', { title: taskTitleText(task) })}
                  title={customSortActive ? t('task.reorderDisabledBySort') : t('task.moveUp')}
                  data-testid="move-task-up"
                  className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                >
                  <ProjectIcon name="arrowUp" className="size-3.5" />
                </button>
                <button
                  type="button"
                  disabled={!canMoveDown}
                  onClick={(e) => {
                    if (isSecondToLastInColumn) focusSiblingAfterBoundaryMove(e.currentTarget, 'down');
                    onMoveDown();
                  }}
                  aria-label={t('task.moveDownOf', { title: taskTitleText(task) })}
                  title={customSortActive ? t('task.reorderDisabledBySort') : t('task.moveDown')}
                  data-testid="move-task-down"
                  className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                >
                  <ProjectIcon name="arrowDown" className="size-3.5" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => onEdit(task)}
              aria-label={t('task.editTaskOf', { title: taskTitleText(task) })}
              className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ProjectIcon name="edit" className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onRemove(task)}
              aria-label={t('task.removeFromProjectOf', { title: taskTitleText(task) })}
              className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ProjectIcon name="unlink" className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="mt-2.5">
        <TaskMetaBadges
          task={task}
          seats={seats}
          pointsEnabled={pointsEnabled}
          cyclesEnabled={cyclesEnabled}
          githubEnabled={githubEnabled}
          cycleName={cycleName}
          canEdit={canEdit}
          onSetTaskPoints={onSetTaskPoints}
        />
      </div>

      {canEdit && (
        <div className="mt-2.5 border-t border-border/60 pt-2">
          {customColumns.length > 0 && onMoveColumn ? (
            <NativeSelect
              aria-label={t('task.changeColumnOf', { title: taskTitleText(task) })}
              data-testid="card-column-switcher"
              disabled={task.checkedOut}
              value={task.status === 'cancelled' ? '__cancelled__' : (resolvedColumnId ?? `__unmapped__:${task.status}`)}
              onChange={(e) => {
                const next = e.target.value;
                if (next === '__cancelled__') {
                  onMoveStatus(task.id, 'cancelled');
                  return;
                }
                const target = customColumns.find((col) => col.id === next);
                if (target) onMoveColumn(task.id, target);
              }}
              className="w-full [&_select]:min-h-11 [&_select]:text-xs"
            >
              {resolvedColumnId === null && task.status !== 'cancelled' && (
                <NativeSelectOption value={`__unmapped__:${task.status}`} disabled>
                  {tt(`status.${task.status}`)}
                </NativeSelectOption>
              )}
              {customColumns.map((col) => (
                <NativeSelectOption key={col.id} value={col.id}>
                  {col.name}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value="__cancelled__">{tt('status.cancelled')}</NativeSelectOption>
            </NativeSelect>
          ) : (
            <NativeSelect
              aria-label={t('task.changeStatusOf', { title: taskTitleText(task) })}
              disabled={task.checkedOut}
              value={task.status}
              onChange={(e) => onMoveStatus(task.id, e.target.value as TaskStatus)}
              className="h-8 w-full text-xs"
            >
              {TASK_STATUSES.map((st) => (
                <NativeSelectOption key={st} value={st}>
                  {tt(`status.${st}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </div>
      )}
    </li>
  );
}

function bucketKeyOfTask(task: ProjectTaskCard, customColumns: readonly ProjectColumn[]): string {
  if (customColumns.length === 0 || task.status === 'cancelled') return task.status;
  return resolveBoardColumnId(customColumns, task) ?? task.status;
}

export function ProjectBoardView({
  slug,
  view,
  tasks,
  seats,
  columns: customColumnsProp,
  canEdit,
  includeCancelled,
  creatingTask,
  customSortActive = false,
  cyclesEnabled = false,
  pointsEnabled = false,
  githubEnabled = false,
  cycleNamesById,
  onSetTaskPoints,
  onMoveStatus,
  onMoveColumn,
  onReorderTask,
  onCreateTask,
  onEditTask,
  onRemoveTask,
}: {
  slug: string;
  view: ProjectViewMode;
  tasks: readonly ProjectTaskCard[];
  seats: readonly ProjectSeat[];
  columns?: readonly ProjectColumn[] | undefined;
  canEdit: boolean;
  includeCancelled: boolean;
  creatingTask: boolean;
  customSortActive?: boolean;
  cyclesEnabled?: boolean;
  pointsEnabled?: boolean;
  githubEnabled?: boolean;
  cycleNamesById?: ReadonlyMap<string, string>;
  onSetTaskPoints?: ((taskId: string, storyPoints: number | null) => void) | undefined;
  onMoveStatus: (taskId: string, nextStatus: TaskStatus, placement?: TaskPlacement) => void;
  onMoveColumn?: ((taskId: string, column: ProjectColumn, placement?: TaskPlacement) => void) | undefined;
  onReorderTask?: (taskId: string, placement: TaskPlacement) => void;
  onCreateTask: (
    input: { title: string; assigneePositionId: string | null; due?: string; checklist?: TaskChecklistStep[]; status: BoardColumnStatus; columnId?: string },
    done: () => void,
  ) => void;
  onEditTask: (task: ProjectTaskCard) => void;
  onRemoveTask: (taskId: string) => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const f = useFormat();

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overBucketKey, setOverBucketKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ anchorId: string; place: 'before' | 'after' } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProjectTaskCard | null>(null);
  const [pendingBlockedMove, setPendingBlockedMove] = useState<{
    task: ProjectTaskCard;
    nextStatus: TaskStatus;
    column?: ProjectColumn | undefined;
    placement?: TaskPlacement | undefined;
  } | null>(null);

  const customColumns = customColumnsProp ?? [];
  const hasCustomColumns = customColumns.length > 0;
  const buckets = groupBoardTasksByColumn(tasks, customColumns, includeCancelled);
  const listTasks = includeCancelled ? tasks : tasks.filter((item) => item.status !== 'cancelled');
  const showReorder = canEdit && onReorderTask !== undefined;

  const requestMoveStatus = (taskId: string, nextStatus: TaskStatus, placement?: TaskPlacement) => {
    const targetTask = tasks.find((item) => item.id === taskId);
    if (targetTask && shouldConfirmBlockedStatusMove(targetTask.status, nextStatus, targetTask.openBlockerCount ?? 0)) {
      setPendingBlockedMove({ task: targetTask, nextStatus, placement });
      return;
    }
    onMoveStatus(taskId, nextStatus, placement);
  };

  const requestMoveColumn = (taskId: string, column: ProjectColumn, placement?: TaskPlacement) => {
    if (!onMoveColumn) {
      requestMoveStatus(taskId, column.taskStatus, placement);
      return;
    }
    const targetTask = tasks.find((item) => item.id === taskId);
    if (targetTask && shouldConfirmBlockedStatusMove(targetTask.status, column.taskStatus, targetTask.openBlockerCount ?? 0)) {
      setPendingBlockedMove({ task: targetTask, nextStatus: column.taskStatus, column, placement });
      return;
    }
    onMoveColumn(taskId, column, placement);
  };

  const clearDrag = () => {
    setDraggingId(null);
    setOverBucketKey(null);
    setDropTarget(null);
  };

  const moveAcrossBuckets = (taskId: string, bucket: BoardBucket, placement?: TaskPlacement) => {
    if (bucket.kind === 'custom' && onMoveColumn) {
      requestMoveColumn(taskId, bucket.column, placement);
      return;
    }
    const nextStatus = bucket.kind === 'canonical' ? bucket.status : bucket.column.taskStatus;
    requestMoveStatus(taskId, nextStatus, placement);
  };

  const handleDropOnBucket = (e: DragEvent<HTMLElement>, bucket: BoardBucket) => {
    e.preventDefault();
    const droppedId = e.dataTransfer.getData('text/plain') || draggingId;
    clearDrag();
    if (!canEdit || !droppedId) return;
    const task = tasks.find((item) => item.id === droppedId);
    if (!task) return;
    const currentKey = bucketKeyOfTask(task, customColumns);
    if (currentKey === bucket.key) {
      if (!customSortActive && onReorderTask) {
        const items = bucket.tasks;
        const last = items[items.length - 1];
        if (last && last.id !== droppedId) {
          onReorderTask(droppedId, { place: 'after', anchorId: last.id });
        }
      }
      return;
    }
    if (task.checkedOut) return;
    moveAcrossBuckets(droppedId, bucket);
  };

  const handleDragOverCard = (e: DragEvent<HTMLLIElement>, targetTask: ProjectTaskCard, targetIndex: number, targetBucket: BoardBucket) => {
    if (!canEdit || !draggingId || draggingId === targetTask.id) return;
    const draggingTask = tasks.find((item) => item.id === draggingId);
    if (!draggingTask) return;
    const draggingKey = bucketKeyOfTask(draggingTask, customColumns);
    const sameColumn = draggingKey === targetBucket.key;
    if (sameColumn && (customSortActive || !onReorderTask)) return;
    if (!sameColumn && draggingTask.checkedOut) return;
    const columnItems = targetBucket.tasks;
    const draggingIndex = sameColumn ? columnItems.findIndex((item) => item.id === draggingId) : -1;
    const place = dropPlaceForCard(e, sameColumn, draggingIndex, targetIndex);
    e.preventDefault();
    e.stopPropagation();
    setOverBucketKey((cur) => (cur === targetBucket.key ? cur : targetBucket.key));
    setDropTarget((cur) => (cur?.anchorId === targetTask.id && cur.place === place ? cur : { anchorId: targetTask.id, place }));
  };

  const handleDropOnCard = (e: DragEvent<HTMLLIElement>, targetTask: ProjectTaskCard, targetIndex: number, targetBucket: BoardBucket) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedId = e.dataTransfer.getData('text/plain') || draggingId;
    clearDrag();
    if (!canEdit || !droppedId || droppedId === targetTask.id) return;
    const droppedTask = tasks.find((item) => item.id === droppedId);
    if (!droppedTask) return;
    const droppedKey = bucketKeyOfTask(droppedTask, customColumns);
    const sameColumn = droppedKey === targetBucket.key;
    const columnItems = targetBucket.tasks;
    const draggingIndex = sameColumn ? columnItems.findIndex((item) => item.id === droppedId) : -1;
    const place = dropPlaceForCard(e, sameColumn, draggingIndex, targetIndex);
    if (sameColumn) {
      if (customSortActive || !onReorderTask) return;
      if (place === 'before' && columnItems[targetIndex - 1]?.id === droppedId) return;
      if (place === 'after' && columnItems[targetIndex + 1]?.id === droppedId) return;
      onReorderTask(droppedId, { place, anchorId: targetTask.id });
      return;
    }
    if (droppedTask.checkedOut) return;
    moveAcrossBuckets(droppedId, targetBucket, !customSortActive && onReorderTask ? { place, anchorId: targetTask.id } : undefined);
  };

  return (
    <>
      {confirmRemove && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirmRemove(null);
          }}
          destructive
          title={t('task.removeConfirmTitle')}
          description={t('task.removeConfirmDesc', { title: taskTitleText(confirmRemove) })}
          confirm={t('task.removeConfirmBtn')}
          onConfirm={() => {
            onRemoveTask(confirmRemove.id);
            setConfirmRemove(null);
          }}
        />
      )}
      {pendingBlockedMove && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setPendingBlockedMove(null);
          }}
          title={t('dependencies.moveBlockedTitle')}
          description={t('dependencies.moveBlockedDesc', {
            title: taskTitleText(pendingBlockedMove.task),
            count: pendingBlockedMove.task.openBlockerCount ?? 0,
          })}
          confirm={t('dependencies.moveBlockedConfirm')}
          onConfirm={() => {
            if (pendingBlockedMove.column && onMoveColumn) {
              onMoveColumn(pendingBlockedMove.task.id, pendingBlockedMove.column, pendingBlockedMove.placement);
            } else {
              onMoveStatus(
                pendingBlockedMove.task.id,
                pendingBlockedMove.nextStatus,
                pendingBlockedMove.placement,
              );
            }
            setPendingBlockedMove(null);
          }}
        />
      )}

      {canEdit && customSortActive && (
        <p className="text-xs text-muted-foreground" data-testid="reorder-disabled-hint">
          {t('task.reorderDisabledHint')}
        </p>
      )}

      {view === 'board' ? (
        <div
          data-testid="project-board"
          className={
            hasCustomColumns
              ? 'flex gap-3 overflow-x-auto pb-2'
              : `grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${buckets.length === 6 ? '2xl:grid-cols-6' : '2xl:grid-cols-5'}`
          }
        >
          {buckets.map((bucket) => {
            const items = bucket.tasks;
            const isOver = overBucketKey === bucket.key;
            const isCustom = bucket.kind === 'custom';
            const status = isCustom ? bucket.column.taskStatus : bucket.status;
            const title = isCustom ? bucket.column.name : tt(`status.${bucket.status}`);
            const dotClass = isCustom ? COLUMN_COLOR_DOT_CLASS[bucket.column.color] : COLUMN_DOT_CLASS[bucket.status];
            const wipLimit = isCustom ? bucket.column.wipLimit : null;
            const overWip = wipLimit !== null && items.length > wipLimit;
            const quickAddStatus: BoardColumnStatus | null = status === 'cancelled' ? null : status;
            const quickAddColumnId = isCustom ? bucket.column.id : undefined;

            return (
              <section
                key={bucket.key}
                aria-label={t('board.columnLabel', { status: title })}
                data-testid="project-column"
                data-column-id={isCustom ? bucket.column.id : undefined}
                data-status={status}
                onDragEnter={(e) => {
                  if (canEdit) e.preventDefault();
                }}
                onDragOver={(e) => {
                  if (!canEdit) return;
                  e.preventDefault();
                  setOverBucketKey((cur) => (cur === bucket.key ? cur : bucket.key));
                  setDropTarget((cur) => (cur ? null : cur));
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setOverBucketKey((cur) => (cur === bucket.key ? null : cur));
                  }
                }}
                onDrop={(e) => handleDropOnBucket(e, bucket)}
                className={`flex min-w-0 flex-col rounded-xl border bg-muted/35 p-2.5 transition-colors ${
                  hasCustomColumns ? 'w-72 shrink-0 md:w-80' : ''
                } ${
                  isOver
                    ? 'border-primary/60 bg-primary/5 ring-2 ring-primary/30'
                    : overWip
                      ? 'border-warning/60'
                      : 'border-border'
                }`}
              >
                <header className="mb-2.5 flex items-center justify-between gap-2 px-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
                    <h2
                      className="truncate text-xs font-semibold text-foreground"
                      title={isCustom ? `${title} · ${tt(`status.${status}`)}` : title}
                    >
                      {title}
                    </h2>
                  </div>
                  {wipLimit !== null ? (
                    <Badge
                      variant={overWip ? 'warning' : 'outline'}
                      data-testid={overWip ? 'column-wip-exceeded' : 'column-wip-count'}
                      aria-label={
                        overWip
                          ? t('board.wipExceededLabel', { count: String(items.length), limit: String(wipLimit) })
                          : t('board.wipCountLabel', { count: String(items.length), limit: String(wipLimit) })
                      }
                      className="h-5 shrink-0 px-1.5 text-[11px] tabular-nums"
                    >
                      {overWip
                        ? t('board.wipExceededText', { count: String(items.length), limit: String(wipLimit) })
                        : t('board.wipBadge', { count: String(items.length), limit: String(wipLimit) })}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[11px] tabular-nums">
                      {items.length}
                    </Badge>
                  )}
                </header>

                <ul className="space-y-2" aria-label={title}>
                  {items.length === 0 ? (
                    <li className="rounded-lg border border-dashed border-border/70 px-3 py-5 text-center text-xs text-muted-foreground">
                      {t('board.emptyColumn')}
                    </li>
                  ) : (
                    items.map((task, idx) => {
                      const prev = idx > 0 ? items[idx - 1] : undefined;
                      const next = idx < items.length - 1 ? items[idx + 1] : undefined;
                      return (
                        <TaskBoardCard
                          key={task.id}
                          slug={slug}
                          task={task}
                          seats={seats}
                          customColumns={customColumns}
                          canEdit={canEdit}
                          pointsEnabled={pointsEnabled}
                          cyclesEnabled={cyclesEnabled}
                          githubEnabled={githubEnabled}
                          cycleName={task.cycleId ? cycleNamesById?.get(task.cycleId) : undefined}
                          dragging={draggingId === task.id}
                          dropEdge={dropTarget?.anchorId === task.id ? dropTarget.place : null}
                          canMoveUp={!customSortActive && prev !== undefined}
                          canMoveDown={!customSortActive && next !== undefined}
                          isSecondInColumn={idx === 1}
                          isSecondToLastInColumn={idx === items.length - 2}
                          customSortActive={customSortActive}
                          showReorder={showReorder}
                          onDragStart={() => setDraggingId(task.id)}
                          onDragEnd={clearDrag}
                          onDragOverCard={(e) => handleDragOverCard(e, task, idx, bucket)}
                          onDropOnCard={(e) => handleDropOnCard(e, task, idx, bucket)}
                          onMoveUp={() => {
                            if (!customSortActive && onReorderTask && prev) {
                              onReorderTask(task.id, { place: 'before', anchorId: prev.id });
                            }
                          }}
                          onMoveDown={() => {
                            if (!customSortActive && onReorderTask && next) {
                              onReorderTask(task.id, { place: 'after', anchorId: next.id });
                            }
                          }}
                          onMoveStatus={(taskId, nextStatus) => requestMoveStatus(taskId, nextStatus)}
                          onMoveColumn={onMoveColumn ? (taskId, col) => requestMoveColumn(taskId, col) : undefined}
                          onSetTaskPoints={onSetTaskPoints}
                          onEdit={onEditTask}
                          onRemove={setConfirmRemove}
                        />
                      );
                    })
                  )}
                </ul>

                {canEdit && quickAddStatus && (
                  <div className="mt-2 pt-1">
                    <QuickAddTask
                      status={quickAddStatus}
                      columnId={quickAddColumnId}
                      seats={seats}
                      busy={creatingTask}
                      onCreate={onCreateTask}
                    />
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3" data-testid="project-list">
          {canEdit && (
            <div className="rounded-xl border border-border bg-muted/35 p-2">
              <QuickAddTask status="todo" seats={seats} busy={creatingTask} onCreate={onCreateTask} />
            </div>
          )}

          {listTasks.length === 0 ? (
            <Empty title={t('detail.emptyBoard')} hint={t('detail.emptyBoardHint')} />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {listTasks.map((task, idx) => {
                const seat = seatDisplay(task.assigneePositionId, seats, tt('rootAssignee'), tt('unknownPosition'));
                const overdue = isTaskOverdue(task);
                const prev = idx > 0 ? listTasks[idx - 1] : undefined;
                const next = idx < listTasks.length - 1 ? listTasks[idx + 1] : undefined;
                return (
                  <li
                    key={task.id}
                    data-testid="project-list-row"
                    data-task-id={task.id}
                    className="flex flex-col gap-2.5 p-3.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  >
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {(() => {
                          const listDotColId = hasCustomColumns ? resolveBoardColumnId(customColumns, task) : null;
                          const listDotCol = listDotColId ? customColumns.find((c) => c.id === listDotColId) : undefined;
                          const dot = listDotCol ? COLUMN_COLOR_DOT_CLASS[listDotCol.color] : COLUMN_DOT_CLASS[task.status];
                          return <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />;
                        })()}
                        <Link
                          to="/o/$slug/tasks/$id"
                          params={{ slug, id: task.id }}
                          className="min-w-0 break-words rounded text-sm font-medium text-foreground hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {taskTitleText(task)}
                        </Link>
                        {githubEnabled && task.taskKey && (
                          <Badge variant="outline" className="h-5 px-1.5 font-mono text-[11px]" data-testid="task-github-key">
                            {task.taskKey}
                          </Badge>
                        )}
                        {task.tainted && (
                          <Badge variant="warning" className="h-5 px-1.5 text-[11px]" title={t('task.taintedHint')}>
                            {t('task.tainted')}
                          </Badge>
                        )}
                        {task.checkedOut && (
                          <Badge variant="brand" className="h-5 gap-1 px-1.5 text-[11px]" title={t('task.checkedOutLocked')}>
                            <ProjectIcon name="bot" className="size-3" />
                            <span>{t('task.checkedOut')}</span>
                          </Badge>
                        )}
                        {task.recurrence && (
                          <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[11px]" data-testid="task-recurrence-badge">
                            <ProjectIcon name="repeat" className="size-3" />
                            <span>{formatRecurrenceBadgeLabel(task.recurrence, t)}</span>
                          </Badge>
                        )}
                        {(task.openBlockerCount ?? 0) > 0 && (
                          <Badge variant="warning" className="h-5 gap-1 px-1.5 text-[11px] tabular-nums" data-testid="task-blocked-by-badge">
                            <ProjectIcon name="link" className="size-3" />
                            <span>{t('dependencies.cardBlockedByBadge', { count: task.openBlockerCount ?? 0 })}</span>
                          </Badge>
                        )}
                        {(task.blockingCount ?? 0) > 0 && (
                          <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[11px] tabular-nums" data-testid="task-blocking-badge">
                            <ProjectIcon name="arrowUp" className="size-3" />
                            <span>{t('dependencies.cardBlockingBadge', { count: task.blockingCount ?? 0 })}</span>
                          </Badge>
                        )}
                        {cyclesEnabled && task.cycleId && cycleNamesById?.get(task.cycleId) && (
                          <Badge variant="outline" className="h-5 px-1.5 text-[11px]" data-testid="task-cycle-badge">
                            {cycleNamesById.get(task.cycleId)}
                          </Badge>
                        )}
                        <StoryPointsChip
                          task={task}
                          pointsEnabled={pointsEnabled}
                          canEdit={canEdit}
                          onSetTaskPoints={onSetTaskPoints}
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          {seat.isAgent ? <ProjectIcon name="bot" className="size-3.5 text-primary" /> : <ProjectIcon name="user" className="size-3.5" />}
                          <span>{seat.label}</span>
                        </span>
                        {task.due && (
                          <span className={`inline-flex items-center gap-1 tabular-nums ${overdue ? 'font-medium text-destructive' : ''}`}>
                            <ProjectIcon name="calendar" className="size-3.5" />
                            <span>{overdue ? `${t('task.overdue')} · ${f.date(task.due)}` : f.date(task.due)}</span>
                          </span>
                        )}
                        <TaskChecklistBadge steps={task.checklist ?? []} className="inline-flex items-center gap-1 tabular-nums" />
                        {task.commentCount > 0 && (
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <NavIcon name="comments" className="size-3.5" />
                            <span>{t('task.commentsCount', { count: String(task.commentCount) })}</span>
                          </span>
                        )}
                        {githubEnabled && (task.githubLinkCount ?? 0) > 0 && (
                          <Badge
                            variant="outline"
                            className="h-5 gap-1 px-1.5 text-[11px] tabular-nums"
                            data-testid="task-github-link-count"
                          >
                            <ProjectIcon name="link" className="size-3" />
                            <span>{t('github.cardLinksBadge', { count: task.githubLinkCount ?? 0 })}</span>
                          </Badge>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                      {(() => {
                        const listColId = hasCustomColumns ? resolveBoardColumnId(customColumns, task) : null;
                        const listCol = listColId ? customColumns.find((c) => c.id === listColId) : undefined;
                        if (canEdit) {
                          if (hasCustomColumns && onMoveColumn) {
                            return (
                              <NativeSelect
                                aria-label={t('task.changeColumnOf', { title: taskTitleText(task) })}
                                disabled={task.checkedOut}
                                value={task.status === 'cancelled' ? '__cancelled__' : (listColId ?? `__unmapped__:${task.status}`)}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  if (next === '__cancelled__') {
                                    requestMoveStatus(task.id, 'cancelled');
                                    return;
                                  }
                                  const target = customColumns.find((col) => col.id === next);
                                  if (target) requestMoveColumn(task.id, target);
                                }}
                                className="min-w-36 [&_select]:min-h-11 [&_select]:text-xs"
                              >
                                {listColId === null && task.status !== 'cancelled' && (
                                  <NativeSelectOption value={`__unmapped__:${task.status}`} disabled>
                                    {tt(`status.${task.status}`)}
                                  </NativeSelectOption>
                                )}
                                {customColumns.map((col) => (
                                  <NativeSelectOption key={col.id} value={col.id}>
                                    {col.name}
                                  </NativeSelectOption>
                                ))}
                                <NativeSelectOption value="__cancelled__">{tt('status.cancelled')}</NativeSelectOption>
                              </NativeSelect>
                            );
                          }
                          return (
                            <NativeSelect
                              aria-label={t('task.changeStatusOf', { title: taskTitleText(task) })}
                              disabled={task.checkedOut}
                              value={task.status}
                              onChange={(e) => requestMoveStatus(task.id, e.target.value as TaskStatus)}
                              className="h-10 min-w-32 text-xs sm:h-8"
                            >
                              {TASK_STATUSES.map((st) => (
                                <NativeSelectOption key={st} value={st}>
                                  {tt(`status.${st}`)}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          );
                        }
                        return <Badge variant={taskStatusVariant(task.status)}>{listCol ? listCol.name : tt(`status.${task.status}`)}</Badge>;
                      })()}
                      {canEdit && (
                        <div className="flex items-center gap-1">
                          {showReorder && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={customSortActive || prev === undefined}
                                aria-label={t('task.moveUpOf', { title: taskTitleText(task) })}
                                title={customSortActive ? t('task.reorderDisabledBySort') : t('task.moveUp')}
                                data-testid="move-task-up"
                                onClick={(e) => {
                                  if (!customSortActive && onReorderTask && prev) {
                                    if (idx === 1) focusSiblingAfterBoundaryMove(e.currentTarget, 'up');
                                    onReorderTask(task.id, { place: 'before', anchorId: prev.id });
                                  }
                                }}
                              >
                                <ProjectIcon name="arrowUp" />
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={customSortActive || next === undefined}
                                aria-label={t('task.moveDownOf', { title: taskTitleText(task) })}
                                title={customSortActive ? t('task.reorderDisabledBySort') : t('task.moveDown')}
                                data-testid="move-task-down"
                                onClick={(e) => {
                                  if (!customSortActive && onReorderTask && next) {
                                    if (idx === listTasks.length - 2) focusSiblingAfterBoundaryMove(e.currentTarget, 'down');
                                    onReorderTask(task.id, { place: 'after', anchorId: next.id });
                                  }
                                }}
                              >
                                <ProjectIcon name="arrowDown" />
                              </Button>
                            </>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={t('task.editTaskOf', { title: taskTitleText(task) })}
                            onClick={() => onEditTask(task)}
                          >
                            <ProjectIcon name="edit" />
                            <span className="sr-only sm:not-sr-only">{t('task.editAction')}</span>
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={t('task.removeFromProjectOf', { title: taskTitleText(task) })}
                            onClick={() => setConfirmRemove(task)}
                          >
                            <ProjectIcon name="unlink" />
                            <span className="sr-only sm:not-sr-only">{t('task.removeAction')}</span>
                          </Button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
