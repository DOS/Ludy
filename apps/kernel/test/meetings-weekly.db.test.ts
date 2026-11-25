// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in weekly notice of the week's meetings (#4967) on a real database: a member turns it on (a Monday time in their own zone) and off, and sees only their own setting; the worker's sweep sends, once a Monday
// at the chosen time, one in-app notice and one mail that hold only four numbers and a link (canary strings pin it: no title, no decision, no item); the four numbers equal what the "this week" card
// (meetings.digest.facts) shows the same member, for a recorder, a reader, an owner and a member limited to one legal entity; and a week with nothing to show, a time not come yet, a day that is not Monday, a muted
// kind, a member who turned it off or left, a disabled account, an org that is closing and a zone the database does not know send nothing; and a second dispatch or pass for the same Monday sends nothing more.
// The tests read the week at a Monday of their own (the `at` of the sweep and of the command): the worker never passes it, so it reads the clock.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { WEEKLY_KIND, briefItemDue, vnDateOf, zWeeklyMail, type DigestFacts, type WeeklyState } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { sql } from 'kysely';
import { runMeetingsWeeklySweep } from '../src/meetings-weekly.ts';
import { weeklyMailTemplate } from '../src/weekly-mail.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'test.weekly' };
const ZONE = 'Asia/Ho_Chi_Minh';
// Words that must never reach a notice, a mail or an audit row.
const CANARY = /Á Châu|hợp đồng 15|Họp kín|Tuấn|Quyết định bí mật|Việc bí mật/u;

