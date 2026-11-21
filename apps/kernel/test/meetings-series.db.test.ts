// SPDX-License-Identifier: AGPL-3.0-only
// A series of meetings (#3542, owner decision 2026-11-17) on a real database: the recurring event id the sweep reads is kept as a hash (never the provider's own id), the member's click that
// links a meeting to its event puts the meeting in that series, the recorder can say one meeting follows another, and the open items of the previous meeting come back with the live status of
// their task (a done task does not), the ones nobody accepted as such, and nothing at all, not even a title, for a reader who did not read the previous meeting.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { GOOGLE_CALENDAR_EVENTS_READ_SCOPE, MICROSOFT_CALENDAR_READ_SCOPE, type SeriesOpenItems } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'test.series' };
const suite = ADMIN ? describe : describe.skip;

suite('a series of meetings (#3542)', () => {
  const dbName = `crove_test_series_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let worker: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const query = <O = unknown>(who: string, name: string, input: unknown = {}) => runtime.query<O>(name, input, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
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

  const iso = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();
  // A connection of a member with the events read on, as the member's own switch leaves it.
  async function connection(who: string, provider: 'google' | 'microsoft' = 'google'): Promise<string> {
    const id = randomUUID();
    const scopes = provider === 'google' ? [GOOGLE_CALENDAR_EVENTS_READ_SCOPE] : [MICROSOFT_CALENDAR_READ_SCOPE];
    await sqlAdmin(`INSERT INTO crove_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events) VALUES ($1, $2, $3, $6, $4, $4, $5, true)`, [
      orgId,
      id,
      users[who],
      `${who}-${randomUUID().slice(0, 6)}@calendar.test`,
      scopes,
      provider,
    ]);
    return id;
  }
  const event = (id: string, startMinutes: number, series: string | null) => ({ id, title: `Họp ${id}`, startsAt: iso(startMinutes), endsAt: iso(startMinutes + 60), timeZone: 'Asia/Ho_Chi_Minh', joinUrl: null, invitees: 2, series });
  const sweep = (connectionId: string, events: unknown[]) => worker.execute<{ written: number }>('meetings.agenda.replace', { connectionId, from: iso(-24 * 60), events }, { actor: SYSTEM, orgId });
  const seriesOfEvent = async (connectionId: string, externalId: string) =>
    (await sqlAdmin<{ series_id: string | null }>('SELECT series_id FROM crove_meetings.calendar_agenda WHERE org_id = $1 AND connection_id = $2 AND external_id = $3', [orgId, connectionId, externalId])).rows[0]?.series_id ?? null;
  const agendaId = async (connectionId: string, externalId: string) =>
    (await sqlAdmin<{ id: string }>('SELECT id FROM crove_meetings.calendar_agenda WHERE org_id = $1 AND connection_id = $2 AND external_id = $3', [orgId, connectionId, externalId])).rows[0]?.id as string;

  // A meeting recorded by `recorder`, started `startMinutes` from now (negative: in the past), read by `readers`.
  async function meeting(recorder: string, startMinutes: number, readers: string[] = [], title = 'Họp giao ban'): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $6, 'vi', $4, $5, 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 20, current_date + 365)`,
      [orgId, id, users[recorder], iso(startMinutes), iso(startMinutes + 60), title],
    );
    for (const who of readers) await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[who]]);
    return id;
  }
  const seriesOf = async (meetingId: string) => (await sqlAdmin<{ series_id: string | null }>('SELECT series_id FROM crove_meetings.meeting WHERE id = $1', [meetingId])).rows[0]?.series_id ?? null;
  const setSeries = (who: string, meetingId: string, previousMeetingId: string | null) => exec<{ inSeries: boolean }>(who, 'meetings.series.set', { meetingId, previousMeetingId });
  const openItems = (who: string, meetingId: string) => query<SeriesOpenItems>(who, 'meetings.series.open_items', { meetingId });

  async function seat(title: string, holder: string | null): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(`INSERT INTO crove_kernel.position (org_id, id, title, module, role_key, holder_user_id) VALUES ($1, $2, $3, 'kernel', 'member', $4)`, [orgId, id, title, holder === null ? null : users[holder]]);
    return id;
  }

  // An item of a meeting, published, with its task when `task` is given (a status), as the accept click leaves them.
  async function item(meetingId: string, title: string, over: { task?: string; stage?: 'draft' | 'published'; who?: string; due?: string; seat?: string } = {}): Promise<string> {
    const id = randomUUID();
    let taskId: string | null = null;
    if (over.task !== undefined) {
      taskId = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.task (org_id, id, title, source, created_by_type, status, due, assignee_position_id) VALUES ($1, $2, $3, 'human', 'system', $4, $5, $6)`, [
        orgId,
        taskId,
        title,
        over.task,
        over.due ?? null,
        over.seat ?? null,
      ]);
    }
    await sqlAdmin(
      `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, task_id, tainted, transcript_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, 'thứ sáu', $7, $8, $9, false, 10)`,
      [orgId, id, meetingId, title, over.who ?? 'Lan', over.who ? null : users.lan, over.stage ?? 'published', taskId === null ? 'suggested' : 'accepted', taskId],
    );
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of ['owner', 'rec', 'lan', 'nam', 'other']) users[key] = await upsertIdentity(createDb(appPool), { issuer: 'series', subject: key, email: `${key}@series.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Chuỗi')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, [orgId, users.rec, users.lan, users.nam, users.other]);
  }, 300_000);

  beforeEach(async () => {
    await sqlAdmin('DELETE FROM crove_kernel.calendar_connection WHERE org_id = $1', [orgId]);
    await sqlAdmin('DELETE FROM crove_meetings.meeting WHERE org_id = $1', [orgId]);
    await sqlAdmin('DELETE FROM crove_kernel.task WHERE org_id = $1', [orgId]);
    await sqlAdmin(`DELETE FROM crove_kernel.position WHERE org_id = $1 AND title LIKE 'Ghế thử%'`, [orgId]);
  });

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps the recurring event id of an occurrence only as a hash of the provider and that id: one series across members, another for another provider, none for a single event', async () => {
    const mine = await connection('rec');
    const theirs = await connection('lan');
    const outlook = await connection('nam', 'microsoft');
    await sweep(mine, [event('e1', 60, 'weekly-staff'), event('e2', 60 * 24 * 7 + 60, 'weekly-staff'), event('single', 120, null)]);
    await sweep(theirs, [event('e1-copy', 60, 'weekly-staff')]);
    await sweep(outlook, [event('o1', 60, 'weekly-staff')]);
    const first = await seriesOfEvent(mine, 'e1');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await seriesOfEvent(mine, 'e2')).toBe(first);
    expect(await seriesOfEvent(theirs, 'e1-copy')).toBe(first);
    expect(await seriesOfEvent(mine, 'single')).toBeNull();
    // The same text from another provider is another series, and the stored value is the hash, not the provider's id.
    const other = await seriesOfEvent(outlook, 'o1');
    expect(other).not.toBe(first);
    expect(first).toBe((await sqlAdmin<{ h: string }>(`SELECT md5('google:weekly-staff')::uuid::text AS h`)).rows[0]?.h);
    expect(other).toBe((await sqlAdmin<{ h: string }>(`SELECT md5('microsoft:weekly-staff')::uuid::text AS h`)).rows[0]?.h);
    const everything = JSON.stringify((await sqlAdmin('SELECT * FROM crove_meetings.calendar_agenda WHERE org_id = $1', [orgId])).rows);
    expect(everything).not.toContain('weekly-staff');
    // A later sweep that finds the event outside a series takes the value away.
    await sweep(mine, [event('e1', 60, null)]);
    expect(await seriesOfEvent(mine, 'e1')).toBeNull();
  });

  it('puts a meeting in the series of the event the recorder links it to, and does not overwrite a series the recorder chose or clear it on unlinking', async () => {
    const mine = await connection('rec');
    await sweep(mine, [event('a', -120, 'weekly-staff'), event('b', -60, 'weekly-staff'), event('c', 30, null)]);
    const m1 = await meeting('rec', -120);
    const m2 = await meeting('rec', -60);
    const m3 = await meeting('rec', 30);
    expect(await exec('rec', 'meetings.agenda.link', { agendaId: await agendaId(mine, 'a'), meetingId: m1 })).toMatchObject({ meetingId: m1 });
    await exec('rec', 'meetings.agenda.link', { agendaId: await agendaId(mine, 'b'), meetingId: m2 });
    const series = await seriesOfEvent(mine, 'a');
    expect(await seriesOf(m1)).toBe(series);
    expect(await seriesOf(m2)).toBe(series);
    // An event with no series leaves the meeting as it is; a series the recorder set by hand is not replaced by an event's.
    await exec('rec', 'meetings.agenda.link', { agendaId: await agendaId(mine, 'c'), meetingId: m3 });
    expect(await seriesOf(m3)).toBeNull();
    const manual = await meeting('rec', -30);
    const chosen = await meeting('rec', -200);
    await setSeries('rec', manual, chosen);
    const mine2 = await seriesOf(manual);
    await sqlAdmin('UPDATE crove_meetings.calendar_agenda SET meeting_id = NULL WHERE org_id = $1', [orgId]);
    await exec('rec', 'meetings.agenda.link', { agendaId: await agendaId(mine, 'a'), meetingId: manual });
    expect(await seriesOf(manual)).toBe(mine2);
    // Unlinking leaves the meeting's series alone.
    await exec('rec', 'meetings.agenda.link', { agendaId: await agendaId(mine, 'a'), meetingId: null });
    expect(await seriesOf(manual)).toBe(mine2);
  });

  it('lets the recorder say one meeting follows an earlier one they recorded: one series for both, joined by a third, never merged, never for another recorder\'s meeting', async () => {
    const m1 = await meeting('rec', -300);
    const m2 = await meeting('rec', -200);
    const m3 = await meeting('rec', -100);
    expect(await setSeries('rec', m2, m1)).toMatchObject({ inSeries: true });
    const series = await seriesOf(m1);
    expect(series).not.toBeNull();
    expect(await seriesOf(m2)).toBe(series);
    // A third meeting follows the second and joins the same series.
    await setSeries('rec', m3, m2);
    expect(await seriesOf(m3)).toBe(series);
    // Two different series are not merged by a click.
    const x1 = await meeting('rec', -90);
    const x2 = await meeting('rec', -80);
    await setSeries('rec', x2, x1);
    expect(await refuses(setSeries('rec', x2, m1))).toBe('SERIES_CONFLICT');
    expect(await refuses(setSeries('rec', m1, m1))).toBe('SERIES_SELF');
    // The "earlier" meeting must have started before this one.
    expect(await refuses(setSeries('rec', m1, m3))).toBe('SERIES_ORDER');
    // Another recorder's meeting is not theirs to follow, and not the recorder's to change: only the recorder sets the series.
    const theirs = await meeting('other', -250, ['rec']);
    expect(await refuses(setSeries('rec', m3, theirs))).toBe('FORBIDDEN');
    expect(await refuses(setSeries('other', m3, theirs))).toMatch(/FORBIDDEN|MEETING_NOT_FOUND/);
    // Leaving takes only this meeting out.
    expect(await setSeries('rec', m3, null)).toMatchObject({ inSeries: false });
    expect(await seriesOf(m3)).toBeNull();
    expect(await seriesOf(m2)).toBe(series);
  });

  it('lists the previous meeting\'s open items: accepted ones with the task\'s live status, unaccepted ones as not assigned, and not a done or cancelled task, a draft item or another meeting\'s item', async () => {
    const earlier = await meeting('rec', -300, ['lan', 'nam'], 'Giao ban tuần trước');
    const current = await meeting('rec', -10, ['lan', 'nam'], 'Giao ban tuần này');
    await setSeries('rec', current, earlier);
    await item(earlier, 'Gửi báo giá', { task: 'in_progress', who: 'Nam', due: '2026-12-01T00:00:00Z' });
    await item(earlier, 'Gọi lại khách', { task: 'todo' });
    await item(earlier, 'Việc đã xong', { task: 'done' });
    await item(earlier, 'Việc đã hủy', { task: 'cancelled' });
    await item(earlier, 'Chưa ai nhận');
    await item(earlier, 'Việc nháp', { stage: 'draft' });
    const unrelated = await meeting('rec', -400, ['lan']);
    await item(unrelated, 'Việc của buổi khác', { task: 'todo' });
    for (const who of ['rec', 'lan']) {
      const out = await openItems(who, current);
      expect(out).toMatchObject({ meetingId: current, inSeries: true, previous: { meetingId: earlier, title: 'Giao ban tuần trước' } });
      expect(out.items.map((i) => [i.title, i.assigned, i.taskStatus]).sort()).toEqual([
        ['Chưa ai nhận', false, null],
        ['Gọi lại khách', true, 'todo'],
        ['Gửi báo giá', true, 'in_progress'],
      ]);
      expect(out.items.find((i) => i.title === 'Gửi báo giá')?.due).toBe('2026-12-01T00:00:00.000Z');
    }
    // The task moves on: the list follows it.
    await sqlAdmin(`UPDATE crove_kernel.task SET status = 'done' WHERE org_id = $1 AND title = 'Gửi báo giá'`, [orgId]);
    expect((await openItems('lan', current)).items.map((i) => i.title).sort()).toEqual(['Chưa ai nhận', 'Gọi lại khách']);
  });

  it('shows a reader of the new meeting who did not read the old one nothing of it: no items and not even its title', async () => {
    const earlier = await meeting('rec', -300, ['lan'], 'Cuộc họp riêng tư tuần trước');
    const current = await meeting('rec', -10, ['lan', 'nam'], 'Giao ban tuần này');
    await setSeries('rec', current, earlier);
    await item(earlier, 'Việc riêng của buổi trước', { task: 'todo' });
    const seen = await openItems('nam', current);
    expect(seen).toEqual({ meetingId: current, inSeries: true, previous: null, items: [] });
    expect(JSON.stringify(seen)).not.toMatch(/riêng|Việc/);
    // A caller who reads neither meeting is told the meeting is not there.
    expect(await refuses(openItems('other', current))).toMatch(/MEETING_NOT_FOUND|NOT_FOUND/);
    expect((await openItems('lan', current)).items).toHaveLength(1);
  });

  it('answers for a meeting that is in no series, or whose series has no earlier meeting, with an empty list', async () => {
    const alone = await meeting('rec', -10, ['lan']);
    expect(await openItems('lan', alone)).toEqual({ meetingId: alone, inSeries: false, previous: null, items: [] });
    const first = await meeting('rec', -300, ['lan']);
    const second = await meeting('rec', -10, ['lan']);
    await setSeries('rec', second, first);
    // The first meeting of a series has nothing before it.
    expect(await openItems('lan', first)).toEqual({ meetingId: first, inSeries: true, previous: null, items: [] });
  });

  it('takes the latest earlier meeting of the series the caller reads, skipping one they do not', async () => {
    const oldest = await meeting('rec', -600, ['nam'], 'Buổi đầu');
    const middle = await meeting('rec', -300, [], 'Buổi giữa (nam không đọc)');
    const current = await meeting('rec', -10, ['nam']);
    await setSeries('rec', middle, oldest);
    await setSeries('rec', current, middle);
    await item(oldest, 'Việc buổi đầu', { task: 'todo' });
    await item(middle, 'Việc buổi giữa', { task: 'todo' });
    const seen = await openItems('nam', current);
    expect(seen.previous?.meetingId).toBe(oldest);
    expect(seen.items.map((i) => i.title)).toEqual(['Việc buổi đầu']);
    expect(JSON.stringify(seen)).not.toContain('giữa');
    expect((await openItems('rec', current)).previous?.meetingId).toBe(middle);
  });

  it('shows the person the task is with NOW (the holder of its seat), not the one the item was parsed to, and the seat title when nobody holds it', async () => {
    const earlier = await meeting('rec', -300, ['lan', 'nam']);
    const current = await meeting('rec', -10, ['lan', 'nam']);
    await setSeries('rec', current, earlier);
    // The item was parsed to Lan; the task was then given to Nam's seat.
    await item(earlier, 'Việc đã giao lại', { task: 'todo', seat: await seat('Ghế thử A', 'nam') });
    await item(earlier, 'Việc ghế trống', { task: 'todo', seat: await seat('Ghế thử B', null) });
    await item(earlier, 'Việc không ghế', { task: 'todo' });
    const out = (await openItems('lan', current)).items;
    const by = (title: string) => out.find((i) => i.title === title);
    expect(by('Việc đã giao lại')).toMatchObject({ whoUserId: users.nam, assigneeSeat: 'Ghế thử A' });
    expect(by('Việc ghế trống')).toMatchObject({ whoUserId: users.lan, assigneeSeat: 'Ghế thử B' });
    expect(by('Việc không ghế')).toMatchObject({ whoUserId: users.lan, assigneeSeat: null });
  });

  it('does not list the items of a previous meeting whose text period has ended', async () => {
    const earlier = await meeting('rec', -300, ['lan']);
    const current = await meeting('rec', -10, ['lan']);
    await setSeries('rec', current, earlier);
    await item(earlier, 'Việc cũ', { task: 'todo' });
    await sqlAdmin('UPDATE crove_meetings.meeting SET text_retention_date = current_date - 1 WHERE id = $1', [earlier]);
    expect(await openItems('lan', current)).toEqual({ meetingId: current, inSeries: true, previous: null, items: [] });
  });
});
