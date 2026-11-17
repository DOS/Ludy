// The notes module (issue #1671, plan docs/plan/notes.md §3, ADR-0037): members' notes, private to their author or
// shared with the org, linked to records. The inputs its commands and queries take and the views they return; the app
// reads the same types.
import { z } from 'zod';
import { DEFAULT_TIME_ZONE, zTimeZone, zonedDate, zonedInstant, zoneOffsetMs } from './calendar.ts';
import { zId } from './schemas.ts';

export const NOTE_VISIBILITIES = ['private', 'org'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];
// The records a note links to (notes.md §3.4): the kernel's parties, files and tasks, and targets owned by finance,
// crm, projects (#1672, #2595) and meetings (#1679), which another module owns and may be off.
export const NOTE_LINK_TARGETS = ['kernel.party', 'kernel.file', 'kernel.task', 'finance.purchase_document', 'finance.journal_entry', 'crm.booking', 'projects.project', 'meetings.meeting'] as const;
export type NoteLinkTarget = (typeof NOTE_LINK_TARGETS)[number];
// The lists of the notes screen (notes.md §3.10).
export const NOTE_LIST_VIEWS = ['mine', 'shared', 'pinned', 'archived', 'trash'] as const;
export type NoteListView = (typeof NOTE_LIST_VIEWS)[number];

export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 100_000;
export const NOTE_TAGS_MAX = 20;
export const NOTE_TAG_MAX = 40;
// Links one note keeps: each read of the note checks every link through its module (#1672).
export const NOTE_LINKS_MAX = 50;
// Days a deleted note stays in the trash, and a former member's private notes stay sealed (ADR-0037 §4).
export const NOTE_TRASH_DAYS = 30;
export const NOTE_MEMBER_PURGE_DAYS = 30;

const zTitle = z.string().trim().min(1).max(NOTE_TITLE_MAX);
const zBody = z.string().max(NOTE_BODY_MAX);
// Lower case, trimmed, each once, at most NOTE_TAGS_MAX.
const zTags = z
  .array(z.string().trim().toLowerCase().min(1).max(NOTE_TAG_MAX))
  .max(NOTE_TAGS_MAX)
  .transform((tags) => [...new Set(tags)]);
export const zNoteLinkTarget = z.strictObject({ targetType: z.enum(NOTE_LINK_TARGETS), targetId: zId });
export type NoteLinkTargetInput = z.infer<typeof zNoteLinkTarget>;

