// SPDX-License-Identifier: AGPL-3.0-only
// Modals for Projects screens: project creation, settings & team management, attaching existing tasks, and editing tasks (#2591).
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  PROJECT_CYCLE_DURATION_WEEKS_MAX,
  PROJECT_CYCLE_DURATION_WEEKS_MIN,
  PROJECT_TASK_STORY_POINTS_MAX,
  PROJECT_TASK_STORY_POINTS_MIN,
  TASK_CHECKLIST_STEPS_MAX,
  TASK_CHECKLIST_STEP_MAX,
  serializeTaskChecklist,
  type ProjectBoard,
  type ProjectCandidateTask,
  type ProjectCycle,
  type ProjectDetail,
  type ProjectSeat,
  type ProjectStatus,
  type ProjectTaskCard,
  type ProjectTaskRecurrenceView,
  type ProjectUpdateInput,
  type ProjectVisibility,
  type TaskChecklistStep,
} from '@ludy/kernel-contract';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { Textarea } from '@ludy/ui/components/textarea';
import { VisibilityIcon } from '@ludy/ui/components/visibility-icon';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput } from './date-input.tsx';
import { FormDialog } from './form-dialog.tsx';
import { FormPanel } from './form-panel.tsx';
import { TaskChecklistEditor, hasBlankChecklistStep, normalizeChecklistSteps } from './task-checklist.tsx';
import { ProjectDependencies } from './project-dependencies.tsx';
import { TaskTimeTrackingPanel } from './project-time-panel.tsx';
import { TaskRecurrenceControl } from './task-recurrence-control.tsx';
import { ErrorText, FieldError, RowsSkeleton, fieldControl, fieldHintId } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { taskDueDay, taskDueFromDay } from '../lib/agents.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import {
  PROJECT_CYCLE_SUMMARY_QUERY_PREFIX,
  PROJECT_STATUSES,
  PROJECT_WEEKLY_STATUS_QUERY_PREFIX,
  projectStatusVariant,
  taskStatusVariant,
} from '../lib/projects.ts';
import { taskTitleHidden, taskTitleText } from '../lib/task-title.ts';

export const refreshProjectQueries = async () => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.projects.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.tasks.key() }),
    queryClient.invalidateQueries({ queryKey: PROJECT_WEEKLY_STATUS_QUERY_PREFIX }),
    queryClient.invalidateQueries({ queryKey: PROJECT_CYCLE_SUMMARY_QUERY_PREFIX }),
  ]);
};

export function seatOptionLabel(
  seat: ProjectSeat,
  aiSuffix: string,
  openSuffix: string,
): string {
  if (seat.holder?.type === 'agent') {
    const who = seat.holder.name?.trim() || aiSuffix;
    return `${seat.title} (${who})`;
  }
  if (seat.holder?.type === 'user') {
    const who = seat.holder.displayName?.trim() || seat.holder.email?.trim() || '';
    return who ? `${seat.title} (${who})` : seat.title;
  }
  return `${seat.title} ${openSuffix}`;
}

export function memberLabel(m: { displayName: string | null; email: string | null; userId: string }): string {
  return m.displayName?.trim() || m.email?.trim() || m.userId.slice(0, 8);
}

export function ProjectVisibilityField({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  value: ProjectVisibility;
  onChange: (next: ProjectVisibility) => void;
  disabled?: boolean | undefined;
}) {
  const t = useTranslations('projects');
  const isPrivate = value === 'private';

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor={id}>{t('visibility.label')}</Label>
        <NativeSelect
          id={id}
          className="w-full [&>select]:min-h-11"
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value as ProjectVisibility)}
          data-testid="project-visibility-select"
        >
          <NativeSelectOption value="org">{t('visibility.org')}</NativeSelectOption>
          <NativeSelectOption value="private">{t('visibility.private')}</NativeSelectOption>
        </NativeSelect>
      </div>
      <Alert
        className={isPrivate ? 'border-border bg-muted/40' : 'border-primary/25 bg-primary/5'}
        data-testid="project-visibility-notice"
        data-visibility={value}
      >
        {isPrivate ? (
          <VisibilityIcon shared={false} className="text-foreground" />
        ) : (
          <NavIcon name="info" className="text-primary" />
        )}
        <AlertDescription className="text-xs leading-relaxed text-foreground">
          {isPrivate ? t('privateVisibilityNotice') : t('visibilityNotice')}
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => void;
}) {
  if (!open) return null;
  return <CreateProjectFormDialog onOpenChange={onOpenChange} onCreated={onCreated} />;
}

