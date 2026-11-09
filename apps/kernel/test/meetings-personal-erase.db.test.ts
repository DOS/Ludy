// SPDX-License-Identifier: AGPL-3.0-only
// The erasure in meeting text (#2594, meetings plan L5, ADR-0047 points 2 and 7, ADR-0037 section 5), part 2, on a real database through kernel.personal_data.erase: every whole
// mention of a person's value is redacted in place in the rows the owner reads at once (their own meeting, a published row of a meeting they read), and in the rows they cannot read
// (an attendees-only meeting, a draft that is not theirs) only after a notice named the meeting at its text and its recorder was told 24 hours ago. Nothing but the text changes.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { PersonalDataErasure, PersonalDataNotice, PersonalDataResult } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const EMAIL = 'khach.hang@congty.example';
const MARK = '[đã xóa]';

suite('the erasure in meeting text (#2594, L5 part 2)', () => {
  const dbName = `crove_test_meetings_erase_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const asMfa = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const find = (who: string, value = EMAIL) => runtime.execute<PersonalDataResult>('kernel.personal_data.find', { value }, { actor: asUser(who), orgId, idempotencyKey: randomUUID() });
  const notify = (value = EMAIL) => runtime.execute<PersonalDataNotice>('kernel.personal_data.notify', { value }, { actor: asUser('owner'), orgId, idempotencyKey: randomUUID() });
  const erase = (value = EMAIL) => runtime.execute<PersonalDataErasure>('kernel.personal_data.erase', { value }, { actor: asMfa('owner'), orgId, idempotencyKey: randomUUID() });
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
  const count = async (text: string, params: unknown[] = []) => Number((await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM (${text}) q`, params)).rows[0]?.n);

  async function meeting(recorder: string, title: string, visibility: 'attendees' | 'org', readers: string[] = [], org = orgId): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $3, 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $4, $5, 'ready', 'told_at_start', $4, now(), '1.0', current_date + 20, current_date + 365)`,
      [org, id, title, users[recorder], visibility],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [org, randomUUID(), id, users[reader]]);
    return id;
  }
  const segment = async (meetingId: string, text: string, stage: 'draft' | 'published', label = 'Hà', org = orgId) =>
    (await sqlAdmin<{ id: string }>(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, 0, 10, $3, $4, $5) RETURNING id`, [org, meetingId, label, text, stage])).rows[0]?.id as string;
  const result = async (meetingId: string, summary: string, decisions: string[], stage: 'draft' | 'published', tainted = false) =>
    (await sqlAdmin<{ id: string }>(`INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage, tainted) VALUES ($1, $2, $3, $4::jsonb, 'manual', $5, $6) RETURNING id`, [orgId, meetingId, summary, JSON.stringify(decisions), stage, tainted])).rows[0]?.id as string;
  const item = async (meetingId: string, title: string, stage: 'draft' | 'published', who = 'Hà') =>
    (await sqlAdmin<{ id: string }>(`INSERT INTO crove_meetings.action_item (org_id, meeting_id, title, who_drafted, when_drafted, stage) VALUES ($1, $2, $3, $4, 'thứ sáu', $5) RETURNING id`, [orgId, meetingId, title, who, stage])).rows[0]?.id as string;
  const textOf = async (table: string, id: string, column: string) => (await sqlAdmin<{ v: string }>(`SELECT ${column}::text AS v FROM crove_meetings.${table} WHERE id = $1`, [id])).rows[0]?.v as string;
  const erasedRows = (e: PersonalDataErasure, column: string) => e.erased.find((r) => r.column === column)?.rows ?? 0;

  // What the erasure must never touch (row counts), taken before and after.
  const untouchedCounts = async () => ({
    vy: await count('SELECT 1 FROM crove_kernel.member_vy_result'),
    audio: await count('SELECT 1 FROM crove_meetings.audio_segment'),
    files: await count('SELECT 1 FROM crove_kernel.file'),
    readers: await count('SELECT 1 FROM crove_meetings.meeting_reader'),
    keys: await count('SELECT 1 FROM crove_meetings.media_key'),
  });

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
    setSummaryEnabled(false);
    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'outsider']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'meetings-erase', subject: key, email: `${key}@meetings-erase.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Xóa trong họp')).orgId;
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

  it('redacts at once what the owner reads, leaves what they cannot read, and changes nothing but the text', async () => {
    // Readable: a meeting shared with the org (published rows, the title) and the owner's own meeting (a draft).
    const shared = await meeting('recorder', `Họp báo giá ${EMAIL}`, 'org');
    const line = await segment(shared, `Gửi hợp đồng về ${EMAIL} nhé, tổng 1.250.000 đồng hạn 12/03/2026`, 'published', `Anh ${EMAIL}`);
    const summary = await result(shared, `Chốt giá, gửi tới ${EMAIL}. Giữ nguyên chiết khấu 10%`, [`Liên hệ ${EMAIL}`, 'Không đổi giá'], 'published');
    const published = await item(shared, `Gửi báo giá tới ${EMAIL}`, 'published', EMAIL);
    const own = await meeting('owner', 'Họp của chủ', 'attendees');
    const ownLine = await segment(own, `Nháp của chủ ${EMAIL}`, 'draft');
    // Not readable: the recorder's draft in the shared meeting, and an attendees-only meeting the owner is no reader of.
    const sharedDraft = await segment(shared, `Nháp riêng của người ghi ${EMAIL}`, 'draft');
    const hidden = await meeting('recorder', `Họp kín ${EMAIL}`, 'attendees', ['attendee']);
    const hiddenLine = await segment(hidden, `Chuyện kín về ${EMAIL}`, 'published');
    const hiddenItem = await item(hidden, `Việc kín cho ${EMAIL}`, 'draft');
    // Another org holds the value too.
    const foreign = await meeting('outsider', 'Họp org khác', 'attendees', [], otherOrgId);
    const foreignLine = await segment(foreign, `Của org khác ${EMAIL}`, 'published', 'Hà', otherOrgId);
    // The things an erasure must not touch.
    await sqlAdmin(`INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'a.opus', 'audio/ogg', 10, 'meeting_audio')`, [orgId, randomUUID(), 'a'.repeat(64), `org/${orgId}/${'a'.repeat(64)}`]);
    const fileId = (await sqlAdmin<{ id: string }>(`SELECT id FROM crove_kernel.file WHERE org_id = $1 AND filename = 'a.opus'`, [orgId])).rows[0]?.id;
    await sqlAdmin(`INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES ($1, $2, $3, $4, 0, 0, 600)`, [orgId, randomUUID(), hidden, fileId]);
    await runtime.execute('kernel.member_vy.run.start', { feature: 'meetings.summary', subjectType: 'meeting', subjectId: shared }, { actor: asUser('recorder'), orgId });
    const before = await untouchedCounts();
    expect(before.vy).toBeGreaterThan(0);

    const erased = await erase();
    // The readable rows: every whole mention gone, the rest of each text, the amounts and the dates kept.
    expect(await textOf('transcript_segment', line, 'text')).toBe(`Gửi hợp đồng về ${MARK} nhé, tổng 1.250.000 đồng hạn 12/03/2026`);
    expect(await textOf('transcript_segment', line, 'speaker_label')).toBe(`Anh ${MARK}`);
    expect(await textOf('meeting_result', summary, 'summary')).toBe(`Chốt giá, gửi tới ${MARK}. Giữ nguyên chiết khấu 10%`);
    expect(JSON.parse(await textOf('meeting_result', summary, 'decisions'))).toEqual([`Liên hệ ${MARK}`, 'Không đổi giá']);
    expect(await textOf('action_item', published, 'title')).toBe(`Gửi báo giá tới ${MARK}`);
    expect(await textOf('action_item', published, 'who_drafted')).toBe(MARK);
    expect(await textOf('meeting', shared, 'title')).toBe(`Họp báo giá ${MARK}`);
    expect(await textOf('transcript_segment', ownLine, 'text')).toBe(`Nháp của chủ ${MARK}`);
    // The rows the owner cannot read stay: the recorder's draft in the shared meeting, and the whole attendees-only meeting.
    expect(await textOf('transcript_segment', sharedDraft, 'text')).toContain(EMAIL);
    expect(await textOf('transcript_segment', hiddenLine, 'text')).toContain(EMAIL);
    expect(await textOf('action_item', hiddenItem, 'title')).toContain(EMAIL);
    expect(await textOf('meeting', hidden, 'title')).toContain(EMAIL);
    expect(await textOf('transcript_segment', foreignLine, 'text')).toContain(EMAIL);
    expect(erasedRows(erased, 'crove_meetings.transcript_segment.text')).toBe(2);
    expect(erasedRows(erased, 'crove_meetings.meeting_result.summary')).toBe(1);
    expect(erasedRows(erased, 'crove_meetings.action_item.title')).toBe(1);
    expect(erasedRows(erased, 'crove_meetings.meeting.title')).toBe(1);
    // The answer says what it left: the unread text, the audio and its date with the way to delete a meeting now, and the Vy results it cannot read.
    expect(erased.kept.find((k) => k.column === 'crove_meetings.text')?.reason).toMatch(/send the notice/);
    const audio = erased.kept.find((k) => k.column === 'crove_meetings.audio');
    expect(audio?.rows).toBe(1);
    expect(audio?.reason).toMatch(/owner_delete/);
    expect(audio?.reason).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(erased.kept.find((k) => k.column === 'crove_kernel.member_vy_result.body')?.reason).toMatch(/at most 31 days/);
    // Nothing else changed.
    expect(await untouchedCounts()).toEqual(before);
    // The audit row has counts and ids only, never the value or a text.
    const audit = JSON.stringify((await sqlAdmin(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.erase' ORDER BY id DESC LIMIT 1`, [orgId])).rows);
    for (const secret of [EMAIL, 'Chuyện kín', 'Nháp riêng']) expect(audit, secret).not.toContain(secret);
    // A second run changes nothing more.
    const again = await erase();
    expect(erasedRows(again, 'crove_meetings.transcript_segment.text')).toBe(0);
    expect(await textOf('transcript_segment', line, 'text')).toBe(`Gửi hợp đồng về ${MARK} nhé, tổng 1.250.000 đồng hạn 12/03/2026`);
  });

  it('redacts a meeting the owner cannot read only after a notice names it at its text and its recorder was told 24 hours ago, and keeps its taint', async () => {
    const value = 'nguoi.can.xoa@khach.example';
    const hidden = await meeting('recorder', 'Họp kín thứ hai', 'attendees', ['attendee']);
    const line = await segment(hidden, `Gửi tới ${value}`, 'published');
    const draft = await result(hidden, `Tóm tắt kín ${value}`, [`Gọi ${value}`], 'draft', true);
    // No notice yet: nothing is redacted, and the answer counts it.
    const first = await erase(value);
    expect(erasedRows(first, 'crove_meetings.transcript_segment.text')).toBe(0);
    expect(await textOf('transcript_segment', line, 'text')).toContain(value);
    expect(first.kept.find((k) => k.column === 'crove_meetings.text')?.rows).toBeGreaterThanOrEqual(2);
    // The notice: the recorder is named with a count, no text.
    const notice = await notify(value);
    expect(notice.authors).toEqual([{ authorUserId: users.recorder, notes: 0, todos: 0, meetings: 1 }]);
    const detail = (await sqlAdmin<{ detail: { event: string; meetings: string[]; meeting_key: string } }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.notify' ORDER BY id DESC LIMIT 1`, [orgId])).rows[0]?.detail;
    expect(detail?.meetings).toHaveLength(1);
    expect(detail?.meetings[0]).toMatch(new RegExp(`^${hidden}:-?\\d+$`));
    expect(JSON.stringify(detail)).not.toContain(value);
    // Sent, but the recorder was not told yet (no notification): kept.
    expect(erasedRows(await erase(value), 'crove_meetings.transcript_segment.text')).toBe(0);
    const told = (hoursAgo: number) =>
      sqlAdmin(`INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, created_at) VALUES ($1, $2, 'kernel.personal_data_notice', $3, now() - make_interval(hours => $4))`, [orgId, users.recorder, `personal_data_notice:${detail?.event}`, hoursAgo]);
    const age = () =>
      admin(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [orgId]);
        await c.query('COMMIT');
      });
    // Told only an hour ago: kept.
    await told(1);
    await age();
    expect(erasedRows(await erase(value), 'crove_meetings.transcript_segment.text')).toBe(0);
    // Told a day ago, but the recorder changed the text after the notice: the notice did not see it, so it stays.
    await sqlAdmin(`UPDATE crove_kernel.notification SET created_at = now() - interval '25 hours' WHERE org_id = $1 AND dedupe_key = $2`, [orgId, `personal_data_notice:${detail?.event}`]);
    await sqlAdmin(`UPDATE crove_meetings.transcript_segment SET text = text || ' (sửa)' WHERE id = $1`, [line]);
    expect(erasedRows(await erase(value), 'crove_meetings.transcript_segment.text')).toBe(0);
    expect(await textOf('transcript_segment', line, 'text')).toContain(value);
    // A new notice at the text as it is now, told a day ago: redacted, and the tainted draft is still tainted and still refused for publishing.
    await notify(value);
    const fresh = (await sqlAdmin<{ detail: { event: string } }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.notify' ORDER BY id DESC LIMIT 1`, [orgId])).rows[0]?.detail;
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [orgId]);
      await c.query('COMMIT');
    });
    await sqlAdmin(`INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, created_at) VALUES ($1, $2, 'kernel.personal_data_notice', $3, now() - interval '25 hours')`, [orgId, users.recorder, `personal_data_notice:${fresh?.event}`]);
    const done = await erase(value);
    expect(erasedRows(done, 'crove_meetings.transcript_segment.text')).toBe(1);
    expect(erasedRows(done, 'crove_meetings.meeting_result.summary')).toBe(1);
    expect(await textOf('transcript_segment', line, 'text')).toBe(`Gửi tới ${MARK} (sửa)`);
    expect(await textOf('meeting_result', draft, 'summary')).toBe(`Tóm tắt kín ${MARK}`);
    expect(await textOf('meeting_result', draft, 'tainted')).toBe('true');
    await expect(runtime.execute('meetings.result.publish', { meetingId: hidden, confirmed: true }, { actor: asUser('recorder'), orgId })).rejects.toMatchObject({ code: 'DRAFT_NOT_REVIEWED' });
  });

  // The notice's meetings are named at the text the OWNER cannot read: the owner's own redaction of the rest does not make a notice stale, and a notice for another value never covers.
  it('keeps a notice valid when the owner erases at once, covers only its own value, and treats +84 and 0 as one phone number', async () => {
    const value = 'moi.lien.he@khach.example';
    const shared = await meeting('recorder', 'Họp chung có nháp', 'org');
    const published = await segment(shared, `Dòng chung ${value}`, 'published');
    const draft = await segment(shared, `Nháp riêng ${value}`, 'draft');
    const eventOf = async () => (await sqlAdmin<{ event: string }>(`SELECT detail ->> 'event' AS event FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.notify' ORDER BY id DESC LIMIT 1`, [orgId])).rows[0]?.event as string;
    await notify(value);
    const event = await eventOf();
    // The owner erases straight away: the published line (the owner reads it) goes, the recorder's draft stays.
    const now = await erase(value);
    expect(erasedRows(now, 'crove_meetings.transcript_segment.text')).toBe(1);
    expect(await textOf('transcript_segment', published, 'text')).toBe(`Dòng chung ${MARK}`);
    expect(await textOf('transcript_segment', draft, 'text')).toContain(value);
    // A day later the notice still covers the draft: the owner's own redaction did not change what the notice saw.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [orgId]);
      await c.query('COMMIT');
    });
    await sqlAdmin(`INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, created_at) VALUES ($1, $2, 'kernel.personal_data_notice', $3, now() - interval '25 hours')`, [orgId, users.recorder, `personal_data_notice:${event}`]);
    // A notice sent for another value does not cover this one.
    expect(erasedRows(await erase('autre.personne@khach.example'), 'crove_meetings.transcript_segment.text')).toBe(0);
    expect(await textOf('transcript_segment', draft, 'text')).toContain(value);
    const later = await erase(value);
    expect(erasedRows(later, 'crove_meetings.transcript_segment.text')).toBe(1);
    expect(await textOf('transcript_segment', draft, 'text')).toBe(`Nháp riêng ${MARK}`);

    // The same for a phone number written +84 in the notice and 0 in the erasure.
    const room = await meeting('recorder', 'Họp kín số điện thoại', 'attendees', ['attendee']);
    const phoneLine = await segment(room, 'Gọi anh Tuấn số 0912 345 678 nhé', 'published');
    await notify('84912345678');
    const phoneEvent = await eventOf();
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [orgId]);
      await c.query('COMMIT');
    });
    await sqlAdmin(`INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, created_at) VALUES ($1, $2, 'kernel.personal_data_notice', $3, now() - interval '25 hours')`, [orgId, users.recorder, `personal_data_notice:${phoneEvent}`]);
    expect(erasedRows(await erase('0912345678'), 'crove_meetings.transcript_segment.text')).toBe(1);
    expect(await textOf('transcript_segment', phoneLine, 'text')).toBe(`Gọi anh Tuấn số ${MARK} nhé`);
  });

  it('does not redact text the recorder edits while the erasure waits for it: the edit is not what the notice saw', async () => {
    const value = 'sua.dang.xoa@khach.example';
    const hidden = await meeting('recorder', 'Họp kín đang sửa', 'attendees', ['attendee']);
    const line = await segment(hidden, `Dòng ${value}`, 'published');
    await notify(value);
    const event = (await sqlAdmin<{ event: string }>(`SELECT detail ->> 'event' AS event FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.notify' ORDER BY id DESC LIMIT 1`, [orgId])).rows[0]?.event as string;
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [orgId]);
      await c.query('COMMIT');
    });
    await sqlAdmin(`INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, created_at) VALUES ($1, $2, 'kernel.personal_data_notice', $3, now() - interval '25 hours')`, [orgId, users.recorder, `personal_data_notice:${event}`]);
    // The recorder's correction holds the line's lock, uncommitted, while the erasure starts and waits.
    const editor = new pg.Client({ connectionString: adminUrl });
    await editor.connect();
    try {
      await editor.query('BEGIN');
      await editor.query(`UPDATE crove_meetings.transcript_segment SET text = text || ' (đã sửa)' WHERE id = $1`, [line]);
      const erasing = erase(value);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        waiting = (await count("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%personal_erase%'")) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      await editor.query('COMMIT');
      const out = await erasing;
      expect(erasedRows(out, 'crove_meetings.transcript_segment.text')).toBe(0);
    } finally {
      await editor.end();
    }
    // The edited text, which no notice saw, stays.
    expect(await textOf('transcript_segment', line, 'text')).toBe(`Dòng ${value} (đã sửa)`);
  });

  it('redacts decisions one element at a time and keeps the array shape', async () => {
    const value = 'quyet.dinh@khach.example';
    const shared = await meeting('recorder', 'Họp có quyết định', 'org');
    const summary = await result(shared, 'Tóm tắt không nhắc ai', ['Giữ giá cũ', `Gửi ${value} bản chốt`, 'Họp lại "tuần sau"\nvà bàn tiếp'], 'published');
    await erase(value);
    expect(JSON.parse(await textOf('meeting_result', summary, 'decisions'))).toEqual(['Giữ giá cũ', `Gửi ${MARK} bản chốt`, 'Họp lại "tuần sau"\nvà bàn tiếp']);
    expect(await textOf('meeting_result', summary, 'summary')).toBe('Tóm tắt không nhắc ai');
  });

  it('fails the find when the database refuses a meeting scan (only a timeout is skipped)', async () => {
    await sqlAdmin('REVOKE EXECUTE ON FUNCTION crove_meetings.personal_row_ids(text, text) FROM crove_tenant');
    try {
      await expect(find('owner')).rejects.toBeTruthy();
    } finally {
      await sqlAdmin('GRANT EXECUTE ON FUNCTION crove_meetings.personal_row_ids(text, text) TO crove_tenant');
    }
    // And the finder is whole again.
    expect((await find('owner')).meetingTextSkipped).toBe(false);
  });
});
