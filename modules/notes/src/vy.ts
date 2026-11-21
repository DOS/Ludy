// SPDX-License-Identifier: AGPL-3.0-only
// Notes N8 (#1677, ADR-0037, ADR-0049): status check and explicit human acceptance commands for AI summary and suggested to-dos.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import {
  DEFAULT_TIME_ZONE,
  NOTE_BODY_MAX,
  zId,
  zNoteAcceptSummary,
  zTimeZone,
  zTodoAcceptSuggestions,
  zonedDate,
  type NoteVyStatus,
  type NoteWritten,
  type TodoAcceptSuggestionsResult,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { assertAuthor, assertNotInTrash, loadForChange, recordNoteVersionSnapshot } from './notes.ts';
import { TODO_SUMMARY_COLUMNS, detailsOf, due, ownKeys, placeBetween, remindAt, todoSummaryRow } from './todos.ts';

const MODULE = 'notes';
const ALL_MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

function userOf(actor: QueryContext['actor'] | CommandContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

function stripDangerousHtmlElements(text: string): string {
  let out = text;
  for (const tag of ['script', 'style', 'svg', 'iframe', 'object', 'embed']) {
    const open = `<${tag}`;
    const close = `</${tag}`;
    let lower = out.toLowerCase();
    let searchFrom = 0;
    while (searchFrom < lower.length) {
      const idx = lower.indexOf(open, searchFrom);
      if (idx < 0) break;
      const nextCh = lower[idx + open.length];
      if (nextCh !== undefined && !/[\s>/]/.test(nextCh)) {
        searchFrom = idx + open.length;
        continue;
      }
      const endTag = lower.indexOf(close, idx + open.length);
      if (endTag < 0) {
        out = out.slice(0, idx);
        break;
      }
      const closeGt = out.indexOf('>', endTag + close.length);
      const cutTo = closeGt >= 0 ? closeGt + 1 : endTag + close.length;
      out = out.slice(0, idx) + ' ' + out.slice(cutTo);
      lower = out.toLowerCase();
      searchFrom = idx + 1;
    }
  }
  return out;
}

function findHtmlTagEnd(text: string, openIndex: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = openIndex + 1; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '<') return -1;
    if (ch === '>') return i;
  }
  return -1;
}

