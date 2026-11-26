// SPDX-License-Identifier: AGPL-3.0-only
// Title search and keyset cursor pagination on `meetings.meeting.list` (#5052, refs #3519) on PostgreSQL 17:
// - keyset pagination `(date_trunc('milliseconds', COALESCE(started_at, created_at)), id) DESC` handles sub-millisecond ties and NULL `started_at` without skips or repeats;
// - plain-text `search` folds Vietnamese diacritics, `đ`, case, and punctuation via `ludy_kernel.search_fold` and treats `%` / `_` / emoji literally when folded text is empty;
// - caller RLS, org isolation, and text retention exclusion still hold when searching or paging, letting pickers reach meetings older than the top 100.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { MeetingListInput, MeetingListItem } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('meetings.meeting.list search and cursor pagination (#5052)', () => {
  const dbName = `ludy_test_meeting_list_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const NAMES: Record<string, string> = {
    owner: 'Chủ Công Ty',
    rec: 'Người Ghi',
    solo: 'Thành Viên Đọc',
    nam: 'Nguyễn Văn Nam',
    viewer: 'Người Xem',
    outsider: 'Người Công Ty Khác',
  };
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const listMeetings = (who: string, input: MeetingListInput = {}, targetOrg = orgId) =>
    runtime.query<MeetingListItem[]>('meetings.meeting.list', input, { actor: asUser(who), orgId: targetOrg });

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
      org?: string;
      recorder?: string;
      readers?: string[];
      visibility?: 'attendees' | 'org';
      startedAt?: string | null;
      createdAt?: string;
      expired?: boolean;
    } = {},
  ): Promise<string> {
    const id = opts.id ?? randomUUID();
    const targetOrg = opts.org ?? orgId;
    const recorder = users[opts.recorder ?? 'rec'] as string;
    const startedAt = opts.startedAt === undefined ? '2026-11-25T03:00:00.000Z' : opts.startedAt;
    const createdAt = opts.createdAt ?? startedAt ?? '2026-11-25T03:00:00.000Z';
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, created_at, updated_at)
       VALUES ($1, $2, $4, 'vi', $6::timestamptz, $6::timestamptz + interval '1 hour', 3600, $3, $5, 'ready', 'told_at_start', $3, $7::timestamptz, '1.0', current_date + 30, ${opts.expired ? 'current_date - 1' : 'current_date + 365'}, $7::timestamptz, $7::timestamptz)`,
      [targetOrg, id, recorder, title, opts.visibility ?? 'attendees', startedAt, createdAt],
    );
    for (const reader of opts.readers ?? ['solo']) {
      await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [targetOrg, randomUUID(), id, users[reader]]);
    }
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
    const appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    for (const key of Object.keys(NAMES)) {
      users[key] = await upsertIdentity(db, { issuer: 'meeting-list', subject: key, email: `${key}@meeting-list.test`, name: NAMES[key] as string });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Danh Sách Họp')).orgId;
    otherOrgId = (await createOrg(runtime, asUser('outsider'), 'Công ty Khác')).orgId;
    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
      [orgId, users.rec, users.solo, users.nam, users.viewer],
    );
  }, 300_000);

  beforeEach(async () => {
    await sqlAdmin('DELETE FROM ludy_meetings.meeting WHERE org_id IN ($1, $2)', [orgId, otherOrgId]);
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('pages deterministically across sub-millisecond ties and NULL started_at without skips or duplicates', async () => {
    const newest = await seedMeeting('Mới nhất', { startedAt: '2026-11-25T05:00:00.000Z' });
    const idLow = '019a0000-0000-7000-8000-000000000001';
    const idHigh = '019a0000-0000-7000-8000-000000000002';
    // Even with more microseconds on idLow, millisecond truncation breaks ties strictly by id DESC.
    await seedMeeting('Cùng mili giây nhỏ', { id: idLow, startedAt: '2026-11-25T03:00:00.123900Z' });
    await seedMeeting('Cùng mili giây lớn', { id: idHigh, startedAt: '2026-11-25T03:00:00.123100Z' });
    const nullStarted = await seedMeeting('Chưa đặt giờ bắt đầu', { startedAt: null, createdAt: '2026-11-25T02:00:00.456Z' });
    const older = await seedMeeting('Cũ hơn', { startedAt: '2026-11-24T03:00:00.000Z' });

    const page1 = await listMeetings('solo', { limit: 2 });
    expect(page1.map((m) => m.id)).toEqual([newest, idHigh]);
    const c1 = page1.at(-1)!;
    const page2 = await listMeetings('solo', { limit: 2, afterStartedAt: c1.startedAt ?? c1.createdAt, afterId: c1.id });
    expect(page2.map((m) => m.id)).toEqual([idLow, nullStarted]);
    const c2 = page2.at(-1)!;
    const page3 = await listMeetings('solo', { limit: 2, afterStartedAt: c2.startedAt ?? c2.createdAt, afterId: c2.id });
    expect(page3.map((m) => m.id)).toEqual([older]);
    const c3 = page3.at(-1)!;
    expect(await listMeetings('solo', { limit: 2, afterStartedAt: c3.startedAt ?? c3.createdAt, afterId: c3.id })).toEqual([]);
  });

  it('searches titles with Vietnamese fold, literal wildcards/emoji, whitespace-as-unset, and combined cursor', async () => {
    const phone = await seedMeeting('Họp điện-thoại khách hàng', { startedAt: '2026-11-25T05:00:00Z' });
    const lotusNew = await seedMeeting('Họp khách Hoa Sen đợt 2', { startedAt: '2026-11-25T04:00:00Z' });
    const lotusOld = await seedMeeting('Tổng kết Hoa Sen đợt 1', { startedAt: '2026-11-25T03:00:00Z' });
    const pct = await seedMeeting('Tăng 50% quý 4', { startedAt: '2026-11-25T02:00:00Z' });
    const under = await seedMeeting('Mã ma_01 nội bộ', { startedAt: '2026-11-25T01:30:00Z' });
    const emoji = await seedMeeting('🎯 OKR quý 4', { startedAt: '2026-11-25T01:00:00Z' });

    expect((await listMeetings('solo', { search: 'dien thoai' })).map((m) => m.id)).toEqual([phone]);
    expect((await listMeetings('solo', { search: 'HOA SEN' })).map((m) => m.id)).toEqual([lotusNew, lotusOld]);
    expect((await listMeetings('solo', { search: '%' })).map((m) => m.id)).toEqual([pct]);
    expect((await listMeetings('solo', { search: '_' })).map((m) => m.id)).toEqual([under]);
    expect((await listMeetings('solo', { search: '🎯' })).map((m) => m.id)).toEqual([emoji]);
    expect(await listMeetings('solo', { search: '   ' })).toHaveLength(6);

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

  it('enforces RLS, org isolation, retention expiry, role access, and cursor validation', async () => {
    const hidden = await seedMeeting('Họp bí mật Hoa Sen', { readers: ['nam'], startedAt: '2026-11-25T04:00:00Z' });
    const expired = await seedMeeting('Họp hết hạn Hoa Sen', { readers: ['solo'], expired: true, startedAt: '2026-11-25T05:00:00Z' });
    await seedMeeting('Họp công ty khác Hoa Sen', { org: otherOrgId, recorder: 'outsider', readers: [], startedAt: '2026-11-25T06:00:00Z' });

    expect(await listMeetings('solo', { search: 'Hoa Sen' })).toEqual([]);
    expect(await listMeetings('owner', { search: 'Hoa Sen' })).toEqual([]);
    expect((await listMeetings('nam', { search: 'Hoa Sen' })).map((m) => m.id)).toEqual([hidden]);
    expect((await listMeetings('rec', { search: 'Hoa Sen' })).map((m) => m.id)).toEqual([hidden]);
    expect((await listMeetings('rec')).map((m) => m.id)).not.toContain(expired);

    await expect(listMeetings('viewer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      runtime.query('meetings.meeting.list', { afterStartedAt: '2026-11-25T03:00:00Z' }, { actor: asUser('solo'), orgId }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('reaches meetings older than the newest 100 via search or cursor pagination', async () => {
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
  });
});
