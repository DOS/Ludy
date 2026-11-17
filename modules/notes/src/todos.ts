// A member's own to-dos (issue #1673, plan docs/plan/notes.md §3.2, §3.5, §3.8 and step N4, ADR-0037). A to-do is
// always private: the database's row policies show it to its owner alone, so every query here reads only the caller's
// own, and another member's to-do answers TODO_NOT_FOUND as if it did not exist, for an owner or admin of the org too.
// Agents run none of these (no command declares `agent`), and the system context reads none (its definers count).
//
// Audit rows are anchored in the WORM stream and outlive an erasure, so a command's audit facts carry ids, the due day
// and changed field names, and a marker for the text (auditValue), never the title, details or steps. Command results
// carry ids and the revision only, since idempotency rows keep them.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  PROJECT_TASK_MAP_LIMIT,
  REBALANCE_AT,
  TODO_LISTS_MAX,
  TODO_LIST_COLORS,
  auditValue,
  countTaskChecklistSteps,
  keyBetween,
  spreadKeys,
  taskStanding,
  todoAutoReminder,
  todoDueInstant,
  todoLocalTime,
  todoStanding,
  zMyWorkInput,
  zTodoCreate,
  zTodoHandOver,
  zTodoLinkAdd,
  zTodoLinkRemove,
  zTodoList,
  zTodoListCreate,
  zTodoListRef,
  zTodoListUpdate,
  zTodoRef,
  zTodoReorder,
  zTodoUpdate,
  type MyWork,
  type MyWorkTask,
  type ProjectTaskProjectEntry,
  type TaskChecklistStep,
  type Todo,
  type TodoCount,
  type TodoHandedOver,
  type TodoListColor,
  type TodoListSection,
  type TodoListSectionInput,
  type TodoListSummary,
  type TodoListWritten,
  type TodoListsResponse,
  type TodoPriority,
  type TodoReminder,
  type TodoSourceNote,
  type TodoStatus,
  type TodoStep,
  type TodoSummary,
  type TodoWritten,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { insertRecordLink, loadEnrichedLinks } from './links.ts';
import { notesManifest } from './manifest.ts';

// Owners, admins and members keep to-dos; viewers write none (notes.md §3.5). They run the reads, where the row
// policies show them none but their own: a member made a viewer still reads what they wrote.
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const TODO = notesManifest.tables.crove_notes.todo;
const TODO_LIST = notesManifest.tables.crove_notes.todo_list;

export const TODO_SUMMARY_COLUMNS = [
  'id',
  'title',
  'checklist',
  'status',
  'priority',
  'tags',
  'list_id',
  'section_id',
  'due_on',
  'due_at',
  'time_zone',
  'remind_at',
  'sort_key',
  'source_note_id',
  'task_id',
  'tainted',
  'revision',
  'created_at',
  'updated_at',
  'done_at',
  'deleted_at',
] as const;
const SUMMARY = TODO_SUMMARY_COLUMNS;