suite("the opt-in weekly notice of the week's meetings (#4967)", () => {
  const dbName = `ludy_test_weekly_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  // A Monday, 08:30 in Vietnam, at or just before now: the instant the week is read at.
  let AT = '';
  let AT_DAY = '';
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const get = (who: string) => runtime.query<WeeklyState>('meetings.weekly.get', {}, { actor: asUser(who), orgId });
  const set = (who: string, input: Record<string, unknown>) => runtime.execute<WeeklyState>('meetings.weekly.set', input, { actor: asUser(who), orgId });
  const facts = (who: string) => runtime.query<DigestFacts>('meetings.digest.facts', { days: 7 }, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
  const notice = (who: string, at: string = AT, day: string = AT_DAY) => worker.execute<{ notified: boolean; mailed: boolean; notificationId?: string | null }>('meetings.weekly.notice', { userId: users[who], day, at }, { actor: SYSTEM, orgId });
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
  const notices = async (who: string) =>
    (await sqlAdmin<{ dedupe_key: string; detail: Record<string, string>; subject_id: string | null }>(`SELECT dedupe_key, detail, subject_id FROM ludy_kernel.notification WHERE org_id = $1 AND user_id = $2 AND kind = $3 ORDER BY created_at`, [orgId, users[who], WEEKLY_KIND])).rows;
  const mails = async () =>
    (await sqlAdmin<{ to_address: string; subject: string | null; source: string; source_id: string | null; payload: Record<string, unknown>; status: string }>(`SELECT to_address, subject, source, source_id, payload, status FROM ludy_kernel.mail_message WHERE org_id = $1 AND template_key = 'meetings.weekly' ORDER BY created_at`, [orgId])).rows;
  // What the worker's definer says for a member at the Monday: one row of numbers, or none.
  async function due(who: string, at: string = AT) {
    const { rows } = await sql<{ org_id: string; user_id: string; day: string; meetings: number; decisions: number; open_items: number; overdue: number; cut: boolean; english: boolean }>`
      SELECT org_id, user_id, day::text AS day, meetings, decisions, open_items, overdue, cut, english
      FROM ludy_meetings.weekly_notices_due(500, ${orgId}::uuid, ${users[who]}::uuid, NULL::date, ${at}::timestamptz)`.execute(workerDb);
    return rows[0] ?? null;
  }
  // The numbers the card shows, from the same facts: what the notice must say.
  async function cardNumbers(who: string) {
    const card = await facts(who);
    // Overdue is read against the Monday the week is read at, as the definer reads it.
    const today = vnDateOf(AT);
    const items = card.meetings.flatMap((m) => m.items);
    return {
      meetings: card.meetings.length,
      decisions: card.meetings.reduce((n, m) => n + m.decisions.length, 0),
      open: items.length,
      overdue: items.filter((i) => {
        const day = briefItemDue(i);
        return day !== null && day < today;
      }).length,
      cut: card.cut,
    };
  }
  const numbersOf = (row: NonNullable<Awaited<ReturnType<typeof due>>>) => ({ meetings: row.meetings, decisions: row.decisions, open: row.open_items, overdue: row.overdue, cut: row.cut });

  // A meeting started `daysAgo` days before now, recorded by `recorder` and read by `readers` (or by the whole org when its visibility is 'org').
  async function meeting(title: string, daysAgo: number, recorder: string, readers: string[], opts: { visibility?: 'attendees' | 'org'; textDay?: string; at?: string } = {}): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $4, 'vi', ${opts.at ? '$6::timestamptz' : 'now()'} - ($5 || ' days')::interval, ${opts.at ? '$6::timestamptz' : 'now()'} - ($5 || ' days')::interval + interval '30 minutes', 1800, $3, '${opts.visibility ?? 'attendees'}', 'ready', 'told_at_start', $3, now(), '1.0', current_date - 1, ${opts.textDay ?? 'current_date + 365'})`,
      opts.at ? [orgId, id, users[recorder], title, String(daysAgo), opts.at] : [orgId, id, users[recorder], title, String(daysAgo)],
    );
    for (const reader of readers) await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[reader]]);
    return id;
  }
  const result = (meetingId: string, decisions: string[], stage: 'draft' | 'published') =>
    sqlAdmin(`INSERT INTO ludy_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage) VALUES ($1, $2, 'Tóm tắt', $3::jsonb, 'manual', $4)`, [orgId, meetingId, JSON.stringify(decisions), stage]);
  async function item(meetingId: string, title: string, over: { task?: string; due?: string; stage?: 'draft' | 'published' } = {}): Promise<void> {
    let taskId: string | null = null;
    if (over.task !== undefined) {
      taskId = randomUUID();
      await sqlAdmin(`INSERT INTO ludy_kernel.task (org_id, id, title, source, created_by_type, status, due) VALUES ($1, $2, $3, 'human', 'system', $4, ${over.due ? '$5::timestamptz' : 'NULL'})`, over.due ? [orgId, taskId, title, over.task, over.due] : [orgId, taskId, title, over.task]);
    }
    await sqlAdmin(
      `INSERT INTO ludy_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, task_id, tainted, transcript_seconds)
       VALUES ($1, $2, $3, $4, 'Lan', $5, 'thứ sáu', $6, $7, $8, false, 10)`,
      [orgId, randomUUID(), meetingId, title, users.lan, over.stage ?? 'published', taskId === null ? 'suggested' : 'accepted', taskId],
    );
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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    workerDb = createDb(workerPool);
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of ['owner', 'rec', 'lan', 'ltd', 'other', 'muted', 'odd', 'gone', 'disabled', 'late', 'early', 'sunday', 'sweepy', 'big', 'quiet', 'hid', 'hidltd']) {
      users[key] = await upsertIdentity(createDb(appPool), { issuer: 'weekly', subject: key, email: `${key}@weekly.test`, name: key });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Tổng Kết Tuần')).orgId;
    const members = ['rec', 'lan', 'ltd', 'other', 'muted', 'odd', 'gone', 'disabled', 'late', 'early', 'sunday', 'sweepy', 'big', 'quiet', 'hid', 'hidltd'];
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) SELECT $1, u, 'member' FROM unnest($2::uuid[]) u`, [orgId, members.map((m) => users[m])]);
    // ltd reads one legal entity only (the scope enter_context seals for a member whose only assignments name an entity), so an org-visible meeting is not theirs.
    const branch = (await sqlAdmin<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, users.owner])).rows[0]?.id;
    await sqlAdmin(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, users.ltd, branch, users.owner]);
    await sqlAdmin(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, users.hidltd, branch, users.owner]);
    // The Monday: the latest one at 01:30 UTC (08:30 in Vietnam) that is not more than a day ahead of now.
    AT = (await sqlAdmin<{ at: string }>(`SELECT to_char(date_trunc('week', now() AT TIME ZONE 'UTC') + interval '90 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`)).rows[0]?.at ?? '';
    AT_DAY = AT.slice(0, 10);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is off until a member turns it on, shows a member only their own setting, and is turned off by deleting the row', async () => {
    expect(await get('lan')).toEqual({ enabled: false, minute: 480, timeZone: ZONE, language: 'vi' });
    expect(await set('lan', { enabled: true, minute: 450, timeZone: ZONE, language: 'en' })).toEqual({ enabled: true, minute: 450, timeZone: ZONE, language: 'en' });
    expect(await get('lan')).toEqual({ enabled: true, minute: 450, timeZone: ZONE, language: 'en' });
    // Nobody else sees it, an owner included; the system context reads no member's setting either.
    for (const who of ['owner', 'rec']) expect(await get(who), who).toMatchObject({ enabled: false });
    expect(await refuses(worker.query('meetings.weekly.get', {}, { actor: SYSTEM, orgId }))).not.toBeNull();
    // Turning it on again changes the one row; defaults fill what the member left out.
    await set('lan', { enabled: true });
    expect(await get('lan')).toEqual({ enabled: true, minute: 480, timeZone: ZONE, language: 'vi' });
    expect((await sqlAdmin(`SELECT 1 FROM ludy_meetings.weekly_notice WHERE org_id = $1 AND user_id = $2`, [orgId, users.lan])).rowCount).toBe(1);
    await set('lan', { enabled: false });
    expect(await get('lan')).toMatchObject({ enabled: false });
    expect((await sqlAdmin(`SELECT 1 FROM ludy_meetings.weekly_notice WHERE org_id = $1 AND user_id = $2`, [orgId, users.lan])).rowCount).toBe(0);
  });

  it('refuses a time that is not a minute of the day and a zone that is not a zone, and no member but the system dispatches', async () => {
    for (const bad of [{ minute: -1 }, { minute: 1440 }, { minute: 7.5 }, { timeZone: 'Mars/Olympus' }, { timeZone: '' }, { language: 'fr' }, { extra: 1 }]) {
      expect(await refuses(set('lan', { enabled: true, ...bad })), JSON.stringify(bad)).not.toBeNull();
    }
    expect(await get('lan')).toMatchObject({ enabled: false });
    expect(await refuses(runtime.execute('meetings.weekly.notice', { userId: users.lan, day: AT_DAY }, { actor: asUser('lan'), orgId }))).not.toBeNull();
  });

  it('says the same four numbers as the "this week" card, for a recorder, a reader, an owner and a member limited to one legal entity, and nothing to a member who reads nothing', async () => {
    // Readable by lan: one they read as a listed reader, and one the whole org reads. Not readable by lan: a meeting of rec alone. A draft-only meeting, a meeting past its text date and an old one take no place.
    const a = await meeting('Giao ban đầu tuần', 2, 'rec', ['lan']);
    const b = await meeting('Họp khách Á Châu', 1, 'rec', ['lan']);
    const org = await meeting('Họp toàn công ty', 3, 'rec', [], { visibility: 'org' });
    const hidden = await meeting('Họp kín của anh Tuấn', 1, 'rec', []);
    const draftOnly = await meeting('Chỉ có bản nháp', 2, 'rec', ['lan']);
    const expired = await meeting('Họp đã hết hạn lưu', 2, 'rec', ['lan'], { textDay: `date '${AT_DAY}' - 1` });
    // ltd, limited to one legal entity, reads only what they are listed on.
    const own = await meeting('Họp của chi nhánh', 1, 'rec', ['ltd']);
    const old = await meeting('Họp tháng trước', 30, 'rec', ['lan']);
    await result(a, ['Chốt giá gói kế toán', '   ', 'Hẹn khách ký hợp đồng 15 triệu'], 'published');
    await result(a, ['Quyết định bí mật nháp'], 'draft');
    await result(b, ['Gia hạn dịch vụ thêm một quý'], 'published');
    await result(org, ['Nghỉ lễ ngày 2 tháng 9'], 'published');
    await result(hidden, ['Quyết định bí mật của cuộc họp kín'], 'published');
    await result(draftOnly, ['Quyết định bí mật chưa chia sẻ'], 'draft');
    await result(expired, ['Quyết định bí mật đã hết hạn'], 'published');
    await result(old, ['Quyết định bí mật tháng trước'], 'published');
    await result(own, ['Quyết định của chi nhánh'], 'published');
    await item(own, 'Việc của chi nhánh');
    await item(a, 'Gửi báo giá bản cuối', { task: 'in_progress', due: new Date(Date.parse(AT) - 2 * 86_400_000).toISOString() });
    await item(a, 'Việc đã xong', { task: 'done' });
    await item(a, 'Chưa ai nhận việc này');
    await item(a, 'Việc bí mật nháp', { stage: 'draft' });
    await item(b, 'Soạn hợp đồng', { task: 'todo', due: new Date(Date.parse(AT) + 5 * 86_400_000).toISOString() });
    await item(hidden, 'Việc bí mật của cuộc họp kín');
    for (const who of ['lan', 'ltd', 'rec', 'owner', 'other']) await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 480, $3, 'vi') ON CONFLICT DO NOTHING`, [orgId, users[who], ZONE]);
    const seen: Record<string, { meetings: number; decisions: number; open: number; overdue: number; cut: boolean } | null> = {};
    for (const who of ['lan', 'ltd', 'rec', 'owner']) {
      const row = await due(who);
      expect(row, who).not.toBeNull();
      seen[who] = row ? numbersOf(row) : null;
      expect(seen[who], who).toEqual(await cardNumbers(who));
      // A row holds numbers, a day, two flags and ids: nothing of a meeting's text.
      expect(Object.keys(row ?? {}).sort(), who).toEqual(['cut', 'day', 'decisions', 'english', 'meetings', 'open_items', 'org_id', 'overdue', 'user_id']);
      expect(JSON.stringify(row), who).not.toMatch(CANARY);
    }
    // The numbers themselves, so a card and a notice that were both wrong would still be caught.
    expect(seen.lan).toEqual({ meetings: 3, decisions: 4, open: 3, overdue: 1, cut: false });
    // ltd reads the one they are listed on: the org-visible meeting is not theirs (their scope is one entity, not the org), and neither is a or b.
    expect(seen.ltd).toEqual({ meetings: 1, decisions: 1, open: 1, overdue: 0, cut: false });
    // The recorder reads all of their own with a published thing (a, b, the org one, the hidden one and the branch one); an owner reads the org-visible one only, as does a member with nothing of their own.
    expect(seen.rec?.meetings).toBe(5);
    expect(seen.owner).toEqual({ meetings: 1, decisions: 1, open: 0, overdue: 0, cut: false });
    const other = await due('other');
    expect(other && numbersOf(other)).toEqual({ meetings: 1, decisions: 1, open: 0, overdue: 0, cut: false });
    expect(other && numbersOf(other)).toEqual(await cardNumbers('other'));
    // The org-wide meeting is taken back, so the members who read nothing else have nothing to be told of in the tests that follow.
    await sqlAdmin(`DELETE FROM ludy_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2`, [orgId, org]);
    expect(await due('other')).toBeNull();
    expect(await due('owner')).toBeNull();
  });

  it('reports a cut like the card does: at most 30 decisions, and the flag that says it', async () => {
    const m = await meeting('Họp dài nhiều quyết định', 1, 'big', []);
    await result(m, Array.from({ length: 35 }, (_, i) => `Quyết định số ${i + 1}`), 'published');
    await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 480, $3, 'vi')`, [orgId, users.big, ZONE]);
    const row = await due('big');
    expect(row && numbersOf(row)).toEqual({ meetings: 1, decisions: 30, open: 0, overdue: 0, cut: true });
    expect(row && numbersOf(row)).toEqual(await cardNumbers('big'));
  });

  it('sends one in-app notice and one mail with only the numbers and a link, once a Monday, and a second dispatch sends nothing more', async () => {
    const first = await notice('lan');
    expect(first).toMatchObject({ notified: true, mailed: true });
    const mine = await notices('lan');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ dedupe_key: `weekly:${AT_DAY}`, detail: { meetings: '2', decisions: '3', open: '3', overdue: '1', cut: '0' }, subject_id: null });
    const sent = await mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to_address: 'lan@weekly.test', source: 'meetings.weekly', source_id: null, status: 'queued', subject: 'Tổng kết các cuộc họp tuần qua' });
    expect(sent[0]?.payload).toEqual({ lang: 'vi', org: 'Công ty Tổng Kết Tuần', meetings: 2, decisions: 3, open: 3, overdue: 1, cut: false, path: expect.stringMatching(/^\/o\/[a-z0-9-]+\/meetings\?tool=digest$/) });
    // No title, no decision, no item: not in the notice, the mail's data, the mail rendered or the audit rows of the command.
    const rendered = await weeklyMailTemplate.render({ messageId: randomUUID(), subject: 'x', payload: zWeeklyMail.parse(sent[0]?.payload), publicUrl: 'https://ludy.test', inboundAddress: null, brand: 'Ludy', execute: async () => undefined as never });
    const audit = (await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.weekly.notice'`, [orgId])).rows;
    for (const text of [JSON.stringify(mine), JSON.stringify(sent), JSON.stringify(rendered), JSON.stringify(audit)]) expect(text).not.toMatch(CANARY);
    // The audit row names the Monday and nothing that varies (no number, not whether a mail was queued): an owner or admin reads the audit log and must not learn what a member reads.
    // (A system audit row may also name the worker process that ran it, `workerInstance`: the deployment's, not the member's; it is left out of the comparison.)
    expect(audit.length).toBeGreaterThan(0);
    for (const row of audit) {
      const { workerInstance: _worker, ...rest } = (row.detail ?? {}) as Record<string, unknown>;
      expect(rest).toEqual({ day: AT_DAY });
    }
    expect(rendered?.text).toContain('2 cuộc họp');
    expect(rendered?.text).toContain('/o/');
    // The same Monday again: nothing new, by a dispatch of the same row or by a read of the definer.
    expect(await notice('lan')).toEqual({ notified: false, mailed: false });
    expect(await due('lan')).toBeNull();
    expect(await notices('lan')).toHaveLength(1);
    expect(await mails()).toHaveLength(1);
  });

  it('sends nothing before the chosen time, on a day that is not Monday, to a member who muted the kind or turned it off, for a zone the database does not know, or for a week with nothing to show', async () => {
    // early: a Monday time that has not come (10:00 against 08:30), with a meeting to tell of.
    const w = await meeting('Họp của early', 1, 'rec', ['early']);
    await result(w, ['Một quyết định'], 'published');
    await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 600, $3, 'vi')`, [orgId, users.early, ZONE]);
    expect(await due('early')).toBeNull();
    // ...and the same member two hours later is due, and not after the six hours.
    expect(await due('early', new Date(Date.parse(AT) + 2 * 3_600_000).toISOString())).not.toBeNull();
    expect(await due('early', new Date(Date.parse(AT) + 9 * 3_600_000).toISOString())).toBeNull();
    // The next day is a Tuesday: nobody is due, whatever time they chose (early's time has come by then, and they were not told).
    expect(await due('early', new Date(Date.parse(AT) + 26 * 3_600_000).toISOString())).toBeNull();
    // muted: the kind is off in the notification settings.
    await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 480, $3, 'vi')`, [orgId, users.muted, ZONE]);
    await sqlAdmin(`INSERT INTO ludy_kernel.notification_mute (org_id, user_id, kind) VALUES ($1, $2, $3)`, [orgId, users.muted, WEEKLY_KIND]);
    // odd: a zone name the database does not know, stored by hand: skipped, and the others still read.
    await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 480, 'Not/AZone', 'vi')`, [orgId, users.odd]);
    // quiet: a time that has come but a week with nothing published.
    await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 480, $3, 'vi')`, [orgId, users.quiet, ZONE]);
    const draftOnly = await meeting('Chỉ nháp của quiet', 1, 'quiet', []);
    await result(draftOnly, ['Quyết định bí mật nháp'], 'draft');
    for (const who of ['muted', 'odd', 'quiet']) expect(await due(who), who).toBeNull();
    // owner never opted in: nothing though they read meetings.
    await sqlAdmin(`DELETE FROM ludy_meetings.weekly_notice WHERE org_id = $1 AND user_id = $2`, [orgId, users.owner]);
    expect(await due('owner')).toBeNull();
  });

  it('is due in the member\'s own zone: the Monday and the hour are theirs, not Vietnam\'s', async () => {
    const m = await meeting('Họp ở xa', 1, 'rec', ['late', 'sunday']);
    await result(m, ['Quyết định xa'], 'published');
    // Kiritimati is 14 hours ahead: 15:30 on the Monday when it is 08:30 in Vietnam, so 15:00 has come.
    await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 900, 'Pacific/Kiritimati', 'en')`, [orgId, users.late]);
    const row = await due('late');
    expect(row).toMatchObject({ day: AT_DAY, english: true });
    // Pago Pago is 11 hours behind: still Sunday there, so nothing is due however early they chose.
    await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 840, 'Pacific/Pago_Pago', 'vi')`, [orgId, users.sunday]);
    expect(await due('sunday')).toBeNull();
    const sentNow = await notice('late');
    expect(sentNow).toMatchObject({ notified: true });
    const english = (await mails()).find((x) => x.to_address === 'late@weekly.test');
    expect(english?.payload).toMatchObject({ lang: 'en' });
    expect(english?.subject).toBe('Your meetings this past week');
  });

  it('sends nothing for a member who left the org or a disabled account', async () => {
    const m = await meeting('Họp của nhóm đã rời', 1, 'rec', ['gone', 'disabled']);
    await result(m, ['Quyết định nhóm'], 'published');
    for (const who of ['gone', 'disabled']) await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 480, $3, 'vi')`, [orgId, users[who], ZONE]);
    expect(await due('gone')).not.toBeNull();
    expect(await due('disabled')).not.toBeNull();
    // Left the org: the membership row goes (its trigger deletes the setting too).
    await sqlAdmin(`DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgId, users.gone]);
    // The setting goes with the membership (a trigger), so a member who comes back finds the switch off.
    expect((await sqlAdmin(`SELECT 1 FROM ludy_meetings.weekly_notice WHERE org_id = $1 AND user_id = $2`, [orgId, users.gone])).rowCount).toBe(0);
    expect(await due('gone')).toBeNull();
    // A disabled account.
    await sqlAdmin(`UPDATE ludy_kernel.user_account SET disabled_at = now() WHERE id = $1`, [users.disabled]);
    expect(await due('disabled')).toBeNull();
  });

  it('the sweep finds each member due once, hands each to the command, queues push for the written notice, and finds nothing on the next pass', async () => {
    const mine = await meeting('Họp của sweepy', 1, 'rec', ['sweepy']);
    await result(mine, ['Quyết định sweepy'], 'published');
    await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 480, $3, 'vi')`, [orgId, users.sweepy, ZONE]);
    const pushed: Array<{ orgId: string; notificationId: string }> = [];
    const first = await runMeetingsWeeklySweep({ runtime: worker, workerDb, at: AT, onNotified: async (row) => void pushed.push(row) });
    // sweepy and the members above that were still due: each told once. (lan and late were told by the dispatches above.)
    expect(first.failures).toBe(0);
    expect(first.sent).toBe(first.found);
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect(pushed).toHaveLength(first.sent);
    expect((await notices('sweepy')).map((n) => n.dedupe_key)).toEqual([`weekly:${AT_DAY}`]);
    expect(await runMeetingsWeeklySweep({ runtime: worker, workerDb, at: AT })).toMatchObject({ found: 0, sent: 0, failures: 0 });
    // The worker's own clock reads the real week: it finds nothing wrong, whatever day it is.
    expect((await runMeetingsWeeklySweep({ runtime: worker, workerDb })).failures).toBe(0);
  });

  it('reads a task the way the member\'s own row security shows it: one in another legal entity or in a private project they are not part of is absent, so its item counts as open, as on the card', async () => {
    // A closed task of another legal entity, a closed task of a private project the owner runs, and an item with no task, all on one meeting that hid (the whole org) and hidltd (one entity) read.
    const branch2 = (await sqlAdmin<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh hai', 'branch', $2) RETURNING id`, [orgId, users.owner])).rows[0]?.id;
    const project = (await sqlAdmin<{ id: string }>(`INSERT INTO ludy_projects.project (org_id, name, visibility, owner_user_id, created_by) VALUES ($1, 'Dự án riêng', 'private', $2, $2) RETURNING id`, [orgId, users.owner])).rows[0]?.id;
    const task = async (title: string, over: { entity?: string; project?: string }) => {
      const id = randomUUID();
      await sqlAdmin(`INSERT INTO ludy_kernel.task (org_id, id, title, source, created_by_type, status, legal_entity_id) VALUES ($1, $2, $3, 'human', 'system', 'done', $4)`, [orgId, id, title, over.entity ?? null]);
      if (over.project) await sqlAdmin(`INSERT INTO ludy_projects.project_task (org_id, project_id, task_id, added_by) VALUES ($1, $2, $3, $4)`, [orgId, over.project, id, users.owner]);
      return id;
    };
    const m = await meeting('Họp có việc ở nơi khác', 1, 'rec', ['hid', 'hidltd']);
    await result(m, ['Quyết định chung'], 'published');
    const itemOf = async (title: string, taskId: string | null) =>
      sqlAdmin(
        `INSERT INTO ludy_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, task_id, tainted, transcript_seconds) VALUES ($1, $2, $3, $4, 'Lan', $5, 'thứ sáu', 'published', $6, $7, false, 10)`,
        [orgId, randomUUID(), m, title, users.lan, taskId === null ? 'suggested' : 'accepted', taskId],
      );
    await itemOf('Việc của chi nhánh hai', await task('Việc chi nhánh hai', { entity: branch2 as string }));
    await itemOf('Việc trong dự án riêng', await task('Việc dự án riêng', { project: project as string }));
    await itemOf('Việc chưa có task', null);
    for (const who of ['hid', 'hidltd']) await sqlAdmin(`INSERT INTO ludy_meetings.weekly_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 480, $3, 'vi')`, [orgId, users[who], ZONE]);
    // The card, as each member reads it: the whole-org member sees the other entity's closed task (so it is not open) but not the private project's (so it is); the one-entity member sees neither.
    const titles = async (who: string) => (await facts(who)).meetings.flatMap((x) => x.items.map((i) => i.title)).sort();
    expect(await titles('hid')).toEqual(['Việc chưa có task', 'Việc trong dự án riêng']);
    expect(await titles('hidltd')).toEqual(['Việc chưa có task', 'Việc của chi nhánh hai', 'Việc trong dự án riêng']);
    for (const who of ['hid', 'hidltd']) {
      const row = await due(who);
      expect(row, who).not.toBeNull();
      expect(row && numbersOf(row), who).toEqual(await cardNumbers(who));
    }
    expect(numbersOf((await due('hid'))!)).toMatchObject({ meetings: 1, decisions: 1, open: 2 });
    expect(numbersOf((await due('hidltd'))!)).toMatchObject({ meetings: 1, decisions: 1, open: 3 });
  });

  it('sends nothing for an org that is closing', async () => {
    const m = await meeting('Họp của quiet', 1, 'quiet', []);
    await result(m, ['Quyết định của quiet'], 'published');
    expect(await due('quiet')).not.toBeNull();
    await sqlAdmin(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [orgId]);
    expect(await due('quiet')).toBeNull();
    expect(await runMeetingsWeeklySweep({ runtime: worker, workerDb, at: AT })).toMatchObject({ found: 0, sent: 0 });
  });
});
