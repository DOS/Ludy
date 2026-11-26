// SPDX-License-Identifier: AGPL-3.0-only
// Contract, validation, and handler unit tests for Notes N8 member-scoped Vy schemas and commands (#1677, #3522).
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
import {
  zNoteAcceptSummary,
  zNoteSuggestTodosInput,
  zNoteSummarizeInput,
  zTodoAcceptSuggestions,
  zTodoSummary,
} from '@ludy/kernel-contract';
import type { CommandContext } from '@ludy/kernel-runtime';
import { todoAcceptSuggestions } from '../src/vy.ts';

const ORG_ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a50';
const USER_ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a51';
const NOTE_ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const RUN_ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5c';
const TODO_BASE = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4b0';
const NOW = new Date('2026-11-25T00:00:00.000Z');

function createTodoAcceptTrx(opts: {
  note?: { id: string; revision: number; deleted_at: Date | null } | undefined;
  noteOnRecheck?: { id: string; revision: number; deleted_at: Date | null } | undefined;
  recheckSelectIndex?: number | undefined;
  priorTodoId?: string | undefined;
  uniqueConflictOnInsert?: boolean | undefined;
}) {
  const queries: CompiledQuery[] = [];
  const insertedSeqs: Array<number | null> = [];
  let insertCount = 0;
  let noteSelectCount = 0;

  const conn: DatabaseConnection = {
    executeQuery: async <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
      queries.push(compiled);
      const sqlText = compiled.sql.toLowerCase();
      if (sqlText.includes('pg_advisory_xact_lock')) {
        return { rows: [{ pg_advisory_xact_lock: '' }] } as QueryResult<R>;
      }
      if (sqlText.includes('from "ludy_notes"."note"')) {
        noteSelectCount += 1;
        const triggerSelect = opts.recheckSelectIndex ?? 3;
        const selected = noteSelectCount >= triggerSelect && opts.noteOnRecheck ? opts.noteOnRecheck : opts.note;
        return { rows: selected ? [selected] : [] } as QueryResult<R>;
      }
      if (sqlText.startsWith('insert into "ludy_notes"."todo"')) {
        if (opts.uniqueConflictOnInsert) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "todo_source_run_once_uq"'), {
            code: '23505',
            constraint: 'todo_source_run_once_uq',
          });
        }
        const colsMatch = /\(([^)]+)\)\s+values/i.exec(compiled.sql);
        const cols = colsMatch ? colsMatch[1]!.split(',').map((c) => c.replaceAll('"', '').trim()) : [];
        const seqIdx = cols.indexOf('source_run_seq');
        const seqVal = seqIdx >= 0 ? compiled.parameters[seqIdx] : undefined;
        insertedSeqs.push(typeof seqVal === 'number' ? seqVal : null);
        insertCount += 1;
        return { rows: [{ id: `${TODO_BASE}${insertCount}` }] } as QueryResult<R>;
      }
      if (sqlText.includes('from "ludy_notes"."todo"')) {
        if (sqlText.includes('"source_run_id"')) {
          return { rows: opts.priorTodoId ? [{ id: opts.priorTodoId }] : [] } as QueryResult<R>;
        }
        return { rows: [] } as QueryResult<R>;
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

  return { trx: db as unknown as Transaction<Database>, queries, insertedSeqs };
}

function makeTodoCtx(trx: Transaction<Database>) {
  const audits: Record<string, unknown>[] = [];
  const ctx = {
    orgId: ORG_ID,
    now: NOW,
    role: 'member',
    actor: { type: 'user', userId: USER_ID, sessionId: '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a99' },
    trx,
    audit: (fact: Record<string, unknown>) => {
      audits.push(fact);
    },
  } as unknown as CommandContext;
  return { ctx, audits };
}

