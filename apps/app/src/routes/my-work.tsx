// "Việc của tôi" (My work, issues #1673 and #1674, notes plan docs/plan/notes.md §3.10, steps N4 and N5): the member's
// own to-dos, which nobody else in the org reads (ADR-0037), and the open tasks of the positions they hold, marked
// "Việc nhóm". Open ones sit in the groups Quá hạn, Hôm nay, 7 ngày tới, Sau đó and Không hạn, by the due day, the
// to-dos in the member's own order; done ones and the trash have their own tabs. Quick add at the top saves on Enter;
// N, J, K, X and E work the to-dos from the keyboard (DESIGN.md §5.2). A to-do can be handed over to a position as a
// team task, after the member confirms the text the team will read.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import {
  TODO_RECURRENCE_FREQS,
  TODO_RECURRENCE_INTERVAL_MAX,
  addTodoLocalDays,
  nextMondayFrom,
  nextTodoOccurrenceDate,
  normalizeTodoRecurrence,
  zonedDate,
  type MyWorkTask,
  type NoteLinkTargetInput,
  type Todo,
  type TodoCompleteResult,
  type TodoListView,
  type TodoRecurrence,
  type TodoRecurrenceFreq,
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
import { RepeatIcon } from '@crove/ui/components/repeat-icon';
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
  chunkTodoIds,
  filterMyWork,
  formatDayBucketShort,
  formatDayBucketWeekday,
  groupTodos,
  groupUpcomingAgenda,
  handOverDescription,
  moveTarget,
  myWorkProjects,
  myWorkShortcut,
  stepSelection,
  todoRecurrenceEqual,
  todoRecurrencePreset,
  type MyWorkAction,
  type TodoRecurrencePreset,
  type UpcomingHorizon,
} from '../lib/my-work.ts';
import { projectsInstalled } from '../lib/projects.ts';

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

