// SPDX-License-Identifier: AGPL-3.0-only
// The follow-ups of the erasure in meeting text (#2917, review of #2915): the audio date's wording, the notice's clock, decision elements that are not strings, and the lock order against a
// recorder's edit (no deadlock, and a deadlock that still happens is a retryable error).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { PersonalDataErasure, PersonalDataNotice } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const EMAIL = 'khach.hang@congty.example';
const MARK = '[đã xóa]';

suite('the erasure in meeting text: follow-ups (#2917)', () => {
  const dbName = `crove_test_meetings_erase_fu_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let worker: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const asMfa = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
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
  const textOf = async (table: string, id: string, column: string) => (await sqlAdmin<{ v: string }>(`SELECT ${column}::text AS v FROM crove_meetings.${table} WHERE id = $1`, [id])).rows[0]?.v as string;


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
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    const workerUrl = (() => {
      const u = new URL(adminUrl);
      u.username = 'crove_worker';
      u.password = 'test-worker-pw';
      return u.toString();
    })();
    const workerPool = createPool({ connectionString: workerUrl, max: 4 });
    pools.push(workerPool);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    setSummaryEnabled(false);
    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'outsider']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'meetings-erase', subject: key, email: `${key}@meetings-erase.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Xóa trong họp')).orgId;
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


  const SYSTEM = { type: 'system' as const, component: 'test.meetings-erase-followups' };
  const noticeEvent = async () => (await sqlAdmin<{ event: string }>(`SELECT detail ->> 'event' AS event FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.notify' ORDER BY id DESC LIMIT 1`, [orgId])).rows[0]?.event as string;
  const lockWait = async (needle: string) => {
    for (let i = 0; i < 100; i += 1) {
      if ((await count(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%${needle}%'`)) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  // N2: the audio date of the answer comes from the meetings the owner reads; a hidden meeting is only counted, so its date does not show.
  it('gives the audio retention date of readable meetings only and counts the hidden ones', async () => {
    const value = 'khach.cu@congty.example';
    const audioOf = async (meetingId: string, date: string) => {
      await sqlAdmin(`UPDATE crove_meetings.meeting SET audio_retention_date = $3 WHERE org_id = $1 AND id = $2`, [orgId, meetingId, date]);
      const fileId = randomUUID();
      const sha = randomUUID().replaceAll('-', '').repeat(2);
      await sqlAdmin(`INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'a.opus', 'audio/ogg', 10, 'meeting_audio')`, [orgId, fileId, sha, `org/${orgId}/${sha}`]);
      await sqlAdmin(`INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES ($1, $2, $3, $4, 0, 0, 600)`, [orgId, randomUUID(), meetingId, fileId]);
    };
    const hidden = await meeting('recorder', 'Họp kín có ghi âm', 'attendees', ['attendee']);
    await segment(hidden, `Gửi ${value}`, 'published');
    await audioOf(hidden, '2027-01-02');
    const shared = await meeting('recorder', 'Họp chung có ghi âm', 'org');
    await segment(shared, `Gửi ${value}`, 'published');
    await audioOf(shared, '2027-06-30');
    const out = await erase(value);
    const audio = out.kept.find((k) => k.column === 'crove_meetings.audio');
    expect(audio?.rows).toBe(2);
    expect(audio?.reason).toContain('2027-06-30');
    expect(audio?.reason).not.toContain('2027-01-02');
    expect(audio?.reason).toMatch(/1 more held in meetings the owner cannot read/);
  });

  // N3: the notice's notification is stamped by the database clock, so the 24 hours the erasure waits are the database's, whatever the kernel's clock says.
  it('stamps the notice notification with the database clock, not the kernel\'s', async () => {
    const value = 'dong.ho@congty.example';
    const hidden = await meeting('recorder', 'Họp kín đồng hồ', 'attendees', ['attendee']);
    await segment(hidden, `Gửi ${value}`, 'published');
    await notify(value);
    const event = await noticeEvent();
    const eventId = (await sqlAdmin<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.personal_data.notified' ORDER BY id DESC LIMIT 1`, [orgId])).rows[0]?.id as string;
    expect(event).toBe(eventId);
    // The kernel's clock is a day behind while it dispatches.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() - 24 * 3_600_000));
      await worker.execute('kernel.notification.dispatch', { eventId }, { actor: SYSTEM, orgId });
    } finally {
      vi.useRealTimers();
    }
    const skew = (
      await sqlAdmin<{ s: string }>(`SELECT extract(epoch FROM (now() - created_at))::text AS s FROM crove_kernel.notification WHERE org_id = $1 AND dedupe_key = $2 AND user_id = $3`, [orgId, `personal_data_notice:${event}`, users.recorder])
    ).rows[0]?.s;
    expect(Number(skew)).toBeLessThan(60);
  });

  // N4: the finder reads the decisions as text, so the column takes string elements only (a number or a nested value would be found but never cleared); the erasure redacts every string.
  it('refuses decision elements that are not strings and redacts the strings', async () => {
    // 10 digits: a shorter number is left alone (#3064).
    const value = '1234567890';
    const shared = await meeting('recorder', 'Họp quyết định lẫn kiểu', 'org');
    for (const bad of [[12345678], [{ gia: 12345678 }], [true], [null], ['ok', 7], [['x']], [[]]]) {
      await expect(result(shared, 'Tóm tắt', bad as unknown as string[], 'published')).rejects.toMatchObject({ code: '23514' });
    }
    const summary = await result(shared, 'Tóm tắt', ['Giữ giá', `Gọi ${value} nhé`], 'published');
    const out = await erase(value);
    expect(JSON.parse(await textOf('meeting_result', summary, 'decisions'))).toEqual(['Giữ giá', `Gọi ${MARK} nhé`]);
    expect(out.kept.filter((k) => k.column.startsWith('crove_meetings.'))).toEqual([]);
  });

  // N5: the lock order. A recorder's replaceDraft holds the draft's old lines and then inserts new ones (a FOR KEY SHARE of the meeting row for the foreign key): the erasure, which holds
  // the meeting row, must not block that insert.
  it('does not deadlock with a recorder who replaces a draft while the erasure runs', async () => {
    const value = 'khoa.thu.tu@congty.example';
    const hidden = await meeting('recorder', 'Họp kín thay bản nháp', 'attendees', ['attendee']);
    const oldLine = await segment(hidden, `Nháp cũ ${value}`, 'draft');
    const editor = new pg.Client({ connectionString: adminUrl });
    await editor.connect();
    try {
      await editor.query('BEGIN');
      await editor.query('DELETE FROM crove_meetings.transcript_segment WHERE id = $1', [oldLine]);
      const erasing = erase(value);
      expect(await lockWait('personal_erase')).toBe(true);
      // The recorder now inserts the replacement line: it needs the meeting row's key share, which the erasure's lock must allow.
      await editor.query(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, 0, 5, 'Hà', 'Nháp mới', 'draft')`, [orgId, hidden]);
      await editor.query('COMMIT');
      await expect(erasing).resolves.toBeTruthy();
    } finally {
      await editor.end();
    }
    expect(await count('SELECT 1 FROM crove_meetings.transcript_segment WHERE meeting_id = $1 AND text = $2', [hidden, 'Nháp mới'])).toBe(1);
  });

  it('answers a deadlock that still happens with a retryable error and changes nothing', async () => {
    const value = 'bi.khoa.cheo@congty.example';
    const room = await meeting('recorder', 'Họp kín khóa chéo', 'attendees', ['attendee']);
    const line = await segment(room, `Dòng ${value}`, 'published');
    const other = new pg.Client({ connectionString: adminUrl });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(`UPDATE crove_meetings.transcript_segment SET text = text WHERE id = $1`, [line]);
      const erasing = erase(value).then(
        (v) => ({ ok: true as const, v }),
        (e: { code?: string }) => ({ ok: false as const, code: e.code }),
      );
      expect(await lockWait('personal_erase')).toBe(true);
      // The other session now wants the meeting row exclusively, which the erasure holds, while the erasure waits for the line this session holds: a cycle. The erasure waited first, so the
      // database ends it (after deadlock_timeout), and the other session goes on.
      await other.query('SELECT 1 FROM crove_meetings.meeting WHERE id = $1 FOR UPDATE', [room]);
      await other.query('COMMIT');
      const out = await erasing;
      expect(out).toEqual({ ok: false, code: 'PERSONAL_DATA_BUSY' });
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      await other.end();
    }
    expect(await textOf('transcript_segment', line, 'text')).toBe(`Dòng ${value}`);
  }, 60_000);
});
