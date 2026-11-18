// SPDX-License-Identifier: AGPL-3.0-only
// Create and edit a task in the shared side panel (owner rule of 2026-11-17, DESIGN.md 4.5, #3606): the list stays the first thing on
// the screen and the form opens over it. Creating asks for the title first, then who and when; the description and the steps come in
// the same panel once the task exists (edit). Typing a title that an open task already has shows it, with a link, before anything is saved.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { serializeTaskChecklist, type TaskChecklistStep } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { OPEN_TASK_STATUSES, taskDueDay, taskDueFromDay } from '../lib/agents.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { browserTimeZone } from '../lib/my-work.ts';
import { duplicateTaskSearch, findDuplicateTask } from '../lib/task-duplicate.ts';
import { useDebounced } from '../lib/use-debounced.ts';
import { DateInput } from './date-input.tsx';
import { DuplicateHint, FormPanel } from './form-panel.tsx';
import { TaskChecklistEditor, hasBlankChecklistStep, normalizeChecklistSteps } from './task-checklist.tsx';
import { ErrorText, FieldError, ListSkeleton, fieldControl } from './ui.tsx';

type Chart = Awaited<ReturnType<typeof orpc.chart.get.call>>;
type TaskDetail = Awaited<ReturnType<typeof orpc.tasks.get.call>>['task'];

const refresh = () => void queryClient.invalidateQueries();

// The positions a task can be given to: the live ones, and the one it already has even if it was archived since.
function assignable(chart: Chart | undefined, current: string | null) {
  return (chart?.positions ?? []).filter((p) => p.status !== 'archived' || p.id === current);
}

export function NewTaskPanel({ chart, onClose }: { chart: Chart | undefined; onClose: () => void }) {
  const t = useTranslations('tasks');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState(false);
  // The owners are the default: in a one-person company that is the person.
  const [assignee, setAssignee] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const create = useMutation(orpc.tasks.create.mutationOptions({ onSuccess: refresh }));
  const titleField = fieldControl('new-task-title', { error: titleError });

  const typed = useDebounced(title, 250);
  const search = duplicateTaskSearch(typed);
  const matches = useQuery({
    ...orpc.tasks.list.queryOptions({ input: { status: [...OPEN_TASK_STATUSES], ...(search ? { filters: search } : {}) } }),
    enabled: search !== null,
  });
  // Only a result for the title as it is now counts: the search runs a moment behind the typing.
  const duplicate = search !== null && typed === title ? findDuplicateTask(title, matches.data ?? []) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) {
      setTitleError(true);
      return;
    }
    const due = taskDueFromDay(dueOn, browserTimeZone());
    create.mutate(
      { title: name, assigneePositionId: assignee || null, ...(due ? { due } : {}), idempotencyKey: key },
      { onSuccess: onClose },
    );
  };
  return (
    <FormPanel
      title={t('newTask')}
      description={t('newTaskHint')}
      busy={create.isPending}
      dirty={title.trim() !== '' || assignee !== '' || dueOn !== ''}
      onClose={onClose}
      onSubmit={submit}
      footer={(requestClose) => (
        <>
          <Button type="button" variant="outline" disabled={create.isPending} onClick={requestClose}>
            {t('cancel')}
          </Button>
          <Button loading={create.isPending} type="submit">
            {t('create')}
          </Button>
        </>
      )}
    >
      <label htmlFor={titleField.id} className="block text-xs">
        <span className="text-subtle-foreground">{t('newTitle')}</span>
        <Input
          {...titleField}
          autoFocus
          required
          maxLength={300}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (titleError && e.target.value.trim()) setTitleError(false);
          }}
          className="mt-1"
        />
        <FieldError id={titleField.id} className="mt-1">
          {titleError ? t('titleRequired') : null}
        </FieldError>
      </label>
      <DuplicateHint testId="task-duplicate">
        {duplicate && (
          <>
            {t('duplicate')}{' '}
            <Link to="/o/$slug/tasks/$id" params={{ slug, id: duplicate.id }} target="_blank" rel="noopener" className="text-link underline">
              {t('duplicateOpen', { title: duplicate.title })}
            </Link>
          </>
        )}
      </DuplicateHint>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('assignTo')}</span>
        <NativeSelect className="mt-1 w-full" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <NativeSelectOption value="">{t('rootAssignee')}</NativeSelectOption>
          {assignable(chart, null).map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.title}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('dueOptional')}</span>
        <DateInput value={dueOn} onChange={setDueOn} className="mt-1" aria-label={t('dueLabel')} />
      </label>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </FormPanel>
  );
}