function CreateProjectFormDialog({
  onOpenChange,
  onCreated,
}: {
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => void;
}) {
  const t = useTranslations('projects');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<ProjectVisibility>('org');
  const [nameError, setNameError] = useState(false);
  const [idemKey] = useState(() => crypto.randomUUID());

  const create = useMutation(orpc.projects.create.mutationOptions());
  const nameField = fieldControl('create-project-name', { error: nameError });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(true);
      return;
    }
    const trimmedDesc = description.trim();
    create.mutate(
      {
        name: trimmedName,
        ...(trimmedDesc ? { description: trimmedDesc } : {}),
        visibility,
        idempotencyKey: idemKey,
      },
      {
        onSuccess: (res) => {
          refreshProjectQueries();
          onOpenChange(false);
          onCreated(res.projectId);
        },
      },
    );
  };

  return (
    <FormDialog
      testId="create-project-dialog"
      title={t('createTitle')}
      description={t('createSubtitle')}
      busy={create.isPending}
      dirty={name.trim() !== '' || description.trim() !== '' || visibility !== 'org'}
      submitLabel={t('createSubmit')}
      onClose={() => onOpenChange(false)}
      onSubmit={submit}
    >
      <ProjectVisibilityField id="create-project-visibility" value={visibility} onChange={setVisibility} />
      <div className="space-y-1.5">
        <Label htmlFor={nameField.id}>{t('modals.createNameLabel')}</Label>
        <Input
          {...nameField}
          autoFocus
          required
          maxLength={200}
          placeholder={t('modals.createNamePlaceholder')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError && e.target.value.trim()) setNameError(false);
          }}
        />
        <FieldError id={nameField.id}>{nameError ? t('errors.nameRequired') : null}</FieldError>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="create-project-desc">{t('modals.createDescLabel')}</Label>
        <Textarea
          id="create-project-desc"
          rows={3}
          maxLength={2000}
          placeholder={t('modals.createDescPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </FormDialog>
  );
}

