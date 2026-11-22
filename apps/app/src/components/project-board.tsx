// SPDX-License-Identifier: AGPL-3.0-only
// Kanban board and responsive compact list view for a project (#2591, ADR-0048).
import type { ProjectSeat, ProjectTaskCard, TaskChecklistStep } from '@ludy/kernel-contract';
import { Link } from '@tanstack/react-router';
import { useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
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
  boardColumns,
  groupBoardTasks,
  isTaskOverdue,
  taskStatusVariant,
  type ProjectViewMode,
  type TaskPlacement,
} from '../lib/projects.ts';
import { seatOptionLabel } from './project-task-dialog.tsx';
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
  seats,
  busy,
  onCreate,
}: {
  status: BoardColumnStatus;
  seats: readonly ProjectSeat[];
  busy: boolean;
  onCreate: (input: { title: string; assigneePositionId: string | null; due?: string; checklist?: TaskChecklistStep[]; status: BoardColumnStatus }, done: () => void) => void;
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
        data-testid={`quick-add-${status}`}
        onClick={() => setOpen(true)}
        className="flex min-h-10 w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-8"
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
      data-testid={`quick-add-form-${status}`}
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
            idPrefix={`quick-add-${status}`}
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

function TaskMetaBadges({
  task,
  seats,
}: {
  task: ProjectTaskCard;
  seats: readonly ProjectSeat[];
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
      {task.commentCount > 0 && (
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          <NavIcon name="comments" className="size-3" />
          <span>{task.commentCount}</span>
        </span>
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
  canEdit,
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
  onEdit,
  onRemove,
}: {
  slug: string;
  task: ProjectTaskCard;
  seats: readonly ProjectSeat[];
  canEdit: boolean;
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
  onEdit: (task: ProjectTaskCard) => void;
  onRemove: (task: ProjectTaskCard) => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const draggable = canEdit && !task.checkedOut;
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
        <Link
          to="/o/$slug/tasks/$id"
          params={{ slug, id: task.id }}
          draggable={false}
          className="min-w-0 flex-1 break-words rounded text-sm leading-snug font-medium text-foreground hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {taskTitleText(task)}
        </Link>
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
        <TaskMetaBadges task={task} seats={seats} />
      </div>

      {canEdit && (
        <div className="mt-2.5 border-t border-border/60 pt-2">
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
        </div>
      )}
    </li>
  );
}

export function ProjectBoardView({
  slug,
  view,
  tasks,
  seats,
  canEdit,
  includeCancelled,
  creatingTask,
  customSortActive = false,
  onMoveStatus,
  onReorderTask,
  onCreateTask,
  onEditTask,
  onRemoveTask,
}: {
  slug: string;
  view: ProjectViewMode;
  tasks: readonly ProjectTaskCard[];
  seats: readonly ProjectSeat[];
  canEdit: boolean;
  includeCancelled: boolean;
  creatingTask: boolean;
  customSortActive?: boolean;
  onMoveStatus: (taskId: string, nextStatus: TaskStatus, placement?: TaskPlacement) => void;
  onReorderTask?: (taskId: string, placement: TaskPlacement) => void;
  onCreateTask: (input: { title: string; assigneePositionId: string | null; due?: string; checklist?: TaskChecklistStep[]; status: BoardColumnStatus }, done: () => void) => void;
  onEditTask: (task: ProjectTaskCard) => void;
  onRemoveTask: (taskId: string) => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const f = useFormat();

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<TaskStatus | null>(null);
  const [dropTarget, setDropTarget] = useState<{ anchorId: string; place: 'before' | 'after' } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProjectTaskCard | null>(null);

  const columns = boardColumns(includeCancelled);
  const grouped = groupBoardTasks(tasks, includeCancelled);
  const listTasks = includeCancelled ? tasks : tasks.filter((item) => item.status !== 'cancelled');
  const showReorder = canEdit && onReorderTask !== undefined;

  const clearDrag = () => {
    setDraggingId(null);
    setOverStatus(null);
    setDropTarget(null);
  };

  const handleDropOnColumn = (e: DragEvent<HTMLElement>, targetStatus: TaskStatus) => {
    e.preventDefault();
    const droppedId = e.dataTransfer.getData('text/plain') || draggingId;
    clearDrag();
    if (!canEdit || !droppedId) return;
    const task = tasks.find((item) => item.id === droppedId);
    if (!task) return;
    if (task.status === targetStatus) {
      if (!customSortActive && onReorderTask) {
        const items = grouped[targetStatus];
        const last = items[items.length - 1];
        if (last && last.id !== droppedId) {
          onReorderTask(droppedId, { place: 'after', anchorId: last.id });
        }
      }
      return;
    }
    if (task.checkedOut) return;
    onMoveStatus(droppedId, targetStatus);
  };

  const handleDragOverCard = (e: DragEvent<HTMLLIElement>, targetTask: ProjectTaskCard, targetIndex: number) => {
    if (!canEdit || !draggingId || draggingId === targetTask.id) return;
    const draggingTask = tasks.find((item) => item.id === draggingId);
    if (!draggingTask) return;
    const sameColumn = draggingTask.status === targetTask.status;
    if (sameColumn && (customSortActive || !onReorderTask)) return;
    if (!sameColumn && draggingTask.checkedOut) return;
    const columnItems = grouped[targetTask.status];
    const draggingIndex = sameColumn ? columnItems.findIndex((item) => item.id === draggingId) : -1;
    const place = dropPlaceForCard(e, sameColumn, draggingIndex, targetIndex);
    e.preventDefault();
    e.stopPropagation();
    setOverStatus((cur) => (cur === targetTask.status ? cur : targetTask.status));
    setDropTarget((cur) => (cur?.anchorId === targetTask.id && cur.place === place ? cur : { anchorId: targetTask.id, place }));
  };

  const handleDropOnCard = (e: DragEvent<HTMLLIElement>, targetTask: ProjectTaskCard, targetIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedId = e.dataTransfer.getData('text/plain') || draggingId;
    clearDrag();
    if (!canEdit || !droppedId || droppedId === targetTask.id) return;
    const droppedTask = tasks.find((item) => item.id === droppedId);
    if (!droppedTask) return;
    const sameColumn = droppedTask.status === targetTask.status;
    const columnItems = grouped[targetTask.status];
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
    onMoveStatus(droppedId, targetTask.status, !customSortActive && onReorderTask ? { place, anchorId: targetTask.id } : undefined);
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

      {canEdit && customSortActive && (
        <p className="text-xs text-muted-foreground" data-testid="reorder-disabled-hint">
          {t('task.reorderDisabledHint')}
        </p>
      )}

      {view === 'board' ? (
        <div
          data-testid="project-board"
          className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${columns.length === 6 ? '2xl:grid-cols-6' : '2xl:grid-cols-5'}`}
        >
          {columns.map((status) => {
            const items = grouped[status];
            const isOver = overStatus === status;
            const quickAddStatus: BoardColumnStatus | null = status === 'cancelled' ? null : status;
            return (
              <section
                key={status}
                aria-label={t('board.columnLabel', { status: tt(`status.${status}`) })}
                data-testid="project-column"
                data-status={status}
                onDragEnter={(e) => {
                  if (canEdit) e.preventDefault();
                }}
                onDragOver={(e) => {
                  if (!canEdit) return;
                  e.preventDefault();
                  setOverStatus((cur) => (cur === status ? cur : status));
                  setDropTarget((cur) => (cur ? null : cur));
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setOverStatus((cur) => (cur === status ? null : cur));
                  }
                }}
                onDrop={(e) => handleDropOnColumn(e, status)}
                className={`flex min-w-0 flex-col rounded-xl border border-border bg-muted/35 p-2.5 transition-colors ${
                  isOver ? 'border-primary/60 bg-primary/5 ring-2 ring-primary/30' : ''
                }`}
              >
                <header className="mb-2.5 flex items-center justify-between gap-2 px-1">
                  <div className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${COLUMN_DOT_CLASS[status]}`} aria-hidden="true" />
                    <h2 className="text-xs font-semibold tracking-wide text-foreground uppercase">
                      {tt(`status.${status}`)}
                    </h2>
                  </div>
                  <Badge variant="outline" className="h-5 px-1.5 text-[11px] tabular-nums">
                    {items.length}
                  </Badge>
                </header>

                <ul className="space-y-2" aria-label={tt(`status.${status}`)}>
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
                          canEdit={canEdit}
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
                          onDragOverCard={(e) => handleDragOverCard(e, task, idx)}
                          onDropOnCard={(e) => handleDropOnCard(e, task, idx)}
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
                          onMoveStatus={(taskId, nextStatus) => onMoveStatus(taskId, nextStatus)}
                          onEdit={onEditTask}
                          onRemove={setConfirmRemove}
                        />
                      );
                    })
                  )}
                </ul>

                {canEdit && quickAddStatus && (
                  <div className="mt-2 pt-1">
                    <QuickAddTask status={quickAddStatus} seats={seats} busy={creatingTask} onCreate={onCreateTask} />
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
                        <span className={`size-2 shrink-0 rounded-full ${COLUMN_DOT_CLASS[task.status]}`} aria-hidden="true" />
                        <Link
                          to="/o/$slug/tasks/$id"
                          params={{ slug, id: task.id }}
                          className="min-w-0 break-words rounded text-sm font-medium text-foreground hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {taskTitleText(task)}
                        </Link>
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
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                      {canEdit ? (
                        <NativeSelect
                          aria-label={t('task.changeStatusOf', { title: taskTitleText(task) })}
                          disabled={task.checkedOut}
                          value={task.status}
                          onChange={(e) => onMoveStatus(task.id, e.target.value as TaskStatus)}
                          className="h-10 min-w-32 text-xs sm:h-8"
                        >
                          {TASK_STATUSES.map((st) => (
                            <NativeSelectOption key={st} value={st}>
                              {tt(`status.${st}`)}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Badge variant={taskStatusVariant(task.status)}>{tt(`status.${task.status}`)}</Badge>
                      )}
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
