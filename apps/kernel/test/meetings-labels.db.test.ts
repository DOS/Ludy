// SPDX-License-Identifier: AGPL-3.0-only
// Labels on a meeting (#4955) on a real database: the recorder puts up to five short plain-text labels on a meeting; the same label twice (whatever the case) is one label; the meeting's readers read them, a member who
// cannot read the meeting finds no meeting and an owner has no extra right to it; only the recorder adds and removes; a text that looks like an address, a phone number or an ID is refused; the labels across the readable
// meetings are listed with their counts and leave out a meeting past its text date; the labels go with the meeting; the audit rows hold ids, never the text; and the export reader is the worker's alone.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { MEETING_LABELS_MAX, type LabelAdded, type LabelRemoved, type MeetingLabels, type MeetingLabelsInUse, type MeetingListItem } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('Meeting labels (#4955)', () => {
  const dbName = `ludy_test_meeting_label_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const NAMES: Record<string, string> = { owner: 'Chủ Công Ty', rec: 'Phạm Quang Minh', lan: 'Trần Thị Lan', nam: 'Nguyễn Văn Nam', other: 'Bạn Không Đọc', solo: 'Thành Viên Riêng', viewer: 'Người Xem' };
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const put = (who: string, meetingId: string, label: string) => runtime.execute<LabelAdded>('meetings.label.add', { meetingId, label }, { actor: asUser(who), orgId });
  const take = (who: string, meetingId: string, labelId: string) => runtime.execute<LabelRemoved>('meetings.label.remove', { meetingId, labelId }, { actor: asUser(who), orgId });
  const list = (who: string, meetingId: string) => runtime.query<MeetingLabels>('meetings.label.list', { meetingId }, { actor: asUser(who), orgId });
  const inUse = (who: string, limit?: number) => runtime.query<MeetingLabelsInUse>('meetings.label.in_use', limit === undefined ? {} : { limit }, { actor: asUser(who), orgId });
  // The meetings list: each row carries the labels of its meeting (#4966).
  const rows = (who: string) => runtime.query<MeetingListItem[]>('meetings.meeting.list', { limit: 200 }, { actor: asUser(who), orgId });
  const texts = async (who: string, meetingId: string) => (await list(who, meetingId)).labels.map((l) => l.label);
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

  // A meeting held on Wednesday 25 November 2026 (Vietnam time), recorded by `rec` and read by `lan` and `nam`; its text period ends in a year, or yesterday for an expired one.
  async function meeting(title: string, opts: { readers?: string[]; expired?: boolean; visibility?: 'attendees' | 'org'; startedAt?: string } = {}): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $4, 'vi', $6::timestamptz, $6::timestamptz + interval '1 hour', 3600, $3, $5, 'ready', 'told_at_start', $3, now(), '1.0', current_date - 1, ${opts.expired ? 'current_date - 1' : 'current_date + 365'})`,
      [orgId, id, users.rec, title, opts.visibility ?? 'attendees', opts.startedAt ?? '2026-11-25T03:00:00Z'],
    );
    for (const reader of opts.readers ?? ['lan', 'nam']) await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[reader]]);
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
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of Object.keys(NAMES)) users[key] = await upsertIdentity(db, { issuer: 'lb', subject: key, email: `${key}@lb.test`, name: NAMES[key] as string });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Nhãn Họp')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'viewer')`, [orgId, users.rec, users.lan, users.nam, users.other, users.solo, users.viewer]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('the recorder labels a meeting; the same label twice is one, whatever the case and the spaces; the readers read the labels in the order they were added', async () => {
    const id = await meeting('Họp khách Hoa Sen');
    const first = await put('rec', id, '  Khách   Hoa Sen ');
    expect(first).toMatchObject({ meetingId: id, label: 'Khách Hoa Sen', created: true });
    const again = await put('rec', id, 'khách hoa sen');
    expect(again).toEqual({ meetingId: id, labelId: first.labelId, label: 'Khách Hoa Sen', created: false });
    await put('rec', id, 'Dự án website');
    for (const who of ['rec', 'lan', 'nam']) expect(await texts(who, id), who).toEqual(['Khách Hoa Sen', 'Dự án website']);
  });

  it('a meeting has at most five labels, and a label that is already there is still answered at the limit', async () => {
    const id = await meeting('Họp đủ năm nhãn');
    for (let i = 1; i <= MEETING_LABELS_MAX; i++) await put('rec', id, `Nhãn ${i}`);
    await expect(put('rec', id, 'Nhãn sáu')).rejects.toMatchObject({ code: 'MEETING_LABEL_LIMIT' });
    expect((await put('rec', id, 'NHÃN 3')).created).toBe(false);
    expect(await texts('rec', id)).toHaveLength(MEETING_LABELS_MAX);
  });

  it('refuses a text that is empty, too long, has a line break, an "@" or a run of seven digits', async () => {
    const id = await meeting('Họp nhãn không hợp lệ');
    for (const bad of ['   ', 'x'.repeat(41), 'một\nhai', 'khach@example.com', 'Gọi 0901 234 567', 'MST 1234567890']) {
      await expect(put('rec', id, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'MEETING_LABEL_INVALID' });
    }
    // A short number or a month and year is fine.
    expect((await put('rec', id, 'Quý 4 - 2026')).created).toBe(true);
    expect(await texts('rec', id)).toEqual(['Quý 4 - 2026']);
  });

  it('only the recorder adds and removes; a reader may not, and an unknown label is not found', async () => {
    const id = await meeting('Họp chỉ người ghi gắn nhãn');
    const made = await put('rec', id, 'Họp tuần');
    await expect(put('lan', id, 'Của Lan')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(take('lan', id, made.labelId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await texts('nam', id)).toEqual(['Họp tuần']);
    expect(await take('rec', id, made.labelId)).toEqual({ meetingId: id, labelId: made.labelId });
    expect(await texts('rec', id)).toEqual([]);
    await expect(take('rec', id, made.labelId)).rejects.toMatchObject({ code: 'MEETING_LABEL_NOT_FOUND' });
  });

  it('a member who cannot read the meeting finds no meeting, and an owner has no extra right to it', async () => {
    const id = await meeting('Họp riêng của nhóm');
    const made = await put('rec', id, 'Bí mật nhóm');
    for (const who of ['other', 'owner']) {
      await expect(list(who, id), `list ${who}`).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
      await expect(put(who, id, 'Chen vào'), `add ${who}`).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
      await expect(take(who, id, made.labelId), `remove ${who}`).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
      expect((await rows(who)).flatMap((m) => m.labels), `list ${who}`).not.toContain('Bí mật nhóm');
    }
    expect(await texts('lan', id)).toEqual(['Bí mật nhóm']);
  });

  it('the meetings list carries each meeting\'s labels in the order they were added, an empty list for a meeting with none, and leaves out a meeting the caller cannot read or one past its text date (#4966)', async () => {
    const a = await meeting('Họp A', { readers: ['lan'] });
    const b = await meeting('Họp B', { readers: ['lan'] });
    const bare = await meeting('Họp không nhãn', { readers: ['lan'] });
    const hidden = await meeting('Họp C của người khác', { readers: ['nam'] });
    const expired = await meeting('Họp D đã hết hạn', { readers: ['lan'], expired: true });
    await put('rec', a, 'Chỉ ở họp A');
    await put('rec', b, 'chỉ ở họp A');
    await put('rec', b, 'Riêng họp B');
    await put('rec', hidden, 'Riêng của Nam');
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_label (org_id, meeting_id, label, created_by) VALUES ($1, $2, $3, $4)', [orgId, expired, 'Đã hết hạn', users.rec]);
    const seen = await rows('lan');
    expect(seen.find((m) => m.id === a)?.labels).toEqual(['Chỉ ở họp A']);
    expect(seen.find((m) => m.id === b)?.labels).toEqual(['chỉ ở họp A', 'Riêng họp B']);
    expect(seen.find((m) => m.id === bare)?.labels).toEqual([]);
    // Not the meeting nor its label when Lan does not read it, and not a meeting past its text date.
    expect(seen.find((m) => m.id === hidden)).toBeUndefined();
    expect(seen.find((m) => m.id === expired)).toBeUndefined();
    expect(seen.flatMap((m) => m.labels)).not.toContain('Riêng của Nam');
    expect(seen.flatMap((m) => m.labels)).not.toContain('Đã hết hạn');
    // The recorder reads the labels of all their meetings.
    expect((await rows('rec')).find((m) => m.id === hidden)?.labels).toEqual(['Riêng của Nam']);
    // Every meeting of the page answers with its own labels, however many are labelled: no cap besides the page.
    for (const m of seen) expect(m.labels.length).toBeLessThanOrEqual(MEETING_LABELS_MAX);
  });

  it('the labels go with the meeting', async () => {
    const id = await meeting('Họp bị xóa');
    await put('rec', id, 'Sẽ biến mất');
    await put('rec', id, 'Cùng với họp');
    const count = () => sqlAdmin<{ n: number }>('SELECT count(*)::int AS n FROM ludy_meetings.meeting_label WHERE org_id = $1 AND meeting_id = $2', [orgId, id]);
    expect((await count()).rows[0]).toEqual({ n: 2 });
    await sqlAdmin('DELETE FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, id]);
    expect((await count()).rows[0]).toEqual({ n: 0 });
  });

  it('the audit rows hold ids, never the text of a label', async () => {
    const id = await meeting('Họp kiểm toán nhãn');
    const made = await put('rec', id, 'Nhãn rất riêng');
    await take('rec', id, made.labelId);
    const audit = await sqlAdmin<{ row: string }>(
      `SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%meetings.label.%' AND audit_event::text LIKE $2`,
      [orgId, `%${id}%`],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    const text = audit.rows.map((r) => r.row).join('\n');
    for (const secret of ['rất riêng', 'Họp kiểm toán']) expect(text, secret).not.toContain(secret);
    expect(text).toContain(made.labelId);
  });

  it('a login role cannot edit a label, and the export reader is the worker login\'s alone', async () => {
    const id = await meeting('Họp quyền hạn nhãn');
    await put('rec', id, 'Nhãn quyền');
    const privileges = await sqlAdmin<{ tenant_update: boolean; tenant_exec: boolean; worker_exec: boolean; public_exec: boolean }>(
      `SELECT pg_catalog.has_table_privilege('ludy_tenant', 'ludy_meetings.meeting_label', 'UPDATE') AS tenant_update,
              pg_catalog.has_function_privilege('ludy_tenant', 'ludy_kernel.meeting_label_export_rows()', 'EXECUTE') AS tenant_exec,
              pg_catalog.has_function_privilege('ludy_worker', 'ludy_kernel.meeting_label_export_rows()', 'EXECUTE') AS worker_exec,
              pg_catalog.has_function_privilege('public', 'ludy_kernel.meeting_label_export_rows()', 'EXECUTE') AS public_exec`,
    );
    expect(privileges.rows[0]).toEqual({ tenant_update: false, tenant_exec: false, worker_exec: true, public_exec: false });
  });

  it('lists distinct labels in use on readable non-expired meetings, grouped case-insensitively and sorted most used first, enforcing RLS and limits (#5039)', async () => {
    const oldMeeting = await meeting('Họp cũ', { readers: ['solo'], startedAt: '2026-11-20T03:00:00Z' });
    const midMeeting = await meeting('Họp giữa', { readers: ['solo'], startedAt: '2026-11-22T03:00:00Z' });
    const newMeeting = await meeting('Họp mới', { readers: ['solo'], startedAt: '2026-11-24T03:00:00Z' });
    const hidden = await meeting('Họp kín của Nam', { readers: ['nam'], startedAt: '2026-11-25T03:00:00Z' });
    const expired = await meeting('Họp hết hạn của Solo', { readers: ['solo'], expired: true, startedAt: '2026-11-25T05:00:00Z' });

    await put('rec', oldMeeting, 'Khách A');
    await put('rec', oldMeeting, 'Nhãn Cũ');
    await put('rec', midMeeting, 'khách a');
    await put('rec', newMeeting, 'KHÁCH A');
    await put('rec', newMeeting, 'Nhãn Mới');
    await put('rec', hidden, 'Bí mật riêng');
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_label (org_id, meeting_id, label, created_by) VALUES ($1, $2, $3, $4)', [orgId, expired, 'Nhãn Hết Hạn', users.rec]);

    // Grouped case-insensitively with newest meeting spelling on ties, sorted count DESC then started_at DESC then lower(label) ASC; hides hidden and expired meetings.
    expect(await inUse('solo')).toEqual({
      labels: [
        { label: 'KHÁCH A', count: 3 },
        { label: 'Nhãn Mới', count: 1 },
        { label: 'Nhãn Cũ', count: 1 },
      ],
    });
    expect(await inUse('solo', 2)).toEqual({
      labels: [
        { label: 'KHÁCH A', count: 3 },
        { label: 'Nhãn Mới', count: 1 },
      ],
    });

    // Owner cannot read attendees-only meetings' labels (not even Solo's or Nam's).
    const ownerLabels = (await inUse('owner')).labels.map((l) => l.label);
    expect(ownerLabels).not.toContain('KHÁCH A');
    expect(ownerLabels).not.toContain('Bí mật riêng');
    expect(ownerLabels).not.toContain('Nhãn Hết Hạn');

    // Recorder still reads their hidden meeting's label (minus expired).
    const recLabels = (await inUse('rec')).labels.map((l) => l.label);
    expect(recLabels).toContain('Bí mật riêng');
    expect(recLabels).not.toContain('Nhãn Hết Hạn');

    // Viewer and system context are refused.
    await expect(inUse('viewer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.query('meetings.label.in_use', {}, { actor: { type: 'system', component: 'test.label-in-use' }, orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
