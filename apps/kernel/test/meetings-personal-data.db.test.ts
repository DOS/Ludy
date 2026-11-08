// SPDX-License-Identifier: AGPL-3.0-only
// The personal-data finder in meeting text (#2594, meetings plan L5, ADR-0047 points 7 and 11), part 1 (the finder; the erasure is part 2): a value that a transcript, a
// summary, the decisions, an action item or a title holds is listed for an owner or admin where they read the meeting (row security as for every table), and counted per
// recorder, for owners only, where they cannot (an attendees-only meeting they are no reader of, a draft that is not theirs): never which meeting, its title or its text.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { PersonalDataResult } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const EMAIL = 'khach.hang@congty.example';
const PHONE = '0901234567';
const HIDDEN_TITLE = 'Họp kín về anh Tuấn';
const HIDDEN_LINE = `Anh Tuấn nhắn gửi hợp đồng về ${EMAIL} nhé`;

suite('the personal-data finder in meeting text (#2594, L5 part 1)', () => {
  const dbName = `crove_test_meetings_finder_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const find = (who: string, value: string, org = orgId) =>
    runtime.execute<PersonalDataResult>('kernel.personal_data.find', { value }, { actor: asUser(who), orgId: org, idempotencyKey: randomUUID() });
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

  async function meeting(org: string, recorder: string, title: string, visibility: 'attendees' | 'org', readers: string[] = []): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $3, 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $4, $5, 'ready', 'told_at_start', $4, now(), '1.0', current_date + 30, current_date + 365)`,
      [org, id, title, users[recorder], visibility],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [org, randomUUID(), id, users[reader]]);
    return id;
  }
  const segment = (org: string, meetingId: string, text: string, stage: 'draft' | 'published') =>
    sqlAdmin(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, 0, 10, 'Hà', $3, $4)`, [org, meetingId, text, stage]);
  const result = (org: string, meetingId: string, summary: string, decisions: string[], stage: 'draft' | 'published') =>
    sqlAdmin(`INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage) VALUES ($1, $2, $3, $4::jsonb, 'manual', $5)`, [org, meetingId, summary, JSON.stringify(decisions), stage]);
  const item = (org: string, meetingId: string, title: string, stage: 'draft' | 'published') =>
    sqlAdmin(`INSERT INTO crove_meetings.action_item (org_id, meeting_id, title, stage) VALUES ($1, $2, $3, $4)`, [org, meetingId, title, stage]);
  const meetingColumns = (r: PersonalDataResult) => r.matches.filter((m) => m.column.startsWith('crove_meetings.')).map((m) => m.column).sort();

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
    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'outsider']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'meetings-finder', subject: key, email: `${key}@meetings-finder.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Tìm trong họp')).orgId;
    otherOrgId = (await createOrg(runtime, asUser('outsider'), 'Org khác')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.admin, users.recorder, users.attendee]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists the text of meetings the owner reads, counts the rest per recorder for owners only, and shows no text of them', async () => {
    // Readable by the owner: a meeting shared with the org (published rows), and the owner's own meeting with a draft.
    const shared = await meeting(orgId, 'recorder', 'Họp chung tháng 11', 'org');
    await segment(orgId, shared, `Gửi hợp đồng về ${EMAIL}`, 'published');
    await result(orgId, shared, `Chốt giá, gửi tới ${EMAIL}`, [`Liên hệ ${EMAIL}`], 'published');
    await item(orgId, shared, `Gửi báo giá tới ${EMAIL}`, 'published');
    const own = await meeting(orgId, 'owner', 'Họp của chủ', 'attendees');
    await segment(orgId, own, `Nháp của chủ: ${EMAIL}`, 'draft');
    // Not readable by the owner: an attendees-only meeting (title, published line, draft summary, draft item) and a draft of the shared meeting's recorder.
    const hidden = await meeting(orgId, 'recorder', `${HIDDEN_TITLE} ${EMAIL}`, 'attendees', ['attendee']);
    await segment(orgId, hidden, HIDDEN_LINE, 'published');
    await result(orgId, hidden, `Tóm tắt kín ${EMAIL}`, [], 'draft');
    await item(orgId, hidden, `Việc kín cho ${EMAIL}`, 'draft');
    await segment(orgId, shared, `Nháp riêng của người ghi ${EMAIL}`, 'draft');
    // Another org holds the value too: never counted here.
    const foreign = await meeting(otherOrgId, 'outsider', 'Họp org khác', 'attendees');
    await segment(otherOrgId, foreign, `Của org khác ${EMAIL}`, 'published');

    const owner = await find('owner', EMAIL);
    // The owner reads: the shared meeting's three published rows and own draft line.
    expect(meetingColumns(owner)).toEqual(['crove_meetings.action_item.title', 'crove_meetings.meeting_result.decisions', 'crove_meetings.meeting_result.summary', 'crove_meetings.transcript_segment.text', 'crove_meetings.transcript_segment.text'].sort());
    expect(owner.meetingText).toEqual([
      // The recorder's attendees-only meeting: 1 meeting + its title, 1 published line, 1 draft summary, 1 draft item; plus the draft line of the shared meeting (another meeting).
      { recorderUserId: users.recorder, meetings: 2, lines: 2, results: 1, items: 1, titles: 1 },
    ]);
    const answer = JSON.stringify(owner);
    for (const secret of [HIDDEN_TITLE, HIDDEN_LINE, 'Tóm tắt kín', 'Việc kín', 'Nháp riêng của người ghi', 'Của org khác']) expect(answer, secret).not.toContain(secret);
    // The audit row holds counts only.
    const audit = JSON.stringify((await sqlAdmin(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.find' ORDER BY id DESC LIMIT 1`, [orgId])).rows);
    expect(audit).toContain('meeting_text');
    for (const secret of [EMAIL, HIDDEN_TITLE, HIDDEN_LINE]) expect(audit, secret).not.toContain(secret);
  });

  it('gives an admin the rows they read and no counts, and a member nothing', async () => {
    const admin = await find('admin', EMAIL);
    expect(admin.meetingText).toBeNull();
    expect(meetingColumns(admin)).toEqual(['crove_meetings.action_item.title', 'crove_meetings.meeting_result.decisions', 'crove_meetings.meeting_result.summary', 'crove_meetings.transcript_segment.text'].sort());
    await expect(find('recorder', EMAIL)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('matches a phone number as a whole number: amounts, dates and longer numbers are not hits, +84 and separators are', async () => {
    const hidden = await meeting(orgId, 'recorder', 'Họp số điện thoại', 'attendees');
    await segment(orgId, hidden, 'Tổng 1.250.000 đồng, hạn 12/03/2026, mã đơn 000123', 'published');
    await segment(orgId, hidden, 'Số lớn 10901234567 và 09012345678 và 90123456789', 'published');
    const before = (await find('owner', PHONE)).meetingText ?? [];
    expect(before.reduce((n, m) => n + m.lines, 0)).toBe(0);
    await segment(orgId, hidden, 'Gọi anh Tuấn số 0901 234 567 nhé', 'published');
    await segment(orgId, hidden, 'Hoặc +84 901 234 567', 'published');
    const after = (await find('owner', PHONE)).meetingText ?? [];
    expect(after).toEqual([{ recorderUserId: users.recorder, meetings: 1, lines: 2, results: 0, items: 0, titles: 0 }]);
  });

  it('answers a value of the wrong shape with the finder\'s own error, before any row is read', async () => {
    await expect(find('owner', 'abc')).rejects.toMatchObject({ code: 'PERSONAL_DATA_QUERY' });
  });

  it('counts a large body of transcript text in one linear scan', async () => {
    const big = await meeting(orgId, 'recorder', 'Họp dài', 'attendees');
    // 120 000 lines of about 200 characters, a few of them holding the value, and one line of 4000 digits and spaces that no pattern may take long over.
    await sqlAdmin(
      `INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage)
       SELECT $1, $2, g, g + 1, 'Hà', pg_catalog.repeat('Chúng ta bàn về giá và hạn giao hàng tháng này, ', 4) || CASE WHEN g % 40000 = 0 THEN 'liên hệ ${EMAIL}' ELSE '' END, 'published'
         FROM pg_catalog.generate_series(1, 120000) AS g`,
      [orgId, big],
    );
    await sqlAdmin(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, 0, 1, 'Hà', pg_catalog.repeat('0 ', 2000), 'published')`, [orgId, big]);
    const started = Date.now();
    const found = await find('owner', EMAIL);
    const seconds = (Date.now() - started) / 1000;
    if (process.env.CROVE_TEST_TIMING_FILE) appendFileSync(process.env.CROVE_TEST_TIMING_FILE, `finder over 120000 lines: ${seconds.toFixed(2)} s\n`);
    expect(found.meetingText?.find((m) => m.recorderUserId === users.recorder)?.lines).toBeGreaterThanOrEqual(3);
    // A generous budget for a shared runner: the point is that it is seconds, not minutes.
    expect(seconds).toBeLessThan(30);
  }, 120_000);
});