interface SummaryRow {
  id: string;
  title: string;
  checklist: unknown;
  status: TodoStatus;
  priority: number;
  tags: string[];
  list_id: string | null;
  section_id: string | null;
  due_on: string | null;
  due_at: Date | string | null;
  time_zone: string;
  remind_at: Date | string | null;
  sort_key: string;
  source_note_id: string | null;
  task_id: string | null;
  tainted: boolean;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  done_at: Date | string | null;
  deleted_at: Date | string | null;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const steps = (checklist: unknown): TodoStep[] => (Array.isArray(checklist) ? (checklist as TodoStep[]) : []);

// Batch-reads distinct source notes under the caller's own RLS (non-trashed only): returns { id, title, available: true }
// when readable, and { id, title: null, available: false } when unreadable or trashed (never leaking its title).
export async function loadSourceNotes(
  ctx: Pick<QueryContext, 'trx' | 'orgId'>,
  rows: ReadonlyArray<Pick<SummaryRow, 'source_note_id'>>,
): Promise<Map<string, TodoSourceNote>> {
  const ids = [...new Set(rows.map((r) => r.source_note_id).filter((id): id is string => id !== null))];
  const map = new Map<string, TodoSourceNote>();
  if (ids.length === 0) return map;
  const readable = await ctx.trx
    .selectFrom('crove_notes.note')
    .select(['id', 'title'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', ids)
    .where('deleted_at', 'is', null)
    .execute();
  for (const note of readable) {
    map.set(note.id, { id: note.id, title: note.title, available: true });
  }
  for (const id of ids) {
    if (!map.has(id)) map.set(id, { id, title: null, available: false });
  }
  return map;
}

export function todoSummaryRow(r: SummaryRow, now: Date, sourceNotes?: ReadonlyMap<string, TodoSourceNote>): TodoSummary {
  const dueAt = r.due_at === null ? null : new Date(r.due_at);
  const list = steps(r.checklist);
  const standing = r.status === 'open' && r.deleted_at === null ? todoStanding({ dueOn: r.due_on, dueAt, timeZone: r.time_zone }, now) : null;
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: (r.priority ?? 4) as TodoPriority,
    tags: Array.isArray(r.tags) ? r.tags : [],
    listId: r.list_id ?? null,
    sectionId: r.section_id ?? null,
    dueOn: r.due_on,
    dueAt: dueAt?.toISOString() ?? null,
    dueTime: dueAt ? todoLocalTime(dueAt, r.time_zone) : null,
    timeZone: r.time_zone,
    remindAt: iso(r.remind_at),
    group: standing?.group ?? null,
    overdue: standing?.overdue ?? false,
    steps: { done: list.filter((s) => s.done).length, total: list.length },
    sourceNoteId: r.source_note_id,
    sourceNote: r.source_note_id === null ? null : (sourceNotes?.get(r.source_note_id) ?? { id: r.source_note_id, title: null, available: false }),
    taskId: r.task_id,
    tainted: r.tainted,
    revision: r.revision,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    doneAt: iso(r.done_at),
    deletedAt: iso(r.deleted_at),
  };
}
const summary = todoSummaryRow;

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const notFound = () => new DomainError('TODO_NOT_FOUND', 404, 'Không tìm thấy việc này');
const revisionConflict = (revision: number) =>
  new DomainError('TODO_REVISION_CONFLICT', 409, 'Việc này vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', { revision });
const listNotFound = () => new DomainError('TODO_LIST_NOT_FOUND', 404, 'Không tìm thấy danh sách này');
const listRevisionConflict = (revision: number) =>
  new DomainError('TODO_LIST_REVISION_CONFLICT', 409, 'Danh sách này vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', { revision });
const sectionNotFound = () => new DomainError('TODO_SECTION_NOT_FOUND', 400, 'Không tìm thấy mục này trong danh sách');
const listLimitReached = () => new DomainError('TODO_LIST_LIMIT_REACHED', 422, 'Bạn đã tạo tối đa số danh sách cá nhân');

const listTarget = (input: { listId: string }) => ({ type: 'notes.todo_list', id: input.listId });
const listWritten = (row: { id: string; revision: number }): TodoListWritten => ({ listId: row.id, revision: row.revision });
export const listColorOf = (raw: string | null): TodoListColor | null =>
  raw !== null && (TODO_LIST_COLORS as readonly string[]).includes(raw) ? (raw as TodoListColor) : null;

export function parseSections(raw: unknown): TodoListSection[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoListSection[] = [];
  for (const item of raw) {
    if (typeof item === 'object' && item !== null && 'id' in item && 'name' in item && typeof item.id === 'string' && typeof item.name === 'string') {
      out.push({ id: item.id, name: item.name });
    }
  }
  return out;
}

function normalizeSections(inputs: ReadonlyArray<TodoListSectionInput>): TodoListSection[] {
  const seen = new Set<string>();
  return inputs.map((item) => {
    let id = item.id ?? `sec_${randomUUID().slice(0, 8)}`;
    while (seen.has(id)) id = `sec_${randomUUID().slice(0, 8)}`;
    seen.add(id);
    return { id, name: item.name };
  });
}

const normalizeListId = (listId: string | null): string | null => (listId === null ? null : listId.toLowerCase());

// Verify personal list readability/liveness under caller RLS and section_id membership (no existence oracle).
// Takes FOR SHARE when called during a write so concurrent todo_list.update/delete cannot race past it.
async function validateTodoListAndSection(
  ctx: Pick<CommandContext, 'trx' | 'orgId'>,
  listId: string | null,
  sectionId: string | null,
  lockShare = false,
): Promise<void> {
  if (listId === null) {
    if (sectionId !== null) throw sectionNotFound();
    return;
  }
  let q = ctx.trx
    .selectFrom('crove_notes.todo_list')
    .select(['id', 'sections'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', listId)
    .where('deleted_at', 'is', null);
  if (lockShare) q = q.forShare();
  const list = await q.executeTakeFirst();
  if (!list) throw listNotFound();
  if (sectionId !== null && !parseSections(list.sections).some((s) => s.id === sectionId)) {
    throw sectionNotFound();
  }
}

// The caller's to-do (row policies: their own only), with its details, locked for a change when `lock` is set.
async function load(ctx: Pick<QueryContext, 'trx' | 'orgId'>, todoId: string, lock: boolean): Promise<SummaryRow & { details: string | null }> {
  let q = ctx.trx.selectFrom('crove_notes.todo').select([...SUMMARY, 'details']).where('org_id', '=', ctx.orgId).where('id', '=', todoId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

function assertNotInTrash(row: SummaryRow): void {
  if (row.deleted_at !== null) throw new DomainError('TODO_IN_TRASH', 409, 'Việc này đang ở thùng rác; hãy khôi phục trước');
}

// The due day and time as stored: the time becomes an instant on that day in the to-do's time zone.
export function due(input: { dueOn: string | null; dueTime: string | null; timeZone: string }): { due_on: string | null; due_at: Date | null; time_zone: string } {
  return {
    due_on: input.dueOn,
    due_at: input.dueOn !== null && input.dueTime !== null ? todoDueInstant(input.dueOn, input.dueTime, input.timeZone) : null,
    time_zone: input.timeZone,
  };
}

// When the reminder is due (notes.md §3.8), and whether it counts as passed: an automatic time already past (a to-do
// written for today after 8:00) is kept, so it still reads as automatic and follows a moved due day, but marked passed,
// so it is not sent at once; a picked time must be ahead.
export function remindAt(reminder: TodoReminder, at: { due_on: string | null; due_at: Date | null; time_zone: string }, now: Date): { at: Date | null; passed: boolean } {
  if (reminder === 'off') return { at: null, passed: false };
  if (reminder === 'auto') {
    const auto = todoAutoReminder({ dueOn: at.due_on, dueAt: at.due_at, timeZone: at.time_zone });
    return { at: auto, passed: auto !== null && auto.getTime() <= now.getTime() };
  }
  const picked = new Date(reminder.at);
  if (picked.getTime() <= now.getTime()) throw new DomainError('TODO_REMINDER_PAST', 400, 'Giờ nhắc đã qua; hãy chọn một giờ sắp tới');
  return { at: picked, passed: false };
}

// A to-do back in the list (reopened, restored) whose reminder time passed meanwhile is not reminded late.
const reminderPassed = (now: Date) => sql<Date | null>`CASE WHEN remind_at <= ${now}::timestamptz AND reminded_at IS NULL THEN ${now}::timestamptz ELSE reminded_at END`;

// How a reminder is told in the audit: its kind and time, never the to-do's text.
const reminderKind = (reminder: TodoReminder) => (typeof reminder === 'string' ? reminder : 'custom');

// The text as stored: empty details are none, and the steps are JSON for the jsonb column.
export const detailsOf = (details: string): string | null => (details.trim() === '' ? null : details);
const checklistOf = (checklist: readonly TodoStep[]): string => JSON.stringify(checklist.map((s) => ({ text: s.text, done: s.done })));

const written = (row: Pick<SummaryRow, 'id' | 'revision'>): TodoWritten => ({ todoId: row.id, revision: row.revision });
const target = (input: { todoId: string }) => ({ type: 'notes.todo', id: input.todoId });

// The caller's keys in order, ties by id; the moved to-do itself left out.
export async function ownKeys(ctx: CommandContext, except: string | null): Promise<Array<{ id: string; sort_key: string }>> {
  let q = ctx.trx.selectFrom('crove_notes.todo').select(['id', 'sort_key']).where('org_id', '=', ctx.orgId);
  if (except !== null) q = q.where('id', '<>', except);
  return q.orderBy('sort_key').orderBy('id').execute();
}

// Fresh, evenly spread keys for the caller's whole list, in its current order (keys grown long, or two equal).
async function rebalance(ctx: CommandContext, rows: ReadonlyArray<{ id: string }>): Promise<Map<string, string>> {
  const keys = spreadKeys(rows.length);
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    // One statement for the whole list; the update policy still limits it to the caller's own rows.
    await sql`UPDATE crove_notes.todo AS t SET sort_key = v.key
      FROM unnest(${ids}::uuid[], ${keys}::text[]) AS v(id, key)
      WHERE t.org_id = ${ctx.orgId}::uuid AND t.id = v.id`.execute(ctx.trx);
  }
  return new Map(ids.map((id, i) => [id, keys[i] as string]));
}

// A key between two neighbors of the caller's list (by index in `rows`, -1 or rows.length for an end), giving the list
// fresh keys first when the two are equal or the new key would grow long.
export async function placeBetween(ctx: CommandContext, rows: Array<{ id: string; sort_key: string }>, lo: number, hi: number): Promise<string> {
  const keyAt = (i: number) => (i < 0 || i >= rows.length ? null : (rows[i] as { sort_key: string }).sort_key);
  const a = keyAt(lo);
  const b = keyAt(hi);
  if (a === null || b === null || a < b) {
    const key = keyBetween(a, b);
    // A key that ends in '0' from elsewhere can leave no room the byte order agrees with; fresh keys then.
    if (key.length <= REBALANCE_AT && (a === null || a < key) && (b === null || key < b)) return key;
  }
  const fresh = await rebalance(ctx, rows);
  const freshAt = (i: number) => (i < 0 || i >= rows.length ? null : (fresh.get((rows[i] as { id: string }).id) as string));
  return keyBetween(freshAt(lo), freshAt(hi));
}

export const todoCreate = defineCommand({
  name: 'notes.todo.create',
  input: zTodoCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<TodoWritten> => {
    const userId = userOf(ctx.actor);
    let sourceTainted = false;
    if (input.sourceNoteId !== undefined) {
      // Checked under caller RLS with deleted_at IS NULL: missing, trashed, or private to another member all answer
      // identically with 404 NOTE_NOT_FOUND (no existence oracle). Inherit server-side taint so AI note content stays tainted.
      const sourceNote = await ctx.trx
        .selectFrom('crove_notes.note')
        .select(['id', 'tainted'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.sourceNoteId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!sourceNote) throw new DomainError('NOTE_NOT_FOUND', 404, 'Không tìm thấy ghi chú này');
      sourceTainted = sourceNote.tainted;
    }
    const listId = normalizeListId(input.listId);
    await validateTodoListAndSection(ctx, listId, input.sectionId, true);
    // A new to-do goes first in the caller's list.
    const rows = await ownKeys(ctx, null);
    const sortKey = await placeBetween(ctx, rows, -1, 0);
    const when = due(input);
    const remind = remindAt(input.reminder, when, ctx.now);
    const row = await ctx.trx
      .insertInto('crove_notes.todo')
      .values({
        org_id: ctx.orgId,
        owner_user_id: userId,
        title: input.title,
        details: detailsOf(input.details),
        checklist: checklistOf(input.checklist),
        priority: input.priority,
        tags: input.tags,
        list_id: listId,
        section_id: input.sectionId,
        ...when,
        remind_at: remind.at,
        reminded_at: remind.passed ? ctx.now : null,
        sort_key: sortKey,
        source_note_id: input.sourceNoteId ?? null,
        tainted: sourceTainted,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    if (input.link) await insertRecordLink(ctx, { kind: 'todo', id: row.id }, userId, input.link.targetType, input.link.targetId);
    ctx.audit({
      todoId: row.id,
      title: auditValue(TODO, 'title', input.title),
      details: auditValue(TODO, 'details', detailsOf(input.details)),
      checklist: auditValue(TODO, 'checklist', input.checklist.length > 0 ? input.checklist : null),
      priority: input.priority,
      tags: auditValue(TODO, 'tags', input.tags.length > 0 ? input.tags : null),
      ...(listId !== null ? { listId } : {}),
      ...(input.sectionId !== null ? { sectionId: input.sectionId } : {}),
      dueOn: input.dueOn,
      dueTime: input.dueTime !== null,
      timeZone: input.timeZone,
      reminder: reminderKind(input.reminder),
      remindAt: remind.at?.toISOString() ?? null,
      ...(input.sourceNoteId !== undefined ? { sourceNoteId: input.sourceNoteId } : {}),
      ...(sourceTainted ? { tainted: true } : {}),
      ...(input.link ? { target: 'private' as const } : {}),
    });
    return written(row);
  },
});

export const todoUpdate = defineCommand({
  name: 'notes.todo.update',
  input: zTodoUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<TodoWritten> => {
    userOf(ctx.actor);
    const requestedListId = input.listId === undefined ? undefined : normalizeListId(input.listId);
    // Lock target todo_list FOR SHARE before locking the todo row so global lock order matches todoListUpdate/todoListDelete.
    if (requestedListId !== undefined || input.sectionId !== undefined) {
      let lockListId: string | null = requestedListId ?? null;
      if (requestedListId === undefined) {
        const peek = await ctx.trx
          .selectFrom('crove_notes.todo')
          .select('list_id')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', input.todoId)
          .executeTakeFirst();
        if (!peek) throw notFound();
        lockListId = peek.list_id;
      }
      if (lockListId !== null) {
        await validateTodoListAndSection(ctx, lockListId, null, true);
      }
    }
    const before = await load(ctx, input.todoId, true);
    assertNotInTrash(before);
    if (before.revision !== input.revision) throw revisionConflict(before.revision);
    const next = due(input);
    const details = detailsOf(input.details);
    const checklist = checklistOf(input.checklist);
    const nextPriority = input.priority ?? before.priority;
    const nextTags = input.tags ?? before.tags;
    const nextListId = requestedListId !== undefined ? requestedListId : before.list_id;
    const listChanged = nextListId !== before.list_id;
    const nextSectionId =
      input.sectionId !== undefined
        ? input.sectionId
        : listChanged || nextListId === null
          ? null
          : before.section_id;
    if (nextListId === null && nextSectionId !== null) throw sectionNotFound();
    if (listChanged || nextSectionId !== before.section_id) {
      await validateTodoListAndSection(ctx, nextListId, nextSectionId, true);
    }
    const beforeDueAt = before.due_at === null ? null : new Date(before.due_at).getTime();
    const dueMoved = before.due_on !== next.due_on || beforeDueAt !== (next.due_at?.getTime() ?? null) || before.time_zone !== next.time_zone;
    const beforeRemind = before.remind_at === null ? null : new Date(before.remind_at);
    // Without a reminder in the input it stays, unless it was the automatic one of the old due day and time, or there
    // was none for want of a due day: it then follows the new ones.
    const wasAuto =
      beforeRemind === null
        ? before.due_on === null
        : beforeRemind.getTime() === todoAutoReminder({ dueOn: before.due_on, dueAt: beforeDueAt === null ? null : new Date(beforeDueAt), timeZone: before.time_zone })?.getTime();
    const remind = input.reminder !== undefined ? remindAt(input.reminder, next, ctx.now) : dueMoved && wasAuto ? remindAt('auto', next, ctx.now) : null;
    const remindChanged = remind !== null && (beforeRemind?.getTime() ?? null) !== (remind.at?.getTime() ?? null);
    const tagsChanged = before.tags.length !== nextTags.length || before.tags.some((v, i) => v !== nextTags[i]);
    const changed = [
      ...(before.title !== input.title ? ['title'] : []),
      ...(before.details !== details ? ['details'] : []),
      ...(checklistOf(steps(before.checklist)) !== checklist ? ['checklist'] : []),
      ...(before.priority !== nextPriority ? ['priority'] : []),
      ...(tagsChanged ? ['tags'] : []),
      ...(listChanged ? ['listId'] : []),
      ...(before.section_id !== nextSectionId ? ['sectionId'] : []),
      ...(before.due_on !== next.due_on || beforeDueAt !== (next.due_at?.getTime() ?? null) ? ['due'] : []),
      ...(before.time_zone !== next.time_zone ? ['timeZone'] : []),
      ...(remindChanged ? ['reminder'] : []),
    ];
    const row = await ctx.trx
      .updateTable('crove_notes.todo')
      // A new reminder time is sent at that time, unless it has already passed.
      .set({
        title: input.title,
        details,
        checklist,
        priority: nextPriority,
        tags: nextTags,
        list_id: nextListId,
        section_id: nextSectionId,
        ...next,
        ...(remind !== null && remindChanged ? { remind_at: remind.at, reminded_at: remind.passed ? ctx.now : null } : {}),
        revision: before.revision + 1,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.todoId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      todoId: row.id,
      revision: row.revision,
      changed,
      dueOn: next.due_on,
      priority: nextPriority,
      ...(nextListId !== null ? { listId: nextListId } : {}),
      ...(nextSectionId !== null ? { sectionId: nextSectionId } : {}),
      ...(remind !== null && remindChanged ? { remindAt: remind.at?.toISOString() ?? null } : {}),
    });
    return written(row);
  },
});

// Done and open again: the owner's, outside the trash. A to-do handed over or cancelled stays as it is.
function statusCommand(name: string, from: TodoStatus, to: TodoStatus) {
  return defineCommand({
    name,
    input: zTodoRef,
    risk: 'R1',
    sideEffect: 'internal',
    access: WRITERS,
    target,
    handler: async (ctx, input): Promise<TodoWritten> => {
      userOf(ctx.actor);
      const before = await load(ctx, input.todoId, true);
      assertNotInTrash(before);
      if (before.status === to) return written(before);
      if (before.status !== from) throw new DomainError('TODO_NOT_CHANGEABLE', 409, 'Việc này đã được giao hoặc đã hủy');
      const row = await ctx.trx
        .updateTable('crove_notes.todo')
        .set({ status: to, done_at: to === 'done' ? ctx.now : null, ...(to === 'open' ? { reminded_at: reminderPassed(ctx.now) } : {}), revision: before.revision + 1, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.todoId)
        .returning(['id', 'revision'])
        .executeTakeFirstOrThrow();
      ctx.audit({ todoId: row.id, revision: row.revision, status: to, previousStatus: before.status });
      return written(row);
    },
  });
}

export const todoComplete = statusCommand('notes.todo.complete', 'open', 'done');
export const todoReopen = statusCommand('notes.todo.reopen', 'done', 'open');

// Moves a to-do right before or after another of the caller's. The anchor is read through the row policies, so it is
// the caller's own; only the moved to-do's key changes, unless the list needs fresh keys.
export const todoReorder = defineCommand({
  name: 'notes.todo.reorder',
  input: zTodoReorder,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<TodoWritten> => {
    userOf(ctx.actor);
    const moved = await load(ctx, input.todoId, true);
    assertNotInTrash(moved);
    const rows = await ownKeys(ctx, input.todoId);
    const at = rows.findIndex((r) => r.id === input.anchorId);
    if (at < 0) throw notFound();
    const key = input.place === 'before' ? await placeBetween(ctx, rows, at - 1, at) : await placeBetween(ctx, rows, at, at + 1);
    await ctx.trx.updateTable('crove_notes.todo').set({ sort_key: key }).where('org_id', '=', ctx.orgId).where('id', '=', input.todoId).execute();
    ctx.audit({ todoId: input.todoId, place: input.place, anchorId: input.anchorId });
    return written(moved);
  },
});

// To the trash, which the daily job empties after TODO_TRASH_DAYS, and back.
function trashCommand(name: string, toTrash: boolean) {
  return defineCommand({
    name,
    input: zTodoRef,
    risk: 'R1',
    sideEffect: 'internal',
    access: WRITERS,
    target,
    handler: async (ctx, input): Promise<TodoWritten> => {
      userOf(ctx.actor);
      const before = await load(ctx, input.todoId, true);
      if ((before.deleted_at !== null) === toTrash) return written(before);
      await ctx.trx
        .updateTable('crove_notes.todo')
        .set({ deleted_at: toTrash ? ctx.now : null, ...(toTrash ? {} : { reminded_at: reminderPassed(ctx.now) }), updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.todoId)
        .execute();
      ctx.audit({ todoId: input.todoId, changed: ['deletedAt'] });
      return written(before);
    },
  });
}

export const todoDelete = trashCommand('notes.todo.delete', true);
export const todoRestore = trashCommand('notes.todo.restore', false);

// When the task of a handed-over to-do is due: the to-do's time, or else the end of its due day in its time zone.
function taskDue(row: Pick<SummaryRow, 'due_on' | 'due_at' | 'time_zone'>): Date | null {
  if (row.due_at !== null) return new Date(row.due_at);
  return row.due_on === null ? null : todoDueInstant(row.due_on, '23:59', row.time_zone);
}

// Hands an open to-do over to a position (notes.md §3.1, step N5, #1674): kernel.task.create_from_todo creates the task in this
// transaction, with the title and description the member confirmed and a `notes.todo` source_ref of its own, and the
// to-do becomes `handed_over` with the task's id. Nothing of the to-do reaches the task but that confirmed text and
// its due time: not its details unless the member put them in the description, not its steps, not its links. The
// audit row and the event carry ids and markers only.
export const todoHandOver = defineCommand({
  name: 'notes.todo.hand_over',
  input: zTodoHandOver,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<TodoHandedOver> => {
    userOf(ctx.actor);
    const before = await load(ctx, input.todoId, true);
    assertNotInTrash(before);
    if (before.revision !== input.revision) throw revisionConflict(before.revision);
    if (before.status !== 'open') throw new DomainError('TODO_NOT_CHANGEABLE', 409, 'Chỉ giao được việc chưa xong');
    if (input.projectId !== undefined && !ctx.installed('projects')) {
      throw new DomainError('PROJECT_NOT_FOUND', 404, 'Mô-đun Dự án chưa được bật');
    }
    const { tainted } = await ctx.trx
      .selectFrom('crove_notes.todo')
      .select('tainted')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.todoId)
      .executeTakeFirstOrThrow();
    const description = detailsOf(input.description);
    const { taskId } = await ctx.run<{ taskId: string }>('kernel.task.create_from_todo', {
      todoId: input.todoId,
      title: input.title,
      description,
      positionId: input.positionId,
      due: taskDue(before)?.toISOString() ?? null,
      tainted,
    });
    if (input.projectId !== undefined) {
      await ctx.run('projects.task.add', { projectId: input.projectId, taskId });
    }
    const row = await ctx.trx
      .updateTable('crove_notes.todo')
      .set({ status: 'handed_over', task_id: taskId, revision: before.revision + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.todoId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      todoId: row.id,
      revision: row.revision,
      taskId,
      positionId: input.positionId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      title: auditValue(TODO, 'title', input.title),
      description: auditValue(TODO, 'details', description),
    });
    await ctx.emit('notes.todo.handed_over', { todoId: row.id, taskId });
    return { ...written(row), taskId };
  },
});

async function touchTodo(ctx: CommandContext, todoId: string): Promise<void> {
  await ctx.trx.updateTable('crove_notes.todo').set({ updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', todoId).execute();
}

export const todoLinkAdd = defineCommand({
  name: 'notes.todo.link_add',
  input: zTodoLinkAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<{ todoId: string; linkId: string }> => {
    const userId = userOf(ctx.actor);
    const row = await load(ctx, input.todoId, true);
    assertNotInTrash(row);
    const linkId = await insertRecordLink(ctx, { kind: 'todo', id: row.id }, userId, input.targetType, input.targetId);
    await touchTodo(ctx, row.id);
    // ADR-0037 §3: a private to-do's audit row never names which record it links to.
    ctx.audit({ todoId: row.id, linkId, target: 'private' as const });
    return { todoId: row.id, linkId };
  },
});

export const todoLinkRemove = defineCommand({
  name: 'notes.todo.link_remove',
  input: zTodoLinkRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<{ todoId: string; linkId: string }> => {
    userOf(ctx.actor);
    const link = await ctx.trx
      .selectFrom('crove_notes.link')
      .select(['todo_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.linkId)
      .executeTakeFirst();
    if (!link || link.todo_id === null) throw new DomainError('NOTE_LINK_NOT_FOUND', 404, 'Không tìm thấy liên kết này');
    await load(ctx, link.todo_id, true);
    await ctx.trx.deleteFrom('crove_notes.link').where('org_id', '=', ctx.orgId).where('id', '=', input.linkId).execute();
    await touchTodo(ctx, link.todo_id);
    ctx.audit({ todoId: link.todo_id, linkId: input.linkId, target: 'private' as const });
    return { todoId: link.todo_id, linkId: input.linkId };
  },
});

interface TodoFilterInput {
  listId?: string | undefined;
  tag?: string | undefined;
  priority?: TodoPriority | undefined;
}

function applyTodoFilters<Q extends { where: (...args: any[]) => Q }>(query: Q, input: TodoFilterInput): Q {
  let q = query;
  if (input.listId === 'inbox') q = q.where('list_id', 'is', null);
  else if (input.listId !== undefined) q = q.where('list_id', '=', input.listId);
  if (input.tag !== undefined) q = q.where(sql<boolean>`tags @> ARRAY[${input.tag}]::text[]`);
  if (input.priority !== undefined) q = q.where('priority', '=', input.priority);
  return q;
}

export const todoList = defineQuery({
  name: 'notes.todo.list',
  input: zTodoList,
  access: READERS,
  handler: async (ctx, input): Promise<TodoSummary[]> => {
    userOf(ctx.actor);
    let q = applyTodoFilters(ctx.trx.selectFrom('crove_notes.todo').select(SUMMARY).where('org_id', '=', ctx.orgId), input);
    // Words typed without Vietnamese marks find them ("hoa don" finds "hóa đơn"), each as a prefix.
    if (input.q !== undefined) q = q.where(sql<boolean>`search @@ crove_kernel.search_query(${input.q})`);
    if (input.view === 'trash') q = q.where('deleted_at', 'is not', null).orderBy('deleted_at', 'desc');
    else {
      q = q.where('deleted_at', 'is', null);
      if (input.view === 'open') {
        q = q.where('status', '=', 'open');
        if (input.sort === 'priority') q = q.orderBy('priority', 'asc');
        q = q.orderBy('sort_key');
      } else {
        q = q.where('status', '<>', 'open').orderBy(sql`coalesce(done_at, updated_at)`, 'desc');
      }
    }
    const rows = await q.orderBy('id').limit(input.limit).execute();
    const sourceNotes = await loadSourceNotes(ctx, rows);
    const now = new Date();
    return rows.map((r) => summary(r, now, sourceNotes));
  },
});

export const todoGet = defineQuery({
  name: 'notes.todo.get',
  input: zTodoRef,
  access: READERS,
  handler: async (ctx, input): Promise<Todo> => {
    userOf(ctx.actor);
    const row = await load(ctx, input.todoId, false);
    const [links, sourceNotes] = await Promise.all([loadEnrichedLinks(ctx, { kind: 'todo', id: row.id }), loadSourceNotes(ctx, [row])]);
    return { ...summary(row, new Date(), sourceNotes), details: row.details ?? '', checklist: steps(row.checklist).map((s) => ({ text: s.text, done: s.done })), links };
  },
});

// The open statuses of a kernel task (ADR-0029): what My work lists. kernel.task.list answers at most this many tasks
// (TASK_LIST_LIMIT in @crove/kernel), the newest first.
const KERNEL_TASK_LIST_LIMIT = 200;
const OPEN_TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'in_review'] as const;
// The most open to-dos My work shows, as the app's list.
const MY_WORK_LIMIT = 500;

interface KernelTask {
  id: string;
  title: string;
  status: string;
  assigneePositionId: string | null;
  due: string | null;
  checklist?: readonly TaskChecklistStep[];
  tainted: boolean;
}

// "Việc của tôi" (notes.md §3.10, step N5): my open to-dos in my own order, and the open tasks of the positions I hold
// (an owner's also the tasks given to the owners), read through the kernel's own task query so its rules apply. The
// tasks are grouped by their due day in the member's time zone, soonest first.
export const myWork = defineQuery({
  name: 'notes.my_work',
  input: zMyWorkInput,
  access: READERS,
  handler: async (ctx, input): Promise<MyWork> => {
    const userId = userOf(ctx.actor);
    let todoQ = applyTodoFilters(
      ctx.trx.selectFrom('crove_notes.todo').select(SUMMARY).where('org_id', '=', ctx.orgId).where('deleted_at', 'is', null).where('status', '=', 'open'),
      input,
    );
    if (input.sort === 'priority') todoQ = todoQ.orderBy('priority', 'asc');
    const [rows, found, memberCountRow, ownSeatRow] = await Promise.all([
      todoQ.orderBy('sort_key').orderBy('id').limit(MY_WORK_LIMIT).execute(),
      ctx.query<{ tasks: KernelTask[] }>('kernel.task.list', { mine: true, status: [...OPEN_TASK_STATUSES] }),
      ctx.trx
        .selectFrom('crove_kernel.tenant_member')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('org_id', '=', ctx.orgId)
        .executeTakeFirstOrThrow(),
      ctx.trx
        .selectFrom('crove_kernel.position')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('holder_user_id', '=', userId)
        .where('status', '<>', 'archived')
        .limit(1)
        .executeTakeFirst(),
    ]);
    const now = new Date();
    const listed = found.status === 'ok' ? found.value.tasks : [];
    const projectLookup = await ctx.query<ProjectTaskProjectEntry[]>('projects.task_projects', {
      taskIds: listed.slice(0, PROJECT_TASK_MAP_LIMIT).map((t) => t.id),
    });
    const projectsAvailable = projectLookup.status === 'ok';
    const projectByTask = new Map(projectLookup.status === 'ok' ? projectLookup.value.map((entry) => [entry.taskId, entry.project]) : []);
    const allTasks: MyWorkTask[] = listed
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        positionId: t.assigneePositionId,
        due: t.due,
        tainted: t.tainted,
        ...(t.checklist !== undefined ? { steps: countTaskChecklistSteps(t.checklist) } : {}),
        project: projectByTask.get(t.id) ?? null,
        ...taskStanding(t.due === null ? null : new Date(t.due), input.timeZone, now),
      }))
      .sort((a, b) => (a.due === b.due ? 0 : a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1));
    const filteredTasks =
      input.projectId === undefined
        ? allTasks
        : input.projectId === 'none'
          ? allTasks.filter((t) => t.project === null)
          : allTasks.filter((t) => t.project?.id === input.projectId);
    const sourceNotes = input.projectId === undefined ? await loadSourceNotes(ctx, rows) : undefined;
    const todos = input.projectId === undefined ? rows.map((r) => summary(r, now, sourceNotes)) : [];
    const isTeamOrg = Number(memberCountRow.n) > 1;
    const noSeatHint = isTeamOrg && ownSeatRow === undefined && ctx.role !== 'owner' && ctx.role !== 'viewer';
    // A full page from the kernel says the screen may miss older tasks.
    return {
      todos,
      tasks: filteredTasks,
      tasksTruncated: listed.length >= KERNEL_TASK_LIST_LIMIT,
      projectsAvailable,
      noSeatHint,
    };
  },
});

// How many to-dos each member has, for an owner or admin before removing one (ADR-0037 §4): a count from
// crove_notes.todo_counts(), which checks the caller's role itself, never the text.
export const todoCounts = defineQuery({
  name: 'notes.todo.counts',
  input: z.strictObject({}),
  access: MANAGERS,
  handler: async (ctx): Promise<TodoCount[]> => {
    const { rows } = await sql<{ owner_user_id: string; todos: string }>`SELECT owner_user_id, todos FROM crove_notes.todo_counts()`.execute(ctx.trx);
    return rows.map((r) => ({ userId: r.owner_user_id, todos: Number(r.todos) }));
  },
});

// Personal to-do lists and inline sections (#3558, ADR-0037): strictly private to each owner.
export const todoListList = defineQuery({
  name: 'notes.todo_list.list',
  input: z.strictObject({}),
  access: READERS,
  handler: async (ctx): Promise<TodoListsResponse> => {
    userOf(ctx.actor);
    const [listRows, countRows] = await Promise.all([
      ctx.trx
        .selectFrom('crove_notes.todo_list')
        .select(['id', 'name', 'color', 'sections', 'sort_key', 'revision', 'created_at', 'updated_at'])
        .where('org_id', '=', ctx.orgId)
        .where('deleted_at', 'is', null)
        .orderBy('sort_key')
        .orderBy('id')
        .execute(),
      ctx.trx
        .selectFrom('crove_notes.todo')
        .select((eb) => ['list_id', eb.fn.countAll<string>().as('n')])
        .where('org_id', '=', ctx.orgId)
        .where('deleted_at', 'is', null)
        .where('status', '=', 'open')
        .groupBy('list_id')
        .execute(),
    ]);
    let inboxCount = 0;
    const listCounts = new Map<string, number>();
    for (const c of countRows) {
      const n = Number(c.n);
      if (c.list_id === null) inboxCount = n;
      else listCounts.set(c.list_id, n);
    }
    const lists: TodoListSummary[] = listRows.map((r) => ({
      id: r.id,
      name: r.name,
      color: listColorOf(r.color),
      sections: parseSections(r.sections),
      sortKey: r.sort_key,
      openCount: listCounts.get(r.id) ?? 0,
      revision: r.revision,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
    return { lists, inboxCount };
  },
});

export const todoListCreate = defineCommand({
  name: 'notes.todo_list.create',
  input: zTodoListCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<TodoListWritten> => {
    const userId = userOf(ctx.actor);
    const existing = await ctx.trx
      .selectFrom('crove_notes.todo_list')
      .select(['id', 'sort_key'])
      .where('org_id', '=', ctx.orgId)
      .where('deleted_at', 'is', null)
      .orderBy('sort_key')
      .orderBy('id')
      .execute();
    if (existing.length >= TODO_LISTS_MAX) throw listLimitReached();
    let sortKey = keyBetween(existing.at(-1)?.sort_key ?? null, null);
    if (sortKey.length > REBALANCE_AT) {
      const fresh = spreadKeys(existing.length + 1);
      for (let i = 0; i < existing.length; i++) {
        await ctx.trx
          .updateTable('crove_notes.todo_list')
          .set({ sort_key: fresh[i] as string })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', existing[i]!.id)
          .execute();
      }
      sortKey = fresh[existing.length] as string;
    }
    const sections = normalizeSections(input.sections);
    const row = await ctx.trx
      .insertInto('crove_notes.todo_list')
      .values({
        org_id: ctx.orgId,
        owner_user_id: userId,
        name: input.name,
        color: input.color,
        sections: JSON.stringify(sections),
        sort_key: sortKey,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      todoListId: row.id,
      name: auditValue(TODO_LIST, 'name', input.name),
      sections: auditValue(TODO_LIST, 'sections', sections.length > 0 ? sections : null),
      color: input.color,
      sectionCount: sections.length,
    });
    return listWritten(row);
  },
});

export const todoListUpdate = defineCommand({
  name: 'notes.todo_list.update',
  input: zTodoListUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: listTarget,
  handler: async (ctx, input): Promise<TodoListWritten> => {
    userOf(ctx.actor);
    const before = await ctx.trx
      .selectFrom('crove_notes.todo_list')
      .select(['id', 'name', 'color', 'sections', 'revision', 'deleted_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.listId)
      .forUpdate()
      .executeTakeFirst();
    if (!before || before.deleted_at !== null) throw listNotFound();
    if (before.revision !== input.revision) throw listRevisionConflict(before.revision);
    const prevSections = parseSections(before.sections);
    const nextSections = normalizeSections(input.sections);
    const nextIds = new Set(nextSections.map((s) => s.id));
    const removedIds = prevSections.map((s) => s.id).filter((id) => !nextIds.has(id));
    if (removedIds.length > 0) {
      await ctx.trx
        .updateTable('crove_notes.todo')
        .set({ section_id: null, revision: sql`revision + 1`, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('list_id', '=', input.listId)
        .where('section_id', 'in', removedIds)
        .execute();
    }
    const sectionsChanged = JSON.stringify(prevSections) !== JSON.stringify(nextSections);
    const changed = [
      ...(before.name !== input.name ? ['name'] : []),
      ...(before.color !== input.color ? ['color'] : []),
      ...(sectionsChanged ? ['sections'] : []),
    ];
    const row = await ctx.trx
      .updateTable('crove_notes.todo_list')
      .set({
        name: input.name,
        color: input.color,
        sections: JSON.stringify(nextSections),
        revision: before.revision + 1,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.listId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      todoListId: row.id,
      revision: row.revision,
      changed,
      sectionCount: nextSections.length,
      removedSectionCount: removedIds.length,
    });
    return listWritten(row);
  },
});

export const todoListDelete = defineCommand({
  name: 'notes.todo_list.delete',
  input: zTodoListRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: listTarget,
  handler: async (ctx, input): Promise<TodoListWritten> => {
    userOf(ctx.actor);
    const before = await ctx.trx
      .selectFrom('crove_notes.todo_list')
      .select(['id', 'revision', 'deleted_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.listId)
      .forUpdate()
      .executeTakeFirst();
    if (!before || before.deleted_at !== null) throw listNotFound();
    // Move all to-dos of this list back to Inbox before soft-deleting the list, bumping revision so open editors stay in sync.
    await ctx.trx
      .updateTable('crove_notes.todo')
      .set({ list_id: null, section_id: null, revision: sql`revision + 1`, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('list_id', '=', input.listId)
      .execute();
    const row = await ctx.trx
      .updateTable('crove_notes.todo_list')
      .set({
        deleted_at: ctx.now,
        revision: before.revision + 1,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.listId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({ todoListId: row.id, revision: row.revision, changed: ['deletedAt'] });
    return listWritten(row);
  },
});

export const todoCommands = [
  todoCreate,
  todoUpdate,
  todoComplete,
  todoReopen,
  todoReorder,
  todoDelete,
  todoRestore,
  todoHandOver,
  todoLinkAdd,
  todoLinkRemove,
];
export const todoQueries = [todoList, todoGet, todoCounts];
export const todoListCommands = [todoListCreate, todoListUpdate, todoListDelete];
export const todoListQueries = [todoListList];
// My work reads to-dos and the kernel's tasks, so it is the module's, not the to-do list's.
export const myWorkQueries = [myWork];
