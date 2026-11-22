// SPDX-License-Identifier: AGPL-3.0-only
// Modals for Projects screens: project creation, settings & team management, attaching existing tasks, and editing tasks (#2591).
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  serializeTaskChecklist,
  type ProjectBoard,
  type ProjectCandidateTask,
  type ProjectDetail,
  type ProjectSeat,
  type ProjectStatus,
  type ProjectTaskCard,
  type ProjectTaskRecurrenceView,
  type TaskChecklistStep,
} from '@ludy/kernel-contract';
import { Link } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { ProjectIcon } from '@ludy/ui/components/project-icon';
import { Textarea } from '@ludy/ui/components/textarea';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput } from './date-input.tsx';
import { TaskChecklistEditor, hasBlankChecklistStep, normalizeChecklistSteps } from './task-checklist.tsx';
import { TaskRecurrenceControl } from './task-recurrence-control.tsx';
import { ErrorText, FieldError, RowsSkeleton, fieldControl } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { taskDueDay, taskDueFromDay } from '../lib/agents.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import { PROJECT_STATUSES, PROJECT_WEEKLY_STATUS_QUERY_PREFIX, projectStatusVariant, taskStatusVariant } from '../lib/projects.ts';
import { taskTitleText } from '../lib/task-title.ts';

