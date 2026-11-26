// SPDX-License-Identifier: AGPL-3.0-only
// Title search, keyset cursor pagination, and query-plan index usage on `meetings.meeting.list` (#5052, refs #3519) on PostgreSQL 17:
// - keyset pagination `(COALESCE(started_at, created_at), id) DESC` backed by `meeting_held_idx` handles sub-millisecond ties, deleted cursors, and NULL `started_at`;
// - plain-text `search` folds Vietnamese diacritics, `đ`, case, and punctuation via `ludy_kernel.search_fold`, preserves mixed non-Latin/emoji terms alongside ASCII, and treats `%` / `_` literally;
// - lets note link pickers reach meetings older than the newest 100 and verifies index scan usage without a Sort node.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { MeetingDetail, MeetingListInput, MeetingListItem } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { buildMeetingListQuery, meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('meetings.meeting.list search and cursor pagination (#5052)', () => {
  const dbName = `ludy_test_meeting_list_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let db: Db;
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const NAMES: Record<string, string> = {
    owner: 'Chủ Công Ty',
    rec: 'Người Ghi',
    solo: 'Thành Viên Đọc',
  };
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const listMeetings = (who: string, input: MeetingListInput = {}) =>
    runtime.query<MeetingListItem[]>('meetings.meeting.list', input, { actor: asUser(who), orgId });

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

  async function seedMeeting(
    title: string,
    opts: {
      id?: string;
      startedAt?: string | null;
      createdAt?: string;
    } = {},
  ): Promise<string> {
    const id = opts.id ?? randomUUID();
    const startedAt = opts.startedAt === undefined ? '2026-11-25T03:00:00.000Z' : opts.startedAt;
    const createdAt = opts.createdAt ?? startedAt ?? '2026-11-25T03:00:00.000Z';
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, created_at, updated_at)
       VALUES ($1, $2, $4, 'vi', $5::timestamptz, $5::timestamptz + interval '1 hour', 3600, $3, 'attendees', 'ready', 'told_at_start', $3, $6::timestamptz, '1.0', current_date + 30, current_date + 365, $6::timestamptz, $6::timestamptz)`,
      [orgId, id, users.rec, title, startedAt, createdAt],
    );
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users.solo]);
    return id;
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    for (const key of Object.keys(NAMES)) {
      users[key] = await upsertIdentity(db, { issuer: 'meeting-list', subject: key, email: `${key}@meeting-list.test`, name: NAMES[key] as string });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Danh Sách Họp')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [
      orgId,
      users.rec,
      users.solo,
    ]);
  }, 300_000);

  beforeEach(async () => {
    await sqlAdmin('DELETE FROM ludy_meetings.meeting WHERE org_id = $1', [orgId]);
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('pages deterministically across sub-millisecond ties, NULL started_at, and deleted sub-ms cursors without skips or duplicates', async () => {
    const newest = await seedMeeting('Mới nhất', { startedAt: '2026-11-25T05:00:00.000Z' });
    const idLow = '019a0000-0000-7000-8000-000000000001';
    const idHigh = '019a0000-0000-7000-8000-000000000002';
    // True chronological order puts .123900Z ahead of .123100Z; microsecond precision in startedAt preserves that boundary.
    await seedMeeting('Cùng mili giây mới hơn', { id: idLow, startedAt: '2026-11-25T03:00:00.123900Z' });
    await seedMeeting('Cùng mili giây cũ hơn', { id: idHigh, startedAt: '2026-11-25T03:00:00.123100Z' });
    const nullStarted = await seedMeeting('Chưa đặt giờ bắt đầu', { startedAt: null, createdAt: '2026-11-25T02:00:00.456789Z' });
    const deletedSubMsNew = '019a0000-0000-7000-8000-000000000003';
    const deletedSubMsOld = '019a0000-0000-7000-8000-000000000004';
    await seedMeeting('Họp sẽ xóa trong cùng mili giây', { id: deletedSubMsNew, startedAt: '2026-11-24T04:00:00.500900Z' });
    await seedMeeting('Họp giữ lại trong cùng mili giây', { id: deletedSubMsOld, startedAt: '2026-11-24T04:00:00.500100Z' });
    const older = await seedMeeting('Cũ hơn', { startedAt: '2026-11-24T03:00:00.000Z' });

    const page1 = await listMeetings('solo', { limit: 2 });
    expect(page1.map((m) => m.id)).toEqual([newest, idLow]);
    const c1 = page1.at(-1)!;
    expect(c1.startedAt).toBe('2026-11-25T03:00:00.123900Z');
    const detail = await runtime.query<MeetingDetail>('meetings.meeting.get', { meetingId: idLow }, { actor: asUser('solo'), orgId });
    expect(detail.startedAt).toBe('2026-11-25T03:00:00.123900Z');

    const page2 = await listMeetings('solo', { limit: 2, afterStartedAt: c1.startedAt ?? c1.createdAt, afterId: c1.id });
    expect(page2.map((m) => m.id)).toEqual([idHigh, nullStarted]);
    const c2 = page2.at(-1)!;
    expect(c2.startedAt).toBeNull();
    expect(c2.createdAt).toBe('2026-11-25T02:00:00.456789Z');

    const page3 = await listMeetings('solo', { limit: 2, afterStartedAt: c2.startedAt ?? c2.createdAt, afterId: c2.id });
    expect(page3.map((m) => m.id)).toEqual([deletedSubMsNew, deletedSubMsOld]);
    const c3 = page3.at(-1)!;
    const page4 = await listMeetings('solo', { limit: 2, afterStartedAt: c3.startedAt ?? c3.createdAt, afterId: c3.id });
    expect(page4.map((m) => m.id)).toEqual([older]);
    const c4 = page4.at(-1)!;
    expect(await listMeetings('solo', { limit: 2, afterStartedAt: c4.startedAt ?? c4.createdAt, afterId: c4.id })).toEqual([]);

    // Fetch a cursor pointing at deletedSubMsNew, delete it before page 2, and confirm deletedSubMsOld inside the same millisecond is not skipped.
    const pageBeforeDelete = await listMeetings('solo', { limit: 1, afterStartedAt: c2.startedAt ?? c2.createdAt, afterId: c2.id });
    expect(pageBeforeDelete.map((m) => m.id)).toEqual([deletedSubMsNew]);
    const cDel = pageBeforeDelete[0]!;
    expect(cDel.startedAt).toBe('2026-11-24T04:00:00.500900Z');
    await sqlAdmin('DELETE FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, deletedSubMsNew]);
    const afterDeleted = await listMeetings('solo', { limit: 2, afterStartedAt: cDel.startedAt!, afterId: cDel.id });
    expect(afterDeleted.map((m) => m.id)).toEqual([deletedSubMsOld, older]);
  });

  it('searches titles with Vietnamese fold, mixed non-Latin/emoji with digits, literal wildcards, whitespace-as-unset, and cursor', async () => {
    const phone = await seedMeeting('Họp điện-thoại khách hàng', { startedAt: '2026-11-25T06:00:00Z' });
    const lotusNew = await seedMeeting('Họp khách Hoa Sen đợt 2', { startedAt: '2026-11-25T05:00:00Z' });
    const lotusOld = await seedMeeting('Tổng kết Hoa Sen đợt 1', { startedAt: '2026-11-25T04:00:00Z' });
    const tokyo = await seedMeeting('Họp 東京 2026', { startedAt: '2026-11-25T03:00:00Z' });
    await seedMeeting('Họp Hà Nội 2026', { startedAt: '2026-11-25T02:30:00Z' });
    const pct = await seedMeeting('Tăng 50% quý 4', { startedAt: '2026-11-25T02:00:00Z' });
    await seedMeeting('50 người tham dự', { startedAt: '2026-11-25T01:45:00Z' });
    const under = await seedMeeting('Mã_01 nội bộ', { startedAt: '2026-11-25T01:30:00Z' });
    await seedMeeting('Mã-01 nội bộ', { startedAt: '2026-11-25T01:15:00Z' });
    const emojiQ4 = await seedMeeting('🎯 Kế hoạch Q4', { startedAt: '2026-11-25T01:00:00Z' });
    const vnFlagQ4 = await seedMeeting('🇻🇳 Kế hoạch Q4', { startedAt: '2026-11-25T00:45:00Z' });
    await seedMeeting('Kế hoạch Q4 chung', { startedAt: '2026-11-25T00:30:00Z' });

    expect((await listMeetings('solo', { search: 'dien thoai' })).map((m) => m.id)).toEqual([phone]);
    expect((await listMeetings('solo', { search: 'HOA SEN' })).map((m) => m.id)).toEqual([lotusNew, lotusOld]);
    expect((await listMeetings('solo', { search: '東京 2026' })).map((m) => m.id)).toEqual([tokyo]);
    expect((await listMeetings('solo', { search: '🎯 Q4' })).map((m) => m.id)).toEqual([emojiQ4]);
    expect((await listMeetings('solo', { search: '🇻🇳 Q4' })).map((m) => m.id)).toEqual([vnFlagQ4]);
    expect((await listMeetings('solo', { search: '50%' })).map((m) => m.id)).toEqual([pct]);
    expect((await listMeetings('solo', { search: 'tang 50%' })).map((m) => m.id)).toEqual([pct]);
    expect((await listMeetings('solo', { search: 'ma_01' })).map((m) => m.id)).toEqual([under]);
    expect((await listMeetings('solo', { search: 'mã_01' })).map((m) => m.id)).toEqual([under]);
    expect((await listMeetings('solo', { search: '%' })).map((m) => m.id)).toEqual([pct]);
    expect((await listMeetings('solo', { search: '_' })).map((m) => m.id)).toEqual([under]);
    expect((await listMeetings('solo', { search: '🎯' })).map((m) => m.id)).toEqual([emojiQ4]);
    expect(await listMeetings('solo', { search: '   ' })).toHaveLength(12);

    const searchPage1 = await listMeetings('solo', { search: 'hoa sen', limit: 1 });
    expect(searchPage1.map((m) => m.id)).toEqual([lotusNew]);
    const cursor = searchPage1[0]!;
    const searchPage2 = await listMeetings('solo', {
      search: 'hoa sen',
      limit: 1,
      afterStartedAt: cursor.startedAt ?? cursor.createdAt,
      afterId: cursor.id,
    });
    expect(searchPage2.map((m) => m.id)).toEqual([lotusOld]);
  });

  it('rejects half-cursors, out-of-range offsets, and NUL bytes in search via schema validation', async () => {
    await expect(
      runtime.query('meetings.meeting.list', { afterStartedAt: '2026-11-25T03:00:00Z' }, { actor: asUser('solo'), orgId }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      runtime.query(
        'meetings.meeting.list',
        { afterStartedAt: '2026-11-25T03:00:00+16:00', afterId: '019a0000-0000-7000-8000-000000000001' },
        { actor: asUser('solo'), orgId },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(listMeetings('solo', { search: 'abc\u0000def' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('reaches meetings older than the newest 100 and scans meeting_held_idx without a Sort node under RLS', async () => {
    const oldTarget = await seedMeeting('Họp ký hợp đồng Hoa Sen 2025', { startedAt: '2025-01-01T00:00:00.000Z' });
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, created_at, updated_at)
       SELECT $1, ludy_kernel.uuid_v7(), 'Họp định kỳ ' || g, 'vi', '2026-11-26T00:00:00Z'::timestamptz + pg_catalog.make_interval(mins => g), '2026-11-26T01:00:00Z'::timestamptz + pg_catalog.make_interval(mins => g), 3600, $2, 'attendees', 'ready', 'told_at_start', $2, '2026-11-26T00:00:00Z'::timestamptz + pg_catalog.make_interval(mins => g), '1.0', current_date + 30, current_date + 365, '2026-11-26T00:00:00Z'::timestamptz + pg_catalog.make_interval(mins => g), '2026-11-26T00:00:00Z'::timestamptz + pg_catalog.make_interval(mins => g)
       FROM pg_catalog.generate_series(1, 105) AS g`,
      [orgId, users.solo],
    );

    const first100 = await listMeetings('solo', { limit: 100 });
    expect(first100).toHaveLength(100);
    expect(first100.map((m) => m.id)).not.toContain(oldTarget);

    const searched = await listMeetings('solo', { limit: 100, search: 'hoa sen 2025' });
    expect(searched.map((m) => m.id)).toEqual([oldTarget]);

    const tail = first100.at(-1)!;
    const secondPage = await listMeetings('solo', {
      limit: 100,
      afterStartedAt: tail.startedAt ?? tail.createdAt,
      afterId: tail.id,
    });
    expect(secondPage).toHaveLength(6);
    expect(secondPage.at(-1)?.id).toBe(oldTarget);

    await sqlAdmin('ANALYZE ludy_meetings.meeting');
    const c = await appPool.connect();
    let plans: { p1: string; p2: string; p3: string };
    try {
      await c.query('BEGIN');
      await enterUser(c, users.solo as string, orgId);
      const roleRow = (
        await c.query<{ cur: string; sess: string; rls: string }>(
          "SELECT current_user AS cur, session_user AS sess, pg_catalog.current_setting('row_security') AS rls",
        )
      ).rows[0];
      expect(roleRow).toEqual({ cur: 'ludy_app', sess: 'ludy_app', rls: 'on' });
      await c.query('SET LOCAL enable_seqscan = off');
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
      const explain = async (input: MeetingListInput) => {
        const compiled = buildMeetingListQuery(db, orgId, today, input).compile();
        const res = await c.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${compiled.sql}`, [...compiled.parameters]);
        return res.rows.map((r) => r['QUERY PLAN']).join('\n');
      };
      plans = {
        p1: await explain({ limit: 100 }),
        p2: await explain({ limit: 100, afterStartedAt: tail.startedAt ?? tail.createdAt, afterId: tail.id }),
        p3: await explain({ limit: 100, search: 'hoa sen' }),
      };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    expect(plans.p1).toContain('meeting_held_idx');
    expect(plans.p1).not.toMatch(/\bSort\b/);
    expect(plans.p2).toContain('meeting_held_idx');
    expect(plans.p2).not.toMatch(/\bSort\b/);
    expect(plans.p3).toContain('meeting_held_idx');
    expect(plans.p3).not.toMatch(/\bSort\b/);
  });
});