// A new note: private unless the caller shares it (a panel on a record shares by default, notes.md decision N-7),
// optionally linked to one record at once.
export const zNoteCreate = z.strictObject({
  title: zTitle,
  body: zBody.default(''),
  tags: zTags.default([]),
  visibility: z.enum(NOTE_VISIBILITIES).default('private'),
  tainted: z.boolean().optional(),
  link: zNoteLinkTarget.optional(),
});
export type NoteCreateInput = z.input<typeof zNoteCreate>;
// The author's edit of the text, against the revision they read (NOTES.REVISION_CONFLICT when it moved on).
export const zNoteUpdate = z.strictObject({ noteId: zId, revision: z.number().int().positive(), title: zTitle, body: zBody, tags: zTags });
export type NoteUpdateInput = z.input<typeof zNoteUpdate>;
export const zNoteSetVisibility = z.strictObject({ noteId: zId, visibility: z.enum(NOTE_VISIBILITIES) });
export const zNoteRef = z.strictObject({ noteId: zId });
export const zNoteFromMeetingSummary = z.strictObject({ meetingId: zId, title: zTitle.optional() });
export type NoteFromMeetingSummaryInput = z.input<typeof zNoteFromMeetingSummary>;
export const zNoteLinkAdd = z.strictObject({ noteId: zId, targetType: z.enum(NOTE_LINK_TARGETS), targetId: zId });
export const zNoteLinkRemove = z.strictObject({ linkId: zId });
export const zNoteList = z.strictObject({
  view: z.enum(NOTE_LIST_VIEWS),
  tag: z.string().trim().toLowerCase().min(1).max(NOTE_TAG_MAX).optional(),
  target: zNoteLinkTarget.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type NoteListInput = z.input<typeof zNoteList>;
export const zNoteSearch = z.strictObject({ q: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) });

// What a command returns: ids and the new revision, never text (idempotency rows keep results, notes.md §3.5).
export const zNoteWritten = z.object({ noteId: z.string(), revision: z.number().int() });
export type NoteWritten = z.infer<typeof zNoteWritten>;
export const zNoteLinkWritten = z.object({ noteId: z.string(), linkId: z.string() });

// A note in a list: its title and tags, not its body. `mine`: the caller wrote it.
export const zNoteSummary = z.object({
  id: z.string(),
  authorUserId: z.string(),
  mine: z.boolean(),
  visibility: z.enum(NOTE_VISIBILITIES),
  title: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  tainted: z.boolean(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});
export type NoteSummary = z.infer<typeof zNoteSummary>;

// available: the reader can open the record now, checked in their context through its module's own query (its row
// policies, role and legal entities apply); false when they cannot, or its module is off ("Bản ghi không mở được").
export const zNoteLinkView = z.object({ id: z.string(), targetType: z.enum(NOTE_LINK_TARGETS), targetId: z.string(), createdAt: z.string(), available: z.boolean() });
export type NoteLink = z.infer<typeof zNoteLinkView>;

export const zNote = zNoteSummary.extend({ body: z.string(), links: z.array(zNoteLinkView) });
export type Note = z.infer<typeof zNote>;

// How many private notes a member has, for an owner or admin before removing them (ADR-0037 §4). No text.
export const zNotePrivateCount = z.object({ userId: z.string(), notes: z.number().int() });
export type NotePrivateCount = z.infer<typeof zNotePrivateCount>;

// ---------------------------------------------------------------------------
// Personal to-dos (#1673, notes.md §3.2, §3.8 and step N4): a member's own list, always private (ADR-0037). A to-do
// has a due day and, optionally, a time on that day, both in the to-do's own time zone (the member's browser's when
// it was written), so "today" is the day of that zone.
// ---------------------------------------------------------------------------

export const TODO_STATUSES = ['open', 'done', 'handed_over', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
// The lists of the to-do screen: what is left to do, what is done, and the trash.
export const TODO_LIST_VIEWS = ['open', 'done', 'trash'] as const;
export type TodoListView = (typeof TODO_LIST_VIEWS)[number];
// The groups of My work (notes.md §3.10), by the due day in the to-do's time zone: before today, today, the next 7
// days, later, and no day.
export const TODO_DUE_GROUPS = ['overdue', 'today', 'next7', 'later', 'none'] as const;
export type TodoDueGroup = (typeof TODO_DUE_GROUPS)[number];

// A task title's and description's limits, so a hand-over (N5) never truncates.
export const TODO_TITLE_MAX = 300;
export const TODO_DETAILS_MAX = 10_000;
export const TODO_STEPS_MAX = 50;
export const TODO_STEP_MAX = 300;
export const TODO_RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'] as const;
export type TodoRecurrenceFreq = (typeof TODO_RECURRENCE_FREQS)[number];
export const TODO_RECURRENCE_INTERVAL_MAX = 365;
export const TODO_RESCHEDULE_BATCH_MAX = 50;

export const zTodoRecurrence = z
  .strictObject({
    freq: z.enum(TODO_RECURRENCE_FREQS),
    interval: z.number().int().min(1).max(TODO_RECURRENCE_INTERVAL_MAX).default(1),
    byWeekday: z.number().int().min(0).max(6).nullable().optional(),
    byMonthDay: z
      .number()
      .int()
      .refine((v) => v === -1 || (v >= 1 && v <= 31), 'byMonthDay must be 1..31 or -1')
      .nullable()
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.freq !== 'weekly' && v.byWeekday !== undefined && v.byWeekday !== null) {
      ctx.addIssue({ code: 'custom', path: ['byWeekday'], message: 'byWeekday is only allowed for weekly recurrence' });
    }
    if (v.freq !== 'monthly' && v.byMonthDay !== undefined && v.byMonthDay !== null) {
      ctx.addIssue({ code: 'custom', path: ['byMonthDay'], message: 'byMonthDay is only allowed for monthly recurrence' });
    }
  });
export type TodoRecurrence = z.infer<typeof zTodoRecurrence>;
export type TodoRecurrenceInput = z.input<typeof zTodoRecurrence>;

const zTodoTitle = z.string().trim().min(1).max(TODO_TITLE_MAX);
const zTodoDetails = z.string().max(TODO_DETAILS_MAX);
export const zTodoStep = z.strictObject({ text: z.string().trim().min(1).max(TODO_STEP_MAX), done: z.boolean() });
export type TodoStep = z.infer<typeof zTodoStep>;
const zChecklist = z.array(zTodoStep).max(TODO_STEPS_MAX);
const zDay = z.iso.date();
// A time of day, 24-hour HH:mm, on the due day in the to-do's time zone.
const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dueTimeNeedsDay = (v: { dueOn: string | null; dueTime: string | null }) => v.dueTime === null || v.dueOn !== null;
const DUE_TIME_NEEDS_DAY = { message: 'A due time needs a due day', path: ['dueTime'] };

// The reminder (notes.md §3.8): 'auto' reminds at TODO_REMIND_TIME on the due day, or TODO_REMIND_BEFORE_MINUTES
// before a due time, and not at all without a due day or once that time has passed; 'off' never; { at } at that
// instant, which must be ahead.
export const TODO_REMIND_TIME = '08:00';
export const TODO_REMIND_BEFORE_MINUTES = 30;
export const zTodoReminder = z.union([z.enum(['auto', 'off']), z.strictObject({ at: z.iso.datetime({ offset: true }) })]);
export type TodoReminder = z.infer<typeof zTodoReminder>;

// A new to-do: the title, and optionally its details, steps, due day and time, and source note, in the caller's time zone.
export const zTodoCreate = z
  .strictObject({
    title: zTodoTitle,
    details: zTodoDetails.default(''),
    checklist: zChecklist.default([]),
    dueOn: zDay.nullable().default(null),
    dueTime: zTime.nullable().default(null),
    timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
    reminder: zTodoReminder.default('auto'),
    recurrence: zTodoRecurrence.nullable().optional(),
    link: zNoteLinkTarget.optional(),
    sourceNoteId: zId.optional(),
  })
  .refine(dueTimeNeedsDay, DUE_TIME_NEEDS_DAY);
export type TodoCreateInput = z.input<typeof zTodoCreate>;
// The owner's edit, against the revision they read (TODO_REVISION_CONFLICT when it moved on). Without `reminder` the
// reminder stays as it was, unless it was the automatic one, or there was none for want of a due day, and the due day
// or time moved: it then follows them.
export const zTodoUpdate = z
  .strictObject({
    todoId: zId,
    revision: z.number().int().positive(),
    title: zTodoTitle,
    details: zTodoDetails,
    checklist: zChecklist,
    dueOn: zDay.nullable(),
    dueTime: zTime.nullable(),
    timeZone: zTimeZone,
    reminder: zTodoReminder.optional(),
    recurrence: zTodoRecurrence.nullable().optional(),
  })
  .refine(dueTimeNeedsDay, DUE_TIME_NEEDS_DAY);
export type TodoUpdateInput = z.input<typeof zTodoUpdate>;
export const zTodoRef = z.strictObject({ todoId: zId });
export const zTodoStoppedSibling = z.strictObject({
  todoId: zId,
  recurrence: zTodoRecurrence,
});
export type TodoStoppedSibling = z.infer<typeof zTodoStoppedSibling>;
export const zTodoReopen = z.strictObject({
  todoId: zId,
  undoNextTodoId: zId.optional(),
  expectedRevision: z.number().int().positive().optional(),
  restoreRecurrence: zTodoRecurrence.optional(),
  restoreSiblings: z.array(zTodoStoppedSibling).max(100).optional(),
});
export type TodoReopenInput = z.input<typeof zTodoReopen>;
export const zTodoComplete = z.strictObject({
  todoId: zId,
  stopSeries: z.boolean().optional(),
});
export type TodoCompleteInput = z.input<typeof zTodoComplete>;
export const zTodoReschedule = z.strictObject({
  todoIds: z
    .array(zId)
    .min(1)
    .max(TODO_RESCHEDULE_BATCH_MAX)
    .transform((ids) => [...new Set(ids)]),
  dueOn: zDay,
});
export type TodoRescheduleInput = z.input<typeof zTodoReschedule>;
// Moves a to-do right before or right after another of the owner's (the anchor) in their own order.
export const zTodoReorder = z
  .strictObject({ todoId: zId, place: z.enum(['before', 'after']), anchorId: zId })
  .refine((v) => v.todoId !== v.anchorId, { message: 'A to-do is not moved next to itself', path: ['anchorId'] });
export type TodoReorderInput = z.input<typeof zTodoReorder>;
// `q` keeps the to-dos whose title, details or steps hold every word, typed with or without Vietnamese marks.
export const zTodoList = z.strictObject({
  view: z.enum(TODO_LIST_VIEWS),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export type TodoListInput = z.input<typeof zTodoList>;

// What a command returns: ids and the revision, never text (idempotency rows keep results, notes.md §3.5).
export const zTodoWritten = z.object({ todoId: z.string(), revision: z.number().int() });
export type TodoWritten = z.infer<typeof zTodoWritten>;
export const zTodoCompleteResult = zTodoWritten.extend({
  nextTodoId: z.string().nullable().optional(),
  nextDueOn: z.string().nullable().optional(),
  stoppedSiblings: z.array(zTodoStoppedSibling).optional(),
});
export type TodoCompleteResult = z.infer<typeof zTodoCompleteResult>;
export const zTodoRescheduled = z.object({
  updated: z.number().int().nonnegative(),
  todoIds: z.array(z.string()),
});
export type TodoRescheduled = z.infer<typeof zTodoRescheduled>;

// The source note a to-do was made from (notes.md step N7): available says the caller can read the non-trashed
// note now; false when it is trashed or another member's private note (never leaking its title).
export const zTodoSourceNote = z.object({
  id: z.string(),
  title: z.string().nullable(),
  available: z.boolean(),
});
export type TodoSourceNote = z.infer<typeof zTodoSourceNote>;

// A to-do in a list, in the owner's order. `dueTime` is the due time on the wall clock of `timeZone`; `group` is the
// My work group of an open to-do (null otherwise), and `overdue` says its day, or its time today, has passed.
export const zTodoSummary = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(TODO_STATUSES),
  dueOn: z.string().nullable(),
  dueAt: z.string().nullable(),
  dueTime: z.string().nullable(),
  timeZone: z.string(),
  // The reminder's time, or null for none; it may have passed (sent, or already past when it was set).
  remindAt: z.string().nullable(),
  group: z.enum(TODO_DUE_GROUPS).nullable(),
  overdue: z.boolean(),
  steps: z.object({ done: z.number().int(), total: z.number().int() }),
  sourceNoteId: z.string().nullable(),
  sourceNote: zTodoSourceNote.nullable(),
  taskId: z.string().nullable(),
  recurrence: zTodoRecurrence.nullable(),
  seriesId: z.string().nullable(),
  tainted: z.boolean(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  doneAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});
export type TodoSummary = z.infer<typeof zTodoSummary>;
export const zTodo = zTodoSummary.extend({
  details: z.string(),
  checklist: z.array(z.object({ text: z.string(), done: z.boolean() })),
  links: z.array(zNoteLinkView),
});
export type Todo = z.infer<typeof zTodo>;

// A record's panel: its pinned notes, the latest others, and the viewer's own linked private to-dos (notes.md §3.4, §3.10).
export const zNoteRecordPanelView = z.object({
  pinned: z.array(zNoteSummary),
  latest: z.array(zNoteSummary),
  todos: z.array(zTodoSummary),
});
export type NoteRecordPanel = z.infer<typeof zNoteRecordPanelView>;

export const zTodoLinkAdd = z.strictObject({ todoId: zId, targetType: z.enum(NOTE_LINK_TARGETS), targetId: zId });
export const zTodoLinkRemove = z.strictObject({ linkId: zId });
export const zTodoLinkWritten = z.object({ todoId: z.string(), linkId: z.string() });

// How many to-dos each member has, for an owner or admin before removing them (ADR-0037 §4). No text.
export const zTodoCount = z.object({ userId: z.string(), todos: z.number().int() });
export type TodoCount = z.infer<typeof zTodoCount>;

// Hands an open to-do over to a position as a team task (#1674, notes.md step N5): the title and description are the
// text the member confirmed, which every member of the org and the position's holder will read; the to-do's own
// details stay with it. Against the revision the member read, so they confirm the to-do as it is.
export const zTodoHandOver = z.strictObject({
  todoId: zId,
  revision: z.number().int().positive(),
  positionId: zId,
  title: zTodoTitle,
  description: zTodoDetails,
  projectId: zId.optional(),
});
export type TodoHandOverInput = z.input<typeof zTodoHandOver>;
export const zTodoHandedOver = zTodoWritten.extend({ taskId: z.string() });
export type TodoHandedOver = z.infer<typeof zTodoHandedOver>;

// "Việc của tôi" (notes.md §3.10, step N5; projects.md §4.3, step P3): my open to-dos and the open tasks of the
// positions I hold, with each task's project when the projects module is active, grouped by due day in the member's time zone.
export const zMyWorkInput = z.strictObject({
  timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
  projectId: z.union([zId, z.literal('none')]).optional(),
});
export type MyWorkInput = z.input<typeof zMyWorkInput>;
export const zMyWorkTaskProject = z.object({
  id: z.string(),
  name: z.string(),
});
export type MyWorkTaskProject = z.infer<typeof zMyWorkTaskProject>;
export const zMyWorkTask = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  positionId: z.string().nullable(),
  due: z.string().nullable(),
  group: z.enum(TODO_DUE_GROUPS),
  overdue: z.boolean(),
  tainted: z.boolean(),
  steps: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  project: zMyWorkTaskProject.nullable(),
});
export type MyWorkTask = z.infer<typeof zMyWorkTask>;
// tasksTruncated: the kernel's task list was full, so older tasks of my positions may be missing.
// projectsAvailable: projects module is installed and enabled for this org.
// noSeatHint: member (non-owner, non-viewer) holds no active seat in a multi-member org.
export const zMyWork = z.object({
  todos: z.array(zTodoSummary),
  tasks: z.array(zMyWorkTask),
  tasksTruncated: z.boolean(),
  projectsAvailable: z.boolean(),
  noSeatHint: z.boolean(),
});
export type MyWork = z.infer<typeof zMyWork>;

const DAY_MS = 86_400_000;

function parseLocalDateParts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}

function formatLocalDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInTodoMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function resolveTodoMonthlyDate(year: number, month: number, monthDay: number): string {
  const day = monthDay === -1 ? daysInTodoMonth(year, month) : Math.min(monthDay, daysInTodoMonth(year, month));
  return formatLocalDate(year, month, day);
}

/** Adds `n` calendar days to a `YYYY-MM-DD` local date. */
export function addTodoLocalDays(day: string, n: number): string {
  const [y, m, d] = parseLocalDateParts(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Sunday=0 .. Saturday=6 weekday of a `YYYY-MM-DD` calendar date. */
export function weekdayOfTodoDate(day: string): number {
  const [y, m, d] = parseLocalDateParts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The next Monday strictly after `today` (`YYYY-MM-DD`). */
export function nextMondayFrom(today: string): string {
  const sunday0 = weekdayOfTodoDate(today);
  // Sunday(0) -> +1, Monday(1) -> +7, Tuesday(2) -> +6, ..., Saturday(6) -> +2.
  const offset = sunday0 === 0 ? 1 : 8 - sunday0;
  return addTodoLocalDays(today, offset);
}

/** Strips unset optional keys from a validated recurrence rule for deterministic storage and comparison. */
export function normalizeTodoRecurrence(rule: TodoRecurrence): TodoRecurrence {
  if (rule.freq === 'daily') {
    return { freq: 'daily', interval: rule.interval };
  }
  if (rule.freq === 'weekly') {
    return {
      freq: 'weekly',
      interval: rule.interval,
      ...(rule.byWeekday !== undefined && rule.byWeekday !== null ? { byWeekday: rule.byWeekday } : {}),
    };
  }
  return {
    freq: 'monthly',
    interval: rule.interval,
    ...(rule.byMonthDay !== undefined && rule.byMonthDay !== null ? { byMonthDay: rule.byMonthDay } : {}),
  };
}

/** Parses stored JSONB recurrence safely, returning null when null or malformed. */
export function parseTodoRecurrence(value: unknown): TodoRecurrence | null {
  if (value === null || value === undefined) return null;
  const parsed = zTodoRecurrence.safeParse(value);
  return parsed.success ? normalizeTodoRecurrence(parsed.data) : null;
}

/** Computes the next local due date (`YYYY-MM-DD`) strictly after `anchorDate` for a recurring personal to-do. */
export function nextTodoOccurrenceDate(rule: TodoRecurrence, anchorDate: string): string {
  if (rule.freq === 'daily') {
    return addTodoLocalDays(anchorDate, rule.interval);
  }
  if (rule.freq === 'weekly') {
    if (rule.byWeekday === undefined || rule.byWeekday === null) {
      return addTodoLocalDays(anchorDate, rule.interval * 7);
    }
    const afterWeekday = weekdayOfTodoDate(anchorDate);
    const sundayOfAnchor = addTodoLocalDays(anchorDate, -afterWeekday);
    const sameWeekCandidate = addTodoLocalDays(sundayOfAnchor, rule.byWeekday);
    return sameWeekCandidate > anchorDate ? sameWeekCandidate : addTodoLocalDays(sameWeekCandidate, rule.interval * 7);
  }
  const [year, month, anchorDay] = parseLocalDateParts(anchorDate);
  const targetDay = rule.byMonthDay ?? anchorDay;
  if (rule.byMonthDay !== undefined && rule.byMonthDay !== null) {
    const sameMonthCandidate = resolveTodoMonthlyDate(year, month, targetDay);
    if (sameMonthCandidate > anchorDate) return sameMonthCandidate;
  }
  const totalMonths = year * 12 + (month - 1) + rule.interval;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = (totalMonths % 12) + 1;
  return resolveTodoMonthlyDate(nextYear, nextMonth, targetDay);
}

/** The My work group of a due day, against today in the same time zone (both YYYY-MM-DD). */
export function todoDueGroup(dueOn: string | null, today: string): TodoDueGroup {
  if (dueOn === null) return 'none';
  if (dueOn < today) return 'overdue';
  if (dueOn === today) return 'today';
  return dueOn <= addTodoLocalDays(today, 7) ? 'next7' : 'later';
}

/** The instant a to-do is due at: its day at `time` (HH:mm) on the wall clock of `timeZone`. */
export function todoDueInstant(dueOn: string, time: string, timeZone: string): Date {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return new Date(zonedInstant(timeZone, dueOn, h * 60 + m));
}

/** The automatic reminder of a due day and time: TODO_REMIND_BEFORE_MINUTES before the time, else TODO_REMIND_TIME on the day. */
export function todoAutoReminder(t: { dueOn: string | null; dueAt: Date | null; timeZone: string }): Date | null {
  if (t.dueAt !== null) return new Date(t.dueAt.getTime() - TODO_REMIND_BEFORE_MINUTES * 60_000);
  return t.dueOn === null ? null : todoDueInstant(t.dueOn, TODO_REMIND_TIME, t.timeZone);
}

/** The wall-clock time (HH:mm) of an instant in `timeZone`. */
export function todoLocalTime(at: Date, timeZone: string): string {
  const local = at.getTime() + zoneOffsetMs(timeZone, at.getTime());
  const minutes = Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60_000);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Shifts a to-do's `dueOn`, `dueAt`, and `remindAt` to `nextDueOn` in `current.timeZone`:
 * - preserves wall-clock `dueAt` time of day if `dueAt` was set;
 * - keeps automatic reminders automatic on the new day/time, shifts custom reminders by the same lead duration
 *   before the due instant (or local midnight if no time was set), or preserves local clock if previously dateless.
 */
export function shiftTodoSchedule(
  current: { dueOn: string | null; dueAt: Date | null; timeZone: string; remindAt: Date | null },
  nextDueOn: string,
): { dueOn: string; dueAt: Date | null; remindAt: Date | null } {
  const nextDueAt =
    current.dueAt !== null ? todoDueInstant(nextDueOn, todoLocalTime(current.dueAt, current.timeZone), current.timeZone) : null;
  if (current.remindAt === null) {
    return { dueOn: nextDueOn, dueAt: nextDueAt, remindAt: null };
  }
  const autoBefore = todoAutoReminder({ dueOn: current.dueOn, dueAt: current.dueAt, timeZone: current.timeZone });
  if (autoBefore !== null && current.remindAt.getTime() === autoBefore.getTime()) {
    return {
      dueOn: nextDueOn,
      dueAt: nextDueAt,
      remindAt: todoAutoReminder({ dueOn: nextDueOn, dueAt: nextDueAt, timeZone: current.timeZone }),
    };
  }
  if (current.dueOn !== null) {
    const beforeAnchor = current.dueAt ?? todoDueInstant(current.dueOn, '00:00', current.timeZone);
    const nextAnchor = nextDueAt ?? todoDueInstant(nextDueOn, '00:00', current.timeZone);
    const leadMs = beforeAnchor.getTime() - current.remindAt.getTime();
    return {
      dueOn: nextDueOn,
      dueAt: nextDueAt,
      remindAt: new Date(nextAnchor.getTime() - leadMs),
    };
  }
  return {
    dueOn: nextDueOn,
    dueAt: nextDueAt,
    remindAt: todoDueInstant(nextDueOn, todoLocalTime(current.remindAt, current.timeZone), current.timeZone),
  };
}

/** Where a task due at `due` stands at `now` for a member in `timeZone`: its group by that day there, and whether it is late. */
export function taskStanding(due: Date | null, timeZone: string, now: Date): { group: TodoDueGroup; overdue: boolean } {
  if (due === null) return { group: 'none', overdue: false };
  const group = todoDueGroup(zonedDate(timeZone, due.getTime()), zonedDate(timeZone, now.getTime()));
  return { group, overdue: group === 'overdue' || due.getTime() < now.getTime() };
}

/** Where an open to-do stands at `now`: its group by the day in its own time zone, and whether it is late. */
export function todoStanding(t: { dueOn: string | null; dueAt: Date | null; timeZone: string }, now: Date): { group: TodoDueGroup; overdue: boolean } {
  const group = todoDueGroup(t.dueOn, zonedDate(t.timeZone, now.getTime()));
  return { group, overdue: group === 'overdue' || (group === 'today' && t.dueAt !== null && t.dueAt.getTime() < now.getTime()) };
}

// The member's own notes and to-dos, whole, for their download (#1678, notes.md section 5: "Tải về", ADR-0037 section 5:
// their access and portability): every note they wrote, private or shared, archived or in the trash, with its links,
// and every to-do of theirs. Nobody else's, whatever the caller's role. At most NOTES_EXPORT_LIMIT of each and
// NOTES_EXPORT_TEXT characters of their text in all, the newest first; truncated says more were left out.
export const NOTES_EXPORT_LIMIT = 2000;
export const NOTES_EXPORT_TEXT = 20_000_000;
export const zNotesExport = z.object({
  exportedAt: z.string(),
  notes: z.array(
    z.object({
      id: z.string(),
      visibility: z.enum(NOTE_VISIBILITIES),
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()),
      pinned: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string(),
      archivedAt: z.string().nullable(),
      deletedAt: z.string().nullable(),
      links: z.array(z.object({ targetType: z.string(), targetId: z.string() })),
    }),
  ),
  todos: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      details: z.string(),
      checklist: z.array(z.object({ text: z.string(), done: z.boolean() })),
      status: z.enum(TODO_STATUSES),
      dueOn: z.string().nullable(),
      dueAt: z.string().nullable(),
      timeZone: z.string(),
      remindAt: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      doneAt: z.string().nullable(),
      deletedAt: z.string().nullable(),
      // The note it was made from and the team task it was handed over as, when there are.
      sourceNoteId: z.string().nullable(),
      taskId: z.string().nullable(),
      recurrence: zTodoRecurrence.nullable(),
      seriesId: z.string().nullable(),
      links: z.array(z.object({ targetType: z.string(), targetId: z.string() })),
    }),
  ),
  truncated: z.boolean(),
});
export type NotesExport = z.infer<typeof zNotesExport>;

