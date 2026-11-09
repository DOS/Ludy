// SPDX-License-Identifier: AGPL-3.0-only
// The writes on meeting summaries and action items on PostgreSQL 17 (issue #2580, ADR-0047, meetings plan M6 part A). The read side (who sees a draft, who
// sees a published row) is in meetings-readers.db.test.ts; this file pins the write side:
// - only the recorder inserts, and only a draft; nobody inserts a published row, a task link or an accepted item;
// - an attendee changes, deletes and publishes nothing; a published row is not edited by anyone, and a published item is not deleted by hand;
// - status, task_id and accepted_by are written by crove_meetings.action_item_accept alone, which refuses every context but a user who may read the item,
//   refuses a second accept, and is granted to crove_app only.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { contextToken } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('meeting summary and action item writes on PostgreSQL (#2580, ADR-0047)', () => {
  const dbName = `crove_test_meetings_results_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgId = '';
  const users = { owner: '', recorder: '', attendee: '', member: '' };
  const meetingId = randomUUID();
  const ids = { draftItem: randomUUID(), publishedItem: randomUUID(), draftResult: randomUUID(), publishedResult: randomUUID(), task: randomUUID() };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const asUser = (who: keyof typeof users) => ({ url: () => appUrl, enter: (c: pg.Client) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users[who], orgId)]) });
  const asSystem = { url: () => workerUrl, enter: (c: pg.Client) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]) };
  type Actor = { url: () => string; enter: (c: pg.Client) => Promise<unknown> };

  // Runs sql as an actor, always rolled back; reports the error code or the rows affected.
  async function attempt(actor: Actor, text: string, params: unknown[] = []): Promise<{ code: string | null; rows: number }> {
    const c = new pg.Client({ connectionString: actor.url() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await actor.enter(c);
      try {
        const res = await c.query(text, params);
        return { code: null, rows: res.rowCount ?? 0 };
      } catch (error) {
        return { code: (error as { code?: string }).code ?? 'ERR', rows: 0 };
      }
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  // Refused by an error or by a policy that leaves no row to touch.
  const blocked = (r: { code: string | null; rows: number }) => r.code === '42501' || (r.code === null && r.rows === 0);

  const insertItem = (stage: string, status = 'suggested', taskId: string | null = null) =>
    attempt(asUser('recorder'), `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, stage, status, task_id) VALUES ($1, $2, $3, 'Việc', $4, $5, $6)`, [orgId, randomUUID(), meetingId, stage, status, taskId]);

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'meetings-results', subject: key, email: `${key}@meetings-results.test`, name: null });
    }
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Tóm tắt họp')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.attendee, users.member]);
      await c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp', 'vi', now(), now(), 60, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, meetingId, users.recorder],
      );
      await c.query(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users.attendee]);
      await c.query(
        `INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, feature, stage) VALUES ($1, $2, $4, 'Nháp', 'manual', 'draft'), ($1, $3, $4, 'Đã chia sẻ', 'manual', 'published')`,
        [orgId, ids.draftResult, ids.publishedResult, meetingId],
      );
      await c.query(
        `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, stage) VALUES ($1, $2, $4, 'Nháp', 'draft'), ($1, $3, $4, 'Đã chia sẻ', 'published')`,
        [orgId, ids.draftItem, ids.publishedItem, meetingId],
      );
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

  it('lets only the recorder insert, and only a draft that is neither accepted nor linked to a task', async () => {
    expect((await insertItem('draft')).code).toBeNull();
    expect((await insertItem('published')).code).toBe('42501');
    expect((await insertItem('draft', 'accepted')).code).toBe('42501');
    expect((await insertItem('draft', 'suggested', ids.task)).code).toBe('42501');
    for (const who of ['attendee', 'member', 'owner'] as const) {
      const res = await attempt(asUser(who), `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title) VALUES ($1, $2, $3, 'x')`, [orgId, randomUUID(), meetingId]);
      expect(res.code, `${who} inserting an item`).toBe('42501');
      const res2 = await attempt(asUser(who), `INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, feature) VALUES ($1, $2, $3, 'x', 'manual')`, [orgId, randomUUID(), meetingId]);
      expect(res2.code, `${who} inserting a result`).toBe('42501');
    }
    const sys = await attempt(asSystem, `INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, feature) VALUES ($1, $2, $3, 'x', 'manual')`, [orgId, randomUUID(), meetingId]);
    expect(sys.code, 'the system context inserting a result').toBe('42501');
    const dup = await attempt(asUser('recorder'), `INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, feature) VALUES ($1, $2, $3, 'x', 'manual')`, [orgId, randomUUID(), meetingId]);
    expect(dup.code, 'a second draft of the same meeting').toBe('23505');
  });

  it('lets an attendee, a member, an owner and the system change and delete nothing, and nobody edit a published row', async () => {
    for (const actor of [asUser('attendee'), asUser('member'), asUser('owner'), asSystem]) {
      for (const [table, id] of [['meeting_result', ids.draftResult], ['meeting_result', ids.publishedResult], ['action_item', ids.draftItem], ['action_item', ids.publishedItem]] as const) {
        const col = table === 'meeting_result' ? 'summary' : 'title';
        expect(blocked(await attempt(actor, `UPDATE crove_meetings.${table} SET ${col} = 'đổi' WHERE id = $1`, [id])), `update ${table} ${id}`).toBe(true);
        expect(blocked(await attempt(actor, `DELETE FROM crove_meetings.${table} WHERE id = $1`, [id])), `delete ${table} ${id}`).toBe(true);
      }
    }
    // The recorder edits a draft, and may not edit a published row or delete a published item.
    expect((await attempt(asUser('recorder'), `UPDATE crove_meetings.action_item SET title = 'đổi' WHERE id = $1`, [ids.draftItem])).rows).toBe(1);
    expect((await attempt(asUser('recorder'), `UPDATE crove_meetings.action_item SET title = 'đổi' WHERE id = $1`, [ids.publishedItem])).rows).toBe(0);
    expect((await attempt(asUser('recorder'), `UPDATE crove_meetings.meeting_result SET summary = 'đổi' WHERE id = $1`, [ids.publishedResult])).rows).toBe(0);
    expect((await attempt(asUser('recorder'), `DELETE FROM crove_meetings.action_item WHERE id = $1`, [ids.publishedItem])).rows).toBe(0);
    // Publishing is the draft's one change of stage; going back is refused.
    expect((await attempt(asUser('recorder'), `UPDATE crove_meetings.action_item SET stage = 'published' WHERE id = $1`, [ids.draftItem])).rows).toBe(1);
    expect((await attempt(asUser('recorder'), `UPDATE crove_meetings.action_item SET stage = 'draft' WHERE id = $1`, [ids.publishedItem])).rows).toBe(0);
  });

  it('writes status, task_id and accepted_by through action_item_accept alone', async () => {
    for (const col of ['status', 'task_id', 'accepted_by', 'accepted_at', 'meeting_id', 'org_id', 'id']) {
      const value = col === 'status' ? `'accepted'` : col === 'accepted_at' ? 'now()' : `'${randomUUID()}'::uuid`;
      const res = await attempt(asUser('recorder'), `UPDATE crove_meetings.action_item SET ${col} = ${value} WHERE id = $1`, [ids.draftItem]);
      expect(res.code, `recorder updating ${col}`).toBe('42501');
    }
    const columns = await admin((c) =>
      c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges WHERE table_schema = 'crove_meetings' AND table_name = 'action_item' AND privilege_type = 'UPDATE' AND grantee = 'crove_tenant'`,
      ),
    );
    const granted = columns.rows.map((r) => r.column_name);
    for (const forbidden of ['status', 'task_id', 'accepted_by', 'accepted_at', 'meeting_id', 'org_id', 'id', 'created_at']) expect(granted).not.toContain(forbidden);
  });

  it('accepts an item only for a user who may read it, once, and grants the function to crove_app alone', async () => {
    // A task of the org whose source is the item, as the accepting command makes it.
    const taskFor = async (item: string): Promise<string> => {
      const id = randomUUID();
      await admin((c) =>
        c.query(`INSERT INTO crove_kernel.task (org_id, id, title, source, created_by_type, source_ref) VALUES ($1, $2, 'Việc', 'human', 'user', $3::jsonb)`, [orgId, id, JSON.stringify({ type: 'meetings.action_item', id: item })]),
      );
      return id;
    };
    const accept = async (actor: Actor, item: string) => attempt(actor, `SELECT crove_meetings.action_item_accept($1::uuid, $2::uuid, $3::uuid)`, [orgId, item, await taskFor(item)]);
    // The task must be that item's own: a random id, and another item's task, are refused.
    expect((await attempt(asUser('attendee'), `SELECT crove_meetings.action_item_accept($1::uuid, $2::uuid, $3::uuid)`, [orgId, ids.publishedItem, randomUUID()])).code).toBe('42501');
    expect((await attempt(asUser('attendee'), `SELECT crove_meetings.action_item_accept($1::uuid, $2::uuid, $3::uuid)`, [orgId, ids.publishedItem, await taskFor(ids.draftItem)])).code).toBe('42501');
    // The published item: the attendee and the recorder may; a member outside the meeting, the owner and the system may not.
    expect((await accept(asUser('attendee'), ids.publishedItem)).code).toBeNull();
    for (const [name, actor] of [['member', asUser('member')], ['owner', asUser('owner')], ['system', asSystem]] as const) {
      expect((await accept(actor, ids.publishedItem)).code, `${name} accepting a published item`).toBe('42501');
    }
    // A draft item: the recorder only (an attendee does not even find it).
    expect((await accept(asUser('attendee'), ids.draftItem)).code).toBe('42501');
    expect((await accept(asUser('recorder'), ids.draftItem)).code).toBeNull();
    // Twice is refused: one task per item. (A rolled-back accept above leaves the item suggested, so mark it first.)
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await asUser('attendee').enter(c);
      const t = await taskFor(ids.publishedItem);
      await c.query(`SELECT crove_meetings.action_item_accept($1::uuid, $2::uuid, $3::uuid)`, [orgId, ids.publishedItem, t]);
      await expect(c.query(`SELECT crove_meetings.action_item_accept($1::uuid, $2::uuid, $3::uuid)`, [orgId, ids.publishedItem, t])).rejects.toMatchObject({ message: expect.stringContaining('MEETINGS_ITEM_ACCEPTED') });
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
    // A real task of ANOTHER org whose source_ref names this very item is refused too (the task must be one of the caller's org).
    const otherOrg = (await createOrg(runtime, { type: 'user', userId: users.member, aal: 'aal1' }, 'Org khác')).orgId;
    const foreignTask = randomUUID();
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.task (org_id, id, title, source, created_by_type, source_ref) VALUES ($1, $2, 'Việc', 'human', 'user', $3::jsonb)`, [otherOrg, foreignTask, JSON.stringify({ type: 'meetings.action_item', id: ids.draftItem })]),
    );
    expect((await attempt(asUser('recorder'), `SELECT crove_meetings.action_item_accept($1::uuid, $2::uuid, $3::uuid)`, [orgId, ids.draftItem, foreignTask])).code).toBe('42501');
    // Another org's id never matches.
    const wrongOrg = await attempt(asUser('recorder'), `SELECT crove_meetings.action_item_accept($1::uuid, $2::uuid, $3::uuid)`, [randomUUID(), ids.draftItem, randomUUID()]);
    expect(wrongOrg.code).toBe('42501');
    const grants = await admin((client) =>
      client.query<{ grantee: string }>(
        `SELECT grantee FROM information_schema.routine_privileges WHERE routine_schema = 'crove_meetings' AND routine_name = 'action_item_accept' AND privilege_type = 'EXECUTE'`,
      ),
    );
    expect(grants.rows.map((r) => r.grantee).filter((g) => g !== 'postgres').sort()).toEqual(['crove_app']);
  });
});