describe('Notes N8 contracts (#1677)', () => {
  it('validates notes.summarize and notes.suggestTodos inputs strictly', () => {
    expect(zNoteSummarizeInput.parse({ noteId: NOTE_ID, language: 'vi' })).toEqual({
      noteId: NOTE_ID,
      language: 'vi',
    });
    expect(() => zNoteSummarizeInput.parse({ noteId: NOTE_ID, extra: true })).toThrow();

    const suggest = zNoteSuggestTodosInput.parse({ noteId: NOTE_ID });
    expect(suggest).toEqual({ noteId: NOTE_ID, timeZone: 'Asia/Ho_Chi_Minh' });
    expect(() => zNoteSuggestTodosInput.parse({ noteId: NOTE_ID, timeZone: 'Invalid/Zone' })).toThrow();
  });

  it('validates zNoteAcceptSummary bounds, modes, and strict keys', () => {
    const parsed = zNoteAcceptSummary.parse({
      noteId: NOTE_ID,
      revision: 2,
      mode: 'append',
      summary: '  Tom tat cuoc hop  ',
      bullets: ['Chot bao gia', 'Gui hop dong'],
      runId: RUN_ID,
    });
    expect(parsed.summary).toBe('Tom tat cuoc hop');
    expect(parsed.bullets).toEqual(['Chot bao gia', 'Gui hop dong']);

    expect(() =>
      zNoteAcceptSummary.parse({
        noteId: NOTE_ID,
        revision: 0,
        mode: 'replace',
        summary: 'OK',
      }),
    ).toThrow();
    expect(() =>
      zNoteAcceptSummary.parse({
        noteId: NOTE_ID,
        revision: 1,
        mode: 'merge',
        summary: 'OK',
      }),
    ).toThrow();
    expect(() =>
      zNoteAcceptSummary.parse({
        noteId: NOTE_ID,
        revision: 1,
        mode: 'replace',
        summary: '   ',
      }),
    ).toThrow();
    expect(() =>
      zNoteAcceptSummary.parse({
        noteId: NOTE_ID,
        revision: 1,
        mode: 'replace',
        summary: 'OK',
        bullets: Array.from({ length: 11 }, (_, i) => `Item ${i + 1}`),
      }),
    ).toThrow();
  });

  it('validates zTodoAcceptSuggestions item count, calendar dates, and dueTimeNeedsDay', () => {
    const parsed = zTodoAcceptSuggestions.parse({
      noteId: NOTE_ID,
      noteRevision: 3,
      runId: RUN_ID,
      items: [
        {
          title: 'Gui bao gia khach A',
          details: 'Kem ban PDF da ky',
          dueOn: '2026-11-20',
          dueTime: '09:30',
          timeZone: 'Asia/Ho_Chi_Minh',
          reminder: 'auto',
        },
        {
          title: 'Goi lai anh Minh',
        },
      ],
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[1]).toEqual({
      title: 'Goi lai anh Minh',
      details: '',
      dueOn: null,
      dueTime: null,
      timeZone: 'Asia/Ho_Chi_Minh',
      reminder: 'auto',
    });

    // Empty batch and >10 items are rejected.
    expect(() => zTodoAcceptSuggestions.parse({ noteId: NOTE_ID, noteRevision: 1, items: [] })).toThrow();
    expect(() =>
      zTodoAcceptSuggestions.parse({
        noteId: NOTE_ID,
        noteRevision: 1,
        items: Array.from({ length: 11 }, (_, i) => ({ title: `Todo ${i + 1}` })),
      }),
    ).toThrow();

    // dueTime without dueOn is rejected by dueTimeNeedsDay refinement.
    expect(() =>
      zTodoAcceptSuggestions.parse({
        noteId: NOTE_ID,
        noteRevision: 1,
        items: [{ title: 'No day', dueOn: null, dueTime: '14:00' }],
      }),
    ).toThrow();

    // Bogus calendar dates (e.g. 2026-02-31) are rejected by zDay.
    expect(() =>
      zTodoAcceptSuggestions.parse({
        noteId: NOTE_ID,
        noteRevision: 1,
        items: [{ title: 'Bad calendar date', dueOn: '2026-02-31' }],
      }),
    ).toThrow();
  });

  it('requires sourceNoteId and tainted on TodoSummary', () => {
    const todo = zTodoSummary.parse({
      id: NOTE_ID,
      title: 'Kiem tra hop dong',
      status: 'open',
      priority: 4,
      tags: [],
      listId: null,
      sectionId: null,
      dueOn: null,
      dueAt: null,
      dueTime: null,
      timeZone: 'Asia/Ho_Chi_Minh',
      remindAt: null,
      group: 'none',
      overdue: false,
      steps: { done: 0, total: 0 },
      taskId: null,
      sourceNoteId: NOTE_ID,
      sourceNote: { id: NOTE_ID, title: 'Ghi chu hop', available: true },
      recurrence: null,
      seriesId: null,
      tainted: true,
      revision: 1,
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
      doneAt: null,
      deletedAt: null,
    });
    expect(todo.sourceNoteId).toBe(NOTE_ID);
    expect(todo.tainted).toBe(true);
  });
});

describe('todoAcceptSuggestions handler (#3522)', () => {
  const baseInput = zTodoAcceptSuggestions.parse({
    noteId: NOTE_ID,
    noteRevision: 2,
    runId: RUN_ID,
    items: [{ title: 'First task' }, { title: 'Second task' }],
  });

  it('acquires a per-run advisory lock and assigns source_run_seq 0..n-1 on fresh or fully purged runs', async () => {
    const { trx, queries, insertedSeqs } = createTodoAcceptTrx({
      note: { id: NOTE_ID, revision: 2, deleted_at: null },
      priorTodoId: undefined,
    });
    const { ctx, audits } = makeTodoCtx(trx);

    const out = await todoAcceptSuggestions.handler(ctx, {
      ...baseInput,
      runId: RUN_ID.toUpperCase(),
    });
    expect(out).toEqual({
      noteId: NOTE_ID,
      created: 2,
      todoIds: [`${TODO_BASE}2`, `${TODO_BASE}1`],
    });
    expect(insertedSeqs).toEqual([0, 1]);
    expect(queries[0]?.sql.toLowerCase()).toContain('from "ludy_notes"."note"');
    expect(queries[1]?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(queries[1]?.parameters).toEqual([`notes.erase:${ORG_ID}`]);
    expect(queries[2]?.sql).toContain('pg_advisory_xact_lock');
    expect(queries[2]?.parameters).toEqual([`ludy_notes.todo_accept_run:${ORG_ID}:${USER_ID}:${RUN_ID}`]);
    expect(audits).toEqual([
      {
        noteId: NOTE_ID,
        noteRevision: 2,
        created: 2,
        todoIds: [`${TODO_BASE}2`, `${TODO_BASE}1`],
        vyRunId: RUN_ID.toUpperCase(),
      },
    ]);
  });

  it('skips the per-run advisory lock when runId is omitted while still acquiring todo_sort_order', async () => {
    const { trx, queries, insertedSeqs } = createTodoAcceptTrx({
      note: { id: NOTE_ID, revision: 2, deleted_at: null },
    });
    const { ctx } = makeTodoCtx(trx);
    const noRunInput = zTodoAcceptSuggestions.parse({
      noteId: NOTE_ID,
      noteRevision: 2,
      items: [{ title: 'Ad-hoc task' }],
    });

    const out = await todoAcceptSuggestions.handler(ctx, noRunInput);
    expect(out.created).toBe(1);
    expect(insertedSeqs).toEqual([null]);
    const lockParams = queries.filter((q) => q.sql.includes('pg_advisory_xact_lock')).flatMap((q) => q.parameters);
    expect(lockParams.some((p) => String(p).includes('todo_accept_run'))).toBe(false);
    expect(lockParams).toContain(`ludy_notes.todo_sort_order:${ORG_ID}:${USER_ID}`);
    expect(lockParams).toContain(`notes.note:${ORG_ID}:${NOTE_ID}`);
  });

  it('rejects replay when any prior row exists or todo_source_run_once_uq conflicts', async () => {
    const priorTrx = createTodoAcceptTrx({
      note: { id: NOTE_ID, revision: 2, deleted_at: null },
      priorTodoId: `${TODO_BASE}1`,
    });
    await expect(
      todoAcceptSuggestions.handler(makeTodoCtx(priorTrx.trx).ctx, baseInput),
    ).rejects.toMatchObject({ code: 'VY_RUN_ALREADY_ACCEPTED', status: 409 });
    expect(priorTrx.insertedSeqs).toEqual([]);
    expect(priorTrx.queries[0]?.sql.toLowerCase()).toContain('from "ludy_notes"."note"');
    expect(priorTrx.queries[1]?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(priorTrx.queries[2]?.sql).toContain('pg_advisory_xact_lock');

    const conflictTrx = createTodoAcceptTrx({
      note: { id: NOTE_ID, revision: 2, deleted_at: null },
      uniqueConflictOnInsert: true,
    });
    await expect(
      todoAcceptSuggestions.handler(makeTodoCtx(conflictTrx.trx).ctx, baseInput),
    ).rejects.toMatchObject({ code: 'VY_RUN_ALREADY_ACCEPTED', status: 409 });
  });

  it('rejects missing, trashed, and stale-revision notes cleanly without inserting', async () => {
    const missing = createTodoAcceptTrx({ note: undefined });
    await expect(
      todoAcceptSuggestions.handler(makeTodoCtx(missing.trx).ctx, baseInput),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND', status: 404 });
    expect(missing.queries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(false);

    const trashed = createTodoAcceptTrx({ note: { id: NOTE_ID, revision: 2, deleted_at: NOW } });
    await expect(
      todoAcceptSuggestions.handler(makeTodoCtx(trashed.trx).ctx, baseInput),
    ).rejects.toMatchObject({ code: 'NOTE_IN_TRASH', status: 409 });

    const stale = createTodoAcceptTrx({ note: { id: NOTE_ID, revision: 3, deleted_at: null } });
    await expect(
      todoAcceptSuggestions.handler(makeTodoCtx(stale.trx).ctx, baseInput),
    ).rejects.toMatchObject({ code: 'NOTE_REVISION_CONFLICT', status: 409, details: { revision: 3 } });

    const staleDuringLockWait = createTodoAcceptTrx({
      note: { id: NOTE_ID, revision: 2, deleted_at: null },
      noteOnRecheck: { id: NOTE_ID, revision: 3, deleted_at: null },
      recheckSelectIndex: 2,
    });
    await expect(
      todoAcceptSuggestions.handler(makeTodoCtx(staleDuringLockWait.trx).ctx, baseInput),
    ).rejects.toMatchObject({ code: 'NOTE_REVISION_CONFLICT', status: 409, details: { revision: 3 } });
    expect(staleDuringLockWait.insertedSeqs).toEqual([]);

    const staleAfterRebalance = createTodoAcceptTrx({
      note: { id: NOTE_ID, revision: 2, deleted_at: null },
      noteOnRecheck: { id: NOTE_ID, revision: 2, deleted_at: NOW },
    });
    await expect(
      todoAcceptSuggestions.handler(makeTodoCtx(staleAfterRebalance.trx).ctx, baseInput),
    ).rejects.toMatchObject({ code: 'NOTE_IN_TRASH', status: 409 });
    expect(staleAfterRebalance.insertedSeqs).toEqual([]);
  });
});