// Member-scoped Vy for Notes (N8, #1677, ADR-0037, ADR-0049): summarize a readable note and suggest personal to-dos.
export const NOTE_VY_DISABLED_REASONS = ['off', 'paused', 'budget', 'forbidden'] as const;
export type NoteVyDisabledReason = (typeof NOTE_VY_DISABLED_REASONS)[number];

export const zNoteVyStatus = z.object({
  available: z.boolean(),
  reason: z.enum(NOTE_VY_DISABLED_REASONS).nullable(),
  resetOn: z.string().nullable(),
});
export type NoteVyStatus = z.infer<typeof zNoteVyStatus>;

export const zNoteAiLanguage = z.enum(['vi', 'en']);
export type NoteAiLanguage = z.infer<typeof zNoteAiLanguage>;

export const zNoteSummarizeInput = z.strictObject({
  noteId: zId,
  language: zNoteAiLanguage.optional(),
});
export type NoteSummarizeInput = z.infer<typeof zNoteSummarizeInput>;

export const zNoteSummarizeResult = z.object({
  state: z.enum(['ready', 'failed']),
  runId: z.string(),
  noteId: z.string(),
  noteRevision: z.number().int(),
  stale: z.boolean(),
  summary: z.string(),
  bullets: z.array(z.string()),
  dropped: z.number().int(),
  errorCode: z.string().nullable(),
});
export type NoteSummarizeResult = z.infer<typeof zNoteSummarizeResult>;

