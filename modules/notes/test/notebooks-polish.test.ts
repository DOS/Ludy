// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for PR #4190 review polish (#4211): strict pre-load notebook -> note lock order & PG error mapping in
// noteUpdate, and spacing around non-editable shared notebooks + sibling row locking on >80-subdivision rebalance.
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
import type { Database, MemberRole } from '@ludy/db';
import type { CommandContext } from '@ludy/kernel-runtime';
import { notebookCreate, notebookUpdate, planNotebookRebalance, spreadKeysBetween } from '../src/notebooks.ts';
import { noteCreate, noteUpdate } from '../src/notes.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const NOTE_ID = '10000000-0000-4000-8000-000000000001';
const NB_1 = '20000000-0000-4000-8000-000000000001';
const NB_2 = '20000000-0000-4000-8000-000000000002';
const NB_3 = '20000000-0000-4000-8000-000000000003';
const NB_4 = '20000000-0000-4000-8000-000000000004';
const NOW = new Date('2026-11-25T00:00:00.000Z');

function createMockTrx(
  handler: (compiled: CompiledQuery) => Promise<QueryResult<unknown>> | QueryResult<unknown>,
): { trx: Transaction<Database>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const conn: DatabaseConnection = {
    executeQuery: async <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
      queries.push(compiled);
      return (await handler(compiled)) as QueryResult<R>;
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
  return { trx: db as unknown as Transaction<Database>, queries };
}

function makeCtx(trx: Transaction<Database>, userId: string, role: MemberRole): CommandContext {
  return {
    orgId: ORG,
    role,
    now: NOW,
    actor: { type: 'user', userId, aal: 'aal1' },
    audit: () => {},
    trx,
  } as unknown as CommandContext;
}

describe('noteUpdate canonical pre-load lock order & error handling (#4211)', () => {
  const baseNoteRow = {
    id: NOTE_ID,
    author_user_id: USER,
    notebook_id: null,
    visibility: 'private' as const,
    title: 'Ghi chu',
    body: 'Noi dung',
    tags: [],
    pinned: false,
    tainted: false,
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    deleted_at: null,
  };

  it('acquires notebook shared advisory lock strictly before note FOR UPDATE and never re-locks post-load on visibility drift', async () => {
    let noteSelectCount = 0;
    const { trx, queries } = createMockTrx((compiled) => {
      const sqlLower = compiled.sql.toLowerCase();
      if (sqlLower.includes('from "ludy_notes"."note"')) {
        noteSelectCount += 1;
        // Simulate visibility drifting from private on peek to org on locked FOR UPDATE with matching revision.
        const row = noteSelectCount === 1 ? baseNoteRow : { ...baseNoteRow, visibility: 'org' as const, revision: 2 };
        return { rows: [row] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"')) {
        return { rows: [{ id: NB_1, author_user_id: USER, visibility: 'private' }] };
      }
      return { rows: [] };
    });

    await expect(
      noteUpdate.handler(makeCtx(trx, USER, 'member'), {
        noteId: NOTE_ID,
        revision: 2,
        notebookId: NB_1,
      }),
    ).rejects.toMatchObject({ code: 'NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK', status: 422 });

    const lockIndices = queries
      .map((q, idx) => ({ sql: q.sql.toLowerCase(), idx }))
      .filter((x) => x.sql.includes('pg_advisory_xact_lock_shared'));
    const noteForUpdateIdx = queries.findIndex(
      (q) => q.sql.toLowerCase().includes('from "ludy_notes"."note"') && q.sql.toLowerCase().includes('for update'),
    );

    expect(lockIndices).toHaveLength(1);
    expect(noteForUpdateIdx).toBeGreaterThan(lockIndices[0]!.idx);
  });

  it('maps 23514 NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK and 42501 NOTES_NOTEBOOK_NOT_ACCESSIBLE from UPDATE like noteSetVisibility', async () => {
    for (const pgErr of [
      { code: '23514', message: 'NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK', expectedCode: 'NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK', expectedStatus: 422 },
      { code: '42501', message: 'NOTES_NOTEBOOK_NOT_ACCESSIBLE', expectedCode: 'NOTEBOOK_NOT_FOUND', expectedStatus: 404 },
    ]) {
      const { trx } = createMockTrx((compiled) => {
        const sqlLower = compiled.sql.toLowerCase();
        if (sqlLower.includes('from "ludy_notes"."note"')) {
          return { rows: [baseNoteRow] };
        }
        if (sqlLower.includes('from "ludy_notes"."notebook"')) {
          return { rows: [{ id: NB_1, author_user_id: USER, visibility: 'org' }] };
        }
        if (sqlLower.startsWith('update "ludy_notes"."note"')) {
          throw Object.assign(new Error(pgErr.message), { code: pgErr.code });
        }
        return { rows: [] };
      });

      await expect(
        noteUpdate.handler(makeCtx(trx, USER, 'member'), {
          noteId: NOTE_ID,
          revision: 1,
          notebookId: NB_1,
        }),
      ).rejects.toMatchObject({ code: pgErr.expectedCode, status: pgErr.expectedStatus });
    }
  });

  it('maps 23514 NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK and 42501 NOTES_NOTEBOOK_NOT_ACCESSIBLE from INSERT in noteCreate (#4761)', async () => {
    for (const pgErr of [
      { code: '23514', message: 'NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK', expectedCode: 'NOTES_SHARED_NOTE_PRIVATE_NOTEBOOK', expectedStatus: 422 },
      { code: '42501', message: 'NOTES_NOTEBOOK_NOT_ACCESSIBLE', expectedCode: 'NOTEBOOK_NOT_FOUND', expectedStatus: 404 },
    ]) {
      const { trx } = createMockTrx((compiled) => {
        const sqlLower = compiled.sql.toLowerCase();
        if (sqlLower.includes('from "ludy_notes"."notebook"')) {
          return { rows: [{ id: NB_1, author_user_id: USER, visibility: 'org' }] };
        }
        if (sqlLower.startsWith('insert into "ludy_notes"."note"')) {
          throw Object.assign(new Error(pgErr.message), { code: pgErr.code });
        }
        return { rows: [] };
      });

      await expect(
        noteCreate.handler(makeCtx(trx, USER, 'member'), {
          title: 'Ghi chu dong bo',
          body: '',
          visibility: 'private',
          tags: [],
          notebookId: NB_1,
        }),
      ).rejects.toMatchObject({ code: pgErr.expectedCode, status: pgErr.expectedStatus });
    }
  });
});

describe('notebook rebalance around non-editable shared notebooks & sibling row locking (#4211)', () => {
  it('spaces rebalanced keys strictly within enclosing non-editable shared notebooks without touching them', () => {
    const plan = planNotebookRebalance(
      [
        { id: NB_1, editable: false, sortKey: 'B' },
        { id: NB_2, editable: true, sortKey: `C${'0'.repeat(78)}1` },
        { id: NB_3, editable: false, sortKey: 'V' },
        { id: '20000000-0000-4000-8000-000000000005', editable: true, sortKey: 'l' },
      ],
      NB_4,
      'after',
      NB_2,
    );

    expect(plan.movingKey.length).toBeLessThan(10);
    expect(plan.updates).toHaveLength(1);
    const updatedNb2 = plan.updates.find((u) => u.id === NB_2);
    expect(updatedNb2).toBeDefined();
    expect(updatedNb2!.sortKey > 'B').toBe(true);
    expect(updatedNb2!.sortKey < plan.movingKey).toBe(true);
    expect(plan.movingKey < 'V').toBe(true);
    // Clean run after NB_3 ('l') and non-editable shared notebooks (NB_1, NB_3) are untouched.
    expect(plan.updates.some((u) => u.id === NB_1 || u.id === NB_3 || u.id === '20000000-0000-4000-8000-000000000005')).toBe(false);
  });

  it('steps cleanly outside tied non-editable shared notebooks when rebalancing before or after an anchor', () => {
    const afterPlan = planNotebookRebalance(
      [
        { id: NB_1, editable: false, sortKey: 'V' },
        { id: NB_2, editable: false, sortKey: 'V' },
        { id: NB_3, editable: true, sortKey: `V${'0'.repeat(78)}1` },
      ],
      NB_4,
      'after',
      NB_1,
    );
    expect(afterPlan.movingKey > 'V').toBe(true);
    expect(afterPlan.updates[0]?.id).toBe(NB_3);
    expect(afterPlan.updates[0]!.sortKey > afterPlan.movingKey).toBe(true);

    const beforePlan = planNotebookRebalance(
      [
        { id: NB_3, editable: true, sortKey: `U${'z'.repeat(79)}` },
        { id: NB_1, editable: false, sortKey: 'V' },
        { id: NB_2, editable: false, sortKey: 'V' },
      ],
      NB_4,
      'before',
      NB_2,
    );
    expect(beforePlan.movingKey < 'V').toBe(true);
    expect(beforePlan.updates[0]?.id).toBe(NB_3);
    expect(beforePlan.updates[0]!.sortKey < beforePlan.movingKey).toBe(true);

    // Interleaved editable sibling between tied fixed shared notebooks must still escape to a valid gap (never '').
    const interleavedBefore = planNotebookRebalance(
      [
        { id: 'f0', editable: false, sortKey: 'V' },
        { id: 'e0', editable: true, sortKey: 'V' },
        { id: 'f1', editable: false, sortKey: 'V' },
        { id: 'f2', editable: false, sortKey: 'V' },
      ],
      'm',
      'before',
      'f2',
    );
    expect(interleavedBefore.movingKey).not.toBe('');
    expect(interleavedBefore.movingKey < 'V').toBe(true);

    const interleavedAfter = planNotebookRebalance(
      [
        { id: 'f0', editable: false, sortKey: 'V' },
        { id: 'f1', editable: false, sortKey: 'V' },
        { id: 'e0', editable: true, sortKey: 'V' },
        { id: 'f2', editable: false, sortKey: 'V' },
      ],
      'm',
      'after',
      'f0',
    );
    expect(interleavedAfter.movingKey).not.toBe('');
    expect(interleavedAfter.movingKey > 'V').toBe(true);

    // Anchoring on an interleaved editable sibling steps into the nearest bounded editable run.
    const nestedBefore = planNotebookRebalance(
      [
        { id: 'fp', editable: false, sortKey: 'U' },
        { id: 'ep', editable: true, sortKey: 'U5' },
        { id: 'f0', editable: false, sortKey: 'V' },
        { id: 'e0', editable: true, sortKey: 'V' },
        { id: 'f1', editable: false, sortKey: 'V' },
      ],
      'm',
      'before',
      'e0',
    );
    expect(nestedBefore.movingKey > 'U' && nestedBefore.movingKey < 'V').toBe(true);
    expect(nestedBefore.updates[0]?.id).toBe('ep');
    expect(nestedBefore.updates[0]!.sortKey > 'U' && nestedBefore.updates[0]!.sortKey < nestedBefore.movingKey).toBe(true);

    // Zero-gap floor key ('0') has no valid key < '0' and falls back cleanly past the '0' block.
    const floorZero = planNotebookRebalance(
      [
        { id: 'f0', editable: false, sortKey: '0' },
        { id: 'f1', editable: false, sortKey: '0' },
      ],
      'm',
      'before',
      'f1',
    );
    expect(floorZero.movingKey > '0').toBe(true);
  });

  it('spreadKeysBetween keeps 200 keys strictly ordered and compact inside narrow bounds and handles trailing-0 bounds', () => {
    const keys = spreadKeysBetween('V', 'W', 200);
    expect(keys).toHaveLength(200);
    for (let i = 0; i < keys.length; i++) {
      expect(keys[i]!.length).toBeLessThanOrEqual(4);
      expect(keys[i]! > 'V').toBe(true);
      expect(keys[i]! < 'W').toBe(true);
      if (i > 0) expect(keys[i - 1]! < keys[i]!).toBe(true);
    }

    for (const [lo, hi] of [
      ['Z', 'a0'],
      [null, '10'],
      ['V', 'V0010'],
    ] as const) {
      const bounded = spreadKeysBetween(lo, hi, 7);
      for (let i = 0; i < bounded.length; i++) {
        if (lo !== null) expect(bounded[i]! > lo).toBe(true);
        expect(bounded[i]! < hi).toBe(true);
        if (i > 0) expect(bounded[i - 1]! < bounded[i]!).toBe(true);
      }
    }

    const beforeTrailingZero = planNotebookRebalance(
      [
        { id: NB_1, editable: false, sortKey: 'Z' },
        { id: NB_2, editable: true, sortKey: `Z${'0'.repeat(78)}1` },
        { id: NB_3, editable: false, sortKey: 'a0' },
      ],
      NB_4,
      'before',
      NB_3,
    );
    expect(beforeTrailingZero.movingKey > 'Z' && beforeTrailingZero.movingKey < 'a0').toBe(true);
    expect(beforeTrailingZero.updates[0]?.id).toBe(NB_2);
    expect(beforeTrailingZero.updates[0]!.sortKey > 'Z' && beforeTrailingZero.updates[0]!.sortKey < beforeTrailingZero.movingKey).toBe(true);
  });

  it('acquires org reorder lock and locks editable sibling rows FOR UPDATE in deterministic id order when >80 subdivisions trigger rebalance', async () => {
    const NB_5 = '20000000-0000-4000-8000-000000000005';
    const deep1 = `C${'0'.repeat(78)}1`;
    const deep2 = `C${'0'.repeat(78)}2`;
    const deep3 = `C${'0'.repeat(78)}3`;
    const notebookRows = [
      { id: NB_1, author_user_id: OTHER, visibility: 'org' as const, name: 'Shared Left', stack_name: null, pinned: false, sort_key: 'B', revision: 1, created_at: NOW, updated_at: NOW },
      { id: NB_2, author_user_id: USER, visibility: 'private' as const, name: 'Mine A', stack_name: null, pinned: false, sort_key: deep1, revision: 1, created_at: NOW, updated_at: NOW },
      { id: NB_5, author_user_id: USER, visibility: 'private' as const, name: 'Mine B', stack_name: null, pinned: false, sort_key: deep2, revision: 1, created_at: NOW, updated_at: NOW },
      { id: NB_3, author_user_id: USER, visibility: 'private' as const, name: 'Mine C', stack_name: null, pinned: false, sort_key: deep3, revision: 1, created_at: NOW, updated_at: NOW },
      { id: NB_4, author_user_id: OTHER, visibility: 'org' as const, name: 'Shared Right', stack_name: null, pinned: false, sort_key: 'V', revision: 1, created_at: NOW, updated_at: NOW },
    ];

    const { trx, queries } = createMockTrx((compiled) => {
      const sqlLower = compiled.sql.toLowerCase();
      if (sqlLower.includes('ctx_le_scope')) {
        return { rows: [{ whole: true }] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"') && sqlLower.includes('where "org_id" = $1 and "id" = $2')) {
        return { rows: [notebookRows[3]] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"') && sqlLower.includes('for update')) {
        return { rows: [{ id: NB_2 }, { id: NB_5 }] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"')) {
        return { rows: notebookRows };
      }
      if (sqlLower.startsWith('update "ludy_notes"."notebook"')) {
        return { rows: [{ id: NB_3, revision: 2 }] };
      }
      return { rows: [] };
    });

    const res = await notebookUpdate.handler(makeCtx(trx, USER, 'member'), {
      notebookId: NB_3,
      revision: 1,
      reorder: { place: 'after', anchorId: NB_2 },
    });
    expect(res).toEqual({ notebookId: NB_3, revision: 2 });

    const reorderLockIdx = queries.findIndex((q) => q.parameters.includes(`notes.notebook.reorder:${ORG}`));
    const targetLockIdx = queries.findIndex((q) => q.parameters.includes(`notes.notebook:${ORG}:${NB_3}`));
    const siblingLockQuery = queries.find(
      (q) =>
        q.sql.toLowerCase().includes('from "ludy_notes"."notebook"') &&
        q.sql.toLowerCase().includes('order by "id"') &&
        q.sql.toLowerCase().includes('for update'),
    );
    const batchUpdateQuery = queries.find((q) => q.sql.toLowerCase().includes('unnest('));

    expect(reorderLockIdx).toBeGreaterThanOrEqual(0);
    expect(targetLockIdx).toBeGreaterThan(reorderLockIdx);
    expect(siblingLockQuery).toBeDefined();
    expect(siblingLockQuery!.parameters).toContain(NB_2);
    expect(siblingLockQuery!.parameters).toContain(NB_5);
    expect(siblingLockQuery!.parameters).not.toContain(NB_1);
    expect(siblingLockQuery!.parameters).not.toContain(NB_4);
    expect(batchUpdateQuery).toBeDefined();
    expect(batchUpdateQuery!.parameters[0]).toEqual([NB_2, NB_5]);
  });

  it('notebookCreate rebalances around non-editable shared org notebooks without mutating them and keeps new sort_key after them (#4211)', async () => {
    const deepSharedKey = 'z'.repeat(80);
    const sharedOrg = {
      id: NB_1,
      author_user_id: OTHER,
      visibility: 'org' as const,
      sort_key: deepSharedKey,
    };
    const mineBefore = {
      id: NB_2,
      author_user_id: USER,
      visibility: 'private' as const,
      sort_key: 'V',
    };

    let insertedSortKey = '';
    const { trx, queries } = createMockTrx((compiled) => {
      const sqlLower = compiled.sql.toLowerCase();
      if (sqlLower.includes('ctx_le_scope')) {
        return { rows: [{ whole: true }] };
      }
      if (sqlLower.includes('pg_catalog.max(sort_key)')) {
        return { rows: [{ last: deepSharedKey }] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"') && sqlLower.includes('where "org_id" = $1 and "author_user_id" = $2')) {
        return { rows: [mineBefore] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"') && sqlLower.includes('for update')) {
        return { rows: [{ id: NB_2 }] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"')) {
        return { rows: [mineBefore, sharedOrg] };
      }
      if (sqlLower.startsWith('insert into "ludy_notes"."notebook"')) {
        // sort_key is the 7th column in notebookCreate's VALUES(...)
        insertedSortKey = String(compiled.parameters[6] ?? '');
        return { rows: [{ id: NB_3, visibility: 'private', revision: 1 }] };
      }
      return { rows: [] };
    });

    const created = await notebookCreate.handler(makeCtx(trx, USER, 'member'), {
      name: 'So moi cua thanh vien',
      stackName: null,
      visibility: 'private',
      pinned: false,
    });
    expect(created).toEqual({ notebookId: NB_3, revision: 1 });
    expect(insertedSortKey > deepSharedKey).toBe(true);

    const reorderLock = queries.find((q) => q.parameters.includes(`notes.notebook.reorder:${ORG}`));
    const siblingLockQuery = queries.find(
      (q) =>
        q.sql.toLowerCase().includes('from "ludy_notes"."notebook"') &&
        q.sql.toLowerCase().includes('order by "id"') &&
        q.sql.toLowerCase().includes('for update'),
    );
    const batchUpdateQuery = queries.find((q) => q.sql.toLowerCase().includes('unnest('));

    expect(reorderLock).toBeDefined();
    expect(siblingLockQuery).toBeDefined();
    expect(siblingLockQuery!.parameters).toContain(NB_2);
    expect(siblingLockQuery!.parameters).not.toContain(NB_1);
    // mineBefore ('V') sits cleanly inside (null, deepSharedKey) and sharedOrg is untouched, so no unnest update is needed.
    expect(batchUpdateQuery).toBeUndefined();
  });

  it('notebookCreate compacts caller trailing editable notebooks after a non-editable shared notebook while keeping order (#4211)', async () => {
    const sharedOrg = {
      id: NB_1,
      author_user_id: OTHER,
      visibility: 'org' as const,
      sort_key: 'V',
    };
    const mineTail = {
      id: NB_2,
      author_user_id: USER,
      visibility: 'private' as const,
      sort_key: 'z'.repeat(80),
    };

    let insertedSortKey = '';
    const { trx, queries } = createMockTrx((compiled) => {
      const sqlLower = compiled.sql.toLowerCase();
      if (sqlLower.includes('ctx_le_scope')) {
        return { rows: [{ whole: true }] };
      }
      if (sqlLower.includes('pg_catalog.max(sort_key)')) {
        return { rows: [{ last: mineTail.sort_key }] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"') && sqlLower.includes('where "org_id" = $1 and "author_user_id" = $2')) {
        return { rows: [mineTail] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"') && sqlLower.includes('for update')) {
        return { rows: [{ id: NB_2 }] };
      }
      if (sqlLower.includes('from "ludy_notes"."notebook"')) {
        return { rows: [sharedOrg, mineTail] };
      }
      if (sqlLower.startsWith('insert into "ludy_notes"."notebook"')) {
        insertedSortKey = String(compiled.parameters[6] ?? '');
        return { rows: [{ id: NB_3, visibility: 'private', revision: 1 }] };
      }
      return { rows: [] };
    });

    await notebookCreate.handler(makeCtx(trx, USER, 'member'), {
      name: 'So moi sau shared',
      stackName: null,
      visibility: 'private',
      pinned: false,
    });

    const batchUpdateQuery = queries.find((q) => q.sql.toLowerCase().includes('unnest('));
    expect(batchUpdateQuery).toBeDefined();
    expect(batchUpdateQuery!.parameters[0]).toEqual([NB_2]);
    const compactedTailKey = (batchUpdateQuery!.parameters[1] as string[])[0]!;
    expect(compactedTailKey.length).toBeLessThan(10);
    expect(compactedTailKey > 'V').toBe(true);
    expect(insertedSortKey.length).toBeLessThan(10);
    expect(insertedSortKey > compactedTailKey).toBe(true);
  });
});
