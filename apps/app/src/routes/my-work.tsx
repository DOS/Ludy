// "Việc của tôi" (My work, issues #1673 and #1674, notes plan docs/plan/notes.md §3.10, steps N4 and N5): the member's
// own to-dos, which nobody else in the org reads (ADR-0037), and the open tasks of the positions they hold, marked
// "Việc nhóm". Open ones sit in the groups Quá hạn, Hôm nay, 7 ngày tới, Sau đó and Không hạn, by the due day, the
// to-dos in the member's own order; done ones and the trash have their own tabs. Quick add at the top saves on Enter;
// N, J, K, X and E work the to-dos from the keyboard (DESIGN.md §5.2). A to-do can be handed over to a position as a
// team task, after the member confirms the text the team will read.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import {
  TODO_LIST_COLORS,
  TODO_LIST_NAME_MAX,
  TODO_LIST_SECTION_NAME_MAX,
  TODO_LIST_SECTIONS_MAX,
  TODO_PRIORITIES,
  type MyWorkTask,
  type NoteLinkTargetInput,
  type Todo,
  type TodoListColor,
  type TodoListSectionInput,
  type TodoListSort,
  type TodoListSummary,
  type TodoListView,
  type TodoPriority,
  type TodoSourceNote,
  type TodoStep,
  type TodoSummary,
} from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ProjectIcon } from '@crove/ui/components/project-icon';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Textarea } from '@crove/ui/components/textarea';
import { cn } from '@crove/ui/lib/utils';
import { DateInput } from '../components/date-input.tsx';
import { NoteLinks, RecordLinkAdder } from '../components/note-links.tsx';
import { TimeInput } from '../components/time-input.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { NotesSubnav } from '../components/notes-subnav.tsx';
import { refreshProjectQueries } from '../components/project-task-dialog.tsx';
import { TaskChecklistBadge } from '../components/task-checklist.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, clientForOrg, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { isModuleOff } from '../lib/errors.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { toast } from '../lib/toast.ts';
import {
  browserTimeZone,
  filterMyWork,
  groupTodos,
  groupTodosBySection,
  handOverDescription,
  moveTarget,
  myWorkProjects,
  myWorkShortcut,
  stepSelection,
  type MyWorkAction,
} from '../lib/my-work.ts';
import { parseTags, tagCounts } from '../lib/notes.ts';
import { projectsInstalled } from '../lib/projects.ts';

const LIST_COLOR_DOT: Record<TodoListColor, string> = {
  slate: 'bg-muted-foreground',
  blue: 'bg-label-blue',
  emerald: 'bg-label-green',
  amber: 'bg-label-yellow',
  rose: 'bg-label-red',
  violet: 'bg-label-purple',
};

const PRIORITY_BADGE_VARIANT: Record<TodoPriority, 'destructive' | 'warning' | 'brand' | 'outline'> = {
  1: 'destructive',
  2: 'warning',
  3: 'brand',
  4: 'outline',
};

function PriorityBadge({ priority }: { priority: TodoPriority }) {
  const t = useTranslations('myWork');
  if (priority === 4) return null;
  const label = t(`priorities.p${priority}`);
  return (
    <Badge variant={PRIORITY_BADGE_VARIANT[priority]} title={label} aria-label={label} data-testid="todo-priority-badge">
      <svg viewBox="0 0 12 12" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path d="M2.5 1.5v9M2.5 2h6.5l-1.5 2.5L9 7H2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {t('priorityShort', { level: String(priority) })}
    </Badge>
  );
}

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.notes.todos.key() });

// A result toast in the action's verb with an undo (DESIGN.md §4.5, #2003): the undo runs the inverse command, says it
// did, or why it could not, and reads the lists again. The inverse goes to the org the action ran in (clientForOrg),
// since the toast outlives a switch to another org.
function toastWithUndo(said: string, undone: string, inverse: () => Promise<unknown>, labels: { undo: string; failed: (reason: string) => string }) {
  const undo = async () => {
    try {
      await inverse();
      toast(undone);
    } catch (error) {
      toast(labels.failed(errorMessage(error)), 'error');
    } finally {
      refresh();
    }
  };
  toast(said, 'success', { action: { label: labels.undo, run: () => void undo() } });
}
type Chart = Awaited<ReturnType<typeof orpc.chart.get.call>>;
// The most to-dos one list shows; a longer list says so.
const LIST_LIMIT = 500;

function DueChip({ todo }: { todo: TodoSummary }) {
  const t = useTranslations('myWork');
  const f = useFormat();
  if (todo.dueOn === null) return null;
  const label = todo.dueTime ? t('dueAt', { day: f.date(todo.dueOn), time: todo.dueTime }) : f.date(todo.dueOn);
  return (
    <Badge variant={todo.overdue ? 'destructive' : 'outline'} data-testid="todo-due">
      {todo.overdue && <span className="sr-only">{t('overdue')}: </span>}
      {label}
    </Badge>
  );
}

/** Back-link chip in a My work row to the note a to-do was created from (step N7, #1676). */
export function TodoSourceBadge({ sourceNote, slug }: { sourceNote: TodoSourceNote | null | undefined; slug: string }) {
  const t = useTranslations('myWork');
  if (!sourceNote) return null;
  if (sourceNote.available) {
    return (
      <Link
        to="/o/$slug/notes"
        params={{ slug }}
        search={{ note: sourceNote.id }}
        data-testid="todo-source-note"
        aria-label={t('openSourceNote', { title: sourceNote.title ?? '' })}
        className="inline-flex max-w-44 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Badge variant="outline" className="max-w-full hover:bg-muted">
          <span className="truncate">{t('sourceNoteBadge', { title: sourceNote.title ?? '' })}</span>
        </Badge>
      </Link>
    );
  }
  return (
    <Badge variant="outline" className="text-subtle-foreground" data-testid="todo-source-note-unavailable">
      {t('sourceNoteUnavailable')}
    </Badge>
  );
}

/** Back-link section in the to-do detail editor to its source note (step N7, #1676). */
export function TodoSourceDetail({ sourceNote, slug }: { sourceNote: TodoSourceNote | null | undefined; slug: string }) {
  const t = useTranslations('myWork');
  if (!sourceNote) return null;
  return (
    <section className="space-y-1 text-sm" data-testid="todo-editor-source-note">
      <h3 className="text-xs font-medium text-muted-foreground">{t('sourceNote')}</h3>
      {sourceNote.available ? (
        <Link to="/o/$slug/notes" params={{ slug }} search={{ note: sourceNote.id }} data-testid="todo-detail-source-note" className="inline-block text-link hover:underline">
          {sourceNote.title ?? ''}
        </Link>
      ) : (
        <span className="text-subtle-foreground" data-testid="todo-detail-source-note-unavailable">
          {t('sourceNoteUnavailable')}
        </span>
      )}
    </section>
  );
}