export const zNoteSuggestTodosInput = z.strictObject({
  noteId: zId,
  timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
  language: zNoteAiLanguage.optional(),
});
export type NoteSuggestTodosInput = z.input<typeof zNoteSuggestTodosInput>;

export const zNoteTodoSuggestion = z.object({
  title: z.string(),
  details: z.string(),
  dueOn: z.string().nullable(),
});
export type NoteTodoSuggestion = z.infer<typeof zNoteTodoSuggestion>;

export const zNoteSuggestTodosResult = z.object({
  state: z.enum(['ready', 'failed']),
  runId: z.string(),
  noteId: z.string(),
  noteRevision: z.number().int(),
  stale: z.boolean(),
  suggestions: z.array(zNoteTodoSuggestion),
  dropped: z.number().int(),
  errorCode: z.string().nullable(),
});
export type NoteSuggestTodosResult = z.infer<typeof zNoteSuggestTodosResult>;

export const zNoteVyResults = z.object({
  noteId: z.string(),
  summary: zNoteSummarizeResult.nullable(),
  todoSuggest: zNoteSuggestTodosResult.nullable(),
});
export type NoteVyResults = z.infer<typeof zNoteVyResults>;

export const NOTE_ACCEPT_SUMMARY_MODES = ['replace', 'append'] as const;
export type NoteAcceptSummaryMode = (typeof NOTE_ACCEPT_SUMMARY_MODES)[number];

