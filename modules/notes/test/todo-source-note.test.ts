// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for sourceNoteId validation, batch loading, and audit behavior (#1676, notes plan step N7).
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type Transaction,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Database } from '@ludy/db';
import { zTodoSourceNote, zTodoSummary, type TodoSourceNote } from '@ludy/kernel-contract';
import type { CommandContext, Lookup, QueryContext } from '@ludy/kernel-runtime';
import { TODO_SUMMARY_COLUMNS, loadSourceNotes, myWork, todoCreate, todoGet, todoList, todoSummaryRow } from '../src/todos.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-000000000003';
const NOTE_1 = '10000000-0000-4000-8000-000000000001';
const NOTE_2 = '10000000-0000-4000-8000-000000000002';
const TODO_1 = '20000000-0000-4000-8000-000000000001';
const TODO_2 = '20000000-0000-4000-8000-000000000002';
const TODO_3 = '20000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-11-17T03:00:00.000Z');

const baseSummaryRow = (id: string, sourceNoteId: string | null = null) => ({
  id,
  title: `Todo ${id}`,
  checklist: [],
  status: 'open' as const,
  priority: 4,
  tags: [],
  list_id: null,
  section_id: null,
  due_on: null,
  due_at: null,
  time_zone: 'Asia/Ho_Chi_Minh',
  remind_at: null,
  sort_key: 'V',
  source_note_id: sourceNoteId,
  task_id: null,
  recurrence: null,
  series_id: null,
  tainted: false,
  revision: 1,
  created_at: NOW,
  updated_at: NOW,
  done_at: null,
  deleted_at: null,
});

