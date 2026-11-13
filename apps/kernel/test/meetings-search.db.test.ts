// SPDX-License-Identifier: AGPL-3.0-only
// Search across the meetings a member can read (#2589, meetings plan L2, ADR-0047 point 2), on a real database through the runtime: the folded search finds
// "chiết khấu" by "chiet khau", only in the lines the caller reads (recorder: own drafts and published lines; attendee: published lines; an owner or admin who is
// no reader and a member who is not named: nothing of an attendees-only meeting; a viewer: refused; another org: nothing), never in a purged, deleted, corrected or
// erased text, paged and capped, with AI off. The security checks that must hold on every later change are also in test/invariant/meetings-search.db.test.ts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { MeetingSearchResult, PersonalDataErasure } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('search across readable meetings (#2589, L2)', () => {
  const dbName = `crove_test_meetings_search_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const asMfa = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const search = (who: string, q: string, page: { limit?: number; offset?: number } = {}, org = orgId) =>
    runtime.query<MeetingSearchResult>('meetings.search', { q, ...page }, { actor: asUser(who), orgId: org });
  const found = async (who: string, q: string) => (await search(who, q)).hits.map((h) => h.text).sort();
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

  async function meeting(recorder: string, title: string, visibility: 'attendees' | 'org', readers: string[] = [], org = orgId, startedAt = '2026-11-10T03:00:00Z'): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $3, 'vi', $6, '2026-11-10T03:30:00Z', 1800, $4, $5, 'ready', 'told_at_start', $4, now(), '1.0', current_date + 20, current_date + 365)`,
      [org, id, title, users[recorder], visibility, startedAt],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [org, randomUUID(), id, users[reader]]);
    return id;
  }
  const line = async (meetingId: string, text: string, stage: 'draft' | 'published', start = 0, org = orgId) =>
    (await sqlAdmin<{ id: string }>(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3::numeric, $3::numeric + 5, 'Hà', $4, $5) RETURNING id`, [org, meetingId, start, text, stage])).rows[0]?.id as string;

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
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    // AI off: the search has no model call, so it must work with the summary and transcription switched off.
    setSummaryEnabled(false);
    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'stranger', 'viewer', 'outsider']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'meetings-search', subject: key, email: `${key}@meetings-search.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Tìm trong họp')).orgId;
    otherOrgId = (await createOrg(runtime, asUser('outsider'), 'Org khác')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer')`, [
      orgId,
      users.admin,
      users.recorder,
      users.attendee,
      users.stranger,
      users.viewer,
    ]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('folds the typed words and the stored text alike: marks, đ and case do not matter, every word is a prefix', async () => {
    const m = await meeting('recorder', 'Họp báo giá', 'attendees');
    await line(m, 'Anh Tuấn đề nghị chiết khấu 5% cho đơn hàng đầu tiên', 'published', 12);
    await line(m, 'Chị Hà đồng ý, ký hợp đồng thứ sáu', 'published', 40);
    const first = 'Anh Tuấn đề nghị chiết khấu 5% cho đơn hàng đầu tiên';
    expect(await found('recorder', 'chiet khau')).toEqual([first]);
    expect(await found('recorder', 'CHIẾT KHẤU')).toEqual([first]);
    expect(await found('recorder', 'chiết khấu')).toEqual([first]);
    expect(await found('recorder', 'chiet kh')).toEqual([first]);
    expect(await found('recorder', 'khau chiet')).toEqual([first]);
    expect(await found('recorder', 'dong y')).toEqual(['Chị Hà đồng ý, ký hợp đồng thứ sáu']);
    expect(await found('recorder', 'dong')).toEqual(['Chị Hà đồng ý, ký hợp đồng thứ sáu']);
    expect(await found('recorder', 'de nghi')).toEqual([first]);
    expect(await found('recorder', 'chiet khau 5')).toEqual([first]);
    // Every word is required.
    expect(await found('recorder', 'chiet khau hop dong')).toEqual([]);
    // The hit names its meeting, its time offset and the line.
    const hit = (await search('recorder', 'chiet khau')).hits[0];
    expect(hit).toMatchObject({ meetingId: m, meetingTitle: 'Họp báo giá', startSeconds: 12, speakerLabel: 'Hà', stage: 'published', heldAt: '2026-11-10T03:00:00.000Z' });
  });

  it('answers nothing, and no error, for text with no letter or digit and for characters that mean something to a text-search query', async () => {
    for (const q of ['!!!', '...', '&&', '| &', "''", '( ) :*', '!chiet', 'chiet:*', "a'b", '\\\\']) {
      const answered = await search('recorder', q);
      expect(answered.hasMore, q).toBe(false);
    }
    expect((await search('recorder', '!!!')).hits).toEqual([]);
    expect((await search('recorder', 'chiet & | ! khau (')).hits.length).toBeGreaterThan(0);
  });

  it('shows each member only the lines they read', async () => {
    const hidden = await meeting('recorder', 'Họp kín về lương', 'attendees', ['attendee']);
    await line(hidden, 'Tăng lương thưởng cho nhóm bán hàng', 'published', 5);
    await line(hidden, 'Nháp: lương thưởng của chị Lan', 'draft', 60);
    const shared = await meeting('recorder', 'Họp chung của công ty', 'org');
    await line(shared, 'Thưởng quý này chia đều', 'published', 7);
    await line(shared, 'Nháp riêng: thưởng thêm cho tôi', 'draft', 90);
    const all = ['Nháp riêng: thưởng thêm cho tôi', 'Nháp: lương thưởng của chị Lan', 'Tăng lương thưởng cho nhóm bán hàng', 'Thưởng quý này chia đều'].sort();
    // The recorder reads every stage of their own meetings.
    expect(await found('recorder', 'thuong')).toEqual(all);
    // An attendee reads the published lines of the meeting they are named in, and of the shared one; no draft.
    expect(await found('attendee', 'thuong')).toEqual(['Tăng lương thưởng cho nhóm bán hàng', 'Thưởng quý này chia đều'].sort());
    // A member not named, an owner and an admin read only the meeting shared with the org: an attendees-only meeting is not theirs to read, whatever their role.
    for (const who of ['stranger', 'owner', 'admin']) expect(await found(who, 'thuong'), who).toEqual(['Thưởng quý này chia đều']);
    expect(await found('stranger', 'luong')).toEqual([]);
    expect(await found('owner', 'luong')).toEqual([]);
    expect(await found('admin', 'lan')).toEqual([]);
    // A viewer reads no meeting.
    await expect(search('viewer', 'thuong')).rejects.toMatchObject({ status: 403 });
  });

  it('keeps another org out, both ways', async () => {
    const foreign = await meeting('outsider', 'Họp org khác', 'org', [], otherOrgId);
    await line(foreign, 'Giá vàng hôm nay tăng mạnh', 'published', 3, otherOrgId);
    const mine = await meeting('recorder', 'Họp vàng của tôi', 'org');
    await line(mine, 'Vàng thì để cuối năm', 'published', 3);
    expect((await search('outsider', 'vang', {}, otherOrgId)).hits.map((h) => h.text)).toEqual(['Giá vàng hôm nay tăng mạnh']);
    expect((await search('outsider', 'vang', {}, otherOrgId)).hits.map((h) => h.meetingId)).toEqual([foreign]);
    expect(await found('recorder', 'vang')).toEqual(['Vàng thì để cuối năm']);
    // Naming the other org's id gets a user who is no member of it nothing.
    await expect(search('recorder', 'vang', {}, otherOrgId)).rejects.toBeDefined();
  });

  it('follows the text: a correction takes the old words out, a new text is found', async () => {
    const m = await meeting('recorder', 'Họp chỉnh sửa', 'attendees');
    const seg = await line(m, 'Giao hàng ngày mười lăm tại kho Bình Dương', 'draft', 2);
    expect(await found('recorder', 'binh duong')).toEqual(['Giao hàng ngày mười lăm tại kho Bình Dương']);
    await runtime.execute('meetings.transcript.correct', { segmentId: seg, text: 'Giao hàng ngày mười lăm tại kho Long An' }, { actor: asUser('recorder'), orgId, idempotencyKey: randomUUID() });
    expect(await found('recorder', 'binh duong')).toEqual([]);
    expect(await found('recorder', 'long an')).toEqual(['Giao hàng ngày mười lăm tại kho Long An']);
  });

  it('finds nothing of a meeting whose text period ended, was purged, or was deleted', async () => {
    const kept = await meeting('recorder', 'Họp còn giữ', 'org');
    await line(kept, 'Điều khoản bảo hành mười hai tháng', 'published', 1);
    const expired = await meeting('recorder', 'Họp hết hạn', 'org');
    await line(expired, 'Điều khoản bảo hành hết hạn', 'published', 1);
    const purged = await meeting('recorder', 'Họp đã xóa chữ', 'org');
    await line(purged, 'Điều khoản bảo hành đã xóa chữ', 'published', 1);
    const deleted = await meeting('recorder', 'Họp bị xóa', 'org');
    await line(deleted, 'Điều khoản bảo hành bị xóa họp', 'published', 1);
    expect(await found('owner', 'bao hanh')).toHaveLength(4);
    // The text date reached, before the nightly job ran: gone from the day it ends (Vietnam's day), for everyone including the recorder.
    await sqlAdmin(`UPDATE crove_meetings.meeting SET text_retention_date = (timezone('Asia/Ho_Chi_Minh', now()))::date WHERE id = $1`, [expired]);
    expect(await found('owner', 'bao hanh')).toHaveLength(3);
    expect(await found('recorder', 'bao hanh')).toHaveLength(3);
    // The nightly purge deletes the lines themselves.
    await sqlAdmin(`DELETE FROM crove_meetings.transcript_segment WHERE meeting_id = $1`, [purged]);
    expect(await found('owner', 'bao hanh')).toHaveLength(2);
    // The recorder's own delete takes the meeting and its lines.
    await runtime.execute('meetings.meeting.delete', { meetingId: deleted }, { actor: asUser('recorder'), orgId, idempotencyKey: randomUUID() });
    expect(await found('owner', 'bao hanh')).toEqual(['Điều khoản bảo hành mười hai tháng']);
    expect(await sqlAdmin(`SELECT 1 FROM crove_meetings.transcript_segment WHERE meeting_id = $1`, [deleted]).then((r) => r.rowCount)).toBe(0);
  });

  it('loses a mention a personal-data erasure redacted, in the same statement', async () => {
    const email = 'khach.hang@congty.example';
    const m = await meeting('recorder', 'Họp có địa chỉ thư', 'org');
    await line(m, `Gửi hợp đồng về ${email} nhé`, 'published', 4);
    expect(await found('owner', 'khach hang')).toHaveLength(1);
    const erased = await runtime.execute<PersonalDataErasure>('kernel.personal_data.erase', { value: email }, { actor: asMfa('owner'), orgId, idempotencyKey: randomUUID() });
    expect(erased.erased.some((r) => r.column === 'crove_meetings.transcript_segment.text' && r.rows > 0)).toBe(true);
    expect(await found('owner', 'khach hang')).toEqual([]);
    expect(await found('recorder', 'congty')).toEqual([]);
    // The rest of the line is still found.
    expect(await found('owner', 'hop dong ve')).toHaveLength(1);
    const stored = await sqlAdmin<{ search: string }>(`SELECT search::text AS search FROM crove_meetings.transcript_segment WHERE meeting_id = $1`, [m]);
    expect(stored.rows[0]?.search).not.toContain('khach');
  });

  it('pages and caps: a page is at most 50, 200 hits can be reached, and `capped` says there were more', async () => {
    const big = await meeting('recorder', 'Họp dài', 'org', [], orgId, '2026-11-11T03:00:00Z');
    await sqlAdmin(
      `INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage)
       SELECT $1, $2, g, g + 1, 'Hà', 'Dòng số ' || g || ' nói về xuongsanxuat', 'published' FROM generate_series(1, 230) g`,
      [orgId, big],
    );
    const first = await search('owner', 'xuongsanxuat', { limit: 20 });
    expect(first.hits.map((h) => h.startSeconds)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(first).toMatchObject({ hasMore: true, capped: false });
    const second = await search('owner', 'xuongsanxuat', { limit: 20, offset: 20 });
    expect(second.hits[0]?.startSeconds).toBe(21);
    expect(second.hits.at(-1)?.startSeconds).toBe(40);
    const lastPage = await search('owner', 'xuongsanxuat', { limit: 50, offset: 150 });
    expect(lastPage.hits).toHaveLength(50);
    expect(lastPage.hits.at(-1)?.startSeconds).toBe(200);
    expect(lastPage).toMatchObject({ hasMore: true, capped: true });
    expect(await search('owner', 'xuongsanxuat', { limit: 20, offset: 200 })).toEqual({ hits: [], hasMore: false, capped: true });
    // A short result ends without a cap.
    const few = await search('owner', 'xuongsanxuat dong so 229');
    expect(few).toMatchObject({ hasMore: false, capped: false });
    await expect(search('owner', 'x', { limit: 51 })).rejects.toBeDefined();
    await expect(search('owner', 'x', { offset: 201 })).rejects.toBeDefined();
    await expect(search('owner', ' '.repeat(3))).rejects.toBeDefined();
    await expect(search('owner', 'a')).rejects.toBeDefined();
    // Words of one letter only match nothing, however many lines hold them.
    expect((await search('owner', 'a b')).hits).toEqual([]);
    await expect(search('owner', 'a'.repeat(201))).rejects.toBeDefined();
  });

  it('lists the newest meeting first, then the lines in order', async () => {
    const older = await meeting('recorder', 'Họp tháng 9', 'org', [], orgId, '2026-09-01T03:00:00Z');
    const newer = await meeting('recorder', 'Họp tháng 12', 'org', [], orgId, '2026-12-01T03:00:00Z');
    await line(older, 'Báo cáo thuedoanhnghiep quý ba', 'published', 30);
    await line(older, 'Nộp thuedoanhnghiep sớm', 'published', 10);
    await line(newer, 'Quyết toán thuedoanhnghiep cuối năm', 'published', 50);
    const hits = (await search('owner', 'thuedoanhnghiep')).hits;
    expect(hits.map((h) => [h.meetingId, h.startSeconds])).toEqual([[newer, 50], [older, 10], [older, 30]]);
  });

  it('can use the index: the folded words answer a rare word through the GIN index', async () => {
    const m = await meeting('recorder', 'Họp để thử chỉ mục', 'org');
    await sqlAdmin(
      `INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage)
       SELECT $1, $2, g, g + 1, 'Hà', 'Lời ' || g || ' về chuyện khác hẳn ' || md5(g::text), 'published' FROM generate_series(1, 40000) g`,
      [orgId, m],
    );
    await line(m, 'Một chuyện hiếm là quỳnhlâm', 'published', 9000);
    await sqlAdmin('ANALYZE crove_meetings.transcript_segment');
    // The planner may still read a table of this size in order; what matters is that the index can answer the test, which a non-indexable predicate could not.
    const plan = await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL enable_seqscan = off');
      const rows = (await c.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT id FROM crove_meetings.transcript_segment WHERE org_id = $1 AND search @@ crove_kernel.search_query('quynhlam')`, [orgId])).rows;
      await c.query('ROLLBACK');
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('transcript_segment_search_idx');
    expect(await found('owner', 'quynhlam')).toEqual(['Một chuyện hiếm là quỳnhlâm']);
  });
});
