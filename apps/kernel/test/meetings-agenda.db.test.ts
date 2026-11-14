// SPDX-License-Identifier: AGPL-3.0-only
// A member's own Google Calendar meetings, read to suggest "record this meeting" (Meetings B1, #3165, plan section 5.1) on a real database: the switch (off by default, on only with a grant that
// carries the events-read scope, off deletes the cache at once), the sweep's write through the one definer (a count, never text; nothing for a connection that is off), the cache read by its member
// alone (an owner, an admin, another member and the system context read none), no invitee address, description or attachment anywhere, the suggestion by time overlap only (one event within 15
// minutes), the member's own click that links a meeting to its event, and nothing that starts a recording.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { GOOGLE_CALENDAR_EVENTS_READ_SCOPE, type AgendaList, type AgendaSuggestion } from '@crove/kernel-contract';
import { Runtime, defineQuery } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'test.agenda' };
const suite = ADMIN ? describe : describe.skip;

// The test's own count of rows, in the caller's own context: what row security shows that actor.
const rowsQuery = defineQuery({
  name: 'test.agenda.rows',
  input: z.object({}),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx): Promise<number> => (await ctx.trx.selectFrom('crove_meetings.calendar_agenda').select('id').where('org_id', '=', ctx.orgId).execute()).length,
});
const systemRowsQuery = defineQuery({
  name: 'test.agenda.system_rows',
  input: z.object({}),
  access: 'system',
  handler: async (ctx): Promise<number> => (await ctx.trx.selectFrom('crove_meetings.calendar_agenda').select('id').where('org_id', '=', ctx.orgId).execute()).length,
});

