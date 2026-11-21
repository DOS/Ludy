// SPDX-License-Identifier: AGPL-3.0-only
// One meeting, one live capture (ADR-0055 slice 1, #4123) on a real database: a client that starts to record a call is a capture, a second capture of the same call is refused (naming the kind of client and
// since when, never a person, and leaving no meeting), a capture not heard from for 90 seconds is over, the person stopping ends it at once, and the call is the same under every spelling of its address and
// unrelated in another org. The calendar event of the member's own agenda is read for its address on the server. The refusal and the rows hold no address and no person.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { DomainError, Runtime, type UserActor } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const CREATE = { title: 'Họp tuần', consentMethod: 'told_at_start' as const, visibility: 'attendees' as const, language: 'vi' as const, keepVideo: false };
interface Session {
  meeting_id: string;
  recorder_user_id: string;
  kind: string;
  agenda_id: string | null;
  meeting_key: string | null;
  ended_at: string | null;
  ended_reason: string | null;
}

suite('one meeting, one live capture (ADR-0055 slice 1, #4123)', () => {
  const dbName = `crove_test_capture_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  let orgB = '';
  const users = { ownerA: '', m1: '', m2: '', ownerB: '', mB: '' };
  const tokens = { m1: randomUUID(), m1Two: randomUUID(), m2: randomUUID() };

  const app = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const ext = (userId: string, tokenId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', mfaAt: null, extension: { tokenId, scopes: ['meetings'] } });
  // Each test has its own calls, so what an earlier test left open never decides a later one.
  let call = 0;
  const meet = () => `abc-${String(1000 + call++).replace(/\d/g, (d) => 'abcdefghij'[Number(d)] as string).slice(0, 4)}-xyz`;
  const meetUrl = (code: string, tail = '') => `https://meet.google.com/${code}${tail}`;
  const keyOf = (org: string, code: string) => createHash('sha256').update(`${org}\ngoogle_meet\n${code}`).digest('hex');

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const rows = <R extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<R>(text, params)).rows);
  const sessionsOf = (meetingId: string) =>
    rows<Session>('SELECT meeting_id, recorder_user_id, kind, agenda_id, meeting_key, ended_at::text, ended_reason FROM crove_meetings.capture_session WHERE meeting_id = $1', [meetingId]);
  const meetingCount = async (userId: string) => Number((await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.meeting WHERE recorder_user_id = $1', [userId]))[0]!.n);

  const create = async (actor: UserActor, org: string, capture?: { agendaId?: string; joinUrl?: string }) =>
    (await runtime.execute<{ meetingId: string }>('meetings.meeting.create', { ...CREATE, ...(capture ? { capture } : {}) }, { actor, orgId: org })).meetingId;
  const beat = (actor: UserActor, org: string, meetingId: string, end?: boolean) =>
    runtime.execute<{ open: boolean }>('meetings.capture.heartbeat', { meetingId, ...(end === undefined ? {} : { end }) }, { actor, orgId: org });
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }
  const silence = (meetingId: string, seconds = 120) => rows("UPDATE crove_meetings.capture_session SET last_seen_at = now() - ($2 || ' seconds')::interval WHERE meeting_id = $1", [meetingId, String(seconds)]);

  async function insertToken(orgId: string, userId: string, id: string) {
    await rows(
      `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'Test device', ARRAY['meetings']::text[], now(), now() + interval '30 days', $3)`,
      [orgId, id, userId, createHash('sha256').update(randomBytes(32)).digest()],
    );
  }
  // An event of the member's own calendar, with the join address the sweep would have read.
  async function agendaEvent(orgId: string, userId: string, joinUrl: string | null) {
    // A member has one calendar connection: made on the first event, used for the rest.
    const existing = await rows<{ id: string }>('SELECT id FROM crove_kernel.calendar_connection WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
    const connection = existing[0]?.id ?? randomUUID();
    const event = randomUUID();
    if (!existing[0]) {
      await rows(
        `INSERT INTO crove_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events)
         VALUES ($1, $2, $3, 'google', $4, 'test', '{}', true)`,
        [orgId, connection, userId, `${connection}@calendar.test`],
      );
    }
    await rows(
      `INSERT INTO crove_meetings.calendar_agenda (org_id, id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, join_url)
       VALUES ($1, $2, $3, $4, $5, 'Họp khách', now(), now() + interval '1 hour', 'Asia/Ho_Chi_Minh', $6)`,
      [orgId, event, connection, userId, `ext-${event}`, joinUrl],
    );
    return event;
  }

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    const pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) users[key] = await upsertIdentity(db, { issuer: 'capture', subject: key, email: `${key}@capture.test`, name: null });
    orgA = (await createOrg(runtime, app(users.ownerA), 'Org A')).orgId;
    orgB = (await createOrg(runtime, app(users.ownerB), 'Org B')).orgId;
    await rows(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($4, $5, 'member')`, [orgA, users.m1, users.m2, orgB, users.mB]);
    await insertToken(orgA, users.m1, tokens.m1);
    await insertToken(orgA, users.m1, tokens.m1Two);
    await insertToken(orgA, users.m2, tokens.m2);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('an extension token is always a capture, with nothing said of its call; two of them never conflict', async () => {
    const first = await create(ext(users.m1, tokens.m1), orgA);
    const second = await create(ext(users.m1, tokens.m1), orgA);
    for (const meetingId of [first, second]) {
      const [row, ...more] = await sessionsOf(meetingId);
      expect(more).toEqual([]);
      expect(row).toMatchObject({ kind: 'extension', recorder_user_id: users.m1, agenda_id: null, meeting_key: null, ended_at: null, ended_reason: null });
    }
  });

  it('the app is a capture only when it says so, and the address is read into a hash that is all that is stored', async () => {
    const plain = await create(app(users.m1), orgA);
    expect(await sessionsOf(plain)).toEqual([]);
    const code = meet();
    const meetingId = await create(app(users.m1), orgA, { joinUrl: meetUrl(code, '?authuser=1') });
    const [row] = await sessionsOf(meetingId);
    expect(row).toMatchObject({ kind: 'app', meeting_key: keyOf(orgA, code), agenda_id: null, ended_at: null });
    // Nothing of the address is kept: not in the row, not in the audit of the start.
    const stored = (await rows<{ j: string }>('SELECT to_jsonb(s)::text AS j FROM crove_meetings.capture_session s WHERE meeting_id = $1', [meetingId]))[0]!.j;
    expect(stored).not.toContain('meet.google.com');
    expect(stored).not.toContain(code);
    const audit = JSON.stringify((await rows('SELECT detail FROM crove_kernel.audit_event WHERE command = $1 AND detail->>$2 = $3', ['meetings.meeting.create', 'meetingId', meetingId]))[0]);
    expect(audit).not.toContain('meet.google.com');
    expect(audit).not.toContain(code);
  });

  it('a second capture of the same call is refused, in any spelling of its address, by anyone in the org: the kind and the time, no person, and no meeting left behind', async () => {
    const code = meet();
    const first = await create(app(users.m1), orgA, { joinUrl: meetUrl(code) });
    const [row] = await sessionsOf(first);
    const since = (await rows<{ s: string }>('SELECT started_at AS s FROM crove_meetings.capture_session WHERE meeting_id = $1', [first]))[0]!.s;
    const before = await meetingCount(users.m2);
    // One after the other: a started promise that is refused must have its refusal awaited at once.
    for (const attempt of [() => create(app(users.m2), orgA, { joinUrl: meetUrl(code.toUpperCase(), '/?hs=179&authuser=2') }), () => create(ext(users.m2, tokens.m2), orgA, { joinUrl: meetUrl(code, '/') })]) {
      const error = await refusal(attempt());
      expect(error.code).toBe('CAPTURE_ALREADY_RUNNING');
      expect(error.status).toBe(409);
      expect(error.details).toEqual({ kind: 'app', since: new Date(since).toISOString() });
      // The refusal names no person, no meeting and no address, in its message, its details or anywhere it may be shown.
      const said = JSON.stringify({ message: error.message, details: error.details });
      for (const secret of [users.m1, users.m2, first, code, 'meet.google.com', row!.meeting_key as string]) expect(said).not.toContain(secret);
    }
    // The refused starts rolled back with their meetings.
    expect(await meetingCount(users.m2)).toBe(before);
    // The holder is untouched.
    expect((await sessionsOf(first))[0]).toMatchObject({ ended_at: null, ended_reason: null });
  });

  it('the same call in another org is another call', async () => {
    const code = meet();
    const inA = await create(app(users.m1), orgA, { joinUrl: meetUrl(code) });
    const inB = await create(app(users.mB), orgB, { joinUrl: meetUrl(code) });
    const [a] = await sessionsOf(inA);
    const [b] = await sessionsOf(inB);
    expect(a!.meeting_key).toBe(keyOf(orgA, code));
    expect(b!.meeting_key).toBe(keyOf(orgB, code));
    expect(a!.meeting_key).not.toBe(b!.meeting_key);
  });

  it('a capture not heard from for 90 seconds is over when the call is started again; the first recorder is told and nothing of its recording is touched; it takes the call back when nothing holds it', async () => {
    const code = meet();
    const m1 = app(users.m1);
    const m2 = app(users.m2);
    const first = await create(m1, orgA, { joinUrl: meetUrl(code) });
    expect(await beat(m1, orgA, first)).toEqual({ open: true });
    // Heard from a moment ago: the call is held. Then 2 minutes of silence: it is free.
    await refusal(create(m2, orgA, { joinUrl: meetUrl(code) }));
    await silence(first);
    const second = await create(m2, orgA, { joinUrl: meetUrl(code) });
    expect((await sessionsOf(first))[0]).toMatchObject({ ended_reason: 'lost' });
    expect((await sessionsOf(second))[0]).toMatchObject({ ended_reason: null, kind: 'app' });
    // The first recorder is still recording: its heartbeat says the capture no longer holds the call, and its meeting is untouched.
    expect(await beat(m1, orgA, first)).toEqual({ open: false });
    expect((await rows<{ ended_at: string | null }>('SELECT ended_at::text FROM crove_meetings.meeting WHERE id = $1', [first]))[0]).toEqual({ ended_at: null });
    // Once the second capture ends, the first takes the call back with its next heartbeat.
    expect(await beat(m2, orgA, second, true)).toEqual({ open: false });
    expect(await beat(m1, orgA, first)).toEqual({ open: true });
    expect((await sessionsOf(first))[0]).toMatchObject({ ended_at: null, ended_reason: null });
  });

  it('a late heartbeat cannot take the call back for a recording that is over', async () => {
    const code = meet();
    const m1 = app(users.m1);
    const m2 = app(users.m2);
    const first = await create(m1, orgA, { joinUrl: meetUrl(code) });
    await silence(first);
    const second = await create(m2, orgA, { joinUrl: meetUrl(code) });
    expect((await sessionsOf(first))[0]).toMatchObject({ ended_reason: 'lost' });
    // The first recording ends (reported stopped): its capture is finished with that reason, not left as lost.
    await runtime.execute('meetings.meeting.recording_stopped', { meetingId: first }, { actor: m1, orgId: orgA });
    expect((await sessionsOf(first))[0]).toMatchObject({ ended_reason: 'stopped' });
    await beat(m2, orgA, second, true);
    // A heartbeat still in flight arrives after: the call stays free, the finished capture stays finished.
    expect(await beat(m1, orgA, first)).toEqual({ open: false });
    expect((await sessionsOf(first))[0]).toMatchObject({ ended_reason: 'stopped' });
    const third = await create(m2, orgA, { joinUrl: meetUrl(code) });
    expect((await sessionsOf(third))[0]).toMatchObject({ ended_reason: null });
  });

  it('the person stopping ends the capture at once, and so does the report that a recording stopped', async () => {
    const code = meet();
    const m1 = app(users.m1);
    const first = await create(m1, orgA, { joinUrl: meetUrl(code) });
    await beat(m1, orgA, first, true);
    expect((await sessionsOf(first))[0]).toMatchObject({ ended_reason: 'stopped' });
    // A new recording of the same call, a second later, is not refused by the one that just ended.
    const again = await create(m1, orgA, { joinUrl: meetUrl(code) });
    await runtime.execute('meetings.meeting.recording_stopped', { meetingId: again }, { actor: m1, orgId: orgA });
    expect((await sessionsOf(again))[0]).toMatchObject({ ended_reason: 'stopped' });
    const third = await create(m1, orgA, { joinUrl: meetUrl(code) });
    expect((await sessionsOf(third))[0]).toMatchObject({ ended_reason: null });
  });

  it('only the recorder sends the heartbeat, and a token only for the meetings it created', async () => {
    const meetingId = await create(ext(users.m1, tokens.m1), orgA);
    const other = await refusal(beat(app(users.m2), orgA, meetingId));
    expect(['MEETING_NOT_FOUND', 'FORBIDDEN']).toContain(other.code);
    const otherToken = await refusal(beat(ext(users.m1, tokens.m1Two), orgA, meetingId));
    expect(otherToken.code).toBe('MEETING_NOT_FOUND');
    // The recorder's own token and the recorder in the app both reach it.
    expect(await beat(ext(users.m1, tokens.m1), orgA, meetingId)).toEqual({ open: true });
    expect(await beat(app(users.m1), orgA, meetingId)).toEqual({ open: true });
  });

  it('the calendar event of the member: its address gives the call when the client sends none, and an event that is not the member\'s is left out', async () => {
    const code = meet();
    const m1 = app(users.m1);
    const m2 = app(users.m2);
    const mine = await agendaEvent(orgA, users.m1, meetUrl(code));
    const theirs = await agendaEvent(orgA, users.m2, meetUrl(code, '?authuser=3'));
    const first = await create(m1, orgA, { agendaId: mine });
    expect((await sessionsOf(first))[0]).toMatchObject({ agenda_id: mine, meeting_key: keyOf(orgA, code), ended_at: null });
    // The other member's own event is the same call: refused, though the client sent no address at all.
    expect((await refusal(create(m2, orgA, { agendaId: theirs }))).code).toBe('CAPTURE_ALREADY_RUNNING');
    // An event id that is another member's is ignored, not refused and not used: here it names another call, and the capture opens without it.
    const other = meet();
    const foreign = await create(m2, orgA, { agendaId: mine, joinUrl: meetUrl(other) });
    expect((await sessionsOf(foreign))[0]).toMatchObject({ agenda_id: null, meeting_key: keyOf(orgA, other) });
    // An event with no address still holds its own identity: a second capture of that very event is refused.
    const bare = await agendaEvent(orgA, users.m1, null);
    const bareFirst = await create(m1, orgA, { agendaId: bare });
    expect((await sessionsOf(bareFirst))[0]).toMatchObject({ agenda_id: bare, meeting_key: null });
    expect((await refusal(create(m1, orgA, { agendaId: bare }))).code).toBe('CAPTURE_ALREADY_RUNNING');
  });

  it('a start with an unreadable address or an unknown event opens a capture that conflicts with nothing', async () => {
    const m1 = app(users.m1);
    const a = await create(m1, orgA, { joinUrl: 'https://calendar.google.com/calendar/event?eid=abc' });
    const b = await create(m1, orgA, { agendaId: randomUUID() });
    for (const meetingId of [a, b]) expect((await sessionsOf(meetingId))[0]).toMatchObject({ agenda_id: null, meeting_key: null, ended_at: null });
  });
});