export const refreshProjectQueries = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.projects.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
  void queryClient.invalidateQueries({ queryKey: PROJECT_WEEKLY_STATUS_QUERY_PREFIX });
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

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => void;
}) {
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());

  const create = useMutation(orpc.projects.create.mutationOptions());

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setNameError(false);
      setIdemKey(crypto.randomUUID());
      create.reset();
    }
    // Reset only when dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc('close')} data-testid="create-project-dialog">
        <DialogHeader>
          <DialogTitle>{t('createTitle')}</DialogTitle>
          <DialogDescription>{t('createSubtitle')}</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={submit} className="space-y-4">
          <Alert className="border-primary/25 bg-primary/5" data-testid="project-visibility-notice">
            <NavIcon name="info" className="text-primary" />
            <AlertDescription className="text-xs leading-relaxed text-foreground">
              {t('visibilityNotice')}
            </AlertDescription>
          </Alert>
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
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{tc('cancel')}</DialogClose>
            <Button type="submit" loading={create.isPending}>
              {t('createSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  seats,
  open,
  onOpenChange,
}: {
  slug: string;
  projectId: string;
  canWrite?: boolean;
  task: ProjectTaskCard | null;
  seats: readonly ProjectSeat[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('projects');
  const tt = useTranslations('tasks');
  const tc = useTranslations('common');
  const tz = browserTimeZone();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [checklist, setChecklist] = useState<TaskChecklistStep[]>([]);
  const [titleError, setTitleError] = useState(false);
  const [stepError, setStepError] = useState(false);
  const [recurrenceOverride, setRecurrenceOverride] = useState<ProjectTaskRecurrenceView | null>(null);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());

  const update = useMutation(orpc.tasks.update.mutationOptions());

  useEffect(() => {
    if (open && task) {
      setTitle(task.title);
      setDescription(task.description ?? '');
      setAssignee(task.assigneePositionId ?? '');
      setDueOn(taskDueDay(task.due, tz));
      setChecklist((task.checklist ?? []).map((s) => ({ ...s })));
      setTitleError(false);
      setStepError(false);
      setRecurrenceOverride(null);
      setIdemKey(crypto.randomUUID());
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  if (!task) return null;

  const titleField = fieldControl(`edit-project-task-${task.id}`, { error: titleError });
  const activeSeats = seats.filter((s) => s.status !== 'archived' || s.id === task.assigneePositionId);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (task.checkedOut) return;
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
    const initialDueOn = taskDueDay(task.due, tz);
    const nextChecklist = normalizeChecklistSteps(checklist);
    const checklistChanged = serializeTaskChecklist(nextChecklist) !== serializeTaskChecklist(task.checklist ?? []);
    const patch = {
      ...(nextTitle !== task.title ? { title: nextTitle } : {}),
      ...(description !== (task.description ?? '') ? { description: nextDesc } : {}),
      ...(nextAssignee !== task.assigneePositionId ? { assigneePositionId: nextAssignee } : {}),
      ...(dueOn !== initialDueOn ? { due: taskDueFromDay(dueOn, tz) } : {}),
      ...(checklistChanged ? { checklist: nextChecklist } : {}),
    };
    if (Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }
    update.mutate(
      { id: task.id, ...patch, idempotencyKey: idemKey },
      {
        onSuccess: () => {
          refreshProjectQueries();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc('close')} data-testid="edit-project-task-dialog">
        <DialogHeader>
          <DialogTitle>{t('modals.editTaskTitle')}</DialogTitle>
          <DialogDescription>
            <Link
              to="/o/$slug/tasks/$id"
              params={{ slug, id: task.id }}
              className="rounded text-xs text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('task.openDetail')}
            </Link>
          </DialogDescription>
        </DialogHeader>
        {task.checkedOut && (
          <Alert className="border-warning/30 bg-warning/10">
            <NavIcon name="agents" className="text-warning" />
            <AlertDescription className="text-xs text-foreground">{t('task.checkedOutLocked')}</AlertDescription>
          </Alert>
        )}
        <form noValidate onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={titleField.id}>{t('modals.taskTitleLabel')}</Label>
            <Input
              {...titleField}
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
          <TaskChecklistEditor
            idPrefix={`edit-project-task-${task.id}`}
            disabled={task.checkedOut}
            label={t('modals.taskChecklistLabel')}
            value={checklist}
            stepError={stepError}
            onChange={(next) => {
              setChecklist(next);
              if (stepError && !hasBlankChecklistStep(next)) setStepError(false);
            }}
          />
          {update.error && <ErrorText>{errorMessage(update.error)}</ErrorText>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{tc('cancel')}</DialogClose>
            <Button type="submit" disabled={task.checkedOut} loading={update.isPending}>
              {t('modals.saveTask')}
            </Button>
          </DialogFooter>
        </form>
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
      </DialogContent>
    </Dialog>
  );
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
  const t = useTranslations('projects');
  const tc = useTranslations('common');

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
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

  useEffect(() => {
    if (open) {
      setName(project.name);
      setDescription(project.description ?? '');
      setNameError(false);
      update.reset();
      setStatus.reset();
      setOwner.reset();
      addMember.reset();
      removeMember.reset();
      archive.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id]);

  const editable = project.canManage && project.status !== 'archived';
  const nameField = fieldControl(`settings-project-name-${project.id}`, { error: nameError });
  const mutationError = update.error ?? setStatus.error ?? setOwner.error ?? addMember.error ?? removeMember.error ?? archive.error;
  const eligibleOwners = members.filter((m) => m.role !== 'viewer');
  const projectMemberCount = members.filter((m) => m.onProject).length;

  const saveDetails = (e: FormEvent) => {
    e.preventDefault();
    if (!editable) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(true);
      return;
    }
    const nextDesc = description.trim() ? description.trim() : null;
    update.mutate({
      projectId: project.id,
      name: trimmed,
      description: nextDesc,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc('close')} className="sm:max-w-lg" data-testid="project-settings-dialog">
        <DialogHeader>
          <DialogTitle>{t('modals.editProjectTitle')}</DialogTitle>
          <DialogDescription>
            <Badge variant={projectStatusVariant(project.status)}>{t(`status.${project.status}`)}</Badge>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {mutationError && <ErrorText>{errorMessage(mutationError)}</ErrorText>}

          <form noValidate onSubmit={saveDetails} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={nameField.id}>{t('modals.nameLabel')}</Label>
              <Input
                {...nameField}
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
            {editable && (
              <div className="flex justify-end">
                <Button type="submit" size="sm" loading={update.isPending}>
                  {t('modals.saveDetails')}
                </Button>
              </div>
            )}
          </form>

          <div className="grid gap-3 border-t pt-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`settings-status-${project.id}`}>{t('modals.statusLabel')}</Label>
              <NativeSelect
                id={`settings-status-${project.id}`}
                className="w-full"
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
                className="w-full"
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
            <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border">
              {members.map((m) => {
                const adding = addMember.isPending && addMember.variables?.userId === m.userId;
                const removing = removeMember.isPending && removeMember.variables?.userId === m.userId;
                return (
                  <li key={m.userId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{memberLabel(m)}</p>
                      <p className="text-xs text-muted-foreground">
                        {m.onProject ? t('modals.memberInProject') : t('modals.memberNotInProject')}
                      </p>
                    </div>
                    {editable &&
                      (m.onProject ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
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

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{tc('close')}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