export const zNoteAcceptSummary = z.strictObject({
  noteId: zId,
  revision: z.number().int().positive(),
  mode: z.enum(NOTE_ACCEPT_SUMMARY_MODES),
  summary: z.string().trim().min(1).max(4_000),
  bullets: z.array(z.string().trim().min(1).max(400)).max(10).default([]),
  runId: zId.optional(),
});
export type NoteAcceptSummaryInput = z.input<typeof zNoteAcceptSummary>;

export const zTodoAcceptSuggestionRow = z
  .strictObject({
    title: zTodoTitle,
    details: zTodoDetails.default(''),
    dueOn: zDay.nullable().default(null),
    dueTime: zTime.nullable().default(null),
    timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
    reminder: zTodoReminder.default('auto'),
  })
  .refine(dueTimeNeedsDay, DUE_TIME_NEEDS_DAY);
export type TodoAcceptSuggestionRow = z.input<typeof zTodoAcceptSuggestionRow>;

export const zTodoAcceptSuggestions = z.strictObject({
  noteId: zId,
  noteRevision: z.number().int().positive(),
  runId: zId.optional(),
  items: z.array(zTodoAcceptSuggestionRow).min(1).max(10),
});
export type TodoAcceptSuggestionsInput = z.input<typeof zTodoAcceptSuggestions>;

export const zTodoAcceptSuggestionsResult = z.object({
  noteId: z.string(),
  created: z.number().int(),
  todoIds: z.array(z.string()),
});
export type TodoAcceptSuggestionsResult = z.infer<typeof zTodoAcceptSuggestionsResult>;