/** Compact recurring schedule badge on a personal to-do row or editor (#3557). */
export function TodoRecurrenceBadge({ recurrence }: { recurrence: TodoRecurrence | null | undefined }) {
  const t = useTranslations('myWork');
  if (!recurrence) return null;
  let label: string;
  if (recurrence.freq === 'daily') {
    label = recurrence.interval === 1 ? t('recurrence.badgeDaily') : t('recurrence.badgeDailyMultiple', { n: String(recurrence.interval) });
  } else if (recurrence.freq === 'weekly') {
    label = recurrence.interval === 1 ? t('recurrence.badgeWeekly') : t('recurrence.badgeWeeklyMultiple', { n: String(recurrence.interval) });
  } else if (recurrence.byMonthDay === -1) {
    label = recurrence.interval === 1 ? t('recurrence.badgeMonthEnd') : t('recurrence.badgeMonthEndMultiple', { n: String(recurrence.interval) });
  } else {
    label = recurrence.interval === 1 ? t('recurrence.badgeMonthly') : t('recurrence.badgeMonthlyMultiple', { n: String(recurrence.interval) });
  }
  return (
    <Badge variant="outline" className="gap-1" data-testid="todo-recurrence-badge">
      <RepeatIcon aria-hidden="true" className="size-3" />
      <span>{label}</span>
    </Badge>
  );
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const TODO_DRAG_MIME = 'application/x-crove-todo';

/** Recurrence selector in the personal to-do editor (#3557). */
export function TodoRecurrenceField({ value, onChange }: { value: TodoRecurrence | null; onChange: (next: TodoRecurrence | null) => void }) {
  const t = useTranslations('myWork');
  const [customOpen, setCustomOpen] = useState(() => todoRecurrencePreset(value) === 'custom');
  const [intervalText, setIntervalText] = useState(() => String(value?.interval ?? 1));
  const preset: TodoRecurrencePreset = customOpen && value ? 'custom' : todoRecurrencePreset(value);

  useEffect(() => {
    if (value) setIntervalText(String(value.interval));
  }, [value?.interval]);

  const handlePresetChange = (nextPreset: TodoRecurrencePreset) => {
    if (nextPreset === 'none') {
      setCustomOpen(false);
      onChange(null);
    } else if (nextPreset === 'daily') {
      setCustomOpen(false);
      onChange({ freq: 'daily', interval: 1 });
    } else if (nextPreset === 'weekly') {
      setCustomOpen(false);
      onChange({ freq: 'weekly', interval: 1 });
    } else if (nextPreset === 'monthly') {
      setCustomOpen(false);
      onChange({ freq: 'monthly', interval: 1 });
    } else if (nextPreset === 'monthEnd') {
      setCustomOpen(false);
      onChange({ freq: 'monthly', interval: 1, byMonthDay: -1 });
    } else {
      setCustomOpen(true);
      onChange(value ?? { freq: 'weekly', interval: 2 });
    }
  };

  const unitLabel = value
    ? value.freq === 'daily'
      ? t('recurrence.daysUnit')
      : value.freq === 'weekly'
        ? t('recurrence.weeksUnit')
        : t('recurrence.monthsUnit')
    : '';

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="todo-recurrence-field">
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('recurrence.label')}</span>
        <NativeSelect
          value={preset}
          onChange={(e) => handlePresetChange(e.target.value as TodoRecurrencePreset)}
          className="mt-1 h-9 w-full text-xs sm:h-8"
          aria-label={t('recurrence.label')}
          data-testid="todo-recurrence-preset"
        >
          <NativeSelectOption value="none">{t('recurrence.none')}</NativeSelectOption>
          <NativeSelectOption value="daily">{t('recurrence.daily')}</NativeSelectOption>
          <NativeSelectOption value="weekly">{t('recurrence.weekly')}</NativeSelectOption>
          <NativeSelectOption value="monthly">{t('recurrence.monthly')}</NativeSelectOption>
          <NativeSelectOption value="monthEnd">{t('recurrence.monthEnd')}</NativeSelectOption>
          <NativeSelectOption value="custom">{t('recurrence.custom')}</NativeSelectOption>
        </NativeSelect>
      </label>
      {preset === 'custom' && value && (
        <div className="grid gap-3 pt-1 sm:grid-cols-2" data-testid="todo-recurrence-custom">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('recurrence.freqLabel')}</span>
            <NativeSelect
              value={value.freq}
              onChange={(e) => onChange({ freq: e.target.value as TodoRecurrenceFreq, interval: value.interval })}
              className="mt-1 h-9 w-full text-xs sm:h-8"
              aria-label={t('recurrence.freqLabel')}
              data-testid="todo-recurrence-freq"
            >
              {TODO_RECURRENCE_FREQS.map((freq) => (
                <NativeSelectOption key={freq} value={freq}>
                  {freq === 'daily' ? t('recurrence.freqDaily') : freq === 'weekly' ? t('recurrence.freqWeekly') : t('recurrence.freqMonthly')}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('recurrence.intervalLabel')}</span>
            <div className="mt-1 flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={TODO_RECURRENCE_INTERVAL_MAX}
                value={intervalText}
                onChange={(e) => {
                  const text = e.target.value;
                  setIntervalText(text);
                  const raw = Number.parseInt(text, 10);
                  if (Number.isFinite(raw) && raw >= 1 && raw <= TODO_RECURRENCE_INTERVAL_MAX) {
                    onChange({ ...value, interval: raw });
                  }
                }}
                onBlur={() => {
                  const raw = Number.parseInt(intervalText, 10);
                  const clamped = Number.isFinite(raw) ? Math.min(TODO_RECURRENCE_INTERVAL_MAX, Math.max(1, raw)) : value.interval;
                  setIntervalText(String(clamped));
                  if (clamped !== value.interval) onChange({ ...value, interval: clamped });
                }}
                aria-label={t('recurrence.intervalLabel')}
                className="h-9 w-20 tabular-nums sm:h-8"
                data-testid="todo-recurrence-interval"
              />
              <span className="text-xs text-subtle-foreground">{unitLabel}</span>
            </div>
          </label>
          {value.freq === 'weekly' && (
            <label className="block text-xs sm:col-span-2">
              <span className="text-subtle-foreground">{t('recurrence.weekdayLabel')}</span>
              <NativeSelect
                value={value.byWeekday === undefined ? '' : String(value.byWeekday)}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange(raw === '' ? { freq: 'weekly', interval: value.interval } : { freq: 'weekly', interval: value.interval, byWeekday: Number(raw) });
                }}
                className="mt-1 h-9 w-full text-xs sm:h-8"
                aria-label={t('recurrence.weekdayLabel')}
                data-testid="todo-recurrence-weekday"
              >
                <NativeSelectOption value="">{t('recurrence.weekdayAuto')}</NativeSelectOption>
                {WEEKDAYS.map((day) => (
                  <NativeSelectOption key={day} value={String(day)}>
                    {t(`recurrence.weekdays.d${day}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          )}
          {value.freq === 'monthly' && (
            <label className="block text-xs sm:col-span-2">
              <span className="text-subtle-foreground">{t('recurrence.monthDayLabel')}</span>
              <NativeSelect
                value={value.byMonthDay === undefined ? '' : String(value.byMonthDay)}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange(raw === '' ? { freq: 'monthly', interval: value.interval } : { freq: 'monthly', interval: value.interval, byMonthDay: Number(raw) });
                }}
                className="mt-1 h-9 w-full text-xs sm:h-8"
                aria-label={t('recurrence.monthDayLabel')}
                data-testid="todo-recurrence-monthday"
              >
                <NativeSelectOption value="">{t('recurrence.monthDayAuto')}</NativeSelectOption>
                <NativeSelectOption value="-1">{t('recurrence.lastDayOfMonth')}</NativeSelectOption>
                {MONTH_DAYS.map((day) => (
                  <NativeSelectOption key={day} value={String(day)}>
                    {t('recurrence.dayNumber', { day: String(day) })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

interface ReschedulePromptState {
  todoIds: string[];
  bulk: boolean;
  dueOn: string;
}

function RescheduleDialog({
  state,
  tomorrow,
  nextMonday,
  pending,
  error,
  onDateChange,
  onClose,
  onConfirm,
}: {
  state: ReschedulePromptState | null;
  tomorrow: string;
  nextMonday: string;
  pending: boolean;
  error: unknown;
  onDateChange: (dueOn: string) => void;
  onClose: () => void;
  onConfirm: (dueOn: string) => void;
}) {
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  return (
    <Dialog open={state !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent closeLabel={common('close')} data-testid="reschedule-dialog">
        <DialogHeader>
          <DialogTitle>
            {state?.bulk ? t('reschedule.dialogBulkTitle', { count: state.todoIds.length }) : t('reschedule.dialogTitle')}
          </DialogTitle>
          <DialogDescription>{t('reschedule.dialogDesc')}</DialogDescription>
        </DialogHeader>
        {state && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (state.dueOn) onConfirm(state.dueOn);
            }}
          >
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onDateChange(tomorrow)}>
                {t('reschedule.tomorrow')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => onDateChange(nextMonday)}>
                {t('reschedule.nextMonday')}
              </Button>
            </div>
            <label className="block text-xs" data-testid="reschedule-dialog-date">
              <span className="text-subtle-foreground">{t('reschedule.dateLabel')}</span>
              <DateInput value={state.dueOn} onChange={onDateChange} className="mt-1" aria-label={t('reschedule.dateLabel')} />
            </label>
            {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>{common('cancel')}</DialogClose>
              <Button type="submit" loading={pending} disabled={!state.dueOn || pending} data-testid="reschedule-dialog-confirm">
                {t('reschedule.confirm')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
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
function TodoEditor({ todo, onClose }: { todo: Todo; onClose: () => void }) {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const f = useFormat();
  const [title, setTitle] = useState(todo.title);
  const [details, setDetails] = useState(todo.details);
  const [steps, setSteps] = useState<TodoStep[]>(todo.checklist);
  const [newStep, setNewStep] = useState('');
  const [dueOn, setDueOn] = useState(todo.dueOn ?? '');
  const [dueTime, setDueTime] = useState(todo.dueTime ?? '');
  const [recurrence, setRecurrence] = useState<TodoRecurrence | null>(todo.recurrence);
  const [remind, setRemind] = useState(todo.remindAt !== null || todo.dueOn === null);
  const [remindTouched, setRemindTouched] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  // A change not saved yet: the hand-over waits for it, so it never hands over a to-do other than the one shown.
  const dirty =
    title !== todo.title ||
    details !== todo.details ||
    JSON.stringify(steps) !== JSON.stringify(todo.checklist) ||
    dueOn !== (todo.dueOn ?? '') ||
    dueTime !== (todo.dueTime ?? '') ||
    !todoRecurrenceEqual(recurrence, todo.recurrence) ||
    remind !== (todo.remindAt !== null || todo.dueOn === null) ||
    newStep.trim() !== '';
  // The values of one save are its variables, so an edit made while it runs does not change what it sends.
  const save = useMutation({
    mutationFn: (v: { title: string; details: string; steps: TodoStep[]; dueOn: string; dueTime: string; recurrence: TodoRecurrence | null; remind: boolean; remindTouched: boolean }) =>
      client.notes.todos.update({
        todoId: todo.id,
        revision: todo.revision,
        title: v.title.trim(),
        details: v.details,
        checklist: v.steps,
        dueOn: v.dueOn || null,
        dueTime: v.dueOn && v.dueTime ? v.dueTime : null,
        // A due day is read in the zone the to-do was written in, unless it gets a new day here.
        timeZone: v.dueOn && v.dueOn !== todo.dueOn ? browserTimeZone() : todo.timeZone,
        ...(v.remindTouched ? { reminder: v.remind ? ('auto' as const) : ('off' as const) } : {}),
        ...(todoRecurrenceEqual(v.recurrence, todo.recurrence) ? {} : { recurrence: v.recurrence ? normalizeTodoRecurrence(v.recurrence) : null }),
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const completeStop = useMutation({
    mutationFn: () => client.notes.todos.complete({ todoId: todo.id, stopSeries: true }),
    onSuccess: () => {
      refresh();
      onClose();
      const savedRecurrence = todo.recurrence ? normalizeTodoRecurrence(todo.recurrence) : null;
      toastWithUndo(
        t('completedToast', { title: todo.title }),
        t('undoneToast', { title: todo.title }),
        async () => {
          const api = clientForOrg(slug).notes.todos;
          const reopened = await api.reopen({ todoId: todo.id });
          if (savedRecurrence) {
            await api.update({
              todoId: todo.id,
              revision: reopened.revision,
              title: todo.title,
              details: todo.details,
              checklist: todo.checklist,
              dueOn: todo.dueOn,
              dueTime: todo.dueTime,
              timeZone: todo.timeZone,
              recurrence: savedRecurrence,
            });
          }
        },
        { undo: common('undo'), failed: (reason) => common('undoFailed', { reason }) },
      );
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
    if (title.trim()) save.mutate({ title, details, steps, dueOn, dueTime, recurrence, remind, remindTouched });
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
            <span className="text-subtle-foreground">{t('fieldDueOn')}</span>
            <DateInput value={dueOn} onChange={setDueOn} className="mt-1" aria-label={t('fieldDueOn')} />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('fieldDueTime')}</span>
            <TimeInput value={dueTime} onChange={setDueTime} disabled={!dueOn} className="mt-1" aria-label={t('fieldDueTime')} />
          </label>
        </div>
        <TodoRecurrenceField value={recurrence} onChange={setRecurrence} />
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
          {todo.status === 'open' && todo.deletedAt === null && todo.recurrence !== null && (
            <Button
              type="button"
              variant="outline"
              loading={completeStop.isPending}
              disabled={completeStop.isPending || dirty}
              onClick={() => completeStop.mutate()}
              data-testid="todo-complete-stop-series"
            >
              {t('recurrence.stopSeries')}
            </Button>
          )}
          {todo.status === 'open' && todo.deletedAt === null && <HandOverDialog todo={todo} disabled={dirty} onDone={onClose} />}
          <Button type="button" variant="destructive" className="ml-auto" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t('delete')}
          </Button>
        </div>
        {dirty && todo.status === 'open' && <p className="text-xs text-subtle-foreground">{t('handOverSaveFirst')}</p>}
        {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        {completeStop.error && <ErrorText>{errorMessage(completeStop.error)}</ErrorText>}
        {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      </form>
    </div>
  );
}

function EditorFor({ id, onClose }: { id: string; onClose: () => void }) {
  const todo = useQuery(orpc.notes.todos.get.queryOptions({ input: { todoId: id } }));
  if (todo.isPending) return <ListSkeleton rows={1} />;
  if (todo.error) return <ErrorText>{errorMessage(todo.error)}</ErrorText>;
  // Keyed by revision, so a change saved elsewhere opens fresh.
  return <TodoEditor key={`${todo.data.id}:${todo.data.revision}`} todo={todo.data} onClose={onClose} />;
}

function QuickAdd({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const t = useTranslations('myWork');
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: (value: string) => client.notes.todos.create({ title: value, timeZone: browserTimeZone() }),
    // Only what was sent is cleared: a title typed meanwhile stays.
    onSuccess: (_, sent) => {
      setTitle((current) => (current.trim() === sent ? '' : current));
      refresh();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (value && !create.isPending) create.mutate(value);
  };
  return (
    <form onSubmit={submit} className="mb-4">
      <Input
        ref={inputRef}
        aria-label={t('quickAdd')}
        placeholder={t('quickAdd')}
        maxLength={300}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
      />
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </form>
  );
}

type MyWorkTab = TodoListView | 'upcoming';

export function MyWorkPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const viewerTz = browserTimeZone();
  const today = zonedDate(viewerTz, Date.now());
  const tomorrow = addTodoLocalDays(today, 1);
  const nextMon = nextMondayFrom(today);
  const [view, setView] = useState<MyWorkTab>('open');
  const [horizon, setHorizon] = useState<UpcomingHorizon>(7);
  const [projectFilter, setProjectFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draggedTodoId, setDraggedTodoId] = useState<string | null>(null);
  const draggedTodoIdRef = useRef<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [reschedulePrompt, setReschedulePrompt] = useState<ReschedulePromptState | null>(null);
  const quickAdd = useRef<HTMLInputElement>(null);
  const live = useStreamLive();
  // Read again every minute while the stream is down, and every few minutes anyway: the groups move with the clock
  // (midnight, a due time passing), which sends no hint. The open view also brings the tasks of my positions.
  const refetchInterval = pollEvery(live, 60_000, SAFETY_POLL_MS);
  const needsWork = view === 'open' || view === 'upcoming';
  const work = useQuery({ ...orpc.notes.todos.myWork.queryOptions({ input: { timeZone: viewerTz } }), refetchInterval, enabled: needsWork });
  const listView: TodoListView = view === 'done' || view === 'trash' ? view : 'open';
  const closed = useQuery({ ...orpc.notes.todos.list.queryOptions({ input: { view: listView, limit: LIST_LIMIT } }), refetchInterval, enabled: view === 'done' || view === 'trash' });
  const list = needsWork ? work : closed;
  const chart = useQuery({ ...orpc.chart.get.queryOptions(), enabled: (work.data?.tasks.length ?? 0) > 0 });
  const todos = useMemo(() => (needsWork ? (work.data?.todos ?? []) : (closed.data ?? [])), [needsWork, work.data, closed.data]);
  const tasks = useMemo(() => (needsWork ? (work.data?.tasks ?? []) : []), [needsWork, work.data]);
  const projectsActive = projectsInstalled() && work.data?.projectsAvailable !== false;
  const projectOptions = useMemo(() => (projectsActive ? myWorkProjects(tasks) : []), [projectsActive, tasks]);
  const effectiveProjectFilter =
    projectsActive && projectOptions.length > 0 && (projectFilter === 'none' || projectOptions.some((p) => p.id === projectFilter)) ? projectFilter : '';
  const filtered = useMemo(
    () => (needsWork ? filterMyWork(todos, tasks, effectiveProjectFilter) : { todos, tasks }),
    [needsWork, todos, tasks, effectiveProjectFilter],
  );
  const groups = useMemo(() => (view === 'open' ? groupTodos(filtered.todos, filtered.tasks) : []), [view, filtered.todos, filtered.tasks]);
  const upcoming = useMemo(
    () => (view === 'upcoming' ? groupUpcomingAgenda(filtered.todos, filtered.tasks, today, horizon, viewerTz) : null),
    [view, filtered.todos, filtered.tasks, today, horizon, viewerTz],
  );
  const overduePersonalTodos = useMemo(() => (needsWork ? filtered.todos.filter((item) => item.overdue) : []), [needsWork, filtered.todos]);
  const quickMoveDays = useMemo(() => {
    if (!upcoming) return [];
    const base = upcoming.days.slice(0, 14).map((d) => d.date);
    if (!base.includes(nextMon)) base.push(nextMon);
    return base.sort();
  }, [upcoming, nextMon]);
  // The order J and K walk: as the screen shows the rows.
  const order = useMemo(() => {
    if (view === 'open') return groups.flatMap((g) => g.items.map((i) => i.id));
    if (view === 'upcoming' && upcoming) return [...upcoming.overdueTodos, ...upcoming.days.flatMap((d) => d.todos)].map((i) => i.id);
    return todos.map((i) => i.id);
  }, [view, groups, upcoming, todos]);
  const visibleSelected = selected && order.includes(selected) ? selected : null;

  const act = useMutation({
    // A completion carries the to-do's title and schedule as shown when asked for: by the answer, the list may move on.
    mutationFn: (
      v:
        | { what: 'complete'; todoId: string; title: string; dueOn: string | null; timeZone: string; recurrence: TodoRecurrence | null }
        | { what: 'reopen' | 'restore'; todoId: string }
        | { what: 'reorder'; todoId: string; place: 'before' | 'after'; anchorId: string },
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
    // Completing (the box or the X key) moves the to-do to Done and spawns the next occurrence when recurring.
    onSuccess: (result, v) => {
      if (v.what !== 'complete') return;
      const { title } = v;
      const nextTodoId = (result as TodoCompleteResult).nextTodoId ?? null;
      if (nextTodoId && v.recurrence) {
        const baseDue = v.dueOn ?? zonedDate(v.timeZone, Date.now());
        const nextDue = nextTodoOccurrenceDate(v.recurrence, baseDue);
        toastWithUndo(
          t('recurrence.completedNextToast', { title, due: f.date(nextDue) }),
          t('undoneToast', { title }),
          async () => {
            const api = clientForOrg(slug).notes.todos;
            const nextCurrent = await api.get({ todoId: nextTodoId }).catch(() => null);
            if (!nextCurrent || nextCurrent.deletedAt !== null || nextCurrent.status !== 'open' || nextCurrent.revision !== 1) {
              throw new Error(t('recurrence.undoSeriesAdvanced'));
            }
            await api.delete({ todoId: nextTodoId });
            await api.reopen({ todoId: v.todoId });
          },
          { undo: common('undo'), failed: (reason) => common('undoFailed', { reason }) },
        );
        return;
      }
      toastWithUndo(t('completedToast', { title }), t('undoneToast', { title }), () => clientForOrg(slug).notes.todos.reopen({ todoId: v.todoId }), {
        undo: common('undo'),
        failed: (reason) => common('undoFailed', { reason }),
      });
    },
    onSettled: refresh,
  });

  const reschedule = useMutation({
    mutationFn: async (v: { todoIds: string[]; dueOn: string; bulk?: boolean }) => {
      const updatedIds: string[] = [];
      for (const batch of chunkTodoIds(v.todoIds)) {
        const res = await client.notes.todos.reschedule({ todoIds: batch, dueOn: v.dueOn });
        updatedIds.push(...res.todoIds);
      }
      return updatedIds;
    },
    onSuccess: (updatedIds, v) => {
      setReschedulePrompt(null);
      const due = f.date(v.dueOn);
      toast(v.bulk ? t('reschedule.bulkMovedToast', { count: updatedIds.length, due }) : t('reschedule.movedToast', { due }), 'success');
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
      ...(visibleSelected && needsWork
        ? {
            done: () => {
              const target = filtered.todos.find((x) => x.id === visibleSelected);
              act.mutate({
                what: 'complete',
                todoId: visibleSelected,
                title: target?.title ?? '',
                dueOn: target?.dueOn ?? null,
                timeZone: target?.timeZone ?? viewerTz,
                recurrence: target?.recurrence ?? null,
              });
            },
          }
        : {}),
      ...(visibleSelected && needsWork ? { edit: () => setEditing(visibleSelected) } : {}),
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

  const dayBucketHeading = (day: string) => {
    const weekday = formatDayBucketWeekday(day, locale);
    const shortDate = formatDayBucketShort(day, locale);
    if (day === today) return `${t('upcoming.todayLabel')} (${weekday}, ${shortDate})`;
    if (day === tomorrow) return `${t('upcoming.tomorrowLabel')} (${weekday}, ${shortDate})`;
    return `${weekday}, ${f.date(day)}`;
  };

  const row = (todo: TodoSummary, group: readonly TodoSummary[]) => {
    const up = view === 'open' ? moveTarget(group, todo.id, 'up') : null;
    const down = view === 'open' ? moveTarget(group, todo.id, 'down') : null;
    const canDrag = view === 'upcoming' && todo.status === 'open' && editing !== todo.id && !reschedule.isPending;
    return (
      <li
        key={todo.id}
        data-todo-id={todo.id}
        data-testid="todo-row"
        aria-current={visibleSelected === todo.id ? 'true' : undefined}
        draggable={canDrag}
        onDragStart={
          canDrag
            ? (e) => {
                e.dataTransfer.setData(TODO_DRAG_MIME, todo.id);
                e.dataTransfer.setData('text/plain', todo.id);
                e.dataTransfer.effectAllowed = 'move';
                draggedTodoIdRef.current = todo.id;
                setDraggedTodoId(todo.id);
              }
            : undefined
        }
        onDragEnd={
          canDrag
            ? () => {
                draggedTodoIdRef.current = null;
                setDraggedTodoId(null);
                setDropDay(null);
              }
            : undefined
        }
        className={cn(
          'flex flex-wrap items-center gap-3 px-4 py-2',
          visibleSelected === todo.id && 'bg-primary/5 ring-1 ring-primary/40 ring-inset',
          draggedTodoId === todo.id && 'opacity-60',
        )}
      >
        {(needsWork || view === 'done') && (todo.status === 'open' || todo.status === 'done') ? (
          <Checkbox
            checked={todo.status === 'done'}
            aria-label={todo.status === 'done' ? t('reopenTodo', { title: todo.title }) : t('completeTodo', { title: todo.title })}
            disabled={act.isPending}
            onCheckedChange={(checked) =>
              act.mutate(
                checked === true
                  ? { what: 'complete', todoId: todo.id, title: todo.title, dueOn: todo.dueOn, timeZone: todo.timeZone, recurrence: todo.recurrence }
                  : { what: 'reopen', todoId: todo.id },
              )
            }
          />
        ) : needsWork || view === 'done' ? (
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
        {todo.steps.total > 0 && (
          <span className="text-xs text-subtle-foreground tabular-nums" aria-label={t('stepsDone', { done: String(todo.steps.done), total: String(todo.steps.total) })}>
            {todo.steps.done}/{todo.steps.total}
          </span>
        )}
        <TodoSourceBadge sourceNote={todo.sourceNote} slug={slug} />
        {todo.tainted && (
          <Badge variant="proposal" title={t('taintedTodoHint')} data-testid="todo-tainted-badge">
            {t('proposalMark')}
          </Badge>
        )}
        <TodoRecurrenceBadge recurrence={todo.recurrence} />
        <DueChip todo={todo} />
        {needsWork && todo.status === 'open' && todo.overdue && (
          <div className="flex flex-wrap items-center gap-1" data-testid="todo-overdue-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reschedule.isPending}
              onClick={() => reschedule.mutate({ todoIds: [todo.id], dueOn: tomorrow })}
              data-testid="todo-reschedule-tomorrow"
            >
              {t('reschedule.tomorrow')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reschedule.isPending}
              onClick={() => reschedule.mutate({ todoIds: [todo.id], dueOn: nextMon })}
              data-testid="todo-reschedule-next-monday"
            >
              {t('reschedule.nextMonday')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reschedule.isPending}
              onClick={() => setReschedulePrompt({ todoIds: [todo.id], bulk: false, dueOn: tomorrow })}
              data-testid="todo-reschedule-pick"
            >
              {t('reschedule.pickDate')}
            </Button>
          </div>
        )}
        {view === 'upcoming' && todo.status === 'open' && (
          <div className="flex flex-wrap items-center gap-1" data-testid="todo-upcoming-move">
            {todo.dueOn && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={reschedule.isPending}
                  aria-label={t('upcoming.prevDay', { title: todo.title })}
                  onClick={() => reschedule.mutate({ todoIds: [todo.id], dueOn: addTodoLocalDays(todo.dueOn!, -1) })}
                  data-testid="todo-move-prev-day"
                >
                  ‹
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={reschedule.isPending}
                  aria-label={t('upcoming.nextDay', { title: todo.title })}
                  onClick={() => reschedule.mutate({ todoIds: [todo.id], dueOn: addTodoLocalDays(todo.dueOn!, 1) })}
                  data-testid="todo-move-next-day"
                >
                  ›
                </Button>
              </>
            )}
            <NativeSelect
              aria-label={t('upcoming.moveDateLabel', { title: todo.title })}
              value=""
              disabled={reschedule.isPending}
              onChange={(e) => {
                const value = e.target.value;
                if (!value) return;
                if (value === '__pick__') {
                  setReschedulePrompt({ todoIds: [todo.id], bulk: false, dueOn: todo.dueOn ?? tomorrow });
                  return;
                }
                reschedule.mutate({ todoIds: [todo.id], dueOn: value });
              }}
              className="h-8 min-w-0 text-xs"
              data-testid="todo-move-date-select"
            >
              <NativeSelectOption value="">{t('upcoming.moveDatePlaceholder')}</NativeSelectOption>
              {quickMoveDays.map((day) => (
                <NativeSelectOption key={day} value={day}>
                  {dayBucketHeading(day)}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value="__pick__">{t('upcoming.pickOtherDate')}</NativeSelectOption>
            </NativeSelect>
          </div>
        )}
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
            <EditorFor id={todo.id} onClose={() => setEditing((current) => (current === todo.id ? null : current))} />
          </div>
        )}
      </li>
    );
  };

  const overdueBulkBar = needsWork && overduePersonalTodos.length > 0 && (
    <Alert className="border-destructive/30 bg-muted/35" data-testid="overdue-bulk-bar">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-destructive">{t('reschedule.bulkTitle', { count: overduePersonalTodos.length })}</p>
          <p className="text-subtle-foreground">{t('reschedule.bulkHint')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={reschedule.isPending}
            onClick={() => reschedule.mutate({ todoIds: overduePersonalTodos.map((item) => item.id), dueOn: tomorrow, bulk: true })}
            data-testid="bulk-reschedule-tomorrow"
          >
            {t('reschedule.tomorrow')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={reschedule.isPending}
            onClick={() => reschedule.mutate({ todoIds: overduePersonalTodos.map((item) => item.id), dueOn: nextMon, bulk: true })}
            data-testid="bulk-reschedule-next-monday"
          >
            {t('reschedule.nextMonday')}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={reschedule.isPending}
            onClick={() => setReschedulePrompt({ todoIds: overduePersonalTodos.map((item) => item.id), bulk: true, dueOn: tomorrow })}
            data-testid="bulk-reschedule-overdue"
          >
            {t('reschedule.bulkButton')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );

  const upcomingHasAnyItems =
    upcoming !== null &&
    (upcoming.overdueTodos.length > 0 || upcoming.overdueTasks.length > 0 || upcoming.days.some((d) => d.todos.length > 0 || d.tasks.length > 0));

  return (
    <div className="space-y-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <NotesSubnav slug={slug} active="my-work" />
      <QuickAdd inputRef={quickAdd} />
      {needsWork && work.data?.noSeatHint && (
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={view}
          onValueChange={(value) => {
            setView(value as MyWorkTab);
            setSelected(null);
            setEditing(null);
          }}
        >
          <TabsList className="h-auto max-w-full flex-wrap justify-start">
            <TabsTrigger value="open" data-testid="my-work-tab-open">
              {t('viewOpen')}
            </TabsTrigger>
            <TabsTrigger value="upcoming" data-testid="my-work-tab-upcoming">
              {t('viewUpcoming')}
            </TabsTrigger>
            <TabsTrigger value="done" data-testid="my-work-tab-done">
              {t('viewDone')}
            </TabsTrigger>
            <TabsTrigger value="trash" data-testid="my-work-tab-trash">
              {t('viewTrash')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          {view === 'upcoming' && (
            <div role="group" aria-label={t('upcoming.rangeLabel')} className="inline-flex items-center gap-1" data-testid="upcoming-range-toggle">
              <Button
                type="button"
                size="sm"
                variant={horizon === 7 ? 'secondary' : 'outline'}
                aria-pressed={horizon === 7}
                onClick={() => setHorizon(7)}
                data-testid="upcoming-range-7"
              >
                {t('upcoming.days7')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={horizon === 30 ? 'secondary' : 'outline'}
                aria-pressed={horizon === 30}
                onClick={() => setHorizon(30)}
                data-testid="upcoming-range-30"
              >
                {t('upcoming.days30')}
              </Button>
            </div>
          )}
          {needsWork && projectsActive && projectOptions.length > 0 && (
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
        </div>
      </div>
      {overdueBulkBar}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : view === 'upcoming' && upcoming ? (
        !upcomingHasAnyItems ? (
          <Empty title={t('upcoming.emptyUpcoming', { days: String(horizon) })} hint={t('upcoming.emptyUpcomingHint')} />
        ) : (
          <div className="space-y-4" data-testid="my-work-upcoming-agenda">
            {(upcoming.overdueTodos.length > 0 || upcoming.overdueTasks.length > 0) && (
              <section aria-labelledby="upcoming-group-overdue" data-testid="upcoming-group-overdue">
                <h2 id="upcoming-group-overdue" className="mb-1 text-sm font-medium text-destructive">
                  {t('groups.overdue')} <span className="text-subtle-foreground tabular-nums">({upcoming.overdueTodos.length + upcoming.overdueTasks.length})</span>
                </h2>
                <Card className="block p-0">
                  <ul className="divide-y">
                    {upcoming.overdueTodos.map((todo) => row(todo, upcoming.overdueTodos))}
                    {upcoming.overdueTasks.map((task) => (
                      <TaskRow key={task.id} task={task} slug={slug} chart={chart.data} projectsActive={projectsActive} />
                    ))}
                  </ul>
                </Card>
              </section>
            )}
            {upcoming.days.map((bucket) => {
              const count = bucket.todos.length + bucket.tasks.length;
              const isDropTarget = dropDay === bucket.date;
              return (
                <section
                  key={bucket.date}
                  aria-labelledby={`upcoming-day-${bucket.date}`}
                  data-testid={`upcoming-day-${bucket.date}`}
                  data-drop-date={bucket.date}
                  onDragOver={(e) => {
                    if (!draggedTodoId && !draggedTodoIdRef.current) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dropDay !== bucket.date) setDropDay(bucket.date);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setDropDay((cur) => (cur === bucket.date ? null : cur));
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData(TODO_DRAG_MIME) || draggedTodoIdRef.current || draggedTodoId;
                    draggedTodoIdRef.current = null;
                    setDropDay(null);
                    setDraggedTodoId(null);
                    if (!id) return;
                    const draggedItem = filtered.todos.find((x) => x.id === id);
                    if (!draggedItem || draggedItem.dueOn === bucket.date) return;
                    reschedule.mutate({ todoIds: [id], dueOn: bucket.date });
                  }}
                >
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <h2 id={`upcoming-day-${bucket.date}`} className="text-sm font-medium text-foreground">
                      {dayBucketHeading(bucket.date)} <span className="text-subtle-foreground tabular-nums">({count})</span>
                    </h2>
                    {isDropTarget && (
                      <Badge variant="secondary" data-testid="upcoming-drop-indicator">
                        {t('upcoming.dropHere')}
                      </Badge>
                    )}
                  </div>
                  <Card className={cn('block p-0 motion-safe:transition-colors', isDropTarget && 'bg-primary/5 ring-2 ring-primary/50')}>
                    {count === 0 ? (
                      <p className="px-4 py-2 text-xs text-subtle-foreground">{t('upcoming.emptyDay')}</p>
                    ) : (
                      <ul className="divide-y">
                        {bucket.todos.map((todo) => row(todo, bucket.todos))}
                        {bucket.tasks.map((task) => (
                          <TaskRow key={task.id} task={task} slug={slug} chart={chart.data} projectsActive={projectsActive} />
                        ))}
                      </ul>
                    )}
                  </Card>
                </section>
              );
            })}
          </div>
        )
      ) : filtered.todos.length === 0 && filtered.tasks.length === 0 ? (
        <Empty
          title={
            view === 'open'
              ? effectiveProjectFilter
                ? t('emptyProjectFilter')
                : t('empty')
              : view === 'done'
                ? t('emptyDone')
                : t('emptyTrash')
          }
          hint={view === 'open' ? (effectiveProjectFilter ? t('emptyProjectFilterHint') : t('emptyHint')) : undefined}
        />
      ) : view === 'open' ? (
        groups.map((g) => (
          <section key={g.id} aria-labelledby={`todo-group-${g.id}`} data-testid={`todo-group-${g.id}`}>
            <h2 id={`todo-group-${g.id}`} className={cn('mb-1 text-sm font-medium', g.id === 'overdue' ? 'text-destructive' : 'text-foreground')}>
              {t(`groups.${g.id}`)} <span className="text-subtle-foreground tabular-nums">({g.items.length + g.tasks.length})</span>
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
      {(!effectiveProjectFilter || !needsWork) && todos.length >= LIST_LIMIT && <p className="text-xs text-subtle-foreground">{t('truncated', { count: String(LIST_LIMIT) })}</p>}
      {needsWork && work.data?.tasksTruncated && (
        <p className="text-xs text-subtle-foreground">
          {t('tasksTruncated')}{' '}
          <Link to="/o/$slug/tasks" params={{ slug }} search={{ filter: 'mine' }} className="text-link underline">
            {t('openTasks')}
          </Link>
        </p>
      )}
      {act.error && <ErrorText>{errorMessage(act.error)}</ErrorText>}
      {reschedule.error && <ErrorText>{errorMessage(reschedule.error)}</ErrorText>}
      <p className="text-xs text-subtle-foreground">{t('shortcuts')}</p>
      <RescheduleDialog
        state={reschedulePrompt}
        tomorrow={tomorrow}
        nextMonday={nextMon}
        pending={reschedule.isPending}
        error={reschedule.error}
        onDateChange={(dueOn) => setReschedulePrompt((cur) => (cur ? { ...cur, dueOn } : cur))}
        onClose={() => {
          setReschedulePrompt(null);
          reschedule.reset();
        }}
        onConfirm={(dueOn) => {
          if (!reschedulePrompt) return;
          reschedule.mutate({ todoIds: reschedulePrompt.todoIds, dueOn, bulk: reschedulePrompt.bulk });
        }}
      />
    </div>
  );
}
