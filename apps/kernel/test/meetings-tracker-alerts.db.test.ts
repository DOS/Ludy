// SPDX-License-Identifier: AGPL-3.0-only
// Alerts when a tracked keyword comes up in a new meeting (#4873) on a real database: the switch is a member's own (off by default, a viewer cannot turn it on); publishing a summary stores one
// event with the meeting's id only; the worker's dispatch tells exactly the members who opted in AND read the meeting now (the recorder is not told about their own publish, an owner or admin who is
// not a reader is not told, a member of an attendees-only meeting who is not one of its readers is not told, a member limited to one legal entity is not told of an org-shared meeting, a member who muted the
// kind is not told), once per meeting however often the event is dispatched; the notice holds term ids and counts and no word, title or text, nor does its mail; no word in the published transcript lines, a
// meeting past its text period and a meeting deleted since tell nobody; and the definer that serves the dispatch refuses a call for another org or with no context. Set LUDY_TEST_ADMIN_URL (or
// CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { TRACKER_ALERT_EVENT, TRACKER_ALERT_KIND, parseTrackerAlertTerms, type TrackerAlertState } from '@ludy/kernel-contract';
import { DomainError, Runtime, defineCommand } from '@ludy/kernel-runtime';
import { countNeedle, lineWords, meetingsCommands, meetingsQueries, needleOf } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Probes for the two definers: the system's own commands that ask them about any org id, from the org context the runtime sets for the call.
const recipientsProbe = defineCommand({
  name: 'test.tracker_alert_recipients_probe',
  input: z.strictObject({ org: z.string(), meeting: z.string(), after: z.string().nullable(), limit: z.number().int() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => (await sql<{ user_id: string; english: boolean }>`SELECT user_id, english FROM ludy_meetings.tracker_alert_recipients(${input.org}::uuid, ${input.meeting}::uuid, pg_catalog.now(), ${input.after}::uuid, ${input.limit}::integer)`.execute(ctx.trx)).rows,
});
const hitsProbe = defineCommand({
  name: 'test.tracker_alert_hits_probe',
  input: z.strictObject({ org: z.string(), meeting: z.string() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => (await sql<{ term_id: string; hits: number }>`SELECT term_id, hits FROM ludy_meetings.tracker_alert_hits(${input.org}::uuid, ${input.meeting}::uuid, pg_catalog.now())`.execute(ctx.trx)).rows,
});

suite('Tracker alerts (#4873)', () => {
  const dbName = `ludy_test_tracker_alert_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  let worker: Runtime;
  const users: Record<string, string> = {};
  const NAMES: Record<string, string> = { owner: 'Chủ Công Ty', adm: 'Quản Trị Viên', rec: 'Phạm Quang Minh', lan: 'Trần Thị Lan', nam: 'Nguyễn Văn Nam', out: 'Bạn Không Đọc', vwr: 'Người Xem', boss2: 'Chủ Hai', scp: 'Thành Viên Chi Nhánh' };
  const asUser = (who: string, org = orgId) => ({ actor: { type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const }, orgId: org });
  const run = <T>(command: string, who: string, input: unknown) => runtime.execute<T>(command, input, asUser(who));
  const ask = <T>(query: string, who: string, input: unknown) => runtime.query<T>(query, input, asUser(who));
  const system = (org = orgId) => ({ actor: { type: 'system' as const, component: 'tracker-alert-test' }, orgId: org });
  const notice = (eventId: string) => worker.execute<{ notified: number; mailed: number }>('meetings.tracker.alert_notice', { eventId }, system());
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
  const addTerm = (term: string) => sqlAdmin('INSERT INTO ludy_meetings.tracker_term (org_id, term, created_by) VALUES ($1, $2, $3)', [orgId, term, users.owner]);
  const clear = async () => {
    await sqlAdmin('DELETE FROM ludy_meetings.tracker_alert WHERE org_id = $1', [orgId]);
    await sqlAdmin('DELETE FROM ludy_meetings.tracker_term WHERE org_id = $1', [orgId]);
    await sqlAdmin('DELETE FROM ludy_kernel.notification WHERE org_id = $1', [orgId]);
    await sqlAdmin('DELETE FROM ludy_kernel.notification_mute WHERE org_id = $1', [orgId]);
    // The outbox is append-only: an earlier test's event stays, and each test finds its own by the meeting id (`published`) and hands that one to the worker.
    await sqlAdmin('DELETE FROM ludy_kernel.mail_message WHERE org_id = $1 AND template_key = $2', [orgId, 'meetings.tracker_alert']);
  };
  const optIn = (...who: string[]) => Promise.all(who.map((w) => run<TrackerAlertState>('meetings.tracker.alert_set', w, { on: true, language: 'vi' })));
  // A meeting recorded by `rec`, shared with the org or with the listed readers only, whose transcript lines are published (what a reader reads; the lines are seeded, as the Trackers card's tests do) and whose
  // summary the recorder saved and published, which stores the alert's event.
  async function published(title: string, visibility: 'org' | 'attendees', readers: string[], lines: string[], stage: 'published' | 'draft' = 'published'): Promise<{ meetingId: string; eventId: string }> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $4, 'vi', now(), now() + interval '30 minutes', 1800, $3, $5, 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.rec, title, visibility],
    );
    for (const reader of readers) await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users[reader]]);
    for (const [n, text] of lines.entries()) {
      await sqlAdmin(`INSERT INTO ludy_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3::numeric, $3::numeric + 5, 'Người nói 1', $4, $5::text)`, [orgId, meetingId, n * 10, text, stage]);
    }
    await run('meetings.summary.save', 'rec', { meetingId, summary: 'Tóm tắt không có từ khóa', decisions: [] });
    await run('meetings.result.publish', 'rec', { meetingId, confirmed: true });
    const events = await sqlAdmin<{ id: string; payload: Record<string, unknown> }>('SELECT id, payload FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY created_at DESC, id DESC', [orgId, TRACKER_ALERT_EVENT]);
    const event = events.rows.find((e) => e.payload.meetingId === meetingId);
    expect(event, 'the publish stored its event').toBeDefined();
    return { meetingId, eventId: (event as { id: string }).id };
  }
  const notices = () =>
    sqlAdmin<{ user_id: string; dedupe_key: string; subject_id: string; detail: Record<string, string> }>('SELECT user_id, dedupe_key, subject_id, detail FROM ludy_kernel.notification WHERE org_id = $1 AND kind = $2', [orgId, TRACKER_ALERT_KIND]).then((r) => r.rows);
  const told = async () => (await notices()).map((n) => Object.keys(users).find((k) => users[k] === n.user_id)).sort();
  const mails = () =>
    sqlAdmin<{ to_address: string; payload: Record<string, unknown>; subject: string }>('SELECT to_address, payload, subject FROM ludy_kernel.mail_message WHERE org_id = $1 AND template_key = $2', [orgId, 'meetings.tracker_alert']).then((r) => r.rows);

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    const db = createDb(appPool);
    const defs = { commands: [...kernelCommands, ...meetingsCommands, recipientsProbe, hitsProbe], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(defs);
    for (const key of Object.keys(NAMES)) users[key] = await upsertIdentity(db, { issuer: 'tka', subject: key, email: `${key}@tka.test`, name: NAMES[key] as string });
    orgId = (await createOrg(runtime, asUser('owner').actor, 'Công ty Báo Từ Khóa')).orgId;
    otherOrgId = (await createOrg(runtime, asUser('boss2').actor, 'Công ty Khác')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'admin'), ($1, $7, 'viewer'), ($1, $8, 'member')`, [orgId, users.rec, users.lan, users.nam, users.out, users.adm, users.vwr, users.scp]);
    // A member whose only role assignment names one branch: their context is scoped to it, so a meeting shared with the whole org is not theirs to read.
    const branch = randomUUID();
    await sqlAdmin(`INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh', 'branch', $3)`, [orgId, branch, users.owner]);
    await sqlAdmin(`INSERT INTO ludy_kernel.role_assignment (org_id, id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, $3, 'external_accountant', $4, $5)`, [orgId, randomUUID(), users.scp, branch, users.owner]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is off by default, a member\'s own to turn on and off, and a viewer cannot turn it on', async () => {
    await clear();
    for (const who of ['lan', 'nam', 'adm', 'rec']) expect(await ask<TrackerAlertState>('meetings.tracker.alert_get', who, {}), who).toEqual({ on: false });
    expect(await run<TrackerAlertState>('meetings.tracker.alert_set', 'lan', { on: true })).toEqual({ on: true });
    // Twice is one row; another member's state is their own.
    expect(await run<TrackerAlertState>('meetings.tracker.alert_set', 'lan', { on: true })).toEqual({ on: true });
    expect((await sqlAdmin('SELECT 1 FROM ludy_meetings.tracker_alert WHERE org_id = $1', [orgId])).rowCount).toBe(1);
    expect(await ask<TrackerAlertState>('meetings.tracker.alert_get', 'lan', {})).toEqual({ on: true });
    expect(await ask<TrackerAlertState>('meetings.tracker.alert_get', 'nam', {})).toEqual({ on: false });
    expect(await ask<TrackerAlertState>('meetings.tracker.alert_get', 'owner', {})).toEqual({ on: false });
    await expect(run('meetings.tracker.alert_set', 'vwr', { on: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await run<TrackerAlertState>('meetings.tracker.alert_set', 'lan', { on: false })).toEqual({ on: false });
    expect(await ask<TrackerAlertState>('meetings.tracker.alert_get', 'lan', {})).toEqual({ on: false });
    expect((await sqlAdmin('SELECT 1 FROM ludy_meetings.tracker_alert WHERE org_id = $1', [orgId])).rowCount).toBe(0);
  });

  it('stores one event for a publish of a summary, with the meeting\'s id and no word', async () => {
    await clear();
    await addTerm('giá');
    const { meetingId, eventId } = await published('Họp bí mật BÍ-MẬT-4873', 'attendees', ['lan'], ['Khách hỏi giá BÍ-MẬT-4873']);
    const row = (await sqlAdmin<{ payload: Record<string, unknown> }>('SELECT payload FROM ludy_kernel.outbox_event WHERE id = $1', [eventId])).rows[0];
    expect(row?.payload).toEqual({ meetingId });
    expect(JSON.stringify(row?.payload)).not.toContain('BÍ-MẬT');
  });

  it('tells exactly the members who opted in and read the meeting now, and nobody else, once per meeting', async () => {
    await clear();
    await addTerm('giá');
    await addTerm('hợp đồng');
    await addTerm('Đại Việt');
    // lan is a reader and opted in; nam is a reader and did not; out opted in and is no reader; adm opted in and is an admin with no reader row; rec opted in and recorded it.
    await optIn('lan', 'out', 'adm', 'rec');
    const { meetingId, eventId } = await published('Họp bán hàng', 'attendees', ['lan', 'nam'], ['Khách hỏi giá, giá cao.', 'Giảm giá 5%.', 'Ký hợp đồng.', 'Gửi hợp đồng mẫu.']);
    expect(await notice(eventId)).toEqual({ notified: 1, mailed: 1 });
    expect(await told()).toEqual(['lan']);
    const [only] = await notices();
    expect(only?.dedupe_key).toBe(`tracker:${meetingId}`);
    expect(only?.subject_id).toBe(meetingId);
    // Ids and counts only: giá 3 times (two in the first line, one in "Giảm giá"), hợp đồng 2 times; no word, no title, no text in the row.
    const listed = parseTrackerAlertTerms(only?.detail);
    const wordOf = new Map((await sqlAdmin<{ id: string; term: string }>('SELECT id, term FROM ludy_meetings.tracker_term WHERE org_id = $1', [orgId])).rows.map((r) => [r.id, r.term]));
    expect(listed.map((w) => [wordOf.get(w.termId), w.count])).toEqual([['giá', 3], ['hợp đồng', 2]]);
    expect(Object.keys(only?.detail ?? {})).toEqual(['terms']);
    const rowText = JSON.stringify(only);
    for (const leak of ['giá', 'hợp đồng', 'Họp bán hàng', 'Khách hỏi', 'Giảm']) expect(rowText, leak).not.toContain(leak);
    // The mail holds a fixed line, how many words and the link: no word, no title.
    const [mail] = await mails();
    expect(mail?.to_address).toBe('lan@tka.test');
    expect(Object.keys(mail?.payload ?? {}).sort()).toEqual(['lang', 'org', 'path', 'words']);
    expect(mail?.payload.words).toBe(2);
    expect(mail?.payload.path).toMatch(new RegExp(`/meetings/${meetingId}$`));
    for (const leak of ['giá', 'hợp đồng', 'Họp bán hàng']) expect(JSON.stringify(mail), leak).not.toContain(leak);
    // The same event again, and a second publish of the same meeting, tell nobody twice.
    expect(await notice(eventId)).toEqual({ notified: 0, mailed: 0 });
    await run('meetings.summary.save', 'rec', { meetingId, summary: 'Tóm tắt lần hai', decisions: [] });
    await run('meetings.result.publish', 'rec', { meetingId, confirmed: true });
    for (const e of (await sqlAdmin<{ id: string }>(`SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = $2 AND payload->>'meetingId' = $3`, [orgId, TRACKER_ALERT_EVENT, meetingId])).rows) await notice(e.id);
    expect(await told()).toEqual(['lan']);
    expect(await mails()).toHaveLength(1);
  });

  it('tells every opted-in member of a meeting shared with the org whose scope is the whole org (the recorder and a member limited to one branch excepted), and a reader added to an attendees-only meeting', async () => {
    await clear();
    await addTerm('giá');
    await optIn('lan', 'out', 'adm', 'rec', 'nam', 'scp');
    const shared = await published('Họp cả công ty', 'org', [], ['Bàn về giá mới.']);
    expect(await notice(shared.eventId)).toEqual({ notified: 4, mailed: 4 });
    expect(await told()).toEqual(['adm', 'lan', 'nam', 'out']);
    // An attendees-only meeting whose reader list later gains `out`: told when the event is dispatched, as the reader rule stands then.
    const closed = await published('Họp kín', 'attendees', ['lan'], ['Nói về giá.']);
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), closed.meetingId, users.out]);
    await notice(closed.eventId);
    const got = (await notices()).filter((n) => n.subject_id === closed.meetingId).map((n) => Object.keys(users).find((k) => users[k] === n.user_id));
    expect(got.sort()).toEqual(['lan', 'out']);
  });

  it('tells nobody when no tracked word is in the published lines, when none is tracked, when the kind is muted, when the lines are drafts, or when the meeting is past its text period or gone', async () => {
    await clear();
    await optIn('lan');
    // No word tracked at all.
    const bare = await published('Họp không theo dõi', 'org', [], ['Bàn về giá.']);
    expect(await notice(bare.eventId)).toEqual({ notified: 0, mailed: 0 });
    await addTerm('giá');
    // A word is tracked, and the lines do not hold it.
    const none = await published('Họp không có từ', 'org', [], ['Nói chuyện thời tiết.']);
    expect(await notice(none.eventId)).toEqual({ notified: 0, mailed: 0 });
    // Draft lines are the recorder's alone: a reader has none to count.
    const draft = await published('Họp còn bản nháp', 'org', [], ['Bàn về giá.'], 'draft');
    expect(await notice(draft.eventId)).toEqual({ notified: 0, mailed: 0 });
    // A member who muted the kind gets neither the notice nor the mail.
    await run('kernel.notification.mute', 'lan', { kind: TRACKER_ALERT_KIND, muted: true });
    const muted = await published('Họp tắt tiếng', 'org', [], ['Bàn về giá.']);
    expect(await notice(muted.eventId)).toEqual({ notified: 0, mailed: 0 });
    await run('kernel.notification.mute', 'lan', { kind: TRACKER_ALERT_KIND, muted: false });
    // The text period reached before the dispatch: nothing is read.
    const aged = await published('Họp hết hạn', 'org', [], ['Bàn về giá.']);
    await sqlAdmin('UPDATE ludy_meetings.meeting SET text_retention_date = current_date - 1 WHERE org_id = $1 AND id = $2', [orgId, aged.meetingId]);
    expect(await notice(aged.eventId)).toEqual({ notified: 0, mailed: 0 });
    // The meeting is gone before the dispatch.
    const gone = await published('Họp bị xóa', 'org', [], ['Bàn về giá.']);
    await sqlAdmin('DELETE FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, gone.meetingId]);
    expect(await notice(gone.eventId)).toEqual({ notified: 0, mailed: 0 });
    expect(await told()).toEqual([]);
    expect(await mails()).toEqual([]);
  });

  it('tells nobody for a disabled account or for an org that is being offboarded, and everyone again when both are back', async () => {
    await clear();
    await addTerm('giá');
    await optIn('lan', 'nam');
    const first = await published('Họp tài khoản', 'org', [], ['Bàn về giá.']);
    // A disabled account is not told (and gets no mail); the other member still is.
    await sqlAdmin('UPDATE ludy_kernel.user_account SET disabled_at = now() WHERE id = $1', [users.lan]);
    expect(await notice(first.eventId)).toEqual({ notified: 1, mailed: 1 });
    expect(await told()).toEqual(['nam']);
    await sqlAdmin('UPDATE ludy_kernel.user_account SET disabled_at = NULL WHERE id = $1', [users.lan]);
    // An org that is being offboarded tells nobody: its members are not alerted about a meeting while it is closed down.
    await clear();
    await optIn('lan', 'nam');
    const second = await published('Họp đóng tổ chức', 'org', [], ['Bàn về giá.']);
    await addTerm('giá');
    // Moved without the triggers (the move's own audit check belongs to kernel.org.offboard), as the other tests do.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [orgId]);
      await c.query('COMMIT');
    });
    try {
      expect(await notice(second.eventId)).toEqual({ notified: 0, mailed: 0 });
      expect(await told()).toEqual([]);
    } finally {
      await sqlAdmin(`UPDATE ludy_kernel.tenant SET status = 'active' WHERE org_id = $1`, [orgId]);
    }
    expect(await notice(second.eventId)).toEqual({ notified: 2, mailed: 2 });
    expect(await told()).toEqual(['lan', 'nam']);
  });

  it('writes the mail in the language each member chose where they turned the alert on, not the meeting\'s', async () => {
    await clear();
    await addTerm('giá');
    await run('meetings.tracker.alert_set', 'lan', { on: true, language: 'en' });
    await run('meetings.tracker.alert_set', 'nam', { on: true, language: 'vi' });
    // Turning it on again replaces the row: the language chosen last is the one used.
    await run('meetings.tracker.alert_set', 'out', { on: true, language: 'vi' });
    await run('meetings.tracker.alert_set', 'out', { on: true, language: 'en' });
    expect((await sqlAdmin('SELECT 1 FROM ludy_meetings.tracker_alert WHERE org_id = $1', [orgId])).rowCount).toBe(3);
    const { eventId } = await published('Họp tiếng Việt', 'org', [], ['Bàn về giá.']);
    expect(await notice(eventId)).toEqual({ notified: 3, mailed: 3 });
    const langs = Object.fromEntries((await mails()).map((m) => [m.to_address, m.payload.lang]));
    expect(langs).toEqual({ 'lan@tka.test': 'en', 'nam@tka.test': 'vi', 'out@tka.test': 'en' });
    const subjects = Object.fromEntries((await mails()).map((m) => [m.to_address, m.subject]));
    expect(subjects['lan@tka.test']).toMatch(/^A word you track/);
    expect(subjects['nam@tka.test']).toMatch(/^Từ khóa/);
  });

  it('counts the words inside the database with the same counts as the Trackers card\'s own counting, and a draft line counts for nobody', async () => {
    await clear();
    const LINES = [
      'Khách hỏi giá và hợp đồng, giá cao.', 'Quyết định: gửi hợp đồng cho ACME.', 'Việc: báo giá', 'Giá này cao quá, GIÁ bên kia thấp hơn', 'giá, già, giả và gia đình', 'giảm giá mạnh, giám đốc đồng ý',
      'hợp đồng hợp đồngg', 'Ký hợp đồng. Hợp, đồng mới', 'Ký Hợp đồng mới và hop dong khác', 'a a a b a', 'Đối thủ ĐỐI THỦ đối   thủ, doi thu', 'dai viet 2024 Đại Việt', 'Nguyễn Văn Nam gặp nguyen van nam',
      '   ', '!!!', 'ACME-Corp, acme corp; ACME_Corp', "d'Artagnan và O'Neil", 'tiếng Việt 100% (ok)', 'Hợp\tđồng\nmới', 'số 1 số 12 số 1', 'giá'.normalize('NFD') + ' rẻ', 'Hợp đồng'.normalize('NFD') + ' mới', 'đ', 'Đ đ',
    ];
    const TERMS = ['giá', 'gia', 'Hợp đồng', 'hop dong', 'ACME', 'acme corp', 'đối thủ', 'doi thu', 'Đại Việt', 'dai viet', 'a', 'a a', 'số 1', '100 ok', 'nguyen van nam', 'Nguyễn Văn', 'd', 'đ', "o neil", 'giá % _ \\ . * ( [', 'a.*', '[giá'];
    const { meetingId } = await published('Họp đếm từ', 'org', [], LINES);
    // A draft line, never counted: the reader has none of it.
    await sqlAdmin(`INSERT INTO ludy_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, 9999, 10000, 'Người nói 1', 'giá giá giá', 'draft')`, [orgId, meetingId]);
    const ids = new Map<string, string>();
    for (const term of TERMS) {
      await addTerm(term);
      ids.set(term, (await sqlAdmin<{ id: string }>('SELECT id FROM ludy_meetings.tracker_term WHERE org_id = $1 AND term = $2', [orgId, term])).rows[0]!.id);
    }
    const inSql = new Map((await worker.execute<Array<{ term_id: string; hits: number }>>('test.tracker_alert_hits_probe', { org: orgId, meeting: meetingId }, system())).map((r) => [r.term_id, r.hits]));
    for (const term of TERMS) {
      const target = needleOf(term);
      const inTs = target === null ? 0 : LINES.reduce((sum, line) => sum + countNeedle(lineWords(line), target), 0);
      expect(inSql.get(ids.get(term) as string) ?? 0, `the count of ${JSON.stringify(term)}`).toBe(inTs);
    }
    // The answer is ids and numbers: no word, no line.
    expect(JSON.stringify([...inSql])).not.toMatch(/Khách|hợp đồng|ACME/);
  }, 60_000);

  it('writes the same audit detail whether or not a tracked word was found: the event and the meeting, nothing else', async () => {
    await clear();
    await addTerm('giá');
    await optIn('lan');
    const withHit = await published('Họp có từ khóa', 'org', [], ['Bàn về giá hôm nay.']);
    const withoutHit = await published('Họp không có từ khóa', 'org', [], ['Chào mọi người, hẹn gặp lại.']);
    expect(await notice(withHit.eventId)).toEqual({ notified: 1, mailed: 1 });
    expect(await notice(withoutHit.eventId)).toEqual({ notified: 0, mailed: 0 });
    for (const [label, { meetingId, eventId }] of [['with a hit', withHit], ['without a hit', withoutHit]] as const) {
      const rows = await sqlAdmin<{ detail: Record<string, unknown> }>(
        "SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.tracker.alert_notice' AND detail ->> 'meetingId' = $2",
        [orgId, meetingId],
      );
      // An owner or admin who is not a reader of an attendees-only meeting reads this log: a count of words, recipients or notices would tell them what is in it.
      expect(rows.rows.map((r) => r.detail), label).toEqual([{ eventId, meetingId }]);
    }
  });

  it('returns the recipients a page at a time in id order, and the page is clamped', async () => {
    await clear();
    await addTerm('giá');
    await optIn('lan', 'nam', 'out', 'adm');
    const { meetingId } = await published('Họp nhiều người', 'org', [], ['Bàn về giá.']);
    const page = (after: string | null, limit: number) => worker.execute<Array<{ user_id: string; english: boolean }>>('test.tracker_alert_recipients_probe', { org: orgId, meeting: meetingId, after, limit }, system());
    const all = (await page(null, 500)).map((r) => r.user_id);
    expect([...all].sort()).toEqual(all);
    expect(all.sort()).toEqual([users.adm, users.lan, users.nam, users.out].sort());
    const sorted = [...all].sort();
    const first = (await page(null, 3)).map((r) => r.user_id);
    expect(first).toEqual(sorted.slice(0, 3));
    expect((await page(first[2] as string, 3)).map((r) => r.user_id)).toEqual(sorted.slice(3));
    expect((await page(sorted[3] as string, 3)).map((r) => r.user_id)).toEqual([]);
    // A limit below one reads as one; the largest is 500.
    expect(await page(null, 0)).toHaveLength(1);
    expect((await page(null, 100000)).length).toBe(4);
  });

  it('holds both definers to the system context of the same org: another org\'s id and no context are refused, its own org is answered with ids and numbers only', async () => {
    await clear();
    await addTerm('giá');
    await optIn('lan');
    const { meetingId } = await published('Họp thử', 'org', [], ['Bàn về giá.']);
    const termId = (await sqlAdmin<{ id: string }>('SELECT id FROM ludy_meetings.tracker_term WHERE org_id = $1', [orgId])).rows[0]!.id;
    expect(await worker.execute('test.tracker_alert_recipients_probe', { org: orgId, meeting: meetingId, after: null, limit: 10 }, system())).toEqual([{ user_id: users.lan, english: false }]);
    expect(await worker.execute('test.tracker_alert_hits_probe', { org: orgId, meeting: meetingId }, system())).toEqual([{ term_id: termId, hits: 1 }]);
    // Each call is started when its turn comes: started together, the later ones would reject before anything handles them, and the run would end with an unhandled rejection.
    for (const call of [
      () => worker.execute('test.tracker_alert_recipients_probe', { org: otherOrgId, meeting: meetingId, after: null, limit: 10 }, system()),
      () => worker.execute('test.tracker_alert_recipients_probe', { org: orgId, meeting: meetingId, after: null, limit: 10 }, system(otherOrgId)),
      () => worker.execute('test.tracker_alert_hits_probe', { org: otherOrgId, meeting: meetingId }, system()),
      () => worker.execute('test.tracker_alert_hits_probe', { org: orgId, meeting: meetingId }, system(otherOrgId)),
    ]) {
      const error = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('FORBIDDEN');
    }
    const bare = new pg.Client({ connectionString: (() => { const url = new URL(adminUrl); url.username = 'ludy_worker'; url.password = 'test-worker-pw'; return url.toString(); })() });
    await bare.connect();
    try {
      await expect(bare.query('SELECT * FROM ludy_meetings.tracker_alert_recipients($1::uuid, $2::uuid, now(), NULL, 10)', [orgId, meetingId])).rejects.toThrow(/NO_CONTEXT/);
      await expect(bare.query('SELECT * FROM ludy_meetings.tracker_alert_hits($1::uuid, $2::uuid, now())', [orgId, meetingId])).rejects.toThrow(/NO_CONTEXT/);
    } finally {
      await bare.end();
    }
    // The login of the API reads and runs none of it.
    await expect(ask('meetings.tracker.alert_get', 'out', {})).resolves.toEqual({ on: false });
  });
});