// The panel of one task, opened from a row of the list or from the task's own page: it reads the task first (the list does not carry
// the description), then shows the form.
export function EditTaskPanel({ taskId, chart, onClose }: { taskId: string; chart: Chart | undefined; onClose: () => void }) {
  const t = useTranslations('tasks');
  // The task is read afresh each time the panel opens, and the form is built from that answer only: a copy left in the cache from an
  // earlier visit would show an old title or assignee, and the form keeps the values it starts from.
  const detail = useQuery({ ...orpc.tasks.get.queryOptions({ input: { id: taskId } }), refetchOnMount: 'always' });
  const [fresh, setFresh] = useState<{ task: TaskDetail } | null>(null);
  useEffect(() => {
    if (!fresh && detail.data && !detail.isFetching) setFresh({ task: detail.data.task });
  }, [fresh, detail.data, detail.isFetching]);
  if (fresh) {
    // An AI coworker holds the task: nothing can be changed until it lets go, so the panel says so and offers no form.
    if (fresh.task.checkedOut) {
      return (
        <FormPanel
          title={t('editTask')}
          description={fresh.task.title}
          onClose={onClose}
          footer={
            <Button type="button" variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">{t('checkedOut')}</p>
        </FormPanel>
      );
    }
    return <EditTaskForm key={fresh.task.id} task={fresh.task} chart={chart} onClose={onClose} />;
  }
  return (
    <FormPanel
      title={t('editTask')}
      busy={false}
      onClose={onClose}
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cancel')}
        </Button>
      }
    >
      {detail.error ? <ErrorText>{errorMessage(detail.error)}</ErrorText> : <ListSkeleton />}
    </FormPanel>
  );
}

function EditTaskForm({ task, chart, onClose }: { task: TaskDetail; chart: Chart | undefined; onClose: () => void }) {
  const t = useTranslations('tasks');
  const tz = browserTimeZone();
  const [initial] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [titleError, setTitleError] = useState(false);
  const [description, setDescription] = useState(task.description ?? '');
  const [assignee, setAssignee] = useState(task.assigneePositionId ?? '');
  const [dueOn, setDueOn] = useState(() => taskDueDay(task.due, tz));
  const [checklist, setChecklist] = useState<TaskChecklistStep[]>(() => (task.checklist ?? []).map((s) => ({ ...s })));
  const [stepError, setStepError] = useState(false);
  // What is typed in the new-step box and not added yet is input too.
  const [stepDraft, setStepDraft] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const update = useMutation(orpc.tasks.update.mutationOptions({ onSuccess: refresh }));
  const titleField = fieldControl(`task-${task.id}-title`, { error: titleError });

  // What differs from the task as it was opened: the patch the server gets, and what a close would throw away.
  const nextTitle = title.trim();
  const nextAssignee = assignee || null;
  const nextChecklist = normalizeChecklistSteps(checklist);
  const patch = {
    ...(nextTitle !== '' && nextTitle !== initial.title ? { title: nextTitle } : {}),
    ...(description !== (initial.description ?? '') ? { description: description.trim() ? description.trim() : null } : {}),
    ...(nextAssignee !== initial.assigneePositionId ? { assigneePositionId: nextAssignee } : {}),
    ...(dueOn !== taskDueDay(initial.due, tz) ? { due: taskDueFromDay(dueOn, tz) } : {}),
    ...(serializeTaskChecklist(nextChecklist) !== serializeTaskChecklist(initial.checklist ?? []) ? { checklist: nextChecklist } : {}),
  };
  const dirty = Object.keys(patch).length > 0 || title !== initial.title || stepDraft.trim() !== '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!nextTitle) {
      setTitleError(true);
      return;
    }
    if (hasBlankChecklistStep(checklist)) {
      setStepError(true);
      return;
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    update.mutate(
      { id: task.id, ...patch, idempotencyKey: key },
      {
        onSuccess: () => {
          setKey(crypto.randomUUID());
          onClose();
        },
      },
    );
  };
  return (
    <FormPanel
      title={t('editTask')}
      description={initial.title}
      busy={update.isPending}
      dirty={dirty}
      onClose={onClose}
      onSubmit={submit}
      footer={(requestClose) => (
        <>
          <Button type="button" variant="outline" disabled={update.isPending} onClick={requestClose}>
            {t('cancel')}
          </Button>
          <Button loading={update.isPending} type="submit">
            {t('save')}
          </Button>
        </>
      )}
    >
      <label htmlFor={titleField.id} className="block text-xs">
        <span className="text-subtle-foreground">{t('newTitle')}</span>
        <Input
          {...titleField}
          autoFocus
          required
          maxLength={300}
          value={title}
          onBlur={(e) => {
            if (!e.target.value.trim()) setTitleError(true);
          }}
          onChange={(e) => {
            setTitle(e.target.value);
            if (titleError && e.target.value.trim()) setTitleError(false);
          }}
          className="mt-1"
        />
        <FieldError id={titleField.id} className="mt-1">
          {titleError ? t('titleRequired') : null}
        </FieldError>
      </label>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('assignTo')}</span>
        <NativeSelect className="mt-1 w-full" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <NativeSelectOption value="">{t('rootAssignee')}</NativeSelectOption>
          {assignable(chart, task.assigneePositionId).map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.title}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('dueOptional')}</span>
        <DateInput value={dueOn} onChange={setDueOn} className="mt-1" aria-label={t('dueLabel')} />
      </label>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('description')}</span>
        <Textarea rows={3} maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1" />
      </label>
      <TaskChecklistEditor
        idPrefix={`edit-task-${task.id}`}
        value={checklist}
        onDraftChange={setStepDraft}
        stepError={stepError}
        onChange={(next) => {
          setChecklist(next);
          if (stepError && !hasBlankChecklistStep(next)) setStepError(false);
        }}
      />
      {update.error && <ErrorText>{errorMessage(update.error)}</ErrorText>}
    </FormPanel>
  );
}