describe('todo source notes (#1676)', () => {
  it('includes source_note_id in TODO_SUMMARY_COLUMNS and builds TodoSummary cleanly', () => {
    expect(TODO_SUMMARY_COLUMNS).toContain('source_note_id');

    const map = new Map<string, TodoSourceNote>([[NOTE_1, { id: NOTE_1, title: 'Khách VIP', available: true }]]);
    const available = todoSummaryRow(baseSummaryRow(TODO_1, NOTE_1), NOW, map);
    const unavailable = todoSummaryRow(baseSummaryRow(TODO_2, NOTE_2), NOW, map);
    const plain = todoSummaryRow(baseSummaryRow(TODO_3, null), NOW, map);

    expect(zTodoSummary.parse(available).sourceNote).toEqual({ id: NOTE_1, title: 'Khách VIP', available: true });
    expect(zTodoSummary.parse(unavailable)).toMatchObject({
      sourceNoteId: NOTE_2,
      sourceNote: { id: NOTE_2, title: null, available: false },
    });
    expect(zTodoSummary.parse(plain)).toMatchObject({ sourceNoteId: null, sourceNote: null });
    expect(zTodoSourceNote.safeParse({ id: NOTE_1, title: null, available: false }).success).toBe(true);
  });

  it('skips querying ludy_notes.note when no row references a source note, and deduplicates distinct ids', async () => {
    let noteQueries = 0;
    let capturedWhereValues: unknown[] = [];

    const makeCtx = (noteRows: Array<{ id: string; title: string }>) =>
      ({
        orgId: ORG,
        trx: {
          selectFrom: (table: string) => {
            if (table === 'ludy_notes.note') noteQueries += 1;
            const chain = {
              select: () => chain,
              where: (_col: string, op: string, val: unknown) => {
                if (op === 'in') capturedWhereValues = val as unknown[];
                return chain;
              },
              execute: async () => noteRows,
            };
            return chain;
          },
        },
      }) as unknown as QueryContext;

    const empty = await loadSourceNotes(makeCtx([]), [{ source_note_id: null }]);
    expect(empty.size).toBe(0);
    expect(noteQueries).toBe(0);

    const resolved = await loadSourceNotes(makeCtx([{ id: NOTE_1, title: 'Ghi chú chung' }]), [
      { source_note_id: NOTE_1 },
      { source_note_id: NOTE_1 },
      { source_note_id: NOTE_2 },
      { source_note_id: null },
    ]);
    expect(noteQueries).toBe(1);
    expect(capturedWhereValues).toEqual([NOTE_1, NOTE_2]);
    expect(resolved.get(NOTE_1)).toEqual({ id: NOTE_1, title: 'Ghi chú chung', available: true });
    expect(resolved.get(NOTE_2)).toEqual({ id: NOTE_2, title: null, available: false });
  });

  it('validates sourceNoteId in notes.todo.create, re-verifies under note lock, and throws 404 NOTE_NOT_FOUND without locking when unreadable', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    let auditedFact: Record<string, unknown> | undefined;
    let recordedLocks: string[] = [];

    const makeCtx = (
      foundNote: { id: string; tainted: boolean } | undefined,
      noteOnRecheck?: { id: string; tainted: boolean } | null,
    ) => {
      let noteSelectCount = 0;
      recordedLocks = [];
      insertedValues = undefined;
      auditedFact = undefined;
      const conn: DatabaseConnection = {
        executeQuery: async <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
          const sqlText = compiled.sql.toLowerCase();
          if (sqlText.includes('pg_advisory_xact_lock')) {
            recordedLocks.push(String(compiled.parameters[0] ?? ''));
            return { rows: [{ pg_advisory_xact_lock: '' }] } as QueryResult<R>;
          }
          if (sqlText.includes('from "ludy_notes"."note"')) {
            noteSelectCount += 1;
            const selected =
              noteSelectCount > 1 && noteOnRecheck !== undefined ? noteOnRecheck ?? undefined : foundNote;
            return { rows: selected ? [selected] : [] } as QueryResult<R>;
          }
          if (sqlText.startsWith('insert into "ludy_notes"."todo"')) {
            const colsMatch = /\(([^)]+)\)\s+values\s*\(([^)]+)\)/i.exec(compiled.sql);
            if (colsMatch) {
              const cols = colsMatch[1]!.split(',').map((c) => c.replaceAll('"', '').trim());
              const vals = colsMatch[2]!.split(',').map((v) => v.trim());
              const captured: Record<string, unknown> = {};
              cols.forEach((col, idx) => {
                const tok = vals[idx] ?? '';
                if (/^\$\d+$/.test(tok)) {
                  captured[col] = compiled.parameters[Number(tok.slice(1)) - 1];
                }
              });
              insertedValues = captured;
            }
            return { rows: [{ id: TODO_1, revision: 1 }] } as QueryResult<R>;
          }
          return { rows: [] } as QueryResult<R>;
        },
        streamQuery: (() => {
          throw new Error('streamQuery not implemented');
        }) as DatabaseConnection['streamQuery'],
      };
      const driver: Driver = {
        init: async () => {},
        acquireConnection: async () => conn,
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
      };
      const db = new Kysely<Database>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => driver,
          createIntrospector: (inst) => new PostgresIntrospector(inst),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      });
      return {
        orgId: ORG,
        now: NOW,
        actor: { type: 'user', userId: USER, sessionId: SESSION },
        audit: (fact: Record<string, unknown>) => {
          auditedFact = fact;
        },
        trx: db as unknown as Transaction<Database>,
      } as unknown as CommandContext;
    };

    await expect(
      todoCreate.handler(makeCtx(undefined), {
        title: 'Gọi khách',
        details: '',
        checklist: [],
        priority: 4,
        tags: [],
        listId: null,
        sectionId: null,
        dueOn: null,
        dueTime: null,
        timeZone: 'Asia/Ho_Chi_Minh',
        reminder: 'auto',
        sourceNoteId: NOTE_1,
      }),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND', status: 404 });
    expect(insertedValues).toBeUndefined();
    expect(recordedLocks).toEqual([]);

    // Concurrent trash/visibility change while waiting on todo sort lock aborts after re-check under shared note lock.
    await expect(
      todoCreate.handler(makeCtx({ id: NOTE_1, tainted: false }, null), {
        title: 'Gọi khách',
        details: '',
        checklist: [],
        priority: 4,
        tags: [],
        listId: null,
        sectionId: null,
        dueOn: null,
        dueTime: null,
        timeZone: 'Asia/Ho_Chi_Minh',
        reminder: 'auto',
        sourceNoteId: NOTE_1,
      }),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND', status: 404 });
    expect(insertedValues).toBeUndefined();
    expect(recordedLocks).toEqual([`ludy_notes.todo_sort_order:${ORG}:${USER}`, `notes.note:${ORG}:${NOTE_1}`]);

    // Concurrent Vy summary tainting the source note while waiting on todo sort lock is inherited from the locked re-read.
    const taintedAfterLock = await todoCreate.handler(
      makeCtx({ id: NOTE_1, tainted: false }, { id: NOTE_1, tainted: true }),
      {
        title: 'Gọi khách',
        details: '',
        checklist: [],
        priority: 4,
        tags: [],
        listId: null,
        sectionId: null,
        dueOn: null,
        dueTime: null,
        timeZone: 'Asia/Ho_Chi_Minh',
        reminder: 'auto',
        sourceNoteId: NOTE_1,
      },
    );
    expect(taintedAfterLock).toEqual({ todoId: TODO_1, revision: 1 });
    expect(insertedValues).toMatchObject({ owner_user_id: USER, source_note_id: NOTE_1, tainted: true });
    expect(auditedFact).toMatchObject({ todoId: TODO_1, sourceNoteId: NOTE_1, tainted: true });

    const written = await todoCreate.handler(makeCtx({ id: NOTE_1, tainted: false }), {
      title: 'Gọi khách',
      details: '',
      checklist: [],
      priority: 4,
      tags: [],
      listId: null,
      sectionId: null,
      dueOn: null,
      dueTime: null,
      timeZone: 'Asia/Ho_Chi_Minh',
      reminder: 'auto',
      sourceNoteId: NOTE_1,
    });
    expect(written).toEqual({ todoId: TODO_1, revision: 1 });
    expect(insertedValues).toMatchObject({ owner_user_id: USER, source_note_id: NOTE_1, tainted: false });
    expect(auditedFact).toMatchObject({ todoId: TODO_1, sourceNoteId: NOTE_1, title: { redacted: 'pii' } });
    expect(JSON.stringify(auditedFact)).not.toContain('Gọi khách');

    await todoCreate.handler(makeCtx({ id: NOTE_1, tainted: true }), {
      title: 'Theo gợi ý AI',
      details: '',
      checklist: [],
      priority: 4,
      tags: [],
      listId: null,
      sectionId: null,
      dueOn: null,
      dueTime: null,
      timeZone: 'Asia/Ho_Chi_Minh',
      reminder: 'auto',
      sourceNoteId: NOTE_1,
    });
    expect(insertedValues).toMatchObject({ owner_user_id: USER, source_note_id: NOTE_1, tainted: true });
    expect(auditedFact).toMatchObject({ todoId: TODO_1, sourceNoteId: NOTE_1, tainted: true });
  });

  it('hydrates sourceNote in notes.todo.list, notes.todo.get, and notes.my_work', async () => {
    const todoRows = [
      { ...baseSummaryRow(TODO_1, NOTE_1), details: 'Chi tiết' },
      { ...baseSummaryRow(TODO_2, NOTE_2), details: null },
    ];
    const noteRows = [{ id: NOTE_1, title: 'Biên bản họp' }];

    const ctx = {
      orgId: ORG,
      role: 'member',
      actor: { type: 'user', userId: USER, sessionId: SESSION },
      trx: {
        selectFrom: (table: string) => {
          const chain = {
            select: () => chain,
            where: () => chain,
            orderBy: () => chain,
            limit: () => chain,
            execute: async () => {
              if (table === 'ludy_notes.todo') return todoRows;
              if (table === 'ludy_notes.note') return noteRows;
              return [];
            },
            executeTakeFirst: async () => {
              if (table === 'ludy_notes.todo') return todoRows[0];
              if (table === 'ludy_kernel.position') return undefined;
              return undefined;
            },
            executeTakeFirstOrThrow: async () => ({ n: '1' }),
          };
          return chain;
        },
      },
      query: async (name: string): Promise<Lookup<unknown>> => {
        if (name === 'kernel.task.list') return { status: 'ok', value: { tasks: [] } };
        return { status: 'not_installed', module: name };
      },
    } as unknown as QueryContext;

    const listed = await todoList.handler(ctx, { view: 'open', sort: 'manual', limit: 200 });
    expect(listed.map((t) => t.sourceNote)).toEqual([
      { id: NOTE_1, title: 'Biên bản họp', available: true },
      { id: NOTE_2, title: null, available: false },
    ]);

    const got = await todoGet.handler(ctx, { todoId: TODO_1 });
    expect(got.sourceNote).toEqual({ id: NOTE_1, title: 'Biên bản họp', available: true });

    const work = await myWork.handler(ctx, { timeZone: 'Asia/Ho_Chi_Minh', sort: 'manual' });
    expect(work.todos.map((t) => t.sourceNote)).toEqual([
      { id: NOTE_1, title: 'Biên bản họp', available: true },
      { id: NOTE_2, title: null, available: false },
    ]);
  });
});