export function AttachTaskDialog({
  open,
  onOpenChange,
  projectId,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  disabled: boolean;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const tc = useTranslations('common');
  const f = useFormat();
  const [search, setSearch] = useState('');
  const [addedIds, setAddedIds] = useState<string[]>([]);

  const candidates = useQuery({
    ...orpc.projects.unassignedTasks.queryOptions({ input: {} }),
    enabled: open,
  });

  const addTask = useMutation(
    orpc.projects.addTask.mutationOptions({
      onSuccess: (_res, vars) => {
        setAddedIds((prev) => (prev.includes(vars.taskId) ? prev : [...prev, vars.taskId]));
        refreshProjectQueries();
      },
    }),
  );

  useEffect(() => {
    if (open) {
      setSearch('');
      setAddedIds([]);
      addTask.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const query = search.trim().toLowerCase();
  const visible = (candidates.data ?? []).filter((task: ProjectCandidateTask) =>
    !query ? true : task.title.toLowerCase().includes(query),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc('close')} className="sm:max-w-lg" data-testid="attach-task-dialog">
        <DialogHeader>
          <DialogTitle>{t('modals.attachTitle')}</DialogTitle>
          <DialogDescription>{t('modals.attachSubtitle')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="search"
            autoFocus
            placeholder={t('modals.attachSearch')}
            aria-label={t('modals.attachSearch')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {addTask.error && <ErrorText>{errorMessage(addTask.error)}</ErrorText>}
          {candidates.isPending ? (
            <RowsSkeleton rows={3} />
          ) : candidates.error ? (
            <ErrorText>{errorMessage(candidates.error)}</ErrorText>
          ) : visible.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t('modals.attachEmpty')}
            </p>
          ) : (
            <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
              {visible.map((task) => {
                const isAdded = addedIds.includes(task.id);
                const busy = addTask.isPending && addTask.variables?.taskId === task.id;
                return (
                  <li key={task.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-medium text-foreground">{taskTitleText(task)}</p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant={taskStatusVariant(task.status)}>{tt(`status.${task.status}`)}</Badge>
                        {task.due && <span>{f.date(task.due)}</span>}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={isAdded ? 'secondary' : 'outline'}
                      disabled={disabled || isAdded || addTask.isPending}
                      loading={busy}
                      onClick={() =>
                        addTask.mutate({
                          projectId,
                          taskId: task.id,
                          idempotencyKey: crypto.randomUUID(),
                        })
                      }
                    >
                      {isAdded ? (
                        <>
                          <ProjectIcon name="check" />
                          {t('modals.attachAdded')}
                        </>
                      ) : (
                        t('modals.attachAdd')
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{tc('close')}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditProjectTaskDialog({
  slug,
  projectId,
  canWrite = true,
  task,
  projectTasks,
  seats,
  cyclesEnabled = false,
  pointsEnabled = false,
  cycles = [],
  open,
  onOpenChange,
}: {
  slug: string;
  projectId: string;
  canWrite?: boolean;
  task: ProjectTaskCard | null;
  projectTasks?: readonly ProjectTaskCard[] | undefined;
  seats: readonly ProjectSeat[];
  cyclesEnabled?: boolean;
  pointsEnabled?: boolean;
  cycles?: readonly ProjectCycle[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open || !task) return null;
  return (
    <EditProjectTaskPanel
      key={task.id}
      slug={slug}
      projectId={projectId}
      canWrite={canWrite}
      task={task}
      projectTasks={projectTasks}
      seats={seats}
      cyclesEnabled={cyclesEnabled}
      pointsEnabled={pointsEnabled}
      cycles={cycles}
      onOpenChange={onOpenChange}
    />
  );
}

function EditProjectTaskPanel({
  slug,
  projectId,
  canWrite,
  task,
  projectTasks,
  seats,
  cyclesEnabled,
  pointsEnabled,
  cycles,
  onOpenChange,
}: {
  slug: string;
  projectId: string;
  canWrite: boolean;
  task: ProjectTaskCard;
  projectTasks?: readonly ProjectTaskCard[] | undefined;
  seats: readonly ProjectSeat[];
  cyclesEnabled: boolean;
  pointsEnabled: boolean;
  cycles: readonly ProjectCycle[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const tc = useTranslations('common');
  const tz = browserTimeZone();
  const formId = useId();

  const initialDueOn = taskDueDay(task.due, tz);
  const initialChecklist = (task.checklist ?? []).map((s) => ({ ...s }));
  const initialBaseline = {
    title: task.title,
    description: task.description ?? '',
    assignee: task.assigneePositionId ?? '',
    dueOn: initialDueOn,
    checklistJson: serializeTaskChecklist(normalizeChecklistSteps(initialChecklist)),
    cycleId: task.cycleId ?? null,
    points: task.storyPoints ?? null,
  };

  const [title, setTitle] = useState(initialBaseline.title);
  const [description, setDescription] = useState(initialBaseline.description);
  const [assignee, setAssignee] = useState(initialBaseline.assignee);
  const [dueOn, setDueOn] = useState(initialBaseline.dueOn);
  const [cycleId, setCycleId] = useState(initialBaseline.cycleId ?? '');
  const [pointsText, setPointsText] = useState(initialBaseline.points === null ? '' : String(initialBaseline.points));
  const [checklist, setChecklist] = useState<TaskChecklistStep[]>(initialChecklist);
  const [stepDraft, setStepDraft] = useState('');
  const [checklistEpoch, setChecklistEpoch] = useState(0);
  const [baseline, setBaseline] = useState(initialBaseline);
  const [titleError, setTitleError] = useState(false);
  const [stepError, setStepError] = useState(false);
  const [pointsError, setPointsError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [recurrenceOverride, setRecurrenceOverride] = useState<ProjectTaskRecurrenceView | null>(null);

  const activeRef = useRef(true);
  useEffect(
    () => () => {
      activeRef.current = false;
    },
    [],
  );

  const update = useMutation(orpc.tasks.update.mutationOptions());
  const setTaskCycle = useMutation(orpc.projects.setTaskCycle.mutationOptions());
  const setTaskPoints = useMutation(orpc.projects.setTaskPoints.mutationOptions());

  // A tainted title that holds characters nobody can see in the field is written out beside it (#4423); the field is described by it.
  const hiddenInTitle = taskTitleHidden({ title, tainted: task.tainted });
  const titleField = fieldControl(`edit-project-task-${task.id}`, { error: titleError, hint: hiddenInTitle !== null });
  const activeSeats = seats.filter((s) => s.status !== 'archived' || s.id === task.assigneePositionId);

  const pendingStep = stepDraft.trim();
  const effectiveChecklist = normalizeChecklistSteps(
    pendingStep && checklist.length < TASK_CHECKLIST_STEPS_MAX
      ? [...checklist, { text: pendingStep.slice(0, TASK_CHECKLIST_STEP_MAX), done: false }]
      : checklist,
  );
  const effectiveChecklistJson = serializeTaskChecklist(effectiveChecklist);
  const initialPointsText = baseline.points === null ? '' : String(baseline.points);
  const dirty =
    !task.checkedOut &&
    (title !== baseline.title ||
      description !== baseline.description ||
      assignee !== baseline.assignee ||
      dueOn !== baseline.dueOn ||
      effectiveChecklistJson !== baseline.checklistJson ||
      pendingStep !== '' ||
      (cyclesEnabled && (cycleId || null) !== baseline.cycleId) ||
      (pointsEnabled && pointsText !== initialPointsText));

  const busy = isSaving || update.isPending || setTaskCycle.isPending || setTaskPoints.isPending;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (task.checkedOut || busy) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setTitleError(true);
      return;
    }
    if (hasBlankChecklistStep(checklist)) {
      setStepError(true);
      return;
    }
    if (!e.currentTarget.checkValidity()) {
      e.currentTarget.reportValidity();
      return;
    }
    const nextDesc = description.trim() ? description.trim() : null;
    const nextAssignee = assignee || null;
    const patch = {
      ...(nextTitle !== baseline.title ? { title: nextTitle } : {}),
      ...(description !== baseline.description ? { description: nextDesc } : {}),
      ...(nextAssignee !== baseline.assignee ? { assigneePositionId: nextAssignee } : {}),
      ...(dueOn !== baseline.dueOn ? { due: taskDueFromDay(dueOn, tz) } : {}),
      ...(effectiveChecklistJson !== baseline.checklistJson ? { checklist: effectiveChecklist } : {}),
    };
    const nextCycleId = cycleId || null;
    const cycleChanged = cyclesEnabled && nextCycleId !== baseline.cycleId;
    const trimmedPts = pointsText.trim();
    let nextPoints: number | null = null;
    if (pointsEnabled && trimmedPts !== '') {
      const parsedPts = Number(trimmedPts);
      if (
        !Number.isInteger(parsedPts) ||
        parsedPts < PROJECT_TASK_STORY_POINTS_MIN ||
        parsedPts > PROJECT_TASK_STORY_POINTS_MAX
      ) {
        setPointsError(true);
        return;
      }
      nextPoints = parsedPts;
    }
    const pointsChanged = pointsEnabled && nextPoints !== baseline.points;

    if (Object.keys(patch).length === 0 && !cycleChanged && !pointsChanged) {
      onOpenChange(false);
      return;
    }

    update.reset();
    setTaskCycle.reset();
    setTaskPoints.reset();
    setTitleError(false);
    setStepError(false);
    setPointsError(false);

    const submitTaskId = task.id;
    const runFollowups = async () => {
      let anyWriteSucceeded = false;
      setIsSaving(true);
      try {
        if (Object.keys(patch).length > 0) {
          await update.mutateAsync({ id: submitTaskId, ...patch, idempotencyKey: crypto.randomUUID() });
          anyWriteSucceeded = true;
          if (activeRef.current) {
            setChecklist(effectiveChecklist);
            setStepDraft('');
            if (pendingStep) setChecklistEpoch((n) => n + 1);
            setBaseline((prev) => ({
              ...prev,
              title: nextTitle,
              description,
              assignee: nextAssignee ?? '',
              dueOn,
              checklistJson: effectiveChecklistJson,
            }));
          }
        }
        if (cycleChanged) {
          await setTaskCycle.mutateAsync({
            projectId,
            taskId: submitTaskId,
            cycleId: nextCycleId,
            idempotencyKey: crypto.randomUUID(),
          });
          anyWriteSucceeded = true;
          if (activeRef.current) {
            setBaseline((prev) => ({ ...prev, cycleId: nextCycleId }));
          }
        }
        if (pointsChanged) {
          await setTaskPoints.mutateAsync({
            projectId,
            taskId: submitTaskId,
            storyPoints: nextPoints,
            idempotencyKey: crypto.randomUUID(),
          });
          anyWriteSucceeded = true;
          if (activeRef.current) {
            setBaseline((prev) => ({ ...prev, points: nextPoints }));
          }
        }
        if (activeRef.current) {
          onOpenChange(false);
        }
      } finally {
        if (activeRef.current) setIsSaving(false);
        if (anyWriteSucceeded) await refreshProjectQueries();
      }
    };
    void runFollowups().catch(() => undefined);
  };

  return (
    <FormPanel
      testId="edit-project-task-dialog"
      title={t('modals.editTaskTitle')}
      description={
        <Link
          to="/o/$slug/tasks/$id"
          params={{ slug, id: task.id }}
          className="inline-flex max-md:min-h-11 items-center rounded text-xs text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {t('task.openDetail')}
        </Link>
      }
      wide
      noValidate
      formId={formId}
      busy={busy}
      dirty={dirty}
      onClose={() => onOpenChange(false)}
      onSubmit={submit}
      footer={(requestClose) => (
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={requestClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" form={formId} disabled={task.checkedOut || busy} loading={busy}>
            {t('modals.saveTask')}
          </Button>
        </>
      )}
      outside={
        <div className="space-y-4 border-t border-border pt-4">
          <ProjectDependencies
            projectId={projectId}
            taskId={task.id}
            canWrite={canWrite && !task.checkedOut}
            projectTasks={projectTasks}
            onChanged={refreshProjectQueries}
          />
          <TaskTimeTrackingPanel
            projectId={projectId}
            taskId={task.id}
            taskTitle={taskTitleText(task)}
            canWrite={canWrite && !task.checkedOut}
          />
          <TaskRecurrenceControl
            projectId={projectId}
            taskId={task.id}
            canEdit={canWrite && !task.checkedOut}
            view={
              recurrenceOverride ?? {
                projectId,
                taskId: task.id,
                recurrence: task.recurrence ?? null,
                recurrenceCount: task.recurrenceCount ?? 0,
                recurrenceLastDue: task.recurrenceLastDue ?? null,
                recurrenceNextAt: task.recurrenceNextAt ?? null,
                recurrenceSourceTaskId: task.recurrenceSourceTaskId ?? null,
              }
            }
            onUpdated={(next) => {
              setRecurrenceOverride(next);
              refreshProjectQueries();
            }}
          />
        </div>
      }
    >
      {task.checkedOut && (
        <Alert className="border-warning/30 bg-warning/10">
          <NavIcon name="agents" className="text-warning" />
          <AlertDescription className="text-xs text-foreground">{t('task.checkedOutLocked')}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={titleField.id}>{t('modals.taskTitleLabel')}</Label>
        <Input
          {...titleField}
          autoFocus={!task.checkedOut}
          required
          disabled={task.checkedOut}
          maxLength={300}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (titleError && e.target.value.trim()) setTitleError(false);
          }}
        />
        <FieldError id={titleField.id}>{titleError ? t('errors.taskTitleRequired') : null}</FieldError>
        {hiddenInTitle !== null && (
          <p id={fieldHintId(titleField.id)} className="break-words text-xs text-warning" data-testid="task-title-hidden">
            {tt('titleHidden', { marked: hiddenInTitle })}
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`edit-seat-${task.id}`}>{t('modals.taskSeatLabel')}</Label>
          <NativeSelect
            id={`edit-seat-${task.id}`}
            className="w-full"
            disabled={task.checkedOut}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <NativeSelectOption value="">{tt('rootAssignee')}</NativeSelectOption>
            {activeSeats.map((seat) => (
              <NativeSelectOption key={seat.id} value={seat.id}>
                {seatOptionLabel(seat, t('modals.aiSeatSuffix'), t('modals.openSeatSuffix'))}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-due-${task.id}`}>{t('modals.taskDueLabel')}</Label>
          <DateInput
            id={`edit-due-${task.id}`}
            disabled={task.checkedOut}
            value={dueOn}
            onChange={setDueOn}
            aria-label={t('modals.taskDueLabel')}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`edit-desc-${task.id}`}>{t('modals.taskDescLabel')}</Label>
        <Textarea
          id={`edit-desc-${task.id}`}
          rows={3}
          disabled={task.checkedOut}
          maxLength={10000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {(cyclesEnabled || pointsEnabled) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {cyclesEnabled && (
            <div className="space-y-1.5">
              <Label htmlFor={`edit-cycle-${task.id}`}>{t('cycles.taskCycleLabel')}</Label>
              <NativeSelect
                id={`edit-cycle-${task.id}`}
                className="w-full max-md:[&>select]:min-h-11"
                disabled={task.checkedOut || !canWrite}
                value={cycleId}
                onChange={(e) => setCycleId(e.target.value)}
              >
                <NativeSelectOption value="">{t('cycles.backlogOption')}</NativeSelectOption>
                {cycles
                  .filter((c) => c.status !== 'completed' || c.id === task.cycleId)
                  .map((c) => (
                    <NativeSelectOption key={c.id} value={c.id} disabled={c.status === 'completed'}>
                      {t('cycles.cycleLabel', { number: c.number, name: c.name })}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </div>
          )}
          {pointsEnabled && (
            <div className="space-y-1.5">
              <Label htmlFor={`edit-points-${task.id}`}>{t('cycles.pointsInputLabel')}</Label>
              <Input
                id={`edit-points-${task.id}`}
                type="number"
                min={PROJECT_TASK_STORY_POINTS_MIN}
                max={PROJECT_TASK_STORY_POINTS_MAX}
                step={1}
                inputMode="numeric"
                aria-invalid={pointsError || undefined}
                className="max-md:min-h-11"
                disabled={task.checkedOut || !canWrite}
                placeholder={t('cycles.pointsPlaceholder')}
                value={pointsText}
                onChange={(e) => {
                  setPointsText(e.target.value);
                  if (pointsError) setPointsError(false);
                }}
              />
              {pointsError && <ErrorText>{t('cycles.pointsInvalid')}</ErrorText>}
            </div>
          )}
        </div>
      )}
      <TaskChecklistEditor
        key={checklistEpoch}
        idPrefix={`edit-project-task-${task.id}`}
        disabled={task.checkedOut}
        label={t('modals.taskChecklistLabel')}
        value={checklist}
        onDraftChange={setStepDraft}
        stepError={stepError}
        onChange={(next) => {
          setChecklist(next);
          if (stepError && !hasBlankChecklistStep(next)) setStepError(false);
        }}
      />
      {(update.error ?? setTaskCycle.error ?? setTaskPoints.error) && (
        <ErrorText>{errorMessage(update.error ?? setTaskCycle.error ?? setTaskPoints.error)}</ErrorText>
      )}
      {(task.openBlockerCount ?? 0) > 0 && (
        <Alert data-testid="edit-task-open-blockers-warning">
          <AlertDescription>
            {t('dependencies.moveBlockedWarning', { count: task.openBlockerCount ?? 0 })}
          </AlertDescription>
        </Alert>
      )}
    </FormPanel>
  );
}

export function buildProjectDetailsUpdateInput(params: {
  projectId: string;
  name: string;
  description: string | null;
  visibility: ProjectVisibility;
  currentVisibility: ProjectVisibility;
  cyclesEnabled: boolean;
  cycleDurationWeeks: number;
  pointsEnabled: boolean;
}): ProjectUpdateInput {
  return {
    projectId: params.projectId,
    name: params.name,
    description: params.description,
    // Omit unchanged visibility so saving name/description/cycles never overwrites a concurrent org <-> private transition.
    ...(params.visibility !== params.currentVisibility ? { visibility: params.visibility } : {}),
    cyclesEnabled: params.cyclesEnabled,
    cycleDurationWeeks: params.cycleDurationWeeks,
    pointsEnabled: params.pointsEnabled,
  };
}

export function ProjectSettingsDialog({
  open,
  onOpenChange,
  project,
  members,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectDetail;
  members: ProjectBoard['members'];
}) {
  if (!open) return null;
  return <ProjectSettingsPanel key={project.id} project={project} members={members} onOpenChange={onOpenChange} />;
}

function ProjectSettingsPanel({
  onOpenChange,
  project,
  members,
}: {
  onOpenChange: (open: boolean) => void;
  project: ProjectDetail;
  members: ProjectBoard['members'];
}) {
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const formId = useId();

  const initialBaseline = {
    name: project.name,
    description: project.description ?? '',
    visibility: project.visibility,
    cyclesEnabled: project.cyclesEnabled ?? false,
    cycleDurationWeeks: project.cycleDurationWeeks ?? 2,
    pointsEnabled: project.pointsEnabled ?? false,
  };

  const [name, setName] = useState(initialBaseline.name);
  const [description, setDescription] = useState(initialBaseline.description);
  const [visibility, setVisibility] = useState<ProjectVisibility>(initialBaseline.visibility);
  const [cyclesEnabled, setCyclesEnabled] = useState(initialBaseline.cyclesEnabled);
  const [cycleDurationWeeks, setCycleDurationWeeks] = useState(initialBaseline.cycleDurationWeeks);
  const [pointsEnabled, setPointsEnabled] = useState(initialBaseline.pointsEnabled);
  const [baseline, setBaseline] = useState(initialBaseline);
  const [nameError, setNameError] = useState(false);

  const update = useMutation(orpc.projects.update.mutationOptions({ onSuccess: refreshProjectQueries }));
  const setStatus = useMutation(orpc.projects.setStatus.mutationOptions({ onSuccess: refreshProjectQueries }));
  const setOwner = useMutation(orpc.projects.setOwner.mutationOptions({ onSuccess: refreshProjectQueries }));
  const addMember = useMutation(orpc.projects.addMember.mutationOptions({ onSuccess: refreshProjectQueries }));
  const removeMember = useMutation(orpc.projects.removeMember.mutationOptions({ onSuccess: refreshProjectQueries }));
  const archive = useMutation(
    orpc.projects.archive.mutationOptions({
      onSuccess: () => {
        refreshProjectQueries();
        onOpenChange(false);
      },
    }),
  );

  const editable = project.canManage && project.status !== 'archived';
  const nameField = fieldControl(`settings-project-name-${project.id}`, { error: nameError });
  const otherMutationError = setStatus.error ?? setOwner.error ?? addMember.error ?? removeMember.error ?? archive.error;
  const eligibleOwners = members.filter((m) => m.role !== 'viewer');
  const projectMemberCount = members.filter((m) => m.onProject).length;
  const dirty =
    editable &&
    (name !== baseline.name ||
      description !== baseline.description ||
      visibility !== baseline.visibility ||
      cyclesEnabled !== baseline.cyclesEnabled ||
      cycleDurationWeeks !== baseline.cycleDurationWeeks ||
      pointsEnabled !== baseline.pointsEnabled);

  const saveDetails = (e: FormEvent) => {
    e.preventDefault();
    if (!editable || update.isPending) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(true);
      return;
    }
    const nextDesc = description.trim() ? description.trim() : null;
    update.mutate(
      {
        ...buildProjectDetailsUpdateInput({
          projectId: project.id,
          name: trimmed,
          description: nextDesc,
          visibility,
          currentVisibility: baseline.visibility,
          cyclesEnabled,
          cycleDurationWeeks,
          pointsEnabled,
        }),
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: () => {
          const savedDesc = nextDesc ?? '';
          setName(trimmed);
          setDescription(savedDesc);
          setBaseline({
            name: trimmed,
            description: savedDesc,
            visibility,
            cyclesEnabled,
            cycleDurationWeeks,
            pointsEnabled,
          });
        },
      },
    );
  };

  return (
    <FormPanel
      testId="project-settings-dialog"
      title={t('modals.editProjectTitle')}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={projectStatusVariant(project.status)}>{t(`status.${project.status}`)}</Badge>
          {project.visibility === 'private' && (
            <Badge variant="secondary" className="gap-1">
              <VisibilityIcon shared={false} className="size-3" />
              {t('visibility.privateBadge')}
            </Badge>
          )}
        </span>
      }
      wide
      noValidate
      formId={formId}
      busy={update.isPending}
      dirty={dirty}
      onClose={() => onOpenChange(false)}
      onSubmit={editable ? saveDetails : undefined}
      footer={(requestClose) => (
        <>
          <Button type="button" variant="outline" disabled={update.isPending} onClick={requestClose}>
            {tc('close')}
          </Button>
          {editable && (
            <Button type="submit" form={formId} loading={update.isPending}>
              {t('modals.saveDetails')}
            </Button>
          )}
        </>
      )}
      outside={
        <div className="space-y-4">
          {otherMutationError && <ErrorText>{errorMessage(otherMutationError)}</ErrorText>}

          <div className="grid gap-3 border-t pt-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`settings-status-${project.id}`}>{t('modals.statusLabel')}</Label>
              <NativeSelect
                id={`settings-status-${project.id}`}
                className="w-full [&>select]:min-h-11"
                disabled={!project.canManage || setStatus.isPending}
                value={project.status}
                onChange={(e) =>
                  setStatus.mutate({
                    projectId: project.id,
                    status: e.target.value as ProjectStatus,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
              >
                {PROJECT_STATUSES.map((st) => (
                  <NativeSelectOption key={st} value={st}>
                    {t(`status.${st}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`settings-owner-${project.id}`}>{t('modals.ownerLabel')}</Label>
              <NativeSelect
                id={`settings-owner-${project.id}`}
                className="w-full [&>select]:min-h-11"
                disabled={!editable || setOwner.isPending}
                value={project.ownerUserId ?? ''}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setOwner.mutate({
                    projectId: project.id,
                    ownerUserId: e.target.value,
                    idempotencyKey: crypto.randomUUID(),
                  });
                }}
              >
                {project.ownerUserId === null && (
                  <NativeSelectOption value="">{t('modals.ownerFallback')}</NativeSelectOption>
                )}
                {eligibleOwners.map((m) => (
                  <NativeSelectOption key={m.userId} value={m.userId}>
                    {memberLabel(m)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="space-y-2 border-t pt-4">
            <p className="text-xs font-medium text-foreground">
              {t('modals.membersLabel', { count: String(projectMemberCount) })}
            </p>
            {(visibility === 'private' || project.visibility === 'private') && (
              <p className="text-xs text-muted-foreground" data-testid="project-private-members-hint">
                {t('modals.privateMembersHint')}
              </p>
            )}
            <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border">
              {members.map((m) => {
                const adding = addMember.isPending && addMember.variables?.userId === m.userId;
                const removing = removeMember.isPending && removeMember.variables?.userId === m.userId;
                const isProjectOwner = project.ownerUserId !== null && m.userId === project.ownerUserId;
                return (
                  <li key={m.userId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{memberLabel(m)}</p>
                      <p className="text-xs text-muted-foreground">
                        {isProjectOwner
                          ? t('modals.memberOwnerHint')
                          : m.onProject
                            ? t('modals.memberInProject')
                            : t('modals.memberNotInProject')}
                      </p>
                    </div>
                    {editable &&
                      (m.onProject ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="min-h-11 shrink-0"
                          disabled={isProjectOwner}
                          loading={removing}
                          onClick={() =>
                            removeMember.mutate({
                              projectId: project.id,
                              userId: m.userId,
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                        >
                          {t('modals.memberRemoveLabel')}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 shrink-0"
                          loading={adding}
                          onClick={() =>
                            addMember.mutate({
                              projectId: project.id,
                              userId: m.userId,
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                        >
                          {t('modals.memberAddLabel')}
                        </Button>
                      ))}
                  </li>
                );
              })}
            </ul>
          </div>

          {project.canManage && project.status !== 'archived' && (
            <div className="flex items-center justify-between border-t pt-4">
              <ConfirmDialog
                destructive
                title={t('modals.archiveConfirmTitle')}
                description={t('modals.archiveConfirmDesc')}
                confirm={t('modals.archiveConfirmBtn')}
                onConfirm={() =>
                  archive.mutate({
                    projectId: project.id,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
                render={<Button type="button" variant="outline" size="sm" loading={archive.isPending} />}
              >
                <ProjectIcon name="archive" />
                {t('modals.archiveBtn')}
              </ConfirmDialog>
            </div>
          )}
        </div>
      }
    >
      {update.error && <ErrorText>{errorMessage(update.error)}</ErrorText>}
      <div className="space-y-1.5">
        <Label htmlFor={nameField.id}>{t('modals.nameLabel')}</Label>
        <Input
          {...nameField}
          autoFocus={editable}
          disabled={!editable}
          maxLength={200}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError && e.target.value.trim()) setNameError(false);
          }}
        />
        <FieldError id={nameField.id}>{nameError ? t('errors.nameRequired') : null}</FieldError>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`settings-desc-${project.id}`}>{t('modals.descLabel')}</Label>
        <Textarea
          id={`settings-desc-${project.id}`}
          rows={2}
          disabled={!editable}
          maxLength={2000}
          placeholder={t('modals.descPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <ProjectVisibilityField
        id={`settings-visibility-${project.id}`}
        value={visibility}
        onChange={setVisibility}
        disabled={!editable || update.isPending}
      />
      <div className="space-y-3 rounded-lg border border-border bg-muted/25 p-3">
        <p className="text-xs font-semibold text-foreground">{t('cycles.settingsHeading')}</p>
        <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-xs text-foreground">
          <Checkbox
            checked={cyclesEnabled}
            disabled={!editable}
            onCheckedChange={(checked) => setCyclesEnabled(checked === true)}
            data-testid="settings-cycles-enabled"
          />
          <span className="space-y-0.5">
            <span className="block font-medium">{t('cycles.enableCyclesLabel')}</span>
            <span className="block text-[11px] text-muted-foreground">{t('cycles.enableCyclesHint')}</span>
          </span>
        </label>
        {cyclesEnabled && (
          <div className="space-y-1.5 pl-6">
            <Label htmlFor={`settings-cycle-weeks-${project.id}`}>{t('cycles.durationWeeksLabel')}</Label>
            <NativeSelect
              id={`settings-cycle-weeks-${project.id}`}
              className="w-full max-md:[&>select]:min-h-11"
              disabled={!editable}
              value={String(cycleDurationWeeks)}
              onChange={(e) => setCycleDurationWeeks(Number(e.target.value))}
            >
              {Array.from(
                { length: PROJECT_CYCLE_DURATION_WEEKS_MAX - PROJECT_CYCLE_DURATION_WEEKS_MIN + 1 },
                (_, i) => PROJECT_CYCLE_DURATION_WEEKS_MIN + i,
              ).map((w) => (
                <NativeSelectOption key={w} value={String(w)}>
                  {w === 1 ? t('cycles.weekSingleOption') : t('cycles.weeksOption', { weeks: w })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-xs text-foreground">
          <Checkbox
            checked={pointsEnabled}
            disabled={!editable}
            onCheckedChange={(checked) => setPointsEnabled(checked === true)}
            data-testid="settings-points-enabled"
          />
          <span className="space-y-0.5">
            <span className="block font-medium">{t('cycles.enablePointsLabel')}</span>
            <span className="block text-[11px] text-muted-foreground">{t('cycles.enablePointsHint')}</span>
          </span>
        </label>
      </div>
    </FormPanel>
  );
}
