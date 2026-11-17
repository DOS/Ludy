// SPDX-License-Identifier: AGPL-3.0-only
// Database integration tests on PostgreSQL 17 for Notes v2 T3 recurring personal to-dos and reschedule (#3557):
// schema CHECK constraint, atomic recurring spawn with checklist reset & reminder shift, stopSeries/idempotency,
// single/bulk reschedule with ADR-0037 author-only isolation, and strict PII redaction in audit/outbox.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import {
  type NotesExport,
  type Todo,
  type TodoCompleteResult,
  type TodoRescheduled,
  type TodoSummary,
  type TodoWritten,
} from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET_TITLE = 'Nộp tờ khai thuế quý 4 bí mật';
const SECRET_DETAILS = 'Số tài khoản nội bộ tuyệt mật 999888';
const SECRET_STEP_1 = 'Chốt số hóa đơn đầu vào';
const SECRET_STEP_2 = 'Ký tờ khai điện tử';

suite('personal to-do recurrence and reschedule on PostgreSQL (#3557)', () => {
  const dbName = `crove_test_notes_todo_rec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const makeUser = (name: string) =>
      upsertIdentity(createDb(pools[0] as pg.Pool), {
        issuer: 'todo-rec',
        subject: `${name}-${tag}`,
        email: `${name}-${tag}@rec.test`,
        name: null,
      });
    const owner = await makeUser('owner');
    const adminUser = await makeUser('admin');
    const mine = await makeUser('mine');
    const other = await makeUser('other');
    const { orgId } = await createOrg(app, asUser(owner), `Recurring ${tag}`);
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`, [
        orgId,
        adminUser,
        mine,
        other,
      ]),
    );
    const exec = <O>(userId: string, name: string, input: unknown = {}) => app.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => app.query<O>(name, input, { actor: asUser(userId), orgId });
    return { orgId, owner, admin: adminUser, mine, other, exec, query };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    app = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries],
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces crove_notes.todo_recurrence_valid(jsonb) CHECK constraints at the SQL layer', async () => {
    await admin(async (c) => {
      const check = async (expr: string, params: unknown[] = []) => {
        const res = await c.query<{ ok: boolean }>(`SELECT crove_notes.todo_recurrence_valid(${expr}) AS ok`, params);
        return res.rows[0]?.ok;
      };
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'daily', interval: 1 })])).toBe(true);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'weekly', interval: 2, byWeekday: 0 })])).toBe(true);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'monthly', interval: 1, byMonthDay: -1 })])).toBe(true);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'monthly', interval: 12, byMonthDay: 31 })])).toBe(true);

      // Missing required keys and disallowed shapes, keys, intervals, and cross-frequency qualifiers.
      expect(await check('$1::jsonb', ['{}'])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'daily' })])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify({ interval: 1 })])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'yearly', interval: 1 })])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'daily', interval: 0 })])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'daily', interval: 366 })])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'daily', interval: 1, byWeekday: 1 })])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'monthly', interval: 1, byMonthDay: 0 })])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'monthly', interval: 1, byMonthDay: 32 })])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify({ freq: 'daily', interval: 1, extra: 'bad' })])).toBe(false);
      expect(await check('$1::jsonb', [JSON.stringify(['daily'])])).toBe(false);
    });
  });

  it('atomically completes a recurring to-do, spawns the next occurrence with reset checklist, shifted dates/reminders and zero PII in audit/outbox', async () => {
    const o = await setupOrg();
    const created = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: SECRET_TITLE,
      details: SECRET_DETAILS,
      checklist: [
        { text: SECRET_STEP_1, done: true },
        { text: SECRET_STEP_2, done: false },
      ],
      dueOn: '2026-11-30',
      dueTime: '09:30',
      timeZone: 'Asia/Ho_Chi_Minh',
      reminder: 'auto',
      recurrence: { freq: 'monthly', interval: 1, byMonthDay: -1 },
    });

    // Simulate a previous reminder delivery marker so we can verify the spawned occurrence clears reminded_at.
    await admin((c) => c.query(`UPDATE crove_notes.todo SET reminded_at = now() WHERE org_id = $1 AND id = $2`, [o.orgId, created.todoId]));

    const initial = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: created.todoId });
    expect(initial.seriesId).toBe(created.todoId);
    expect(initial.recurrence).toEqual({ freq: 'monthly', interval: 1, byMonthDay: -1 });

    const doneRes = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: created.todoId });
    expect(doneRes.todoId).toBe(created.todoId);
    expect(doneRes.nextTodoId).toBeTruthy();
    const nextId = doneRes.nextTodoId as string;
    expect(nextId).not.toBe(created.todoId);

    // Completed row keeps history and checklist done state intact.
    const completedRow = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: created.todoId });
    expect(completedRow.status).toBe('done');
    expect(completedRow.checklist).toEqual([
      { text: SECRET_STEP_1, done: true },
      { text: SECRET_STEP_2, done: false },
    ]);
    expect(completedRow.seriesId).toBe(created.todoId);

    // Next occurrence shares seriesId & recurrence, resets checklist, shifts dueOn to 2026-12-31, keeps 09:30, shifts auto reminder, clears reminded_at.
    const spawned = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: nextId });
    expect(spawned.status).toBe('open');
    expect(spawned.title).toBe(SECRET_TITLE);
    expect(spawned.details).toBe(SECRET_DETAILS);
    expect(spawned.seriesId).toBe(created.todoId);
    expect(spawned.recurrence).toEqual({ freq: 'monthly', interval: 1, byMonthDay: -1 });
    expect(spawned.dueOn).toBe('2026-12-31');
    expect(spawned.dueTime).toBe('09:30');
    expect(spawned.remindAt).toBe('2026-12-31T02:00:00.000Z'); // 09:00 Asia/Ho_Chi_Minh = 02:00Z
    expect(spawned.checklist).toEqual([
      { text: SECRET_STEP_1, done: false },
      { text: SECRET_STEP_2, done: false },
    ]);

    const rawDbNext = await admin((c) =>
      c.query<{ reminded_at: Date | null }>(`SELECT reminded_at FROM crove_notes.todo WHERE org_id = $1 AND id = $2`, [o.orgId, nextId]),
    );
    expect(rawDbNext.rows[0]?.reminded_at).toBeNull();

    // Re-completing the already-done row is idempotent and spawns no third occurrence.
    const secondComplete = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: created.todoId });
    expect(secondComplete.nextTodoId ?? null).toBeNull();

    // Reopening the completed row and completing again must NOT create a duplicate open row for the same (series_id, 2026-12-31).
    await o.exec<TodoWritten>(o.mine, 'notes.todo.reopen', { todoId: created.todoId });
    const recompleted = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: created.todoId });
    expect(recompleted.nextTodoId ?? null).toBeNull();

    // Completing with stopSeries: true finishes the series cleanly and clears recurrence on the done row.
    const stopped = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: nextId, stopSeries: true });
    expect(stopped.nextTodoId ?? null).toBeNull();
    const stoppedRow = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: nextId });
    expect(stoppedRow.status).toBe('done');
    expect(stoppedRow.recurrence).toBeNull();
    expect(stoppedRow.seriesId).toBe(created.todoId);

    const openList = await o.query<TodoSummary[]>(o.mine, 'notes.todo.list', { view: 'open' });
    expect(openList).toEqual([]);

    // Audit & outbox hold IDs/dates/status only, never title/details/steps.
    await admin(async (c) => {
      const audits = await c.query<{ command: string; detail: Record<string, unknown> }>(
        `SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'notes.todo.%'`,
        [o.orgId],
      );
      const outbox = await c.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type LIKE 'notes.todo.%'`,
        [o.orgId],
      );
      const blob = JSON.stringify({ audits: audits.rows, outbox: outbox.rows });
      expect(blob).not.toContain(SECRET_TITLE);
      expect(blob).not.toContain(SECRET_DETAILS);
      expect(blob).not.toContain(SECRET_STEP_1);
      expect(blob).not.toContain(SECRET_STEP_2);
    });
  });

  it('supports setting recurrence on update and bulk reschedules with ADR-0037 author-only isolation', async () => {
    const o = await setupOrg();
    const a = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Overdue Alpha',
      dueOn: '2026-10-01',
      dueTime: '15:00',
      timeZone: 'Asia/Ho_Chi_Minh',
      reminder: 'auto',
    });
    const b = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Overdue Beta',
      dueOn: '2026-10-02',
      timeZone: 'Asia/Ho_Chi_Minh',
      reminder: 'off',
    });

    // Update a to add weekly recurrence; assigns seriesId = a.todoId.
    const aRead = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: a.todoId });
    await o.exec<TodoWritten>(o.mine, 'notes.todo.update', {
      todoId: a.todoId,
      revision: aRead.revision,
      title: aRead.title,
      details: aRead.details,
      checklist: aRead.checklist,
      dueOn: aRead.dueOn,
      dueTime: aRead.dueTime,
      timeZone: aRead.timeZone,
      recurrence: { freq: 'weekly', interval: 1 },
    });
    const aWithRec = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: a.todoId });
    expect(aWithRec.seriesId).toBe(a.todoId);
    expect(aWithRec.recurrence).toEqual({ freq: 'weekly', interval: 1 });

    // Owner, admin and other member cannot reschedule mine's private to-dos.
    for (const stranger of [o.owner, o.admin, o.other]) {
      await expect(o.exec(stranger, 'notes.todo.reschedule', { todoIds: [a.todoId, b.todoId], dueOn: '2026-12-01' })).rejects.toMatchObject({
        code: 'TODO_NOT_FOUND',
        status: 404,
      });
    }

    // Mark a's reminded_at so reschedule must clear it.
    await admin((c) => c.query(`UPDATE crove_notes.todo SET reminded_at = now() WHERE org_id = $1 AND id = $2`, [o.orgId, a.todoId]));

    // Reschedule both in batch to 2026-12-10; a retains 15:00 + 14:30 reminder, b stays reminder: null, order is preserved.
    const resched = await o.exec<TodoRescheduled>(o.mine, 'notes.todo.reschedule', {
      todoIds: [a.todoId, b.todoId],
      dueOn: '2026-12-10',
    });
    expect(resched).toEqual({ updated: 2, todoIds: [a.todoId, b.todoId] });

    const aAfter = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: a.todoId });
    const bAfter = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: b.todoId });
    expect(aAfter.dueOn).toBe('2026-12-10');
    expect(aAfter.dueTime).toBe('15:00');
    expect(aAfter.remindAt).toBe('2026-12-10T07:30:00.000Z'); // 14:30 Asia/Ho_Chi_Minh = 07:30Z
    expect(aAfter.revision).toBe(aWithRec.revision + 1);
    expect(bAfter.dueOn).toBe('2026-12-10');
    expect(bAfter.remindAt).toBeNull();

    const rawA = await admin((c) =>
      c.query<{ reminded_at: Date | null }>(`SELECT reminded_at FROM crove_notes.todo WHERE org_id = $1 AND id = $2`, [o.orgId, a.todoId]),
    );
    expect(rawA.rows[0]?.reminded_at).toBeNull();

    // Reschedule rejects if a to-do is trashed (409 TODO_IN_TRASH), done (409), or missing (404).
    await o.exec<TodoWritten>(o.mine, 'notes.todo.delete', { todoId: b.todoId });
    await expect(o.exec(o.mine, 'notes.todo.reschedule', { todoIds: [b.todoId], dueOn: '2026-12-11' })).rejects.toMatchObject({
      code: 'TODO_IN_TRASH',
      status: 409,
    });
    await expect(o.exec(o.mine, 'notes.todo.reschedule', { todoIds: [randomUUID()], dueOn: '2026-12-11' })).rejects.toMatchObject({
      code: 'TODO_NOT_FOUND',
      status: 404,
    });

    // Audit for reschedule contains IDs and dates only across both ok and rejected attempts, never titles.
    await admin(async (c) => {
      const rows = await c.query<{ outcome: string; detail: Record<string, unknown> }>(
        `SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'notes.todo.reschedule'`,
        [o.orgId],
      );
      const okRows = rows.rows.filter((r) => r.outcome === 'ok');
      expect(okRows).toHaveLength(1);
      expect(okRows[0]?.detail).toEqual({ count: 2, dueOn: '2026-12-10', todoIds: [a.todoId, b.todoId] });
      expect(JSON.stringify(rows.rows)).not.toContain('Overdue Alpha');
      expect(JSON.stringify(rows.rows)).not.toContain('Overdue Beta');
    });

    // Multi-step series advancement + reopen of an older occurrence never duplicates a past or active occurrence,
    // and rescheduling into a past reminder timestamp stamps reminded_at as passed instead of leaving null.
    const day1 = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Daily Standup',
      dueOn: '2027-02-01',
      dueTime: '09:00',
      timeZone: 'Asia/Ho_Chi_Minh',
      reminder: 'auto',
      recurrence: { freq: 'daily', interval: 1 },
    });
    const c1 = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: day1.todoId });
    const day2Id = c1.nextTodoId as string;
    const c2 = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: day2Id });
    const day3Id = c2.nextTodoId as string;

    await o.exec<TodoWritten>(o.mine, 'notes.todo.reopen', { todoId: day1.todoId });
    const recompleteDay1 = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: day1.todoId });
    expect(recompleteDay1.nextTodoId ?? null).toBeNull();

    // Reschedule day3 to a past calendar date so its reminder timestamp has already passed -> reminded_at must be stamped.
    await o.exec<TodoRescheduled>(o.mine, 'notes.todo.reschedule', { todoIds: [day3Id], dueOn: '2020-01-01' });
    const rawPast = await admin((c) =>
      c.query<{ reminded_at: Date | null }>(`SELECT reminded_at FROM crove_notes.todo WHERE org_id = $1 AND id = $2`, [o.orgId, day3Id]),
    );
    expect(rawPast.rows[0]?.reminded_at).not.toBeNull();

    // Out-of-order reopen + completion: reopen A after B spawned, complete B before A -> B MUST still spawn C,
    // and then completing A afterwards must NOT spawn a duplicate of B.
    const seqA = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Out of order test',
      dueOn: '2027-04-01',
      timeZone: 'Asia/Ho_Chi_Minh',
      recurrence: { freq: 'daily', interval: 1 },
    });
    const resB = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: seqA.todoId });
    const seqBId = resB.nextTodoId as string;
    await o.exec<TodoWritten>(o.mine, 'notes.todo.reopen', { todoId: seqA.todoId });
    const resC = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: seqBId });
    expect(resC.nextTodoId).toBeTruthy();
    const seqC = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: resC.nextTodoId as string });
    expect(seqC.dueOn).toBe('2027-04-03');
    const afterRecompleteA = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: seqA.todoId });
    expect(afterRecompleteA.nextTodoId ?? null).toBeNull();

    // Default Monthly rule on Jan 30 persists day 30 across shorter February even if the root row is trashed and purged.
    const jan30 = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Monthly on 30th',
      dueOn: '2026-01-30',
      timeZone: 'Asia/Ho_Chi_Minh',
      recurrence: { freq: 'monthly', interval: 1 },
    });
    const febRes = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: jan30.todoId });
    expect(febRes.nextDueOn).toBe('2026-02-28');
    await o.exec<TodoWritten>(o.mine, 'notes.todo.delete', { todoId: jan30.todoId });
    await admin((c) => c.query(`DELETE FROM crove_notes.todo WHERE org_id = $1 AND id = $2`, [o.orgId, jan30.todoId]));
    const febTodo = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: febRes.nextTodoId as string });
    expect(febTodo.dueOn).toBe('2026-02-28');
    expect(febTodo.recurrence).toEqual({ freq: 'monthly', interval: 1, byMonthDay: 30 });
    const marRes = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: febTodo.id });
    expect(marRes.nextDueOn).toBe('2026-03-30');
    const marTodo = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: marRes.nextTodoId as string });
    expect(marTodo.dueOn).toBe('2026-03-30');

    // Moving the active occurrence backward before an earlier completed date keeps the series advancing cleanly.
    const moveRoot = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Backwards reschedule keeps series alive',
      dueOn: '2027-05-17',
      timeZone: 'Asia/Ho_Chi_Minh',
      recurrence: { freq: 'daily', interval: 1 },
    });
    const moveSecond = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: moveRoot.todoId });
    await o.exec<TodoRescheduled>(o.mine, 'notes.todo.reschedule', { todoIds: [moveSecond.nextTodoId as string], dueOn: '2027-05-16' });
    const moveThird = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: moveSecond.nextTodoId as string });
    expect(moveThird.nextTodoId).toBeTruthy();
    expect(moveThird.nextDueOn).toBe('2027-05-18');

    // Transactional undo (`undoNextTodoId`): rejects edits to the spawned row without deleting it or leaving partial state,
    // rolls back cleanly when source row was trashed, and atomically undoes untouched pairs.
    await expect(
      o.exec(o.mine, 'notes.todo.reopen', { todoId: moveSecond.nextTodoId as string, undoNextTodoId: moveThird.nextTodoId as string }),
    ).resolves.toMatchObject({ todoId: moveSecond.nextTodoId });
    const undoneThird = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: moveThird.nextTodoId as string });
    expect(undoneThird.deletedAt).not.toBeNull();

    const atomicRoot = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Atomic undo guard',
      dueOn: '2027-06-01',
      timeZone: 'Asia/Ho_Chi_Minh',
      recurrence: { freq: 'daily', interval: 1 },
    });
    const atomicNext = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: atomicRoot.todoId });
    const atomicSpawned = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: atomicNext.nextTodoId as string });
    await o.exec<TodoWritten>(o.mine, 'notes.todo.update', {
      todoId: atomicSpawned.id,
      revision: atomicSpawned.revision,
      title: 'Edited spawned title',
      details: '',
      checklist: [],
      dueOn: atomicSpawned.dueOn,
      dueTime: atomicSpawned.dueTime,
      timeZone: atomicSpawned.timeZone,
    });
    await expect(
      o.exec(o.mine, 'notes.todo.reopen', { todoId: atomicRoot.todoId, undoNextTodoId: atomicSpawned.id }),
    ).rejects.toMatchObject({ code: 'TODO_UNDO_SERIES_ADVANCED', status: 409 });
    const stillOpenSpawned = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: atomicSpawned.id });
    expect(stillOpenSpawned.deletedAt).toBeNull();
    expect(stillOpenSpawned.status).toBe('open');

    // If source row was trashed while spawned row is untouched, undo fails cleanly and rolls back soft-delete.
    const rollbackRoot = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Atomic rollback guard',
      dueOn: '2027-06-10',
      timeZone: 'Asia/Ho_Chi_Minh',
      recurrence: { freq: 'daily', interval: 1 },
    });
    const rollbackNext = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: rollbackRoot.todoId });
    await o.exec<TodoWritten>(o.mine, 'notes.todo.delete', { todoId: rollbackRoot.todoId });
    await expect(
      o.exec(o.mine, 'notes.todo.reopen', { todoId: rollbackRoot.todoId, undoNextTodoId: rollbackNext.nextTodoId as string }),
    ).rejects.toMatchObject({ code: 'TODO_IN_TRASH', status: 409 });
    const rolledBackNext = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: rollbackNext.nextTodoId as string });
    expect(rolledBackNext.deletedAt).toBeNull();

    // Adding a link onto the spawned next occurrence (even without bumping revision) blocks undoNextTodoId.
    const linkRoot = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Link edit guard',
      dueOn: '2027-06-15',
      timeZone: 'Asia/Ho_Chi_Minh',
      recurrence: { freq: 'daily', interval: 1 },
    });
    const linkNext = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: linkRoot.todoId });
    const targetTask = await admin(async (c) =>
      (await c.query<{ id: string }>(`INSERT INTO crove_kernel.task (org_id, title, source, created_by_type) VALUES ($1, 'Ref task', 'human', 'user') RETURNING id`, [o.orgId])).rows[0] as { id: string },
    );
    await o.exec(o.mine, 'notes.todo.link_add', { todoId: linkNext.nextTodoId as string, targetType: 'kernel.task', targetId: targetTask.id });
    await expect(
      o.exec(o.mine, 'notes.todo.reopen', { todoId: linkRoot.todoId, undoNextTodoId: linkNext.nextTodoId as string }),
    ).rejects.toMatchObject({ code: 'TODO_UNDO_SERIES_ADVANCED', status: 409 });

    // Undoing stopSeries with restoreRecurrence + expectedRevision checks optimistic revision and restores rule atomically.
    const stopRoot = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Stop series undo',
      dueOn: '2027-06-20',
      timeZone: 'Asia/Ho_Chi_Minh',
      recurrence: { freq: 'weekly', interval: 1 },
    });
    const stopDone = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: stopRoot.todoId, stopSeries: true });
    await o.exec<TodoWritten>(o.mine, 'notes.todo.reopen', {
      todoId: stopRoot.todoId,
      expectedRevision: stopDone.revision,
      restoreRecurrence: { freq: 'weekly', interval: 1 },
    });
    const stopRestored = await o.query<Todo>(o.mine, 'notes.todo.get', { todoId: stopRoot.todoId });
    expect(stopRestored.status).toBe('open');
    expect(stopRestored.recurrence).toEqual({ freq: 'weekly', interval: 1 });
    // Stale expectedRevision is rejected cleanly without overwriting concurrent changes.
    await expect(
      o.exec(o.mine, 'notes.todo.reopen', {
        todoId: stopRoot.todoId,
        expectedRevision: stopDone.revision,
        restoreRecurrence: { freq: 'daily', interval: 1 },
      }),
    ).rejects.toMatchObject({ code: 'TODO_REVISION_CONFLICT', status: 409 });

    // Skipping an occupied short-month date (Feb 28) on a 31st monthly series lands cleanly on Mar 31, not Mar 28.
    const jan31 = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: 'Skip Feb preserves 31st',
      dueOn: '2027-01-31',
      timeZone: 'Asia/Ho_Chi_Minh',
      recurrence: { freq: 'monthly', interval: 1 },
    });
    const febOccupied = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: jan31.todoId });
    expect(febOccupied.nextDueOn).toBe('2027-02-28');
    // Move Feb 28 back to Jan 31 after creating an extra historical 2027-02-28 done record by reopening & rescheduling.
    await o.exec<TodoRescheduled>(o.mine, 'notes.todo.reschedule', { todoIds: [febOccupied.nextTodoId as string], dueOn: '2027-01-31' });
    await o.exec<TodoWritten>(o.mine, 'notes.todo.reopen', { todoId: jan31.todoId });
    // Now mark older row as occupying 2027-02-28 and clear byMonthDay on the active Jan 31 row to verify stepRule fixes target day.
    await admin((c) => c.query(`UPDATE crove_notes.todo SET due_on = '2027-02-28' WHERE org_id = $1 AND id = $2`, [o.orgId, jan31.todoId]));
    await admin((c) =>
      c.query(`UPDATE crove_notes.todo SET recurrence = '{"freq":"monthly","interval":1}'::jsonb WHERE org_id = $1 AND id = $2`, [
        o.orgId,
        febOccupied.nextTodoId,
      ]),
    );
    const marFrom31 = await o.exec<TodoCompleteResult>(o.mine, 'notes.todo.complete', { todoId: febOccupied.nextTodoId as string });
    expect(marFrom31.nextDueOn).toBe('2027-03-31');

    // Member portability export includes recurrence and seriesId.
    const exported = await o.query<NotesExport>(o.mine, 'notes.mine.export');
    const expRow = exported.todos.find((item) => item.id === stopRoot.todoId);
    expect(expRow).toBeDefined();
    expect(expRow?.recurrence).toEqual({ freq: 'weekly', interval: 1 });
    expect(expRow?.seriesId).toBe(stopRoot.todoId);
  });
});
