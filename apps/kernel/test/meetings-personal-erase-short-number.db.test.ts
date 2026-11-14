// SPDX-License-Identifier: AGPL-3.0-only
// The short-number guard of the erasure in meeting text (#3064): a digit value of fewer than 10 digits may as well be a date or a figure in a transcript line, a summary, a decision, an
// action item or a title, and a redaction cannot be undone, so kernel.personal_data.erase leaves those rows as they are and says so (the activity lines and tasks have the same guard);
// a value of 10 digits or more is redacted as before. The finder still reports the rows.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { PersonalDataErasure, PersonalDataResult } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const EMAIL = 'khach.hang@congty.example';
const MARK = '[đã xóa]';

suite('the short-number guard in meeting text (#3064)', () => {
  const dbName = `crove_test_meetings_short_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const asMfa = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const find = (who: string, value = EMAIL) => runtime.execute<PersonalDataResult>('kernel.personal_data.find', { value }, { actor: asUser(who), orgId, idempotencyKey: randomUUID() });
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
    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'outsider']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'meetings-short', subject: key, email: `${key}@meetings-short.test`, name: null });
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

  it('leaves meeting text alone for a number of fewer than 10 digits, lists it with a reason, and still finds it', async () => {
    const value = '20261112';
    const shared = await meeting('recorder', `Họp hạn 2026-11-12`, 'org');
    const line = await segment(shared, 'Hợp đồng hết hạn ngày 2026-11-12 nhé', 'published', 'Hà');
    const summary = await result(shared, 'Chốt hạn 2026-11-12', ['Nộp trước 2026-11-12'], 'published');
    const published = await item(shared, 'Nộp hồ sơ 2026-11-12', 'published');
    const own = await meeting('owner', 'Họp của chủ', 'attendees');
    const ownLine = await segment(own, 'Nháp hạn 2026-11-12', 'draft');
    const hidden = await meeting('recorder', 'Họp kín', 'attendees', ['attendee']);
    const hiddenLine = await segment(hidden, 'Chuyện kín hạn 2026-11-12', 'published');
    const hiddenItem = await item(hidden, 'Việc kín 2026-11-12', 'draft');
    const before = {
      lines: [await textOf('transcript_segment', line, 'text'), await textOf('transcript_segment', ownLine, 'text'), await textOf('transcript_segment', hiddenLine, 'text')],
      summary: await textOf('meeting_result', summary, 'summary'),
      decisions: await textOf('meeting_result', summary, 'decisions'),
      items: [await textOf('action_item', published, 'title'), await textOf('action_item', hiddenItem, 'title')],
      title: await textOf('meeting', shared, 'title'),
    };
    // The finder reports the readable rows, by column.
    const found = await find('owner', value);
    expect(found.matches.some((m) => m.column === 'crove_meetings.transcript_segment.text' && m.rowId === line)).toBe(true);

    const erased = await erase(value);
    // Nothing of the meeting text changed, and nothing is reported as erased in it.
    expect({
      lines: [await textOf('transcript_segment', line, 'text'), await textOf('transcript_segment', ownLine, 'text'), await textOf('transcript_segment', hiddenLine, 'text')],
      summary: await textOf('meeting_result', summary, 'summary'),
      decisions: await textOf('meeting_result', summary, 'decisions'),
      items: [await textOf('action_item', published, 'title'), await textOf('action_item', hiddenItem, 'title')],
      title: await textOf('meeting', shared, 'title'),
    }).toEqual(before);
    for (const column of ['crove_meetings.transcript_segment.text', 'crove_meetings.meeting_result.summary', 'crove_meetings.action_item.title', 'crove_meetings.meeting.title']) expect(erasedRows(erased, column), column).toBe(0);
    // The answer lists the rows the owner reads by column and counts the ones they cannot read, each with the short-number reason, never the notice reason.
    const listed = erased.kept.filter((k) => k.column.startsWith('crove_meetings.'));
    for (const column of ['crove_meetings.transcript_segment.text', 'crove_meetings.meeting_result.summary', 'crove_meetings.meeting_result.decisions', 'crove_meetings.action_item.title', 'crove_meetings.meeting.title']) {
      expect(listed.find((k) => k.column === column)?.reason, column).toMatch(/fewer than 10 digits/);
    }
    const unread = listed.find((k) => k.column === 'crove_meetings.text');
    expect(unread?.rows).toBe(2);
    expect(unread?.reason).toMatch(/fewer than 10 digits/);
    expect(listed.some((k) => /send the notice/.test(k.reason))).toBe(false);
    // The audit row has counts only.
    const audit = JSON.stringify((await sqlAdmin(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.erase' ORDER BY id DESC LIMIT 1`, [orgId])).rows);
    expect(audit).not.toContain('Chuyện kín');
  });

  it('still redacts meeting text for a number of 10 digits, and a date beside it stays', async () => {
    const shared = await meeting('recorder', 'Họp gọi lại', 'org');
    const line = await segment(shared, 'Gọi anh Tuấn số 0912 345 678 trước 2026-11-12', 'published');
    const erased = await erase('0912345678');
    expect(await textOf('transcript_segment', line, 'text')).toBe(`Gọi anh Tuấn số ${MARK} trước 2026-11-12`);
    expect(erasedRows(erased, 'crove_meetings.transcript_segment.text')).toBe(1);
    expect(erased.kept.some((k) => /fewer than 10 digits/.test(k.reason))).toBe(false);
  });
});