function stripHtmlTags(raw: string): string {
  const withoutDangerous = stripDangerousHtmlElements(raw);
  let out = '';
  let i = 0;
  while (i < withoutDangerous.length) {
    if (withoutDangerous[i] === '<') {
      if (withoutDangerous.startsWith('<!--', i)) {
        const end = withoutDangerous.indexOf('-->', i + 4);
        if (end >= 0) {
          out += ' ';
          i = end + 3;
          continue;
        }
      } else if (
        withoutDangerous[i + 1] === '!' ||
        withoutDangerous[i + 1] === '?' ||
        /^<\/?[A-Za-z][A-Za-z0-9:-]*(?:[\s/>]|$)/.test(withoutDangerous.slice(i, i + 64))
      ) {
        const end = findHtmlTagEnd(withoutDangerous, i);
        if (end >= 0) {
          out += ' ';
          i = end + 1;
          continue;
        }
      }
    }
    out += withoutDangerous[i];
    i += 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export const notesVyStatus = defineQuery({
  name: 'notes.vy.status',
  input: z.strictObject({}),
  access: ALL_MEMBERS,
  handler: async (ctx): Promise<NoteVyStatus> => {
    const userId = userOf(ctx.actor);
    if (ctx.role === null) {
      return { available: false, reason: 'forbidden', resetOn: null };
    }
    if (!ctx.installed(MODULE)) {
      return { available: false, reason: 'off', resetOn: null };
    }

    const allowed = await sql<{ ok: boolean }>`SELECT crove_kernel.ctx_vy_use() AS ok`.execute(ctx.trx);
    if (allowed.rows[0]?.ok !== true) {
      return { available: false, reason: 'forbidden', resetOn: null };
    }

    const agentRow = await ctx.trx
      .selectFrom('crove_kernel.agent')
      .select(['id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('kind', '=', 'member_vy')
      .where('member_user_id', '=', userId)
      .executeTakeFirst();
    if (agentRow && agentRow.status !== 'active') {
      return { available: false, reason: 'forbidden', resetOn: null };
    }
    const agentId = agentRow?.id ?? null;

    const stopped = await sql<{ stopped: boolean }>`
      SELECT crove_kernel.global_kill_switch_on('ai') OR EXISTS (
        SELECT 1 FROM crove_kernel.kill_switch k
         WHERE k.org_id = ${ctx.orgId}::uuid
           AND k.released_at IS NULL
           AND (
             k.scope = 'org'
             OR (k.scope = 'module' AND k.target = ${MODULE})
             OR (${agentId}::uuid IS NOT NULL AND k.scope = 'agent' AND k.target = ${agentId}::text)
           )
      ) AS stopped`.execute(ctx.trx);
    if (stopped.rows[0]?.stopped === true) {
      return { available: false, reason: 'paused', resetOn: null };
    }

    const budget = await sql<{ spent: boolean; reset_on: string }>`
      SELECT crove_kernel.ai_budget_exhausted(${ctx.orgId}::uuid, ${MODULE}, ${agentId}::uuid) AS spent,
             pg_catalog.to_char(
               (pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE ${DEFAULT_TIME_ZONE}) + pg_catalog.make_interval(months => 1))::date,
               'YYYY-MM-DD'
             ) AS reset_on`
      .execute(ctx.trx);
    if (budget.rows[0]?.spent === true) {
      return { available: false, reason: 'budget', resetOn: budget.rows[0].reset_on ?? null };
    }

    return { available: true, reason: null, resetOn: null };
  },
});

export const notesVyAccepted = defineQuery({
  name: 'notes.vy.accepted',
  input: z.strictObject({
    noteId: zId,
    summaryRunId: zId.optional(),
    todoRunId: zId.optional(),
  }),
  access: ALL_MEMBERS,
  handler: async (ctx, input): Promise<{ summaryAccepted: boolean; todosAccepted: boolean }> => {
    const userId = userOf(ctx.actor);
    let summaryAccepted = false;
    if (input.summaryRunId !== undefined) {
      const noteRow = await ctx.trx
        .selectFrom('crove_notes.note')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.noteId)
        .where('author_user_id', '=', userId)
        .where(sql<boolean>`${input.summaryRunId}::uuid = ANY(summary_run_ids)`)
        .executeTakeFirst();
      summaryAccepted = noteRow !== undefined;
    }

    let todosAccepted = false;
    if (input.todoRunId !== undefined) {
      const todoRow = await ctx.trx
        .selectFrom('crove_notes.todo')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('owner_user_id', '=', userId)
        .where('source_run_id', '=', input.todoRunId)
        .executeTakeFirst();
      todosAccepted = todoRow !== undefined;
    }

    return { summaryAccepted, todosAccepted };
  },
});

export const noteAcceptSummary = defineCommand({
  name: 'notes.note.accept_summary',
  input: zNoteAcceptSummary,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'notes.note', id: input.noteId }),
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const before = await loadForChange(ctx, input.noteId, (row) => assertAuthor(row, userId));
    assertNotInTrash(before);
    const existingRun = await ctx.trx
      .selectFrom('crove_notes.note')
      .select('summary_run_ids')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .executeTakeFirst();
    if (input.runId !== undefined && existingRun?.summary_run_ids?.includes(input.runId)) {
      throw new DomainError('VY_RUN_ALREADY_ACCEPTED', 409, 'Bản tóm tắt của lượt chạy này đã được áp dụng rồi');
    }
    if (before.revision !== input.revision) {
      throw new DomainError('NOTE_REVISION_CONFLICT', 409, 'Ghi chú vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', {
        revision: before.revision,
      });
    }

    const cleanSummary = stripHtmlTags(input.summary);
    const cleanBullets = input.bullets.map(stripHtmlTags).filter((b) => b.length > 0);
    if (cleanSummary.length === 0 && cleanBullets.length === 0) {
      throw new DomainError('VALIDATION', 400, 'Tóm tắt không được để trống');
    }

    const section = [cleanSummary, cleanBullets.map((b) => `- ${b}`).join('\n')].filter((part) => part.length > 0).join('\n\n');
    const nextBody =
      input.mode === 'replace'
        ? section
        : before.body.trim().length > 0
          ? `${before.body.trimEnd()}\n\n${section}`
          : section;
    if (nextBody.length > NOTE_BODY_MAX) {
      throw new DomainError('NOTE_TOO_LONG', 422, 'Nội dung ghi chú sau khi chèn vượt quá giới hạn cho phép');
    }

    if (nextBody !== before.body) {
      await recordNoteVersionSnapshot(ctx, before);
    }

    const row = await ctx.trx
      .updateTable('crove_notes.note')
      .set({
        body: nextBody,
        tainted: true,
        ...(input.runId !== undefined
          ? {
              summary_run_ids: sql`CASE WHEN ${input.runId}::uuid = ANY(crove_notes.note.summary_run_ids) THEN crove_notes.note.summary_run_ids ELSE pg_catalog.array_append(crove_notes.note.summary_run_ids, ${input.runId}::uuid) END`,
            }
          : {}),
        revision: before.revision + 1,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .where('revision', '=', input.revision)
      .returning(['id', 'revision'])
      .executeTakeFirst();
    if (!row) {
      throw new DomainError('NOTE_REVISION_CONFLICT', 409, 'Ghi chú vừa được sửa ở nơi khác; hãy tải lại trước khi lưu');
    }

    ctx.audit({
      noteId: row.id,
      revision: row.revision,
      mode: input.mode,
      changed: ['body', 'tainted'],
      ...(input.runId !== undefined ? { vyRunId: input.runId } : {}),
    });
    return { noteId: row.id, revision: row.revision };
  },
});

export const todoAcceptSuggestions = defineCommand({
  name: 'notes.todo.accept_suggestions',
  input: zTodoAcceptSuggestions,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'notes.note', id: input.noteId }),
  handler: async (ctx, input): Promise<TodoAcceptSuggestionsResult> => {
    const userId = userOf(ctx.actor);
    const note = await ctx.trx
      .selectFrom('crove_notes.note')
      .select(['id', 'revision', 'deleted_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .executeTakeFirst();
    if (!note) {
      throw new DomainError('NOTE_NOT_FOUND', 404, 'Không tìm thấy ghi chú');
    }
    if (note.deleted_at !== null) {
      throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
    }
    if (note.revision !== input.noteRevision) {
      throw new DomainError('NOTE_REVISION_CONFLICT', 409, 'Ghi chú vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', {
        revision: note.revision,
      });
    }
    if (input.runId !== undefined) {
      const prior = await ctx.trx
        .selectFrom('crove_notes.todo')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('owner_user_id', '=', userId)
        .where('source_run_id', '=', input.runId)
        .executeTakeFirst();
      if (prior) {
        throw new DomainError('VY_RUN_ALREADY_ACCEPTED', 409, 'Các việc gợi ý của lượt chạy này đã được lưu rồi');
      }
    }

    const createdReversed: string[] = [];
    for (let i = input.items.length - 1; i >= 0; i -= 1) {
      const item = input.items[i]!;
      const rows = await ownKeys(ctx, null);
      const sortKey = await placeBetween(ctx, rows, -1, 0);
      const when = due({ dueOn: item.dueOn, dueTime: item.dueTime, timeZone: item.timeZone });
      const remind = remindAt(item.reminder, when, ctx.now);
      const seq = input.runId !== undefined ? input.items.length - 1 - i : null;
      let inserted: { id: string };
      try {
        inserted = await ctx.trx
          .insertInto('crove_notes.todo')
          .values({
            org_id: ctx.orgId,
            owner_user_id: userId,
            title: item.title,
            details: detailsOf(item.details),
            checklist: '[]',
            ...when,
            remind_at: remind.at,
            reminded_at: remind.passed ? ctx.now : null,
            sort_key: sortKey,
            source_note_id: input.noteId,
            source_run_id: input.runId ?? null,
            source_run_seq: seq,
            tainted: true,
            created_at: ctx.now,
            updated_at: ctx.now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      } catch (error: unknown) {
        const pgErr = error as { code?: string; constraint?: string };
        if (pgErr.code === '23505' && pgErr.constraint === 'todo_source_run_once_uq') {
          throw new DomainError('VY_RUN_ALREADY_ACCEPTED', 409, 'Các việc gợi ý của lượt chạy này đã được lưu rồi');
        }
        throw error;
      }
      createdReversed.push(inserted.id);
    }

    const todoIds = createdReversed.reverse();
    ctx.audit({
      noteId: input.noteId,
      noteRevision: note.revision,
      created: todoIds.length,
      todoIds,
      ...(input.runId !== undefined ? { vyRunId: input.runId } : {}),
    });
    return { noteId: input.noteId, created: todoIds.length, todoIds };
  },
});

// Member-scoped open personal to-dos for Vy daily planner (Notes v2 T4b, #3563): writers only, bounded batch read under caller RLS.
export const notesVyPlanInputs = defineQuery({
  name: 'notes.vy.plan_inputs',
  input: z.strictObject({ timeZone: zTimeZone.optional() }),
  access: WRITERS,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const now = new Date();
    const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
    const today = zonedDate(timeZone, now.getTime());
    const [todoRows, listRows] = await Promise.all([
      ctx.trx
        .selectFrom('crove_notes.todo')
        .select([...TODO_SUMMARY_COLUMNS, 'details'])
        .where('org_id', '=', ctx.orgId)
        .where('owner_user_id', '=', userId)
        .where('status', '=', 'open')
        .where('deleted_at', 'is', null)
        .orderBy('due_on')
        .orderBy('priority')
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .limit(120)
        .execute(),
      ctx.trx
        .selectFrom('crove_notes.todo_list')
        .select(['id', 'name'])
        .where('org_id', '=', ctx.orgId)
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .execute(),
    ]);
    const listNames = new Map(listRows.map((l) => [l.id, l.name]));
    return {
      today,
      todos: todoRows.map((row) => {
        const s = todoSummaryRow(row, now);
        const overdue = s.overdue || (s.dueOn !== null && s.dueOn < today);
        const group: 'overdue' | 'today' | 'later' | 'none' = overdue
          ? 'overdue'
          : s.dueOn === today
            ? 'today'
            : s.dueOn !== null
              ? 'later'
              : 'none';
        return {
          id: s.id,
          title: s.title,
          details: (row.details ?? '').trim().slice(0, 240) || null,
          priority: s.priority,
          tags: s.tags,
          dueOn: s.dueOn,
          dueTime: s.dueTime,
          overdue,
          group,
          listName: s.listId ? (listNames.get(s.listId) ?? null) : null,
          revision: s.revision,
        };
      }),
    };
  },
});

// Member-scoped unfiled editable notes and readable notebooks for Vy inbox organizer (Notes v2 E5b, #3563): writers only, bounded batch read under caller RLS.
export const notesVyOrganizeInputs = defineQuery({
  name: 'notes.vy.organize_inputs',
  input: z.strictObject({}),
  access: WRITERS,
  handler: async (ctx) => {
    const userId = userOf(ctx.actor);
    const isManager = ctx.role === 'owner' || ctx.role === 'admin';
    let notesQ = ctx.trx
      .selectFrom('crove_notes.note')
      .select(['id', 'author_user_id', 'visibility', 'title', 'body', 'tags', 'revision', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('deleted_at', 'is', null)
      .where('archived_at', 'is', null)
      .where('notebook_id', 'is', null);
    notesQ = isManager
      ? notesQ.where((eb) => eb.or([eb('author_user_id', '=', userId), eb('visibility', '=', 'org')]))
      : notesQ.where('author_user_id', '=', userId);

    const [noteRows, notebookRows] = await Promise.all([
      notesQ.orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(25).execute(),
      ctx.trx
        .selectFrom('crove_notes.notebook')
        .select(['id', 'name', 'visibility'])
        .where('org_id', '=', ctx.orgId)
        .where((eb) => eb.or([eb('author_user_id', '=', userId), eb('visibility', '=', 'org')]))
        .orderBy('pinned', 'desc')
        .orderBy('sort_key')
        .orderBy('id')
        .limit(50)
        .execute(),
    ]);

    return {
      notes: noteRows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        tags: Array.isArray(r.tags) ? r.tags : [],
        visibility: r.visibility as 'private' | 'org',
        updatedAt: new Date(r.updated_at).toISOString(),
        canEditTags: r.author_user_id === userId,
        revision: r.revision,
      })),
      notebooks: notebookRows.map((nb) => ({
        id: nb.id,
        name: nb.name,
        visibility: nb.visibility as 'private' | 'org',
      })),
    };
  },
});

export const vyCommands = [noteAcceptSummary, todoAcceptSuggestions];
export const vyQueries = [notesVyStatus, notesVyAccepted, notesVyPlanInputs, notesVyOrganizeInputs];