// Hands a to-do over to a position as a team task (#1674). The dialog shows the title and description the team will
// read, proposed from the to-do and editable; nothing goes to the task but what the member confirms here. It hands over
// the to-do as saved, so it waits while the editor holds unsaved changes (`disabled`), and it says when the task is due.
function HandOverDialog({ todo, disabled, onDone }: { todo: Todo; disabled: boolean; onDone: () => void }) {
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const f = useFormat();
  const hasProjects = projectsInstalled();
  const chart = useQuery(orpc.chart.get.queryOptions());
  const positions = (chart.data?.positions ?? []).filter((p) => p.status !== 'archived');
  const [open, setOpen] = useState(false);
  const [positionId, setPositionId] = useState('');
  const [projectId, setProjectId] = useState('');
  const projects = useQuery({
    ...orpc.projects.list.queryOptions({ input: {} }),
    enabled: open && hasProjects,
    retry: (count, error) => !isModuleOff(error) && count < 1,
  });
  const projectsActive = hasProjects && !isModuleOff(projects.error);
  const activeProjects = (projects.data?.projects ?? []).filter((p) => p.status !== 'archived');
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(() => handOverDescription(todo));
  const handOver = useMutation({
    mutationFn: (v: { positionId: string; projectId: string; title: string; description: string }) =>
      client.notes.todos.handOver({
        todoId: todo.id,
        revision: todo.revision,
        positionId: v.positionId,
        ...(v.projectId ? { projectId: v.projectId } : {}),
        title: v.title.trim(),
        description: v.description,
      }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
      if (hasProjects) void refreshProjectQueries();
      setOpen(false);
      onDone();
    },
  });
  const resetForm = () => {
    setPositionId('');
    setProjectId('');
    setTitle(todo.title);
    setDescription(handOverDescription(todo));
    handOver.reset();
  };
  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) resetForm();
    else handOver.reset();
  };
  // The dialog renders in a portal but sits inside the editor's form in React's tree, so its submit stops here and
  // never saves the editor (the editor ignores keys from outside its own form).
  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (positionId && title.trim() && !handOver.isPending) handOver.mutate({ positionId, projectId, title, description });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button type="button" variant="outline" disabled={disabled} title={disabled ? t('handOverSaveFirst') : undefined} onClick={() => onOpenChange(true)} data-testid="todo-hand-over">
        {t('handOver')}
      </Button>
      <DialogContent closeLabel={common('close')} className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('handOverTitle')}</DialogTitle>
            <DialogDescription>{t('handOverHint')}</DialogDescription>
          </DialogHeader>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('handOverPosition')}</span>
            <NativeSelect required className="mt-1 w-full" value={positionId} onChange={(e) => setPositionId(e.target.value)} data-testid="hand-over-position">
              <NativeSelectOption value="">{t('handOverPick')}</NativeSelectOption>
              {positions.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.holder?.type === 'agent' ? t('handOverAgentHeld', { position: p.title }) : p.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {projectsActive && (
            <label className="block text-xs">
              <span className="text-subtle-foreground">{t('handOverProject')}</span>
              <NativeSelect className="mt-1 w-full" value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="hand-over-project">
                <NativeSelectOption value="">{t('handOverNoProject')}</NativeSelectOption>
                {activeProjects.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          )}
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('handOverTaskTitle')}</span>
            <Input required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('handOverDescription')}</span>
            <Textarea rows={6} maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1" />
          </label>
          <p className="text-xs text-subtle-foreground" data-testid="hand-over-due">
            {todo.dueOn === null ? t('handOverNoDue') : t('handOverDue', { due: todo.dueTime ? t('dueAt', { day: f.date(todo.dueOn), time: todo.dueTime }) : f.date(todo.dueOn) })}
          </p>
          {chart.data && positions.length === 0 && <p className="text-xs text-subtle-foreground">{t('handOverNoPositions')}</p>}
          {projectsActive && projects.error && <ErrorText>{errorMessage(projects.error)}</ErrorText>}
          {handOver.error && <ErrorText>{errorMessage(handOver.error)}</ErrorText>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{common('cancel')}</DialogClose>
            <Button loading={handOver.isPending} type="submit" disabled={!positionId || !title.trim() || handOver.isPending}>
              {t('handOverConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function positionTitle(chart: Chart | undefined, id: string | null, root: string, unknown: string): string {
  if (id === null) return root;
  return chart?.positions.find((p) => p.id === id)?.title ?? unknown;
}

// A team task of a position the member holds (#1674): read here, worked on the task's own page.
function TaskRow({ task, slug, chart, projectsActive }: { task: MyWorkTask; slug: string; chart: Chart | undefined; projectsActive: boolean }) {
  const t = useTranslations('myWork');
  const tt = useTranslations('tasks');
  const f = useFormat();
  return (
    <li data-testid="my-work-task" className="flex flex-wrap items-center gap-3 px-4 py-2">
      <Badge variant="secondary">{t('teamTask')}</Badge>
      <Link to="/o/$slug/tasks/$id" params={{ slug, id: task.id }} className="min-w-0 flex-1 truncate text-sm text-link hover:underline">
        {task.title}
      </Link>
      {projectsActive && task.project && (
        <Link
          to="/o/$slug/projects/$id"
          params={{ slug, id: task.project.id }}
          data-testid="my-work-task-project"
          className="inline-flex max-w-44 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Badge variant="outline" className="max-w-full hover:bg-muted">
            <span className="truncate">{task.project.name}</span>
          </Badge>
        </Link>
      )}
      {task.tainted && (
        <Badge variant="warning" title={tt('taintedHint')}>
          {tt('tainted')}
        </Badge>
      )}
      <span className="text-xs text-subtle-foreground">{positionTitle(chart, task.positionId, tt('rootAssignee'), tt('unknownPosition'))}</span>
      {task.steps && task.steps.total > 0 && (
        <TaskChecklistBadge
          steps={task.steps}
          label={t('stepsDone', { done: String(task.steps.done), total: String(task.steps.total) })}
        />
      )}
      {task.due && (
        <Badge variant={task.overdue ? 'destructive' : 'outline'}>
          {task.overdue && <span className="sr-only">{t('overdue')}: </span>}
          {f.dateTime(task.due)}
        </Badge>
      )}
    </li>
  );
}

// The editor of one to-do: title, details, checklist steps, the due day and time and whether to be reminded (#1675),
// saved against its revision. The reminder is on unless the member turned it off: a to-do with a due day and no
// reminder had it turned off (or its time had passed when it was written). Untouched, the box sends nothing and the
// server keeps the reminder, moving an automatic one with the due day; a time picked elsewhere stays.
function TodoEditor({ todo, lists, onClose }: { todo: Todo; lists: readonly TodoListSummary[]; onClose: () => void }) {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const f = useFormat();
  const [title, setTitle] = useState(todo.title);
  const [details, setDetails] = useState(todo.details);
  const [steps, setSteps] = useState<TodoStep[]>(todo.checklist);
  const [newStep, setNewStep] = useState('');
  const [priority, setPriority] = useState<TodoPriority>(todo.priority);
  const [tagsInput, setTagsInput] = useState(todo.tags.join(', '));
  const [listId, setListId] = useState<string>(todo.listId ?? '');
  const [sectionId, setSectionId] = useState<string>(todo.sectionId ?? '');
  const [dueOn, setDueOn] = useState(todo.dueOn ?? '');
  const [dueTime, setDueTime] = useState(todo.dueTime ?? '');
  const [remind, setRemind] = useState(todo.remindAt !== null || todo.dueOn === null);
  const [remindTouched, setRemindTouched] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const selectedList = lists.find((l) => l.id === listId);
  const availableSections = selectedList?.sections ?? [];
  const parsedTags = parseTags(
    tagsInput
      .split(',')
      .map((tag) => tag.trim().replace(/^#+/, ''))
      .join(','),
  );
  // A change not saved yet: the hand-over waits for it, so it never hands over a to-do other than the one shown.
  const dirty =
    title !== todo.title ||
    details !== todo.details ||
    JSON.stringify(steps) !== JSON.stringify(todo.checklist) ||
    priority !== todo.priority ||
    JSON.stringify(parsedTags) !== JSON.stringify(todo.tags) ||
    (listId || null) !== todo.listId ||
    (sectionId || null) !== todo.sectionId ||
    dueOn !== (todo.dueOn ?? '') ||
    dueTime !== (todo.dueTime ?? '') ||
    remind !== (todo.remindAt !== null || todo.dueOn === null) ||
    newStep.trim() !== '';
  // The values of one save are its variables, so an edit made while it runs does not change what it sends.
  const save = useMutation({
    mutationFn: (v: {
      title: string;
      details: string;
      steps: TodoStep[];
      priority: TodoPriority;
      tags: string[];
      listId: string | null;
      sectionId: string | null;
      dueOn: string;
      dueTime: string;
      remind: boolean;
      remindTouched: boolean;
    }) =>
      client.notes.todos.update({
        todoId: todo.id,
        revision: todo.revision,
        title: v.title.trim(),
        details: v.details,
        checklist: v.steps,
        priority: v.priority,
        tags: v.tags,
        listId: v.listId,
        sectionId: v.listId === null ? null : v.sectionId,
        dueOn: v.dueOn || null,
        dueTime: v.dueOn && v.dueTime ? v.dueTime : null,
        // A due day is read in the zone the to-do was written in, unless it gets a new day here.
        timeZone: v.dueOn && v.dueOn !== todo.dueOn ? browserTimeZone() : todo.timeZone,
        ...(v.remindTouched ? { reminder: v.remind ? ('auto' as const) : ('off' as const) } : {}),
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => client.notes.todos.delete({ todoId: todo.id }),
    onSuccess: () => {
      refresh();
      onClose();
      toastWithUndo(t('deletedToast', { title: todo.title }), t('undoneToast', { title: todo.title }), () => clientForOrg(slug).notes.todos.restore({ todoId: todo.id }), {
        undo: common('undo'),
        failed: (reason) => common('undoFailed', { reason }),
      });
    },
  });
  const linkAdd = useMutation({
    mutationFn: (target: NoteLinkTargetInput) => client.notes.todos.linkAdd({ todoId: todo.id, ...target }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: orpc.notes.panel.key() });
    },
  });
  const linkRemove = useMutation({
    mutationFn: (linkId: string) => client.notes.todos.linkRemove({ linkId }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: orpc.notes.panel.key() });
    },
  });
  const addStep = () => {
    const text = newStep.trim();
    if (!text || steps.length >= 50) return;
    setSteps([...steps, { text, done: false }]);
    setNewStep('');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) {
      save.mutate({
        title,
        details,
        steps,
        priority,
        tags: parsedTags,
        listId: listId || null,
        sectionId: sectionId || null,
        dueOn,
        dueTime,
        remind,
        remindTouched,
      });
    }
  };
  return (
    <div className="mt-2 border-t pt-3" data-testid="todo-editor">
      {todo.tainted && (
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="proposal" title={t('taintedTodoHint')} data-testid="todo-editor-tainted-badge">
            {t('proposalMark')}
          </Badge>
        </div>
      )}
      <form onSubmit={submit} className="space-y-3" onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.contains(e.target as Node) && onClose()}>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('fieldTitle')}</span>
          <Input ref={titleRef} required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
        </label>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('fieldDetails')}</span>
          <Textarea rows={3} maxLength={10000} value={details} onChange={(e) => setDetails(e.target.value)} className="mt-1" />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-xs text-subtle-foreground">{t('checklist')}</legend>
          <ul className="space-y-1">
            {steps.map((step, i) => (
              <li key={i} className="flex items-center gap-2" data-testid="todo-step">
                <Checkbox
                  checked={step.done}
                  aria-label={t('stepDone', { step: step.text })}
                  onCheckedChange={(checked) => setSteps(steps.map((s, j) => (j === i ? { ...s, done: checked === true } : s)))}
                />
                <Input
                  aria-label={t('stepText', { n: String(i + 1) })}
                  maxLength={300}
                  value={step.text}
                  onChange={(e) => setSteps(steps.map((s, j) => (j === i ? { ...s, text: e.target.value } : s)))}
                  className={cn('h-8', step.done && 'text-subtle-foreground line-through')}
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                  {t('removeStep')}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input
              aria-label={t('newStep')}
              placeholder={t('newStep')}
              maxLength={300}
              value={newStep}
              onChange={(e) => setNewStep(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addStep();
                }
              }}
              className="h-8"
            />
            <Button type="button" variant="outline" size="sm" onClick={addStep} disabled={!newStep.trim() || steps.length >= 50}>
              {t('addStep')}
            </Button>
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('fieldPriority')}</span>
            <NativeSelect
              data-testid="todo-editor-priority"
              aria-label={t('fieldPriority')}
              value={String(priority)}
              onChange={(e) => setPriority(Number(e.target.value) as TodoPriority)}
              className="mt-1 h-9 w-full text-xs sm:h-8"
            >
              {TODO_PRIORITIES.map((p) => (
                <NativeSelectOption key={p} value={String(p)}>
                  {t(`priorities.p${p}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('fieldTags')}</span>
            <Input
              data-testid="todo-editor-tags"
              aria-label={t('fieldTags')}
              placeholder={t('tagsPlaceholder')}
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              className="mt-1 h-9 text-xs sm:h-8"
            />
          </label>
        </div>
        {parsedTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {parsedTags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs font-normal">
                #{tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('fieldList')}</span>
            <NativeSelect
              data-testid="todo-editor-list"
              aria-label={t('fieldList')}
              value={listId}
              onChange={(e) => {
                const nextId = e.target.value;
                setListId(nextId);
                const nextList = lists.find((l) => l.id === nextId);
                if (!nextList || !nextList.sections.some((s) => s.id === sectionId)) {
                  setSectionId('');
                }
              }}
              className="mt-1 h-9 w-full text-xs sm:h-8"
            >
              <NativeSelectOption value="">{t('listInbox')}</NativeSelectOption>
              {lists.map((l) => (
                <NativeSelectOption key={l.id} value={l.id}>
                  {l.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {listId && availableSections.length > 0 && (
            <label className="block text-xs">
              <span className="text-subtle-foreground">{t('fieldSection')}</span>
              <NativeSelect
                data-testid="todo-editor-section"
                aria-label={t('fieldSection')}
                value={sectionId}
                onChange={(e) => setSectionId(e.target.value)}
                className="mt-1 h-9 w-full text-xs sm:h-8"
              >
                <NativeSelectOption value="">{t('noSection')}</NativeSelectOption>
                {availableSections.map((s) => (
                  <NativeSelectOption key={s.id} value={s.id}>
                    {s.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('fieldDueOn')}</span>
            <DateInput value={dueOn} onChange={setDueOn} className="mt-1" aria-label={t('fieldDueOn')} />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('fieldDueTime')}</span>
            <TimeInput value={dueTime} onChange={setDueTime} disabled={!dueOn} className="mt-1" aria-label={t('fieldDueTime')} />
          </label>
        </div>
        <label className="flex items-start gap-2 text-xs">
          <Checkbox
            checked={remind && (dueOn !== '' || todo.remindAt !== null)}
            disabled={!dueOn && todo.remindAt === null}
            onCheckedChange={(checked) => {
              setRemind(checked === true);
              setRemindTouched(true);
            }}
            className="mt-0.5"
            data-testid="todo-remind"
          />
          <span>
            <span className="block text-foreground">{t('fieldRemind')}</span>
            <span className="block text-subtle-foreground">
              {todo.remindAt && Date.parse(todo.remindAt) > Date.now() && remind && !remindTouched && dueOn === (todo.dueOn ?? '') && dueTime === (todo.dueTime ?? '')
                ? t('remindAt', { time: f.dateTime(todo.remindAt) })
                : t('remindHint')}
            </span>
          </span>
        </label>
        <TodoSourceDetail sourceNote={todo.sourceNote} slug={slug} />
        <NoteLinks
          links={todo.links}
          slug={slug}
          onRemove={todo.deletedAt === null ? (linkId) => linkRemove.mutate(linkId) : undefined}
          removingId={linkRemove.isPending ? linkRemove.variables : undefined}
        />
        {linkRemove.error && <ErrorText>{errorMessage(linkRemove.error)}</ErrorText>}
        {todo.deletedAt === null && (
          <RecordLinkAdder
            existingLinks={todo.links}
            onAdd={(target) => linkAdd.mutateAsync(target)}
            adding={linkAdd.isPending}
            error={linkAdd.error}
            onClearError={() => linkAdd.reset()}
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button loading={save.isPending} type="submit" disabled={save.isPending || !title.trim()}>
            {t('save')}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          {todo.status === 'open' && todo.deletedAt === null && <HandOverDialog todo={todo} disabled={dirty} onDone={onClose} />}
          <Button type="button" variant="destructive" className="ml-auto" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t('delete')}
          </Button>
        </div>
        {dirty && todo.status === 'open' && <p className="text-xs text-subtle-foreground">{t('handOverSaveFirst')}</p>}
        {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      </form>
    </div>
  );
}

function EditorFor({ id, lists, onClose }: { id: string; lists: readonly TodoListSummary[]; onClose: () => void }) {
  const todo = useQuery(orpc.notes.todos.get.queryOptions({ input: { todoId: id } }));
  if (todo.isPending) return <ListSkeleton rows={1} />;
  if (todo.error) return <ErrorText>{errorMessage(todo.error)}</ErrorText>;
  // Keyed by revision, so a change saved elsewhere opens fresh.
  return <TodoEditor key={`${todo.data.id}:${todo.data.revision}`} todo={todo.data} lists={lists} onClose={onClose} />;
}

function ListEditDialog({
  mode,
  list,
  open,
  onOpenChange,
  onDeleted,
  onCreated,
}: {
  mode: 'create' | 'edit';
  list: TodoListSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (deletedId: string) => void;
  onCreated: (createdId: string) => void;
}) {
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const [name, setName] = useState(list?.name ?? '');
  const [color, setColor] = useState<TodoListColor | null>(list?.color ?? null);
  const [sections, setSections] = useState<TodoListSectionInput[]>(list?.sections ?? []);
  const [newSection, setNewSection] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(list?.name ?? '');
    setColor(list?.color ?? null);
    setSections(list?.sections ?? []);
    setNewSection('');
    setConfirmDelete(false);
  }, [open, list]);

  const create = useMutation({
    mutationFn: (v: { name: string; color: TodoListColor | null; sections: TodoListSectionInput[] }) =>
      client.notes.todos.lists.create({ name: v.name, color: v.color, sections: v.sections }),
    onSuccess: (res, v) => {
      refresh();
      toast(t('listCreatedToast', { name: v.name }), 'success');
      onCreated(res.listId);
      onOpenChange(false);
    },
  });

  const update = useMutation({
    mutationFn: (v: { listId: string; revision: number; name: string; color: TodoListColor | null; sections: TodoListSectionInput[] }) =>
      client.notes.todos.lists.update(v),
    onSuccess: (_res, v) => {
      refresh();
      toast(t('listUpdatedToast', { name: v.name }), 'success');
      onOpenChange(false);
    },
  });

  const remove = useMutation({
    mutationFn: (listId: string) => client.notes.todos.lists.delete({ listId }),
    onSuccess: (_res, listId) => {
      refresh();
      toast(t('listDeletedToast', { name: list?.name ?? name }), 'success');
      onDeleted(listId);
      onOpenChange(false);
    },
  });

  const addSection = () => {
    const trimmed = newSection.trim();
    if (!trimmed || sections.length >= TODO_LIST_SECTIONS_MAX) return;
    setSections([...sections, { name: trimmed }]);
    setNewSection('');
  };

  const moveSection = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= sections.length) return;
    const copy = [...sections];
    const [picked] = copy.splice(index, 1);
    if (!picked) return;
    copy.splice(target, 0, picked);
    setSections(copy);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const cleanSections = sections
      .map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name.trim() }))
      .filter((s) => s.name !== '');
    if (mode === 'create' || !list) {
      if (!create.isPending) create.mutate({ name: trimmed, color, sections: cleanSections });
    } else if (!update.isPending) {
      update.mutate({ listId: list.id, revision: list.revision, name: trimmed, color, sections: cleanSections });
    }
  };

  const busy = create.isPending || update.isPending || remove.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={common('close')} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('newList') : t('editList')}</DialogTitle>
          <DialogDescription className="sr-only">{mode === 'create' ? t('newList') : t('editList')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('listNameLabel')}</span>
            <Input
              autoFocus
              required
              maxLength={TODO_LIST_NAME_MAX}
              placeholder={t('newListPlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="list-dialog-name"
              className="mt-1"
            />
          </label>
          <div className="space-y-1.5 text-xs">
            <span className="block text-subtle-foreground">{t('listColorLabel')}</span>
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant={color === null ? 'secondary' : 'outline'}
                onClick={() => setColor(null)}
              >
                {t('listColorNone')}
              </Button>
              {TODO_LIST_COLORS.map((c) => (
                <Button
                  key={c}
                  type="button"
                  size="sm"
                  variant={color === c ? 'secondary' : 'outline'}
                  onClick={() => setColor(c)}
                  data-testid={`list-color-${c}`}
                >
                  <span className={cn('size-2.5 rounded-full', LIST_COLOR_DOT[c])} aria-hidden="true" />
                  {t(`listColors.${c}`)}
                </Button>
              ))}
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs text-subtle-foreground">{t('sectionsTitle')}</legend>
            {sections.length > 0 && (
              <ul className="space-y-1.5">
                {sections.map((s, i) => (
                  <li key={s.id ?? `new-${i}`} className="flex items-center gap-1.5" data-testid="list-dialog-section-row">
                    <Input
                      aria-label={t('renameSection')}
                      maxLength={TODO_LIST_SECTION_NAME_MAX}
                      value={s.name}
                      onChange={(e) => setSections(sections.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      className="h-8 text-xs"
                    />
                    <Button type="button" size="icon-xs" variant="ghost" disabled={i === 0} aria-label={t('moveSectionUp', { name: s.name })} onClick={() => moveSection(i, -1)}>
                      <ProjectIcon name="arrowUp" className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={i === sections.length - 1}
                      aria-label={t('moveSectionDown', { name: s.name })}
                      onClick={() => moveSection(i, 1)}
                    >
                      <ProjectIcon name="arrowDown" className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('removeSection', { name: s.name })}
                      onClick={() => setSections(sections.filter((_, j) => j !== i))}
                    >
                      <ProjectIcon name="remove" className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Input
                aria-label={t('addSectionPlaceholder')}
                placeholder={t('addSectionPlaceholder')}
                maxLength={TODO_LIST_SECTION_NAME_MAX}
                value={newSection}
                onChange={(e) => setNewSection(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addSection();
                  }
                }}
                data-testid="list-dialog-new-section"
                className="h-8 text-xs"
              />
              <Button type="button" size="sm" variant="outline" onClick={addSection} disabled={!newSection.trim() || sections.length >= TODO_LIST_SECTIONS_MAX} data-testid="list-dialog-add-section">
                {t('addSection')}
              </Button>
            </div>
          </fieldset>
          {mode === 'edit' && list && confirmDelete && (
            <Alert className="border-destructive/30 bg-destructive/5">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>{t('deleteListHint', { name: list.name })}</span>
                <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => remove.mutate(list.id)} data-testid="list-dialog-confirm-delete">
                  {t('deleteListConfirm')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {(create.error || update.error || remove.error) && <ErrorText>{errorMessage(create.error ?? update.error ?? remove.error)}</ErrorText>}
          <DialogFooter className="flex-wrap gap-2">
            {mode === 'edit' && list && !confirmDelete && (
              <Button type="button" variant="destructive" className="mr-auto" disabled={busy} onClick={() => setConfirmDelete(true)} data-testid="list-dialog-delete">
                {t('deleteList')}
              </Button>
            )}
            <DialogClose render={<Button type="button" variant="outline" disabled={busy}>{common('cancel')}</Button>} />
            <Button type="submit" loading={create.isPending || update.isPending} disabled={busy || !name.trim()} data-testid="list-dialog-save">
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function QuickAdd({
  inputRef,
  listId,
  sectionId = null,
  label,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  listId: string | null;
  sectionId?: string | null;
  label?: string;
}) {
  const t = useTranslations('myWork');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TodoPriority>(4);
  const create = useMutation({
    mutationFn: (v: { title: string; priority: TodoPriority }) =>
      client.notes.todos.create({
        title: v.title,
        timeZone: browserTimeZone(),
        priority: v.priority,
        listId,
        sectionId,
      }),
    // Only what was sent is cleared: a title typed meanwhile stays.
    onSuccess: (_, sent) => {
      setTitle((current) => (current.trim() === sent.title ? '' : current));
      refresh();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (value && !create.isPending) create.mutate({ title: value, priority });
  };
  return (
    <form onSubmit={submit} className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={inputRef}
          aria-label={label ?? t('quickAdd')}
          placeholder={label ?? t('quickAdd')}
          maxLength={300}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
          className="min-w-0 flex-1"
        />
        <NativeSelect
          aria-label={t('fieldPriority')}
          data-testid={sectionId ? `quick-add-priority-${sectionId}` : 'quick-add-priority'}
          value={String(priority)}
          onChange={(e) => setPriority(Number(e.target.value) as TodoPriority)}
          className="h-9 w-28 shrink-0 text-xs sm:h-9"
        >
          {TODO_PRIORITIES.map((p) => (
            <NativeSelectOption key={p} value={String(p)}>
              {t(`priorities.p${p}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </form>
  );
}

export function MyWorkPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const f = useFormat();
  const [view, setView] = useState<TodoListView>('open');
  const [listFilter, setListFilter] = useState<'all' | 'inbox' | string>('all');
  const [tagFilter, setTagFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<TodoPriority | null>(null);
  const [sortMode, setSortMode] = useState<TodoListSort>('manual');
  const [projectFilter, setProjectFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [listDialog, setListDialog] = useState<{ mode: 'create'; list: null } | { mode: 'edit'; list: TodoListSummary } | null>(null);
  const quickAdd = useRef<HTMLInputElement>(null);
  const live = useStreamLive();
  // Read again every minute while the stream is down, and every few minutes anyway: the groups move with the clock
  // (midnight, a due time passing), which sends no hint. The open view also brings the tasks of my positions.
  const refetchInterval = pollEvery(live, 60_000, SAFETY_POLL_MS);
  const listsQuery = useQuery({ ...orpc.notes.todos.lists.list.queryOptions({ input: {} }), refetchInterval });
  const personalLists = listsQuery.data?.lists ?? [];
  const activeList = listFilter !== 'all' && listFilter !== 'inbox' ? personalLists.find((l) => l.id === listFilter) : undefined;
  const effectiveListFilter = listFilter === 'all' || listFilter === 'inbox' || activeList ? listFilter : 'all';
  const listById = useMemo(() => new Map(personalLists.map((l) => [l.id, l])), [personalLists]);

  const myWorkInput = useMemo(
    () => ({
      timeZone: browserTimeZone(),
      ...(effectiveListFilter !== 'all' ? { listId: effectiveListFilter } : {}),
      ...(tagFilter ? { tag: tagFilter } : {}),
      ...(priorityFilter !== null ? { priority: priorityFilter } : {}),
      ...(sortMode === 'priority' ? { sort: 'priority' as const } : {}),
    }),
    [effectiveListFilter, tagFilter, priorityFilter, sortMode],
  );
  const closedInput = useMemo(
    () => ({
      view,
      limit: LIST_LIMIT,
      ...(effectiveListFilter !== 'all' ? { listId: effectiveListFilter } : {}),
      ...(tagFilter ? { tag: tagFilter } : {}),
      ...(priorityFilter !== null ? { priority: priorityFilter } : {}),
    }),
    [view, effectiveListFilter, tagFilter, priorityFilter],
  );
  const work = useQuery({ ...orpc.notes.todos.myWork.queryOptions({ input: myWorkInput }), refetchInterval, enabled: view === 'open' });
  const closed = useQuery({ ...orpc.notes.todos.list.queryOptions({ input: closedInput }), refetchInterval, enabled: view !== 'open' });
  const list = view === 'open' ? work : closed;
  const chart = useQuery({ ...orpc.chart.get.queryOptions(), enabled: (work.data?.tasks.length ?? 0) > 0 });
  const todos = useMemo(() => (view === 'open' ? (work.data?.todos ?? []) : (closed.data ?? [])), [view, work.data, closed.data]);
  const tasks = useMemo(() => (view === 'open' && effectiveListFilter === 'all' ? (work.data?.tasks ?? []) : []), [view, effectiveListFilter, work.data]);
  const projectsActive = projectsInstalled() && work.data?.projectsAvailable !== false;
  const projectOptions = useMemo(() => (projectsActive ? myWorkProjects(tasks) : []), [projectsActive, tasks]);
  const effectiveProjectFilter =
    projectsActive && projectOptions.length > 0 && (projectFilter === 'none' || projectOptions.some((p) => p.id === projectFilter)) ? projectFilter : '';
  const filtered = useMemo(
    () => (view === 'open' ? filterMyWork(todos, tasks, effectiveProjectFilter) : { todos, tasks }),
    [view, todos, tasks, effectiveProjectFilter],
  );
  const groups = useMemo(() => (view === 'open' && !activeList ? groupTodos(filtered.todos, filtered.tasks) : []), [view, activeList, filtered.todos, filtered.tasks]);
  const sectionGroups = useMemo(
    () => (view === 'open' && activeList ? groupTodosBySection(filtered.todos, activeList.sections) : []),
    [view, activeList, filtered.todos],
  );
  const tagChips = useMemo(() => {
    const counts = tagCounts(todos);
    if (tagFilter && !counts.some((c) => c.tag === tagFilter)) {
      return [{ tag: tagFilter, count: todos.length }, ...counts];
    }
    return counts;
  }, [todos, tagFilter]);
  // The order J and K walk: as the screen shows the rows.
  const order = useMemo(
    () =>
      view === 'open'
        ? activeList
          ? sectionGroups.flatMap((s) => s.items.map((i) => i.id))
          : groups.flatMap((g) => g.items.map((i) => i.id))
        : todos.map((i) => i.id),
    [view, activeList, sectionGroups, groups, todos],
  );
  const visibleSelected = selected && order.includes(selected) ? selected : null;

  const act = useMutation({
    // A completion carries the to-do's title as shown when it was asked for: by the answer, the list may have moved on.
    mutationFn: (
      v: { what: 'complete'; todoId: string; title: string } | { what: 'reopen' | 'restore'; todoId: string } | { what: 'reorder'; todoId: string; place: 'before' | 'after'; anchorId: string },
    ) => {
      switch (v.what) {
        case 'reorder':
          return client.notes.todos.reorder({ todoId: v.todoId, place: v.place, anchorId: v.anchorId });
        case 'complete':
          return client.notes.todos.complete({ todoId: v.todoId });
        case 'reopen':
          return client.notes.todos.reopen({ todoId: v.todoId });
        case 'restore':
          return client.notes.todos.restore({ todoId: v.todoId });
      }
    },
    // Completing (the box or the X key) moves the to-do to Done: the toast says so and can open it again.
    onSuccess: (_done, v) => {
      if (v.what !== 'complete') return;
      const { title } = v;
      toastWithUndo(t('completedToast', { title }), t('undoneToast', { title }), () => clientForOrg(slug).notes.todos.reopen({ todoId: v.todoId }), {
        undo: common('undo'),
        failed: (reason) => common('undoFailed', { reason }),
      });
    },
    onSettled: refresh,
  });

  const shortcuts = useRef<Partial<Record<MyWorkAction, () => void>>>({});
  // The handlers of this render, set after it commits; the key listener reads them through the ref.
  useEffect(() => {
    shortcuts.current = {
      new: () => quickAdd.current?.focus(),
      next: () => setSelected(stepSelection(order, visibleSelected, 1)),
      previous: () => setSelected(stepSelection(order, visibleSelected, -1)),
      ...(visibleSelected && view === 'open' ? { done: () => act.mutate({ what: 'complete', todoId: visibleSelected, title: filtered.todos.find((x) => x.id === visibleSelected)?.title ?? '' }) } : {}),
      ...(visibleSelected && view === 'open' ? { edit: () => setEditing(visibleSelected) } : {}),
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = myWorkShortcut(event);
      const handler = action ? shortcuts.current[action] : undefined;
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The selected row stays in view as J and K move it.
  useEffect(() => {
    if (visibleSelected) document.querySelector(`[data-todo-id="${visibleSelected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [visibleSelected]);

  const row = (todo: TodoSummary, group: readonly TodoSummary[]) => {
    const up = view === 'open' && sortMode === 'manual' ? moveTarget(group, todo.id, 'up') : null;
    const down = view === 'open' && sortMode === 'manual' ? moveTarget(group, todo.id, 'down') : null;
    const todoList = todo.listId ? listById.get(todo.listId) : undefined;
    return (
      <li
        key={todo.id}
        data-todo-id={todo.id}
        data-testid="todo-row"
        aria-current={visibleSelected === todo.id ? 'true' : undefined}
        className={cn('flex flex-wrap items-center gap-2 px-4 py-2 sm:gap-3', visibleSelected === todo.id && 'bg-primary/5 ring-1 ring-primary/40 ring-inset')}
      >
        {(view === 'open' || view === 'done') && (todo.status === 'open' || todo.status === 'done') ? (
          <Checkbox
            checked={todo.status === 'done'}
            aria-label={todo.status === 'done' ? t('reopenTodo', { title: todo.title }) : t('completeTodo', { title: todo.title })}
            disabled={act.isPending}
            onCheckedChange={(checked) => act.mutate(checked === true ? { what: 'complete', todoId: todo.id, title: todo.title } : { what: 'reopen', todoId: todo.id })}
          />
        ) : view === 'open' || view === 'done' ? (
          // A handed-over to-do has no checkbox; the space keeps its title in line with the others.
          <span aria-hidden="true" className="size-4 shrink-0" />
        ) : null}
        <button
          type="button"
          data-testid="todo-title"
          className={cn('min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline focus-visible:underline focus-visible:outline-none', todo.status === 'done' && 'text-subtle-foreground line-through')}
          onClick={() => {
            setSelected(todo.id);
            if (view !== 'trash') setEditing(todo.id);
          }}
        >
          {todo.title}
        </button>
        <PriorityBadge priority={todo.priority} />
        {todo.tags.map((tag) => (
          <Button
            key={tag}
            type="button"
            variant={tagFilter === tag ? 'secondary' : 'outline'}
            size="sm"
            data-testid="todo-tag-chip"
            aria-label={t('tagShow', { tag })}
            onClick={() => {
              setTagFilter((current) => (current === tag ? '' : tag));
              setSelected(null);
            }}
            className="h-auto rounded-full px-2 py-0.5 text-xs font-normal"
          >
            #{tag}
          </Button>
        ))}
        {effectiveListFilter === 'all' && todoList && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="todo-list-badge"
            onClick={() => {
              setListFilter(todoList.id);
              setSelected(null);
            }}
            className="h-auto gap-1.5 rounded-full px-2 py-0.5 text-xs text-subtle-foreground"
          >
            <span className={cn('size-2 rounded-full', LIST_COLOR_DOT[todoList.color ?? 'slate'])} aria-hidden="true" />
            <span className="max-w-28 truncate">{todoList.name}</span>
          </Button>
        )}
        {todo.steps.total > 0 && (
          <span className="text-xs text-subtle-foreground" aria-label={t('stepsDone', { done: String(todo.steps.done), total: String(todo.steps.total) })}>
            {todo.steps.done}/{todo.steps.total}
          </span>
        )}
        <TodoSourceBadge sourceNote={todo.sourceNote} slug={slug} />
        {todo.tainted && (
          <Badge variant="proposal" title={t('taintedTodoHint')} data-testid="todo-tainted-badge">
            {t('proposalMark')}
          </Badge>
        )}
        <DueChip todo={todo} />
        {/* Handed over (#1674): the work is now the team's task, opened from here. */}
        {todo.status === 'handed_over' && todo.taskId && (
          <Link to="/o/$slug/tasks/$id" params={{ slug, id: todo.taskId }} data-testid="todo-handed-over" className="text-xs text-link hover:underline">
            <Badge variant="secondary">{t('handedOver')}</Badge> {t('openTask')}
          </Link>
        )}
        {view === 'done' && todo.doneAt && <span className="text-xs text-subtle-foreground">{t('doneOn', { at: f.dateTime(todo.doneAt) })}</span>}
        {view === 'open' && (
          <span className="flex gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={!up || act.isPending} aria-label={t('moveUp', { title: todo.title })} onClick={() => up && act.mutate({ what: 'reorder', todoId: todo.id, ...up })}>
              ↑
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={!down || act.isPending} aria-label={t('moveDown', { title: todo.title })} onClick={() => down && act.mutate({ what: 'reorder', todoId: todo.id, ...down })}>
              ↓
            </Button>
          </span>
        )}
        {view === 'trash' && (
          <Button type="button" variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ what: 'restore', todoId: todo.id })}>
            {t('restore')}
          </Button>
        )}
        {editing === todo.id && (
          <div className="basis-full">
            {/* A save or delete that ends after another to-do was opened leaves that one's editor open. */}
            <EditorFor id={todo.id} lists={personalLists} onClose={() => setEditing((current) => (current === todo.id ? null : current))} />
          </div>
        )}
      </li>
    );
  };

  const hasFilters = tagFilter !== '' || priorityFilter !== null || effectiveProjectFilter !== '';
  const clearFilters = () => {
    setTagFilter('');
    setPriorityFilter(null);
    setProjectFilter('');
    setSelected(null);
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <NotesSubnav slug={slug} active="my-work" />
      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)] md:items-start">
        <aside aria-label={t('listsTitle')} data-testid="my-work-lists-sidebar" className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-medium tracking-wide text-subtle-foreground uppercase">{t('listsTitle')}</h2>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="new-list-button"
              onClick={() => setListDialog({ mode: 'create', list: null })}
            >
              <ProjectIcon name="plus" className="size-3.5" />
              {t('newList')}
            </Button>
          </div>
          <nav className="flex flex-wrap gap-1.5 md:flex-col md:gap-1" aria-label={t('listsTitle')}>
            <Button
              type="button"
              variant={effectiveListFilter === 'all' ? 'secondary' : 'ghost'}
              size="sm"
              data-testid="list-nav-all"
              aria-current={effectiveListFilter === 'all' ? 'page' : undefined}
              onClick={() => {
                setListFilter('all');
                setSelected(null);
                setEditing(null);
              }}
              className="justify-between md:w-full"
            >
              <span className="truncate">{t('listAll')}</span>
            </Button>
            <Button
              type="button"
              variant={effectiveListFilter === 'inbox' ? 'secondary' : 'ghost'}
              size="sm"
              data-testid="list-nav-inbox"
              aria-current={effectiveListFilter === 'inbox' ? 'page' : undefined}
              onClick={() => {
                setListFilter('inbox');
                setSelected(null);
                setEditing(null);
              }}
              className="justify-between gap-2 md:w-full"
            >
              <span className="truncate">{t('listInbox')}</span>
              {listsQuery.data && <span className="text-xs text-subtle-foreground">{listsQuery.data.inboxCount}</span>}
            </Button>
            {personalLists.map((item) => (
              <div key={item.id} className="flex items-center gap-1 md:w-full">
                <Button
                  type="button"
                  variant={effectiveListFilter === item.id ? 'secondary' : 'ghost'}
                  size="sm"
                  data-testid="list-nav-item"
                  aria-current={effectiveListFilter === item.id ? 'page' : undefined}
                  onClick={() => {
                    setListFilter(item.id);
                    setSelected(null);
                    setEditing(null);
                  }}
                  className="min-w-0 flex-1 justify-between gap-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn('size-2.5 shrink-0 rounded-full', LIST_COLOR_DOT[item.color ?? 'slate'])} aria-hidden="true" />
                    <span className="truncate">{item.name}</span>
                  </span>
                  <span className="text-xs text-subtle-foreground">{item.openCount}</span>
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  data-testid="list-edit-button"
                  aria-label={`${t('editList')}: ${item.name}`}
                  onClick={() => setListDialog({ mode: 'edit', list: item })}
                >
                  <ProjectIcon name="edit" className="size-3.5" />
                </Button>
              </div>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 space-y-4">
          {activeList && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2" data-testid="selected-list-header">
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn('size-3 shrink-0 rounded-full', LIST_COLOR_DOT[activeList.color ?? 'slate'])} aria-hidden="true" />
                <h2 className="truncate text-base font-medium text-foreground">{activeList.name}</h2>
              </div>
              <Button type="button" size="sm" variant="outline" data-testid="edit-selected-list-button" onClick={() => setListDialog({ mode: 'edit', list: activeList })}>
                <ProjectIcon name="edit" className="size-3.5" />
                {t('editList')}
              </Button>
            </div>
          )}
          <QuickAdd inputRef={quickAdd} listId={activeList ? activeList.id : null} {...(activeList ? { label: t('quickAddInList', { name: activeList.name }) } : {})} />
          {view === 'open' && effectiveListFilter === 'all' && work.data?.noSeatHint && (
            <Alert className="border-border bg-muted/35" data-testid="my-work-no-seat-hint">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
                <span>{t('noSeatHint')}</span>
                <Link
                  to="/o/$slug/agents"
                  params={{ slug }}
                  className="rounded font-medium text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {t('openOrgChart')}
                </Link>
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs
              value={view}
              onValueChange={(value) => {
                setView(value as TodoListView);
                setSelected(null);
                setEditing(null);
              }}
            >
              <TabsList>
                <TabsTrigger value="open">{t('viewOpen')}</TabsTrigger>
                <TabsTrigger value="done">{t('viewDone')}</TabsTrigger>
                <TabsTrigger value="trash">{t('viewTrash')}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="my-work-priority-filter" className="sr-only">
                {t('priorityFilter')}
              </Label>
              <NativeSelect
                id="my-work-priority-filter"
                aria-label={t('priorityFilter')}
                data-testid="my-work-priority-filter"
                value={priorityFilter === null ? '' : String(priorityFilter)}
                onChange={(e) => {
                  setPriorityFilter(e.target.value ? (Number(e.target.value) as TodoPriority) : null);
                  setSelected(null);
                }}
                className="h-9 w-36 text-xs sm:h-8"
              >
                <NativeSelectOption value="">{t('allPriorities')}</NativeSelectOption>
                {TODO_PRIORITIES.map((p) => (
                  <NativeSelectOption key={p} value={String(p)}>
                    {t(`priorities.p${p}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {view === 'open' && (
                <>
                  <Label htmlFor="my-work-sort" className="sr-only">
                    {t('sortLabel')}
                  </Label>
                  <NativeSelect
                    id="my-work-sort"
                    aria-label={t('sortLabel')}
                    data-testid="my-work-sort"
                    value={sortMode}
                    onChange={(e) => {
                      setSortMode(e.target.value as TodoListSort);
                      setSelected(null);
                    }}
                    className="h-9 w-36 text-xs sm:h-8"
                  >
                    <NativeSelectOption value="manual">{t('sortManual')}</NativeSelectOption>
                    <NativeSelectOption value="priority">{t('sortPriority')}</NativeSelectOption>
                  </NativeSelect>
                </>
              )}
              {view === 'open' && effectiveListFilter === 'all' && projectsActive && projectOptions.length > 0 && (
                <div className="flex min-w-44 items-center gap-2">
                  <Label htmlFor="my-work-project-filter" className="sr-only">
                    {t('projectFilter')}
                  </Label>
                  <NativeSelect
                    id="my-work-project-filter"
                    aria-label={t('projectFilter')}
                    data-testid="my-work-project-filter"
                    value={effectiveProjectFilter}
                    onChange={(e) => {
                      setProjectFilter(e.target.value);
                      setSelected(null);
                      setEditing(null);
                    }}
                    className="h-9 w-full text-xs sm:h-8"
                  >
                    <NativeSelectOption value="">{t('allProjects')}</NativeSelectOption>
                    {projectOptions.map((project) => (
                      <NativeSelectOption key={project.id} value={project.id}>
                        {project.name}
                      </NativeSelectOption>
                    ))}
                    <NativeSelectOption value="none">{t('noProject')}</NativeSelectOption>
                  </NativeSelect>
                </div>
              )}
              {hasFilters && (
                <Button type="button" size="sm" variant="ghost" data-testid="clear-filters-button" onClick={clearFilters} className="h-9 px-2 text-xs sm:h-8">
                  {t('clearFilters')}
                </Button>
              )}
            </div>
          </div>
          {tagChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="my-work-tag-bar">
              {tagChips.map(({ tag, count }) => (
                <Button
                  key={tag}
                  type="button"
                  size="sm"
                  variant={tagFilter === tag ? 'secondary' : 'outline'}
                  data-testid={`tag-filter-${tag}`}
                  aria-pressed={tagFilter === tag}
                  onClick={() => {
                    setTagFilter((current) => (current === tag ? '' : tag));
                    setSelected(null);
                  }}
                  className="h-auto rounded-full px-2.5 py-0.5 text-xs"
                >
                  #{tag} ({count})
                </Button>
              ))}
              {tagFilter && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setTagFilter('')} className="h-auto px-2 py-0.5 text-xs">
                  {t('clearTagFilter', { tag: tagFilter })}
                </Button>
              )}
            </div>
          )}
          {list.isPending ? (
            <ListSkeleton />
          ) : list.error ? (
            <ErrorText>{errorMessage(list.error)}</ErrorText>
          ) : activeList && view === 'open' ? (
            sectionGroups.every((s) => s.items.length === 0) && activeList.sections.length === 0 ? (
              <Empty
                title={hasFilters ? t('emptyFiltered') : t('emptyList')}
                hint={hasFilters ? t('emptyFilteredHint') : t('emptyListHint')}
                action={
                  hasFilters ? (
                    <Button type="button" size="sm" variant="outline" onClick={clearFilters}>
                      {t('clearFilters')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              sectionGroups.map((sec) => (
                <section
                  key={sec.id ?? 'unsectioned'}
                  aria-labelledby={sec.id ? `todo-section-${sec.id}` : undefined}
                  data-testid={sec.id ? `todo-section-${sec.id}` : 'todo-section-unsectioned'}
                  className="space-y-2"
                >
                  {(sec.name !== null || activeList.sections.length > 0) && (
                    <h3 id={sec.id ? `todo-section-${sec.id}` : undefined} className="text-sm font-medium text-foreground">
                      {sec.name ?? t('unsectioned')} <span className="text-subtle-foreground">({sec.items.length})</span>
                    </h3>
                  )}
                  <Card className="block p-0">
                    {sec.items.length > 0 && <ul className="divide-y">{sec.items.map((todo) => row(todo, sec.items))}</ul>}
                    {sec.id !== null && (
                      <div className={cn('p-3', sec.items.length > 0 && 'border-t')}>
                        <QuickAdd listId={activeList.id} sectionId={sec.id} label={t('quickAddInSection', { name: sec.name ?? '' })} />
                      </div>
                    )}
                  </Card>
                </section>
              ))
            )
          ) : filtered.todos.length === 0 && filtered.tasks.length === 0 ? (
            <Empty
              title={
                view === 'open'
                  ? effectiveProjectFilter
                    ? t('emptyProjectFilter')
                    : hasFilters
                      ? t('emptyFiltered')
                      : t('empty')
                  : hasFilters
                    ? t('emptyFiltered')
                    : view === 'done'
                      ? t('emptyDone')
                      : t('emptyTrash')
              }
              hint={
                view === 'open'
                  ? effectiveProjectFilter
                    ? t('emptyProjectFilterHint')
                    : hasFilters
                      ? t('emptyFilteredHint')
                      : t('emptyHint')
                  : hasFilters
                    ? t('emptyFilteredHint')
                    : undefined
              }
              action={
                hasFilters ? (
                  <Button type="button" size="sm" variant="outline" onClick={clearFilters}>
                    {t('clearFilters')}
                  </Button>
                ) : undefined
              }
            />
          ) : view === 'open' ? (
            groups.map((g) => (
              <section key={g.id} aria-labelledby={`todo-group-${g.id}`} data-testid={`todo-group-${g.id}`}>
                <h2 id={`todo-group-${g.id}`} className={cn('mb-1 text-sm font-medium', g.id === 'overdue' ? 'text-destructive' : 'text-foreground')}>
                  {t(`groups.${g.id}`)} <span className="text-subtle-foreground">({g.items.length + g.tasks.length})</span>
                </h2>
                <Card className="block p-0">
                  <ul className="divide-y">
                    {g.items.map((todo) => row(todo, g.items))}
                    {g.tasks.map((task) => (
                      <TaskRow key={task.id} task={task} slug={slug} chart={chart.data} projectsActive={projectsActive} />
                    ))}
                  </ul>
                </Card>
              </section>
            ))
          ) : (
            <Card className="block p-0">
              <ul className="divide-y">{todos.map((todo) => row(todo, todos))}</ul>
            </Card>
          )}
          {(!effectiveProjectFilter || view !== 'open') && todos.length >= LIST_LIMIT && <p className="text-xs text-subtle-foreground">{t('truncated', { count: String(LIST_LIMIT) })}</p>}
          {view === 'open' && effectiveListFilter === 'all' && work.data?.tasksTruncated && (
            <p className="text-xs text-subtle-foreground">
              {t('tasksTruncated')}{' '}
              <Link to="/o/$slug/tasks" params={{ slug }} search={{ filter: 'mine' }} className="text-link underline">
                {t('openTasks')}
              </Link>
            </p>
          )}
          {act.error && <ErrorText>{errorMessage(act.error)}</ErrorText>}
          <p className="text-xs text-subtle-foreground">{t('shortcuts')}</p>
        </div>
      </div>
      {listDialog && (
        <ListEditDialog
          mode={listDialog.mode}
          list={listDialog.list}
          open={listDialog !== null}
          onOpenChange={(open) => {
            if (!open) setListDialog(null);
          }}
          onCreated={(createdId) => {
            setListFilter(createdId);
            setView('open');
            setSelected(null);
          }}
          onDeleted={(deletedId) => {
            if (listFilter === deletedId) setListFilter('all');
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}