suite("the member's own calendar meetings (B1, #3165)", () => {
  const dbName = `crove_test_agenda_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  // A connection of a member: the grant either carries the events-read scope or not; the switch is the member's, through the module's command.
  async function connection(who: string, scopes: string[] = ['https://www.googleapis.com/auth/calendar.freebusy', GOOGLE_CALENDAR_EVENTS_READ_SCOPE], account = `${who}-${randomUUID().slice(0, 6)}@gmail.test`): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(`INSERT INTO crove_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes) VALUES ($1, $2, $3, 'google', $4, $4, $5)`, [orgId, id, users[who], account, scopes]);
    return id;
  }
  const on = (who: string, connectionId: string) => exec(who, 'meetings.agenda.set_read_events', { connectionId, enabled: true });
  const off = (who: string, connectionId: string) => exec(who, 'meetings.agenda.set_read_events', { connectionId, enabled: false });
  const iso = (offsetMinutes: number, from = Date.now()) => new Date(from + offsetMinutes * 60_000).toISOString();
  // What the sweep hands over: events as the adapter parsed them.
  const event = (id: string, startMinutes: number, lengthMinutes = 60, over: Record<string, unknown> = {}) => ({
    id,
    title: `Họp ${id}`,
    startsAt: iso(startMinutes),
    endsAt: iso(startMinutes + lengthMinutes),
    timeZone: 'Asia/Ho_Chi_Minh',
    joinUrl: null,
    invitees: 2,
    ...over,
  });
  const sweep = (connectionId: string, events: unknown[], fromMinutes = -24 * 60) => worker.execute<{ written: number }>('meetings.agenda.replace', { connectionId, from: iso(fromMinutes), events }, { actor: SYSTEM, orgId });
  const cached = async (connectionId: string) => (await sqlAdmin<{ external_id: string; meeting_id: string | null }>('SELECT external_id, meeting_id FROM crove_meetings.calendar_agenda WHERE org_id = $1 AND connection_id = $2 ORDER BY starts_at', [orgId, connectionId])).rows;
  async function meeting(recorder: string, startMinutes: number, lengthMinutes = 60): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Cuộc họp đã ghi', 'vi', $4, $5, $6, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 20, current_date + 365)`,
      [orgId, id, users[recorder], iso(startMinutes), iso(startMinutes + lengthMinutes), lengthMinutes * 60],
    );
    return id;
  }
  const meetingCount = async () => Number((await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.meeting WHERE org_id = $1', [orgId])).rows[0]?.n);

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
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries, rowsQuery, systemRowsQuery] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of ['owner', 'admin', 'lan', 'nam', 'outsider']) users[key] = await upsertIdentity(createDb(appPool), { issuer: 'agenda', subject: key, email: `${key}@agenda.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Lịch')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.admin, users.lan, users.nam]);
  }, 300_000);

  // Each test starts without the members' connections and caches: the list and the suggestion look at all of a member's own events.
  beforeEach(async () => {
    await sqlAdmin('DELETE FROM crove_kernel.calendar_connection WHERE org_id = $1', [orgId]);
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is off by default: a connection reads busy times only, the sweep writes nothing for it and the list says it is off', async () => {
    const c = await connection('lan');
    expect(await query<AgendaList>('lan', 'meetings.agenda.list')).toEqual({ enabled: false, events: [] });
    expect(await sweep(c, [event('e1', 30)])).toEqual({ connectionId: c, written: 0 });
    expect(await cached(c)).toEqual([]);
    const view = (await sqlAdmin<{ read_events: boolean }>('SELECT read_events FROM crove_kernel.calendar_connection WHERE id = $1', [c])).rows[0];
    expect(view?.read_events).toBe(false);
  });

  it("turns on only for the member's own active connection whose grant carries the events-read scope; a refusal leaves it as it was", async () => {
    const withoutScope = await connection('lan', ['https://www.googleapis.com/auth/calendar.freebusy']);
    expect(await refuses(on('lan', withoutScope))).toBe('CALENDAR_SCOPE_MISSING');
    const mine = await connection('lan');
    // Another member (an admin included) cannot switch it: it is not found for them.
    for (const who of ['nam', 'admin', 'owner']) expect(await refuses(on(who, mine)), who).toBe('CALENDAR_NOT_FOUND');
    expect((await sqlAdmin<{ read_events: boolean }>('SELECT read_events FROM crove_kernel.calendar_connection WHERE id = ANY($1)', [[withoutScope, mine]])).rows.every((r) => r.read_events === false)).toBe(true);
    // An expired connection (Google refused the grant) must be connected again first.
    await sqlAdmin("UPDATE crove_kernel.calendar_connection SET status = 'expired' WHERE id = $1", [mine]);
    expect(await refuses(on('lan', mine))).toBe('CALENDAR_NOT_ACTIVE');
    await sqlAdmin("UPDATE crove_kernel.calendar_connection SET status = 'active' WHERE id = $1", [mine]);
    expect(await on('lan', mine)).toEqual({ connectionId: mine, readEvents: true });
    expect((await query<AgendaList>('lan', 'meetings.agenda.list')).enabled).toBe(true);
    // The kernel's own view of it: the switch and the grant together.
    const state = await worker.query<{ readEvents: boolean }>('kernel.calendar.connection_state', { connectionId: mine }, { actor: SYSTEM, orgId });
    expect(state?.readEvents).toBe(true);
    await off('lan', mine);
    expect((await worker.query<{ readEvents: boolean }>('kernel.calendar.connection_state', { connectionId: mine }, { actor: SYSTEM, orgId }))?.readEvents).toBe(false);
  });

  it("the sweep writes the member's events through the definer and answers a count; the next sweep replaces them and keeps one linked to a meeting", async () => {
    const c = await connection('lan');
    await on('lan', c);
    expect(await sweep(c, [event('e1', 30), event('e2', 120, 30, { joinUrl: 'https://meet.google.com/abc-defg-hij', invitees: 5 }), event('old', -200)])).toEqual({ connectionId: c, written: 3 });
    expect((await cached(c)).map((r) => r.external_id).sort()).toEqual(['e1', 'e2', 'old']);
    const m = await meeting('lan', 30);
    const e1 = (await sqlAdmin<{ id: string }>("SELECT id FROM crove_meetings.calendar_agenda WHERE connection_id = $1 AND external_id = 'e1'", [c])).rows[0]?.id as string;
    await exec('lan', 'meetings.agenda.link', { agendaId: e1, meetingId: m });
    // Next sweep: e2 moved, e1 is gone from the calendar (but linked, so kept), "old" ended before the window (unlinked, so dropped), a new one appears; a repeated id is written once.
    expect(await sweep(c, [event('e2', 150), event('e3', 300), event('e3', 300)])).toEqual({ connectionId: c, written: 2 });
    expect(await cached(c)).toEqual([
      { external_id: 'e1', meeting_id: m },
      { external_id: 'e2', meeting_id: null },
      { external_id: 'e3', meeting_id: null },
    ]);
    const list = await query<AgendaList>('lan', 'meetings.agenda.list');
    expect(list.events.every((e) => e.invitees >= 0)).toBe(true);
  });

  it('keeps only what the table allows: no address, description or attachment column, a join address that is https, a bounded title', async () => {
    const columns = (await sqlAdmin<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'crove_meetings' AND table_name = 'calendar_agenda' ORDER BY column_name")).rows.map((r) => r.column_name);
    expect(columns).toEqual(['connection_id', 'ends_at', 'external_id', 'id', 'invitee_count', 'join_url', 'meeting_id', 'org_id', 'starts_at', 'time_zone', 'title', 'updated_at', 'user_id']);
    const c = await connection('nam');
    await on('nam', c);
    await sweep(c, [event('long', 30, 60, { title: 'x'.repeat(200), joinUrl: 'http://zoom.us/j/1', invitees: 1000 }), event('mail', 90, 30, { title: 'khach@congty.example gọi 0912345678' })]);
    const rows = (await sqlAdmin<{ external_id: string; join_url: string | null; invitee_count: number; title: string }>('SELECT external_id, join_url, invitee_count, title FROM crove_meetings.calendar_agenda WHERE connection_id = $1 ORDER BY external_id', [c])).rows;
    // A join address that is not https is dropped; the invitee count is bounded.
    expect(rows.find((r) => r.external_id === 'long')).toMatchObject({ join_url: null, invitee_count: 1000 });
    // The command's input refuses an absurd count and a title over the cap before the definer sees it.
    expect(await refuses(sweep(c, [event('big', 10, 30, { invitees: 5000 })]))).toBe('VALIDATION');
    expect(await refuses(sweep(c, [event('wide', 10, 30, { title: 'x'.repeat(201) })]))).toBe('VALIDATION');
    // The title is the member's own text as the calendar wrote it: no address is read from anywhere else.
    expect(rows.find((r) => r.external_id === 'mail')?.title).toBe('khach@congty.example gọi 0912345678');
    await expect(sweep(c, [{ ...event('bad', 10), startsAt: 'not a time' }])).rejects.toBeTruthy();
    expect(await refuses(sweep(c, Array.from({ length: 301 }, (_, i) => event(`n${i}`, 30))))).toBe('VALIDATION');
  });

  it('is read by its member alone: another member, an owner, an admin and the system context see none, and a non-member is refused', async () => {
    const c = await connection('lan');
    await on('lan', c);
    await sweep(c, [event('private-1', 30)]);
    expect(await query<number>('lan', 'test.agenda.rows')).toBeGreaterThan(0);
    for (const who of ['nam', 'owner', 'admin']) expect(await query<number>(who, 'test.agenda.rows'), who).toBe(0);
    expect(await refuses(query<number>('outsider', 'test.agenda.rows'))).not.toBeNull();
    expect(await worker.query<number>('test.agenda.system_rows', {}, { actor: SYSTEM, orgId })).toBe(0);
    for (const who of ['nam', 'owner', 'admin']) expect((await query<AgendaList>(who, 'meetings.agenda.list')).events, who).toEqual([]);
    // Nobody else can switch it off, link it or clear it either.
    const row = (await sqlAdmin<{ id: string }>("SELECT id FROM crove_meetings.calendar_agenda WHERE external_id = 'private-1'")).rows[0]?.id as string;
    const m = await meeting('nam', 30);
    expect(await refuses(exec('nam', 'meetings.agenda.link', { agendaId: row, meetingId: m }))).toBe('AGENDA_NOT_FOUND');
    expect(await exec('nam', 'meetings.agenda.clear', { connectionId: c })).toMatchObject({ cleared: 0 });
    expect((await cached(c)).length).toBe(1);
  });

  it('turning the switch off deletes the cache at once, a link with it; clearing and a disconnect do the same', async () => {
    const c = await connection('lan');
    await on('lan', c);
    await sweep(c, [event('a', 30), event('b', 90)]);
    const m = await meeting('lan', 30);
    const a = (await sqlAdmin<{ id: string }>("SELECT id FROM crove_meetings.calendar_agenda WHERE connection_id = $1 AND external_id = 'a'", [c])).rows[0]?.id as string;
    await exec('lan', 'meetings.agenda.link', { agendaId: a, meetingId: m });
    await off('lan', c);
    expect(await cached(c)).toEqual([]);
    // A sweep that was in flight when the switch went off writes nothing.
    expect(await sweep(c, [event('late', 30)])).toMatchObject({ written: 0 });
    expect(await cached(c)).toEqual([]);
    // Clearing (after connecting again without the permission) and the cascade of a disconnect.
    await on('lan', c);
    await sweep(c, [event('c', 30)]);
    expect(await exec('lan', 'meetings.agenda.clear', { connectionId: c })).toMatchObject({ cleared: 1 });
    await sweep(c, [event('d', 30)]);
    expect((await cached(c)).length).toBe(1);
    await sqlAdmin('DELETE FROM crove_kernel.calendar_connection WHERE id = $1', [c]);
    expect(await sqlAdmin('SELECT 1 FROM crove_meetings.calendar_agenda WHERE connection_id = $1', [c]).then((r) => r.rowCount)).toBe(0);
  });

  it('hides the rows of a connection on its way out or whose grant lost the switch, before anything deletes them', async () => {
    const c = await connection('lan');
    await on('lan', c);
    await sweep(c, [event('a', 30)]);
    expect((await query<AgendaList>('lan', 'meetings.agenda.list')).events.length).toBeGreaterThan(0);
    await sqlAdmin("UPDATE crove_kernel.calendar_connection SET status = 'disconnecting' WHERE id = $1", [c]);
    expect((await query<AgendaList>('lan', 'meetings.agenda.list')).events.filter((e) => e.title === 'Họp a')).toEqual([]);
    expect(await sweep(c, [event('z', 30)])).toMatchObject({ written: 0 });
    await sqlAdmin("UPDATE crove_kernel.calendar_connection SET status = 'active' WHERE id = $1", [c]);
    await sqlAdmin('UPDATE crove_kernel.calendar_connection SET read_events = false WHERE id = $1', [c]);
    expect((await query<AgendaList>('lan', 'meetings.agenda.list')).events.filter((e) => e.title === 'Họp a')).toEqual([]);
  });

  it("lists today's meetings only (Vietnam time), earliest first, with a recorded one marked by its meeting", async () => {
    const c = await connection('nam');
    await on('nam', c);
    const vnMidnight = (() => {
      const now = new Date(Date.now() + 7 * 3_600_000);
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 7 * 3_600_000;
    })();
    const at = (hour: number) => new Date(vnMidnight + hour * 3_600_000).toISOString();
    const ev = (id: string, startsAt: string, endsAt: string) => ({ ...event(id, 0), startsAt, endsAt });
    await sweep(c, [ev('late', at(15), at(16)), ev('early', at(8), at(9)), ev('tomorrow', at(30), at(31)), ev('yesterday', at(-5), at(-4))], -48 * 60);
    const list = await query<AgendaList>('nam', 'meetings.agenda.list');
    expect(list.events.map((e) => e.title)).toEqual(['Họp early', 'Họp late']);
  });

  it('suggests the one event a recording overlaps within 15 minutes, and none when two do or none does; a linked meeting shows its event', async () => {
    const c = await connection('lan');
    await on('lan', c);
    // The recording ran from 30 to 90 minutes from now.
    const m = await meeting('lan', 30, 60);
    await sweep(c, [event('far', 300), event('near', 100, 30)]);
    const suggest = (id: string) => query<AgendaSuggestion>('lan', 'meetings.agenda.suggest', { meetingId: id });
    // Starts 10 minutes after the recording ended: within 15 minutes.
    expect(await suggest(m)).toMatchObject({ linked: null, suggestion: { title: 'Họp near' } });
    // A second event close by: no suggestion (never a guess between two).
    await sweep(c, [event('far', 300), event('near', 100, 30), event('also', 85, 30)]);
    expect((await suggest(m)).suggestion).toBeNull();
    // Nothing near: none.
    await sweep(c, [event('far', 300)]);
    expect((await suggest(m)).suggestion).toBeNull();
    // 16 minutes after the end is out; 14 is in.
    await sweep(c, [event('out', 106), event('far', 300)]);
    expect((await suggest(m)).suggestion).toBeNull();
    await sweep(c, [event('in', 104), event('far', 300)]);
    expect((await suggest(m)).suggestion).toMatchObject({ title: 'Họp in' });
    // Linked: the answer is the link, not a suggestion; another member's meeting is refused.
    const row = (await sqlAdmin<{ id: string }>("SELECT id FROM crove_meetings.calendar_agenda WHERE connection_id = $1 AND external_id = 'in'", [c])).rows[0]?.id as string;
    expect(await exec('lan', 'meetings.agenda.link', { agendaId: row, meetingId: m })).toEqual({ agendaId: row, meetingId: m });
    expect(await suggest(m)).toMatchObject({ linked: { title: 'Họp in', meetingId: m }, suggestion: null });
    const other = await meeting('nam', 30);
    expect(await refuses(suggest(other))).toBe('MEETING_NOT_FOUND');
  });

  it('links a meeting the member recorded to one of their events (one event a meeting), and takes the link away', async () => {
    const c = await connection('nam');
    await on('nam', c);
    await sweep(c, [event('x', 30), event('y', 60)]);
    const ids = (await sqlAdmin<{ id: string; external_id: string }>('SELECT id, external_id FROM crove_meetings.calendar_agenda WHERE connection_id = $1', [c])).rows;
    const x = ids.find((r) => r.external_id === 'x')?.id as string;
    const y = ids.find((r) => r.external_id === 'y')?.id as string;
    const m = await meeting('nam', 30);
    const lanMeeting = await meeting('lan', 30);
    expect(await refuses(exec('nam', 'meetings.agenda.link', { agendaId: x, meetingId: lanMeeting }))).toBe('MEETING_NOT_FOUND');
    expect(await exec('nam', 'meetings.agenda.link', { agendaId: x, meetingId: m })).toEqual({ agendaId: x, meetingId: m });
    expect(await refuses(exec('nam', 'meetings.agenda.link', { agendaId: y, meetingId: m }))).toBe('AGENDA_MEETING_LINKED');
    expect(await exec('nam', 'meetings.agenda.link', { agendaId: x, meetingId: null })).toEqual({ agendaId: x, meetingId: null });
    expect(await exec('nam', 'meetings.agenda.link', { agendaId: y, meetingId: m })).toMatchObject({ meetingId: m });
    // The row goes with the meeting.
    await sqlAdmin('DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, m]);
    expect((await cached(c)).map((r) => r.external_id).sort()).toEqual(['x']);
  });

  it('starts no recording and joins no call: nothing but the cache changes', async () => {
    const c = await connection('lan');
    const before = await meetingCount();
    await on('lan', c);
    await sweep(c, [event('joinable', 5, 30, { joinUrl: 'https://meet.google.com/abc-defg-hij' })]);
    const m = await meeting('lan', 0, 30);
    const during = await meetingCount();
    await query('lan', 'meetings.agenda.list');
    await query('lan', 'meetings.agenda.suggest', { meetingId: m });
    expect(await meetingCount()).toBe(during);
    expect(during).toBe(before + 1);
    const recorded = (await sqlAdmin<{ n: string }>("SELECT count(*)::text AS n FROM crove_meetings.audio_segment WHERE org_id = $1", [orgId])).rows[0]?.n;
    expect(Number(recorded)).toBe(0);
  });

  it('can be written only by the worker login in the org\'s system context: not by the API login, a user context or another login', async () => {
    const c = await connection('lan');
    await on('lan', c);
    const call = async (user: string, password: string, context: 'system' | 'user' | 'none') => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      try {
        await client.query('BEGIN');
        if (context === 'system') await client.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
        if (context === 'user') await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [users.lan, 'aal1']).catch(() => undefined);
        await client.query('SELECT crove_meetings.agenda_replace($1::uuid, now(), $2::jsonb)', [c, JSON.stringify([event('hand', 30)])]);
        await client.query('COMMIT');
        return 'ok';
      } catch (error: unknown) {
        return (error as { code?: string; message?: string }).message?.split('\n')[0] ?? 'error';
      } finally {
        await client.end().catch(() => undefined);
      }
    };
    expect(await call('crove_app', 'test-app-pw', 'system')).toMatch(/permission denied/);
    expect(await call('crove_worker', 'test-worker-pw', 'none')).toMatch(/MEETINGS_SYSTEM_CONTEXT|NO_CONTEXT|permission denied/);
    expect(await call('crove_worker', 'test-worker-pw', 'system')).toBe('ok');
    expect((await cached(c)).map((r) => r.external_id)).toEqual(['hand']);
  });
});
