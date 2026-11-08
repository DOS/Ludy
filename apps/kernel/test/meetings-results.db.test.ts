// SPDX-License-Identifier: AGPL-3.0-only
// The summary, the decisions and the action items of a meeting on a real database (#2580, M6 part A). Everything here runs with no AI at all (the deployment
// of the test has none): the recorder types a summary and items, one click publishes them to the meeting's readers, a person makes a team task from an item
// with the title, date and seat they picked. Drafts are the recorder's alone; a task never carries the transcript; nothing is accepted twice.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, itemFlags, itemIsClean } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the summary and the action items of a meeting (#2580)', () => {
  const dbName = `crove_test_results_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const query = <O = unknown>(who: string, name: string, input: unknown) => runtime.query<O>(name, input, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  // A meeting recorded by `recorder`, shared with `readers` (attendees), as the earlier steps leave it.
  async function seedMeeting(recorder: string, readers: string[]): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder]],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users[reader]]);
    return meetingId;
  }
  async function seedPosition(who: string, title: string): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(`INSERT INTO crove_kernel.position (org_id, id, title, module, role_key, holder_user_id) VALUES ($1, $2, $3, 'kernel', 'member', $4)`, [orgId, id, title, users[who]]);
    return id;
  }
  // A member of its own, so a test's seats do not leak into another's.
  async function newMember(key: string): Promise<void> {
    users[key] = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'results', subject: key, email: `${key}@results.test`, name: null });
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users[key]]);
  }
  type Results = { isRecorder: boolean; draft: { summary: string; decisions: string[]; tainted: boolean } | null; published: { summary: string; decisions: string[] } | null; items: Array<{ id: string; stage: string; status: string; title: string; clean: boolean; tainted: boolean; flags: string[]; taskId: string | null; positions: Array<{ id: string }> }> };
  const results = (who: string, meetingId: string) => query<Results>(who, 'meetings.result.get', { meetingId });
  const item = (meetingId: string, over: Record<string, unknown> = {}) => ({ meetingId, title: 'Gửi báo giá cho khách', who: 'An', whoUserId: users.attendee as string, when: 'thứ sáu', whenDate: '2026-11-13', transcriptSeconds: 120, ...over });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    for (const key of ['owner', 'recorder', 'attendee', 'other', 'stranger']) {
      users[key] = await upsertIdentity(createDb(pool), { issuer: 'results', subject: key, email: `${key}@results.test`, name: null });
    }
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner as string, aal: 'aal1' }, 'Results')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, [orgId, users.recorder, users.attendee, users.other, users.stranger]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('flags a link, an email or a phone number in a title, and calls an item clean only with one seat, a date, an attendee and no flag', () => {
    expect(itemFlags('Gửi báo giá cho khách')).toEqual([]);
    expect(itemFlags('Xem https://evil.example/x')).toEqual(['contact_in_title']);
    expect(itemFlags('Gọi www.evil.example')).toEqual(['contact_in_title']);
    expect(itemFlags('Mail anh@evil.example')).toEqual(['contact_in_title']);
    expect(itemFlags('Gọi 0912 345 678 ngay')).toEqual(['contact_in_title']);
    expect(itemFlags('Gửi 3 bản cho 12 khách')).toEqual([]);
    const base = { flags: [] as string[], whoUserId: 'u', whenDate: '2026-11-13' };
    expect(itemIsClean(base, 1)).toBe(true);
    expect(itemIsClean(base, 0)).toBe(false);
    expect(itemIsClean(base, 2)).toBe(false);
    expect(itemIsClean({ ...base, flags: ['contact_in_title'] }, 1)).toBe(false);
    expect(itemIsClean({ ...base, whoUserId: null }, 1)).toBe(false);
    expect(itemIsClean({ ...base, whenDate: null }, 1)).toBe(false);
  });

  it('keeps drafts to the recorder and shows the attendees only what the one click published', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee']);
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: 'Chốt báo giá tuần này.', decisions: ['Giữ giá cũ', 'Gặp khách thứ sáu'] });
    const created = await exec<{ itemId: string }>('recorder', 'meetings.action_item.create', item(meetingId));
    expect((await results('recorder', meetingId)).draft?.summary).toBe('Chốt báo giá tuần này.');
    // An attendee, the owner and another member read nothing of a draft; the attendee reads the meeting and finds no result.
    expect(await results('attendee', meetingId)).toMatchObject({ isRecorder: false, draft: null, published: null, items: [] });
    expect(await refuses(results('owner', meetingId))).toBe('MEETING_NOT_FOUND');
    expect(await refuses(results('other', meetingId))).toBe('MEETING_NOT_FOUND');
    // Not a recorder: nothing to save, add, or publish.
    expect(await refuses(exec('attendee', 'meetings.summary.save', { meetingId, summary: 'x', decisions: [] }))).toBe('FORBIDDEN');
    expect(await refuses(exec('attendee', 'meetings.action_item.create', item(meetingId)))).toBe('FORBIDDEN');
    expect(await refuses(exec('attendee', 'meetings.result.publish', { meetingId, confirmed: true }))).toBe('FORBIDDEN');
    expect(await refuses(exec('attendee', 'meetings.action_item.edit', { itemId: created.itemId, title: 'Khác' }))).toBe('ACTION_ITEM_NOT_FOUND');
    expect(await refuses(exec('attendee', 'meetings.action_item.delete', { itemId: created.itemId }))).toBe('ACTION_ITEM_NOT_FOUND');
    // The click is the person's own: not defaulted, not false.
    expect(await refuses(exec('recorder', 'meetings.result.publish', { meetingId }))).not.toBeNull();
    expect(await refuses(exec('recorder', 'meetings.result.publish', { meetingId, confirmed: false }))).not.toBeNull();
    expect(await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true })).toEqual({ meetingId, results: 1, items: 1 });
    const seen = await results('attendee', meetingId);
    expect(seen).toMatchObject({ isRecorder: false, draft: null, published: { summary: 'Chốt báo giá tuần này.', decisions: ['Giữ giá cũ', 'Gặp khách thứ sáu'] } });
    expect(seen.items.map((i) => [i.title, i.stage, i.status])).toEqual([['Gửi báo giá cho khách', 'published', 'suggested']]);
    // Still nobody outside the meeting; a second publish with nothing left to share is refused.
    expect(await refuses(results('other', meetingId))).toBe('MEETING_NOT_FOUND');
    expect(await refuses(exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true }))).toBe('NOTHING_TO_PUBLISH');
    // A published item is not edited or deleted by hand: a task may rest on it.
    expect(await refuses(exec('recorder', 'meetings.action_item.edit', { itemId: created.itemId, title: 'Khác' }))).toBe('ACTION_ITEM_NOT_FOUND');
  });

  it('edits and deletes a draft item as the recorder, clears the taint of an edit and flags a title that carries a way to reach someone', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee']);
    const { itemId } = await exec<{ itemId: string }>('recorder', 'meetings.action_item.create', item(meetingId, { whoUserId: null, whenDate: null }));
    // Pretend the model wrote it (part B copies it tainted): the recorder's own edit makes it theirs.
    await sqlAdmin(`UPDATE crove_meetings.action_item SET tainted = true WHERE org_id = $1 AND id = $2`, [orgId, itemId]);
    expect((await results('recorder', meetingId)).items[0]).toMatchObject({ tainted: true, clean: false });
    await exec('recorder', 'meetings.action_item.edit', { itemId, title: 'Gọi 0912 345 678', whoUserId: users.attendee, whenDate: '2026-11-14' });
    expect((await results('recorder', meetingId)).items[0]).toMatchObject({ title: 'Gọi 0912 345 678', tainted: false, flags: ['contact_in_title'], clean: false });
    await exec('recorder', 'meetings.action_item.edit', { itemId, title: 'Gọi khách' });
    expect((await results('recorder', meetingId)).items[0]?.flags).toEqual([]);
    // An item names only the recorder or an attendee.
    expect(await refuses(exec('recorder', 'meetings.action_item.edit', { itemId, whoUserId: users.other }))).toBe('INVALID_READER');
    expect(await refuses(exec('recorder', 'meetings.action_item.create', item(meetingId, { whoUserId: users.stranger })))).toBe('INVALID_READER');
    expect(await exec('recorder', 'meetings.action_item.delete', { itemId })).toEqual({ itemId, deleted: true });
    expect((await results('recorder', meetingId)).items).toEqual([]);
  });

  it('makes a team task from an item with what the person confirmed, and never twice', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee']);
    const seat = await seedPosition('attendee', 'Bán hàng');
    const { itemId } = await exec<{ itemId: string }>('recorder', 'meetings.action_item.create', item(meetingId));
    // A reader cannot accept a draft; once it is published, they can.
    expect(await refuses(exec('attendee', 'meetings.action_item.accept', { itemId, confirmed: true, title: 'x', due: null, positionId: seat }))).toBe('ACTION_ITEM_NOT_FOUND');
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
    expect(await refuses(exec('attendee', 'meetings.action_item.accept', { itemId, title: 'x', due: null, positionId: seat }))).not.toBeNull();
    expect(await refuses(exec('other', 'meetings.action_item.accept', { itemId, confirmed: true, title: 'x', due: null, positionId: seat }))).toBe('ACTION_ITEM_NOT_FOUND');
    const accepted = await exec<{ taskId: string }>('attendee', 'meetings.action_item.accept', { itemId, confirmed: true, title: 'Gửi báo giá cho khách A', due: '2026-11-13', positionId: seat });
    const task = await sqlAdmin<{ title: string; description: string | null; assignee_position_id: string; source_ref: { type: string; id: string }; tainted: boolean; due: Date | null }>(
      `SELECT title, description, assignee_position_id, source_ref, tainted, due FROM crove_kernel.task WHERE org_id = $1 AND id = $2`,
      [orgId, accepted.taskId],
    );
    expect(task.rows[0]).toMatchObject({ title: 'Gửi báo giá cho khách A', description: null, assignee_position_id: seat, source_ref: { type: 'meetings.action_item', id: itemId } });
    expect(task.rows[0]?.due?.toISOString()).toBe('2026-11-12T17:00:00.000Z');
    expect(await refuses(exec('attendee', 'meetings.action_item.accept', { itemId, confirmed: true, title: 'x', due: null, positionId: seat }))).toBe('ACTION_ITEM_ACCEPTED');
    const after = (await results('attendee', meetingId)).items[0];
    expect(after).toMatchObject({ status: 'accepted', taskId: accepted.taskId });
    // No task text holds anything of the transcript: only what the person confirmed. Exactly one task came of the item.
    const tasks = await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.task WHERE org_id = $1 AND source_ref ->> 'id' = $2`, [orgId, itemId]);
    expect(tasks.rows[0]?.n).toBe('1');
  });

  it('keeps the model\'s taint on a task while its title is unedited, and the recorder accepts a draft', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee']);
    const seat = await seedPosition('recorder', 'Quản lý');
    const { itemId } = await exec<{ itemId: string }>('recorder', 'meetings.action_item.create', item(meetingId, { whoUserId: users.recorder }));
    await sqlAdmin(`UPDATE crove_meetings.action_item SET tainted = true WHERE org_id = $1 AND id = $2`, [orgId, itemId]);
    const kept = await exec<{ taskId: string }>('recorder', 'meetings.action_item.accept', { itemId, confirmed: true, title: 'Gửi báo giá cho khách', due: null, positionId: seat });
    const row = await sqlAdmin<{ tainted: boolean }>(`SELECT tainted FROM crove_kernel.task WHERE org_id = $1 AND id = $2`, [orgId, kept.taskId]);
    expect(row.rows[0]?.tainted).toBe(true);
    const { itemId: second } = await exec<{ itemId: string }>('recorder', 'meetings.action_item.create', item(meetingId, { whoUserId: users.recorder }));
    await sqlAdmin(`UPDATE crove_meetings.action_item SET tainted = true WHERE org_id = $1 AND id = $2`, [orgId, second]);
    const changed = await exec<{ taskId: string }>('recorder', 'meetings.action_item.accept', { itemId: second, confirmed: true, title: 'Gửi báo giá, bản sửa', due: null, positionId: seat });
    const row2 = await sqlAdmin<{ tainted: boolean }>(`SELECT tainted FROM crove_kernel.task WHERE org_id = $1 AND id = $2`, [orgId, changed.taskId]);
    expect(row2.rows[0]?.tainted).toBe(false);
  });

  it('accepts every clean item at once and none that needs a person: no seat, several seats, a flag, no date', async () => {
    for (const key of ['rec2', 'one', 'two', 'none']) await newMember(key);
    const meetingId = await seedMeeting('rec2', ['one', 'two', 'none']);
    await seedPosition('one', 'Bán hàng');
    await seedPosition('two', 'Kho');
    await seedPosition('two', 'Giao hàng');
    const clean = await exec<{ itemId: string }>('rec2', 'meetings.action_item.create', item(meetingId, { title: 'Gửi báo giá', whoUserId: users.one }));
    await exec('rec2', 'meetings.action_item.create', item(meetingId, { title: 'Đặt lịch', whoUserId: users.two }));
    await exec('rec2', 'meetings.action_item.create', item(meetingId, { title: 'Gọi 0912 345 678', whoUserId: users.one }));
    await exec('rec2', 'meetings.action_item.create', item(meetingId, { title: 'Chưa có hạn', whenDate: null, whoUserId: users.one }));
    await exec('rec2', 'meetings.action_item.create', item(meetingId, { title: 'Chưa có người', whoUserId: null }));
    await exec('rec2', 'meetings.action_item.create', item(meetingId, { title: 'Người dự không có vị trí', whoUserId: users.none }));
    const view = await results('rec2', meetingId);
    expect(view.items.filter((i) => i.clean).map((i) => i.title)).toEqual(['Gửi báo giá']);
    expect(await refuses(exec('rec2', 'meetings.action_item.accept_clean', { meetingId }))).not.toBeNull();
    const done = await exec<{ accepted: number; taskIds: string[] }>('rec2', 'meetings.action_item.accept_clean', { meetingId, confirmed: true });
    expect(done.accepted).toBe(1);
    expect((await results('rec2', meetingId)).items.find((i) => i.id === clean.itemId)).toMatchObject({ status: 'accepted', taskId: done.taskIds[0] });
    expect(await refuses(exec('rec2', 'meetings.action_item.accept_clean', { meetingId, confirmed: true }))).toBe('NO_CLEAN_ITEMS');
  });

  it('tells a task where it came from only to a person who may read the meeting', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee']);
    const { itemId } = await exec<{ itemId: string }>('recorder', 'meetings.action_item.create', item(meetingId));
    expect(await query('recorder', 'meetings.action_item.source', { itemId })).toEqual({ meetingId });
    // A draft is the recorder's; once published, the readers' (and nobody else's: the screen words it "Bản ghi không mở được").
    expect(await refuses(query('attendee', 'meetings.action_item.source', { itemId }))).toBe('MEETING_NOT_FOUND');
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
    expect(await query('attendee', 'meetings.action_item.source', { itemId })).toEqual({ meetingId });
    expect(await refuses(query('other', 'meetings.action_item.source', { itemId }))).toBe('MEETING_NOT_FOUND');
    expect(await refuses(query('owner', 'meetings.action_item.source', { itemId }))).toBe('MEETING_NOT_FOUND');
  });

  it('goes with its meeting', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee']);
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: 'Tóm tắt', decisions: [] });
    await exec('recorder', 'meetings.action_item.create', item(meetingId));
    await exec('recorder', 'meetings.meeting.delete', { meetingId });
    const left = await sqlAdmin<{ results: string; items: string }>(
      `SELECT (SELECT count(*) FROM crove_meetings.meeting_result WHERE meeting_id = $1)::text AS results, (SELECT count(*) FROM crove_meetings.action_item WHERE meeting_id = $1)::text AS items`,
      [meetingId],
    );
    expect(left.rows[0]).toEqual({ results: '0', items: '0' });
  });
});
