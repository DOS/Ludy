// SPDX-License-Identifier: AGPL-3.0-only
// The chapters (table of contents) of a meeting on a real database (#3844): the recorder types them, each start second must be the start of a real transcript line, and they are theirs alone to read
// until they publish them with the minutes, enforced by the table's own row policy and not only by the queries; then the readers of the meeting read the published set. A published set is replaced by
// the next publish, a tainted draft cannot be published, and the chapters go with the meeting and as a draft after 30 days.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Chapters, PersonalDataErasure, PersonalDataResult } from '@crove/kernel-contract';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the chapters of a meeting (#3844)', () => {
  const dbName = `crove_test_chapters_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
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
  // Runs fn as the app's login role in a member's user context (the table's row policy decides, not the commands), rolled back.
  async function asMember<T>(who: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users[who] as string, orgId)]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const rowsOf = (meetingId: string, stage?: string) =>
    sqlAdmin<{ position: number; title: string; start_seconds: number; stage: string; tainted: boolean }>(
      `SELECT position, title, start_seconds, stage, tainted FROM crove_meetings.meeting_chapter WHERE org_id = $1 AND meeting_id = $2 AND ($3::text IS NULL OR stage = $3) ORDER BY stage, position`,
      [orgId, meetingId, stage ?? null],
    ).then((r) => r.rows);

  // Lines start at 0, 10, 20 and 300 seconds.
  async function seedMeeting(recorder: string, readers: string[] = ['reader']): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T04:00:00Z', 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder]],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users[reader]]);
    await exec(recorder, 'meetings.transcript.draft_store', {
      meetingId,
      segments: [
        { startSeconds: 0, endSeconds: 10, speakerLabel: 'Hà', text: 'Chào mọi người' },
        { startSeconds: 10, endSeconds: 20, speakerLabel: 'Hà', text: 'Bàn về báo giá' },
        { startSeconds: 20, endSeconds: 30, speakerLabel: 'Nam', text: 'Chiết khấu tháng này' },
        { startSeconds: 300, endSeconds: 310, speakerLabel: 'Nam', text: 'Kế hoạch giao hàng' },
      ],
    });
    return meetingId;
  }
  const save = (who: string, meetingId: string, chapters: Array<{ title: string; startSeconds: number }>) => exec<{ meetingId: string; chapters: number }>(who, 'meetings.chapters.save', { meetingId, chapters });
  const get = (who: string, meetingId: string) => query<Chapters>(who, 'meetings.chapters.get', { meetingId });
  const titles = (list: Array<{ title: string }>) => list.map((c) => c.title);

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
    appUrl = url.toString();
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    for (const key of ['owner', 'recorder', 'reader', 'stranger']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'chapters', subject: key, email: `${key}@chapters.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Mục lục')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.reader, users.stranger]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('saves the draft in the order of the seconds, replaces it whole and clears it, for the recorder alone', async () => {
    const meetingId = await seedMeeting('recorder');
    expect(await get('recorder', meetingId)).toEqual({ meetingId, draft: [], published: [] });
    expect(await save('recorder', meetingId, [{ title: '  Kế hoạch giao hàng ', startSeconds: 300 }, { title: 'Mở đầu', startSeconds: 0 }, { title: 'Báo giá', startSeconds: 10 }])).toEqual({ meetingId, chapters: 3 });
    const first = await get('recorder', meetingId);
    expect(titles(first.draft)).toEqual(['Mở đầu', 'Báo giá', 'Kế hoạch giao hàng']);
    expect(first.draft.map((c) => [c.position, c.startSeconds, c.tainted])).toEqual([[1, 0, false], [2, 10, false], [3, 300, false]]);
    expect(first.published).toEqual([]);
    // A second save replaces the set.
    await save('recorder', meetingId, [{ title: 'Chiết khấu', startSeconds: 20 }]);
    expect(titles((await get('recorder', meetingId)).draft)).toEqual(['Chiết khấu']);
    expect(await rowsOf(meetingId)).toHaveLength(1);
    // An empty list clears the draft.
    expect(await save('recorder', meetingId, [])).toEqual({ meetingId, chapters: 0 });
    expect(await rowsOf(meetingId)).toEqual([]);
    // Nobody else saves: a reader of the meeting is refused, an owner or a member who is no reader does not even find the meeting.
    expect(await refuses(save('reader', meetingId, [{ title: 'Mở đầu', startSeconds: 0 }]))).toBe('FORBIDDEN');
    for (const who of ['owner', 'stranger']) expect(await refuses(save(who, meetingId, [{ title: 'Mở đầu', startSeconds: 0 }])), who).toBe('MEETING_NOT_FOUND');
  });

  it('refuses a second that no line starts at, a repeated second, a bad title and more than 20 chapters, and changes nothing', async () => {
    const meetingId = await seedMeeting('recorder');
    await save('recorder', meetingId, [{ title: 'Mở đầu', startSeconds: 0 }]);
    const before = await rowsOf(meetingId);
    expect(await refuses(save('recorder', meetingId, [{ title: 'Ở giữa dòng', startSeconds: 5 }]))).toBe('CHAPTER_NOT_ANCHORED');
    expect(await refuses(save('recorder', meetingId, [{ title: 'Quá xa', startSeconds: 86_000 }]))).toBe('CHAPTER_NOT_ANCHORED');
    expect(await refuses(save('recorder', meetingId, [{ title: 'Một', startSeconds: 10 }, { title: 'Hai', startSeconds: 10 }]))).toBe('CHAPTER_DUPLICATE_SECOND');
    expect(await refuses(save('recorder', meetingId, [{ title: '   ', startSeconds: 0 }]))).toBe('CHAPTER_TITLE_EMPTY');
    expect(await refuses(save('recorder', meetingId, [{ title: 'a'.repeat(81), startSeconds: 0 }]))).toBe('CHAPTER_TITLE_TOO_LONG');
    expect(await refuses(save('recorder', meetingId, [{ title: 'dòng một\ndòng hai', startSeconds: 0 }]))).toBe('CHAPTER_TITLE_MULTILINE');
    for (const title of ['Gửi cho an@x.example', 'Gọi 0901 234 567', 'Số 090-123-45.67', 'Mã 1234567890', 'liên hệ (+84) 901 234 567']) {
      expect(await refuses(save('recorder', meetingId, [{ title, startSeconds: 0 }])), title).toBe('CHAPTER_TITLE_CONTACT');
    }
    // Shorter runs of digits are fine (a date, an amount, a quarter).
    expect(await save('recorder', meetingId, [{ title: 'Quý 4 năm 2026, 1.250.000 đồng', startSeconds: 0 }])).toMatchObject({ chapters: 1 });
    expect(await refuses(save('recorder', meetingId, Array.from({ length: 21 }, (_, i) => ({ title: `Mục ${i}`, startSeconds: i })) as never))).toBe('VALIDATION');
    expect(await rowsOf(meetingId)).toHaveLength(1);
    expect(before).toHaveLength(1);
  });

  it('shows the draft to the recorder alone, by the table\'s own policy and by the queries, and the published set to the readers of the meeting', async () => {
    const meetingId = await seedMeeting('recorder');
    await save('recorder', meetingId, [{ title: 'Mở đầu', startSeconds: 0 }, { title: 'Báo giá', startSeconds: 10 }]);
    // The queries: a reader sees nothing before the publish, a stranger (no reader of the meeting) is refused as for any meeting.
    expect(await get('reader', meetingId)).toEqual({ meetingId, draft: [], published: [] });
    expect(await refuses(get('stranger', meetingId))).not.toBeNull();
    // The row policy itself, below the queries: raw SQL as each member counts the rows it can read, and cannot write.
    const count = (c: pg.Client) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_meetings.meeting_chapter WHERE meeting_id = $1`, [meetingId]).then((r) => Number(r.rows[0]?.n));
    expect(await asMember('recorder', count)).toBe(2);
    for (const who of ['owner', 'reader', 'stranger']) expect(await asMember(who, count), `${who} reads no draft row`).toBe(0);
    for (const who of ['owner', 'reader', 'stranger']) {
      await expect(
        asMember(who, (c) => c.query(`INSERT INTO crove_meetings.meeting_chapter (org_id, meeting_id, position, title, start_seconds) VALUES ($1, $2, 3, 'Lén', 20)`, [orgId, meetingId])),
        `${who} cannot insert`,
      ).rejects.toMatchObject({ code: '42501' });
    }
    // Publish (with no summary: the chapters alone are something to share).
    expect(await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true })).toEqual({ meetingId, results: 0, items: 0, chapters: 2 });
    const asReader = await get('reader', meetingId);
    expect(titles(asReader.published)).toEqual(['Mở đầu', 'Báo giá']);
    expect(asReader.draft).toEqual([]);
    expect(await asMember('reader', count)).toBe(2);
    expect(await asMember('stranger', count)).toBe(0);
    const asRecorder = await get('recorder', meetingId);
    expect(titles(asRecorder.published)).toEqual(['Mở đầu', 'Báo giá']);
    expect(asRecorder.draft).toEqual([]);
    // A published row is not edited or deleted by a reader, nor edited by the recorder in place.
    await expect(asMember('reader', (c) => c.query(`DELETE FROM crove_meetings.meeting_chapter WHERE meeting_id = $1`, [meetingId]).then((r) => r.rowCount))).resolves.toBe(0);
    await expect(asMember('recorder', (c) => c.query(`UPDATE crove_meetings.meeting_chapter SET title = 'Sửa tại chỗ' WHERE meeting_id = $1 AND stage = 'published'`, [meetingId]).then((r) => r.rowCount))).resolves.toBe(0);
    // Nothing is left to publish.
    expect(await refuses(exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true }))).toBe('NOTHING_TO_PUBLISH');
  });

  it('replaces the published set at the next publish, and keeps it while a new draft waits', async () => {
    const meetingId = await seedMeeting('recorder');
    await save('recorder', meetingId, [{ title: 'Bản một', startSeconds: 0 }]);
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
    await save('recorder', meetingId, [{ title: 'Bản hai A', startSeconds: 0 }, { title: 'Bản hai B', startSeconds: 20 }]);
    // While the new draft waits, readers still read the first set.
    expect(titles((await get('reader', meetingId)).published)).toEqual(['Bản một']);
    expect(titles((await get('recorder', meetingId)).draft)).toEqual(['Bản hai A', 'Bản hai B']);
    expect(await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true })).toMatchObject({ chapters: 2 });
    expect(titles((await get('reader', meetingId)).published)).toEqual(['Bản hai A', 'Bản hai B']);
    expect(await rowsOf(meetingId)).toHaveLength(2);
  });

  it('refuses to publish a tainted draft chapter and keeps the run of a row fixed, in the database itself', async () => {
    const meetingId = await seedMeeting('recorder');
    const run = randomUUID();
    // A row that comes from a run must be born tainted (the database refuses it otherwise), and a published row never tainted.
    await expect(
      sqlAdmin(`INSERT INTO crove_meetings.meeting_chapter (org_id, meeting_id, position, title, start_seconds, tainted, source_run_id) VALUES ($1, $2, 1, 'Từ run', 0, false, $3)`, [orgId, meetingId, run]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sqlAdmin(`INSERT INTO crove_meetings.meeting_chapter (org_id, meeting_id, stage, position, title, start_seconds, tainted) VALUES ($1, $2, 'published', 1, 'Đã công bố', 0, true)`, [orgId, meetingId]),
    ).rejects.toMatchObject({ code: '42501' });
    await sqlAdmin(`INSERT INTO crove_meetings.meeting_chapter (org_id, meeting_id, position, title, start_seconds, tainted, source_run_id) VALUES ($1, $2, 1, 'Từ run', 0, true, $3)`, [orgId, meetingId, run]);
    // The recorder's publish refuses while it is unread, by the command and by the trigger.
    expect(await refuses(exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true }))).toBe('DRAFT_NOT_REVIEWED');
    await expect(sqlAdmin(`UPDATE crove_meetings.meeting_chapter SET stage = 'published' WHERE meeting_id = $1`, [meetingId])).rejects.toMatchObject({ code: '42501' });
    // The run never changes, and the taint is never set again nor cleared by anyone but the review.
    await expect(sqlAdmin(`UPDATE crove_meetings.meeting_chapter SET source_run_id = $2 WHERE meeting_id = $1`, [meetingId, randomUUID()])).rejects.toMatchObject({ code: '42501' });
    // The taint is not a column the app's role may write (only the recorder's review, a definer, clears it).
    await expect(asMember('recorder', (c) => c.query(`UPDATE crove_meetings.meeting_chapter SET tainted = false WHERE meeting_id = $1`, [meetingId]))).rejects.toMatchObject({ code: '42501' });
    expect((await rowsOf(meetingId, 'draft'))[0]).toMatchObject({ tainted: true });
    // The recorder sees the flag in their own draft.
    expect((await get('recorder', meetingId)).draft[0]).toMatchObject({ tainted: true });
  });

  it('goes with the meeting, is refused after the text date, and a draft expires after 30 days while a published set stays', async () => {
    // The meeting's delete takes the chapters with it, the published ones too.
    const gone = await seedMeeting('recorder');
    await save('recorder', gone, [{ title: 'Mở đầu', startSeconds: 0 }]);
    await exec('recorder', 'meetings.result.publish', { meetingId: gone, confirmed: true });
    await save('recorder', gone, [{ title: 'Bản mới', startSeconds: 10 }]);
    await sqlAdmin(`DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, gone]);
    expect(await rowsOf(gone)).toEqual([]);
    // Past its text date a meeting is not found for anyone.
    const late = await seedMeeting('recorder');
    await save('recorder', late, [{ title: 'Mở đầu', startSeconds: 0 }]);
    await sqlAdmin(`UPDATE crove_meetings.meeting SET text_retention_date = (timezone('Asia/Ho_Chi_Minh', now()))::date WHERE id = $1`, [late]);
    expect(await refuses(get('recorder', late))).not.toBeNull();
    expect(await refuses(save('recorder', late, [{ title: 'Mở đầu', startSeconds: 0 }]))).not.toBeNull();
    // The 30 day draft expiry: only the old draft goes; the published set of the same meeting stays.
    const old = await seedMeeting('recorder');
    await save('recorder', old, [{ title: 'Đã công bố', startSeconds: 0 }]);
    await exec('recorder', 'meetings.result.publish', { meetingId: old, confirmed: true });
    await save('recorder', old, [{ title: 'Nháp cũ', startSeconds: 10 }]);
    await sqlAdmin(`UPDATE crove_meetings.meeting_chapter SET created_at = now() - interval '31 days' WHERE meeting_id = $1`, [old]);
    const fresh = await seedMeeting('recorder');
    await save('recorder', fresh, [{ title: 'Nháp mới', startSeconds: 0 }]);
    const w = new pg.Client({ connectionString: workerUrl });
    await w.connect();
    try {
      const due = (await w.query<{ org_id: string; meeting_id: string }>(`SELECT org_id, meeting_id FROM crove_meetings.meeting_drafts_due(1000)`)).rows.map((r) => r.meeting_id);
      expect(due).toContain(old);
      expect(due).not.toContain(fresh);
    } finally {
      await w.end();
    }
    const system = new pg.Client({ connectionString: workerUrl });
    await system.connect();
    try {
      await system.query('BEGIN');
      await system.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
      const purged = (await system.query<{ n: number }>(`SELECT crove_meetings.meeting_draft_purge($1, $2) AS n`, [orgId, old])).rows[0]?.n;
      expect(purged).toBe(1);
      const kept = (await system.query<{ n: number }>(`SELECT crove_meetings.meeting_draft_purge($1, $2) AS n`, [orgId, fresh])).rows[0]?.n;
      expect(kept).toBe(0);
      await system.query('COMMIT');
    } finally {
      await system.end();
    }
    expect((await rowsOf(old)).map((r) => [r.stage, r.title])).toEqual([['published', 'Đã công bố']]);
    expect((await rowsOf(fresh)).map((r) => r.title)).toEqual(['Nháp mới']);
  });
  // A title may name a person: the finder and the erasure reach it as they reach the title of a meeting, whatever the command lets in (the rows below are written past the command, as a rule
  // that changed later or an import would).
  it('finds a value in a chapter title where the owner reads it, counts it per recorder where they cannot, and an erasure redacts the readable one only', async () => {
    const email = 'chuong.rieng@congty.example';
    const chapter = (meetingId: string, stage: 'draft' | 'published', title: string) =>
      sqlAdmin(`INSERT INTO crove_meetings.meeting_chapter (org_id, meeting_id, stage, position, title, start_seconds) VALUES ($1, $2, $3, 1, $4, 0)`, [orgId, meetingId, stage, title]);
    // Readable by the owner: a meeting shared with the org, with a published chapter.
    const shared = await seedMeeting('recorder', ['reader']);
    await sqlAdmin(`UPDATE crove_meetings.meeting SET visibility = 'org' WHERE org_id = $1 AND id = $2`, [orgId, shared]);
    await chapter(shared, 'published', `Gửi hợp đồng cho ${email}`);
    // Not readable by the owner: an attendees-only meeting, with a draft chapter.
    const hidden = await seedMeeting('recorder', ['reader']);
    await chapter(hidden, 'draft', `Việc riêng ${email}`);
    const find = (who = 'owner') => runtime.execute<PersonalDataResult>('kernel.personal_data.find', { value: email }, { actor: asUser(who), orgId, idempotencyKey: randomUUID() });
    const found = await find();
    expect(found.matches.filter((m) => m.column.startsWith('crove_meetings.')).map((m) => m.column)).toEqual(['crove_meetings.meeting_chapter.title']);
    // The hidden one is counted for its recorder, as a title of a meeting that holds the value; never its text or meeting.
    expect(found.meetingText).toEqual([{ recorderUserId: users.recorder, meetings: 1, lines: 0, results: 0, items: 0, titles: 1 }]);
    expect(JSON.stringify(found)).not.toContain('Việc riêng');
    // The notice path reaches it too: a meeting whose only mention is in a chapter the owner cannot read is listed for a notice, and an edit of that chapter moves the stamp the notice names.
    const notice = (c: pg.Client) => c.query<{ meeting_id: string; stamp: string }>(`SELECT meeting_id, stamp::text AS stamp FROM crove_meetings.personal_notice_items('email', $1)`, [email]).then((r) => r.rows);
    const before = await asMember('owner', notice);
    expect(before.map((r) => r.meeting_id)).toEqual([hidden]);
    await sqlAdmin(`UPDATE crove_meetings.meeting_chapter SET title = $2 WHERE meeting_id = $1`, [hidden, `Việc riêng đã sửa ${email}`]);
    const after = await asMember('owner', notice);
    expect(after.map((r) => r.meeting_id)).toEqual([hidden]);
    expect(after[0]?.stamp).not.toBe(before[0]?.stamp);
    await sqlAdmin(`UPDATE crove_meetings.meeting_chapter SET title = $2 WHERE meeting_id = $1`, [hidden, `Việc riêng ${email}`]);
    const mfa = { type: 'user' as const, userId: users.owner as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const erased = await runtime.execute<PersonalDataErasure>('kernel.personal_data.erase', { value: email }, { actor: mfa, orgId, idempotencyKey: randomUUID() });
    expect(JSON.stringify(erased)).not.toContain('Việc riêng');
    expect((await rowsOf(shared)).map((r) => r.title)).toEqual(['Gửi hợp đồng cho [đã xóa]']);
    // The draft of the meeting the owner cannot read stays as written, and is counted as what is kept.
    expect((await rowsOf(hidden)).map((r) => r.title)).toEqual([`Việc riêng ${email}`]);
    expect(erased.kept.find((k) => k.column === 'crove_meetings.text')).toMatchObject({ rows: 1 });
    expect((await find()).meetingText).toEqual([{ recorderUserId: users.recorder, meetings: 1, lines: 0, results: 0, items: 0, titles: 1 }]);
  });

  // The row policy of the table by itself (#3883), below every command: who reads and writes the chapters with raw SQL, for the contexts the file did not try before. The recorder reads and writes the
  // draft, a reader of the meeting reads the published rows, and nobody else reads or writes anything: an admin who is no reader, every agent context (an MCP company or member grant, a Vy of a
  // member, the same shape with no run), the worker's system context and the sealed company context. The catalog matrix (rls-matrix) and the company-context file say the same for the whole schema;
  // this pins it for this table, in its own file.
  it('lets only the recorder write and only the recorder and the readers read, whatever the context: an admin, an agent, the system, a sealed company grant (#3883)', async () => {
    const meetingId = await seedMeeting('recorder');
    await save('recorder', meetingId, [{ title: 'Mở đầu', startSeconds: 0 }, { title: 'Báo giá', startSeconds: 10 }]);
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
    await save('recorder', meetingId, [{ title: 'Bản nháp mới', startSeconds: 20 }]);
    expect((await rowsOf(meetingId)).map((r) => `${r.stage}:${r.title}`).sort()).toEqual(['draft:Bản nháp mới', 'published:Báo giá', 'published:Mở đầu']);

    // An admin of the org who neither recorded nor reads this meeting: a user context, but no role of the table's policies.
    users.admin = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'chapters', subject: 'admin', email: 'admin@chapters.test', name: null });
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, users.admin]);

    // What each context may do to this meeting's rows with raw SQL, as the app's tenant login (rolled back). The read runs outside a savepoint on purpose: a login that could not read the table at all
    // would abort the transaction and fail the test loudly, never count as "reads nothing". The agent contexts' inserts are refused by the write guard trigger (agent_write_guard) before the policy is met;
    // their reads, updates and deletes are decided by the policies, and so are every user context's and the system context's.
    type Probe = { read: number; insert: 'refused' | 'allowed'; update: number; delete: number };
    const probe = async (c: pg.Client): Promise<Probe> => {
      const read = Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_meetings.meeting_chapter WHERE meeting_id = $1`, [meetingId])).rows[0]?.n);
      const attempt = async <T,>(sql: string, params: unknown[], done: (r: pg.QueryResult) => T, none: T): Promise<T> => {
        await c.query('SAVEPOINT p');
        try {
          const r = await c.query(sql, params);
          await c.query('RELEASE SAVEPOINT p');
          return done(r);
        } catch (error) {
          await c.query('ROLLBACK TO SAVEPOINT p');
          if ((error as { code?: string }).code === '42501') return none;
          throw error;
        }
      };
      const insert = await attempt(
        `INSERT INTO crove_meetings.meeting_chapter (org_id, meeting_id, position, title, start_seconds) VALUES ($1, $2, 5, 'Lén', 100)`,
        [orgId, meetingId],
        () => 'allowed' as const,
        'refused' as const,
      );
      const update = await attempt(`UPDATE crove_meetings.meeting_chapter SET title = 'Sửa lén' WHERE meeting_id = $1`, [meetingId], (r) => r.rowCount ?? 0, 0);
      const del = await attempt(`DELETE FROM crove_meetings.meeting_chapter WHERE meeting_id = $1`, [meetingId], (r) => r.rowCount ?? 0, 0);
      return { read, insert, update, delete: del };
    };
    const NOTHING: Probe = { read: 0, insert: 'refused', update: 0, delete: 0 };
    // A positive control for the contexts below: each one sees this org and says who the actor is, so its zeros come from the policy and not from a context that was never entered.
    const whoAmI = async (c: pg.Client) => (await c.query<{ org: string; actor: string }>(`SELECT crove_kernel.ctx_org_id()::text AS org, crove_kernel.ctx_actor_type() AS actor`)).rows[0];

    // User contexts: the admin and the stranger read and write nothing; the reader reads the published rows and writes nothing.
    expect(await asMember('admin', probe)).toEqual(NOTHING);
    expect(await asMember('stranger', probe)).toEqual(NOTHING);
    expect(await asMember('reader', probe)).toEqual({ ...NOTHING, read: 2 });
    // The recorder reads all three rows and writes the draft: the insert is allowed, and the update changes the drafts only (the draft there was and the one just inserted, never a published row);
    // the delete is theirs for every stage of their own meeting (the four rows).
    const recorder = await asMember('recorder', probe);
    expect(recorder).toEqual({ read: 3, insert: 'allowed', update: 2, delete: 4 });

    // Agent contexts (sealed, as the entries write them), read as the tenant login: the actor is an agent, so none of the user-only policies admits it, whoever the member behind it is.
    const sealed = (over: Record<string, unknown>) => ({ v: 1, org: orgId, actor: 'agent', user: null, role: 'member', agent: randomUUID(), run: null, position: null, module: 'meetings', max_risk: 'R0', tainted: true, le_scope: ['*'], flags: [], ...over });
    const asSealed = async <T,>(ctx: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.ctx_write($1::jsonb)', [JSON.stringify(ctx)]);
        await c.query('SET LOCAL ROLE crove_tenant');
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    };
    const contexts: Record<string, Record<string, unknown>> = {
      'an MCP company grant (sealed, admin role)': sealed({ kind: 'mcp_company', role: 'admin', module: 'kernel', grantor: users.owner }),
      "an MCP grant of the recorder's own account": sealed({ kind: 'mcp_member', module: 'kernel', member: users.recorder }),
      'a Vy of the recorder, with a run': sealed({ kind: 'member_vy', member: users.recorder, run: randomUUID(), module: 'meetings' }),
      'an agent with no run and the admin role': sealed({ role: 'admin', module: 'kernel' }),
    };
    for (const [name, ctx] of Object.entries(contexts)) {
      expect(await asSealed(ctx, whoAmI), `${name}: the context is entered`).toEqual({ org: orgId, actor: 'agent' });
      expect(await asSealed(ctx, probe), name).toEqual(NOTHING);
    }

    // The worker's system context (the login of the background jobs, org-wide but not a user): no read, no write.
    const worker = new pg.Client({ connectionString: workerUrl });
    await worker.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
      expect(await whoAmI(worker), 'the system context is entered').toEqual({ org: orgId, actor: 'system' });
      expect(await probe(worker), 'the system context').toEqual(NOTHING);
    } finally {
      await worker.query('ROLLBACK').catch(() => {});
      await worker.end();
    }

    // The rows are all still there, untouched by any of the above (every probe was rolled back or changed nothing).
    expect((await rowsOf(meetingId)).map((r) => `${r.stage}:${r.title}`).sort()).toEqual(['draft:Bản nháp mới', 'published:Báo giá', 'published:Mở đầu']);
  });

  it('lets the recorder publish an untainted draft in raw SQL, but never a tainted one, never turn a published row back, and never edit one in place (#3883)', async () => {
    const meetingId = await seedMeeting('recorder');
    await save('recorder', meetingId, [{ title: 'Mở đầu', startSeconds: 0 }]);
    // An untainted draft: the policy lets the recorder publish it (the one change of stage), by the command's own statement (rolled back here, so the draft stays for the cases below).
    await expect(asMember('recorder', (c) => c.query(`UPDATE crove_meetings.meeting_chapter SET stage = 'published' WHERE meeting_id = $1 AND stage = 'draft' RETURNING id`, [meetingId]).then((r) => r.rowCount))).resolves.toBe(1);
    // A tainted draft (born of a run) never flips: the trigger refuses it with the recorder's own login, so the unread text of a model cannot be published by a raw statement.
    const run = randomUUID();
    await sqlAdmin(`INSERT INTO crove_meetings.meeting_chapter (org_id, meeting_id, position, title, start_seconds, tainted, source_run_id) VALUES ($1, $2, 2, 'Từ run', 10, true, $3)`, [orgId, meetingId, run]);
    await expect(asMember('recorder', (c) => c.query(`UPDATE crove_meetings.meeting_chapter SET stage = 'published' WHERE meeting_id = $1 AND title = 'Từ run'`, [meetingId]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('MEETINGS_DRAFT_NOT_REVIEWED') });
    // A published row cannot be turned back into a draft, nor edited, by the recorder in place (the update policy sees drafts only).
    await sqlAdmin(`INSERT INTO crove_meetings.meeting_chapter (org_id, meeting_id, stage, position, title, start_seconds) VALUES ($1, $2, 'published', 9, 'Đã công bố', 20)`, [orgId, meetingId]);
    await expect(asMember('recorder', (c) => c.query(`UPDATE crove_meetings.meeting_chapter SET stage = 'draft' WHERE meeting_id = $1 AND title = 'Đã công bố'`, [meetingId]).then((r) => r.rowCount))).resolves.toBe(0);
    await expect(asMember('recorder', (c) => c.query(`UPDATE crove_meetings.meeting_chapter SET title = 'Sửa tại chỗ' WHERE meeting_id = $1 AND title = 'Đã công bố'`, [meetingId]).then((r) => r.rowCount))).resolves.toBe(0);
    // A reader cannot flip anything either: a draft is not even visible to them, and a published row is not theirs.
    await expect(asMember('reader', (c) => c.query(`UPDATE crove_meetings.meeting_chapter SET stage = 'published' WHERE meeting_id = $1`, [meetingId]).then((r) => r.rowCount))).resolves.toBe(0);
    expect((await rowsOf(meetingId)).map((r) => `${r.stage}:${r.title}`).sort()).toEqual(['draft:Mở đầu', 'draft:Từ run', 'published:Đã công bố']);
  });
});
