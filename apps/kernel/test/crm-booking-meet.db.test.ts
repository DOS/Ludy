// SPDX-License-Identifier: AGPL-3.0-only
// A Google Meet per booking (C7, #1375) on PostgreSQL 17: only a host whose own Google connection can write to their calendar picks it, for a one-host type; a
// booking of such a type is confirmed pending with its event asking for a conference and its mails held back; the write-back job (with a recorded adapter) makes
// the Meet and the booking learns the link, or that there is none, and only then its confirmation mails are queued; a booking still pending is settled as failed
// by the delayed job; a host who cannot make a Meet gets the booking confirmed at once with the fixed link. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CalendarAdapter, CalendarWriteResult } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type WriteBackAction } from '@crove/kernel';
import { GOOGLE_CALENDAR_EVENTS_SCOPE, calendarBinding, isVietnamHoliday, zonedDate, zonedInstant, type BookingItem, type EventType } from '@crove/kernel-contract';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { crmCommands, crmQueries, type BookingMailData } from '@crove/mod-crm';
import { bookingRequest } from '../src/booking-page.ts';
import { runCalendarWriteBack } from '../src/calendar-sync.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const SYSTEM = { type: 'system' as const, component: 'test.crm.booking.meet' };
const MEET = 'https://meet.google.com/abc-defg-hij';
const FIXED = 'https://rooms.example.test/phong-1';
const FREEBUSY = 'https://www.googleapis.com/auth/calendar.freebusy';

function bookableDay(offset = 3): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();

suite('a Google Meet per booking on PostgreSQL (C7, #1375)', () => {
  const dbName = `crove_test_crm_booking_meet_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let app: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const register = (db: Db) => new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });

  // An org with an owner and a member host who works every hour of every day.
  async function org() {
    const db = createDb(appPool);
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@meet.test`, name: null });
    const host = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `host-${randomUUID().slice(0, 8)}@meet.test`, name: null });
    const { orgId } = await createOrg(app, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, host]);
    const slug = (await rows<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId]))[0]?.slug as string;
    await app.execute('kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 0, end: 1440 })) }, { actor: asUser(host), orgId });
    return { orgId, slug, owner, host };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  // The host's Google connection, sealed as the app stores it: with the events permission and write-back on, or read-only.
  async function connect(o: Org, over: { events?: boolean; writeBack?: boolean } = {}) {
    const account = `${randomUUID().slice(0, 8)}@gmail.test`;
    const sealed = vault.seal(JSON.stringify({ accessToken: 'a', refreshToken: 'r' }), calendarBinding(o.orgId, 'google', account));
    const connected = await app.execute<{ connectionId: string }>(
      'kernel.calendar.connect',
      {
        provider: 'google',
        externalAccount: account,
        displayName: account,
        scopes: over.events === false ? [FREEBUSY] : [FREEBUSY, GOOGLE_CALENDAR_EVENTS_SCOPE],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(o.host), orgId: o.orgId },
    );
    if (over.writeBack !== false && over.events !== false) await app.execute('kernel.calendar.write_back.set', { connectionId: connected.connectionId, enabled: true }, { actor: asUser(o.host), orgId: o.orgId });
    return connected.connectionId;
  }

  const typeInput = (o: Org, over: Record<string, unknown> = {}) => ({
    slug: 'tu-van',
    title: 'Tư vấn thuế',
    description: null,
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    horizonDays: 60,
    dailyLimit: null,
    locationKind: 'google_meet',
    locationValue: FIXED,
    hostUserId: o.host,
    ...over,
  });
  const createType = (o: Org, by: string, over: Record<string, unknown> = {}) => app.execute<EventType>('crm.event_type.create', typeInput(o, over), { actor: asUser(by), orgId: o.orgId });

  // A booking requested on the public page and confirmed by the worker, on a day no booking of this run used (the days of the hosts never meet).
  const usedDays = new Set<string>();
  function freshDay(): string {
    let offset = 3;
    let day = bookableDay(offset);
    while (usedDays.has(day)) day = bookableDay(++offset);
    usedDays.add(day);
    return day;
  }
  async function book(o: Org) {
    const day = freshDay();
    await bookingRequest(app, o.slug, 'tu-van', { startsAt: at(day, 540), name: 'Nguyễn Văn Khách', email: 'Khach@Example.test', phone: '0901234567', note: null, timeZone: VN });
    const id = (await rows<{ id: string }>('SELECT id FROM crove_crm.booking WHERE org_id = $1 ORDER BY created_at DESC, id LIMIT 1', [o.orgId]))[0]?.id as string;
    const confirmed = await worker.execute<{ status: string }>('crm.booking.confirm', { bookingId: id }, { actor: SYSTEM, orgId: o.orgId });
    const state = () => rows<{ meeting_state: string; meeting_url: string | null; calendar_event_id: string }>('SELECT meeting_state, meeting_url, calendar_event_id FROM crove_crm.booking WHERE org_id = $1 AND id = $2', [o.orgId, id]).then((r) => r[0] as { meeting_state: string; meeting_url: string | null; calendar_event_id: string });
    const mails = () => rows<{ recipient: string }>("SELECT payload->>'recipient' AS recipient FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'crm.booking.confirmed' AND source_id = $2 ORDER BY payload->>'recipient'", [o.orgId, id]).then((r) => r.map((m) => m.recipient));
    return { id, day, confirmed, state, mails };
  }
  const settle = (o: Org, input: Record<string, unknown>) => worker.execute<{ settled: boolean; state?: string }>('crm.booking.meeting_settle', input, { actor: SYSTEM, orgId: o.orgId });
  const eventConference = async (eventId: string) => (await rows<{ conference: boolean }>('SELECT conference FROM crove_kernel.calendar_event WHERE id = $1', [eventId]))[0]?.conference;
  const mailData = (o: Org, bookingId: string) => worker.execute<BookingMailData>('crm.booking.mail_data', { bookingId, revision: 0 }, { actor: SYSTEM, orgId: o.orgId });

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
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 6 });
    app = register(createDb(appPool));
    worker = register(createDb(workerPool));
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('who may pick a Google Meet for an event type', () => {
    it('is the host alone, with a Google connection that can write to their calendar, for a one-host type', async () => {
      const o = await org();
      const meet = { code: 'EVENT_TYPE_MEET_UNAVAILABLE' };
      // No connection at all, then a read-only one (it cannot turn write-back on), then one that may write but has it off.
      await expect(createType(o, o.host)).rejects.toMatchObject(meet);
      const readOnly = await connect(o, { events: false });
      await expect(createType(o, o.host)).rejects.toMatchObject(meet);
      await expect(app.execute('kernel.calendar.write_back.set', { connectionId: readOnly, enabled: true }, { actor: asUser(o.host), orgId: o.orgId })).rejects.toMatchObject({ code: 'CALENDAR_SCOPE_MISSING' });
      await app.execute('kernel.calendar.disconnect', { connectionId: readOnly }, { actor: asUser(o.host), orgId: o.orgId });
      const off = await connect(o, { writeBack: false });
      await expect(createType(o, o.host)).rejects.toMatchObject(meet);
      await app.execute('kernel.calendar.write_back.set', { connectionId: off, enabled: true }, { actor: asUser(o.host), orgId: o.orgId });
      // The owner cannot read the host's connection, so the owner cannot pick it for them; the host can.
      await expect(createType(o, o.owner)).rejects.toMatchObject(meet);
      const made = await createType(o, o.host);
      expect(made).toMatchObject({ locationKind: 'google_meet', locationValue: FIXED });
      // A team type cannot have it, even by its lead host who qualifies.
      await expect(createType(o, o.owner, { slug: 'nhom', hostUserId: o.owner, assignment: 'round_robin', coHostUserIds: [o.host] })).rejects.toMatchObject(meet);
      // The owner edits the rest of the host's Meet type; changing it to another host, or moving a plain type onto Meet without the host's connection, is refused.
      const update = (id: string, by: string, over: Record<string, unknown>) => app.execute('crm.event_type.update', { eventTypeId: id, ...typeInput(o, { slug: made.slug, ...over }) }, { actor: asUser(by), orgId: o.orgId });
      expect(await update(made.id, o.owner, { title: 'Tư vấn thuế 2' })).toMatchObject({ title: 'Tư vấn thuế 2', locationKind: 'google_meet' });
      await expect(update(made.id, o.owner, { hostUserId: o.owner })).rejects.toMatchObject(meet);
      const plain = await createType(o, o.host, { slug: 'khac', locationKind: 'video' });
      await expect(update(plain.id, o.owner, { slug: 'khac', locationKind: 'google_meet' })).rejects.toMatchObject(meet);
      expect(await update(plain.id, o.host, { slug: 'khac', locationKind: 'google_meet' })).toMatchObject({ locationKind: 'google_meet' });
    });
  });

  describe('a booking of a Google Meet type', () => {
    it('is confirmed pending with its event asking for a conference and its mails held back, then ready with the link and its mails queued once', async () => {
      const o = await org();
      const connectionId = await connect(o);
      await createType(o, o.host);
      const b = await book(o);
      expect(b.confirmed).toMatchObject({ status: 'confirmed' });
      const pending = await b.state();
      expect(pending).toMatchObject({ meeting_state: 'pending', meeting_url: null });
      expect(await eventConference(pending.calendar_event_id)).toBe(true);
      expect(await b.mails()).toEqual([]);
      // The relay hands the delayed job its event.
      expect((await rows('SELECT 1 FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 AND payload->>$3 = $4', [o.orgId, 'crm.booking.meeting_pending', 'booking_id', b.id])).length).toBe(1);
      // The write-back plan asks the worker for the conference.
      const plan = await worker.query<{ actions: WriteBackAction[] }>('kernel.calendar.writeback_plan', { connectionId }, { actor: SYSTEM, orgId: o.orgId });
      expect(plan.actions).toEqual([expect.objectContaining({ eventId: pending.calendar_event_id, kind: 'upsert', conference: true })]);
      // The outcome: the link is stored on the booking and the mails go out, to the visitor and the host, once.
      expect(await settle(o, { calendarEventId: pending.calendar_event_id, url: MEET })).toEqual({ settled: true, state: 'ready' });
      expect(await b.state()).toMatchObject({ meeting_state: 'ready', meeting_url: MEET });
      // The event keeps the Meet Google made and stops asking for one, so a later write (a move) does not send the request again.
      expect(await eventConference(pending.calendar_event_id)).toBe(false);
      expect(await b.mails()).toEqual(['host', 'visitor']);
      expect(await mailData(o, b.id)).toMatchObject({ meeting: { state: 'ready', url: MEET } });
      expect(await settle(o, { calendarEventId: pending.calendar_event_id, url: 'https://meet.google.com/zzz-zzzz-zzz' })).toEqual({ settled: false });
      expect(await b.state()).toMatchObject({ meeting_url: MEET });
      expect(await b.mails()).toEqual(['host', 'visitor']);
      // The host sees it in their bookings.
      const listed = await app.query<BookingItem[]>('crm.booking.list', { scope: 'mine', period: 'upcoming' }, { actor: asUser(o.host), orgId: o.orgId });
      expect(listed.find((x) => x.id === b.id)?.meeting).toEqual({ state: 'ready', url: MEET });
    });

    it('goes on without a link when Google gave none, an address that is not a Meet, or nothing came in time: the booking stands, its event stops asking, the mails use the fixed link', async () => {
      const o = await org();
      await connect(o);
      await createType(o, o.host);
      // Google answered with no link.
      const none = await book(o);
      const noneState = await none.state();
      expect(await settle(o, { calendarEventId: noneState.calendar_event_id, url: null })).toEqual({ settled: true, state: 'failed' });
      expect(await none.state()).toMatchObject({ meeting_state: 'failed', meeting_url: null });
      expect(await eventConference(noneState.calendar_event_id)).toBe(false);
      expect(await none.mails()).toEqual(['host', 'visitor']);
      expect(await mailData(o, none.id)).toMatchObject({ meeting: { state: 'failed', url: null } });
      // An address that is not a Meet one is no link.
      const odd = await book(o);
      expect(await settle(o, { calendarEventId: (await odd.state()).calendar_event_id, url: 'https://evil.example/abc-defg-hij' })).toEqual({ settled: true, state: 'failed' });
      expect(await odd.state()).toMatchObject({ meeting_url: null });
      // Nothing came: the delayed job settles it by the booking's id, once, and a settled booking is left alone.
      const late = await book(o);
      expect(await settle(o, { bookingId: late.id, url: null })).toEqual({ settled: true, state: 'failed' });
      expect(await settle(o, { bookingId: late.id, url: null })).toEqual({ settled: false });
      expect(await late.mails()).toEqual(['host', 'visitor']);
      // Naming neither or both is refused by the shape; an event that is nobody's booking is nothing to settle.
      await expect(settle(o, { url: null })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(settle(o, { bookingId: late.id, calendarEventId: noneState.calendar_event_id, url: null })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await settle(o, { calendarEventId: randomUUID(), url: MEET })).toEqual({ settled: false });
    });

    it('is not settled once cancelled, and a cancelled booking has no mails of the confirmation to wait for', async () => {
      const o = await org();
      await connect(o);
      await createType(o, o.host);
      const b = await book(o);
      await app.execute('crm.booking.cancel', { bookingId: b.id }, { actor: asUser(o.host), orgId: o.orgId });
      expect(await settle(o, { bookingId: b.id, url: MEET })).toEqual({ settled: false });
      expect(await b.state()).toMatchObject({ meeting_state: 'pending', meeting_url: null });
      expect(await b.mails()).toEqual([]);
    });

    it('holds the mails of a move made while the Meet is pending, and the confirmation sent once it is settled names the new time and the current revision', async () => {
      const o = await org();
      await connect(o);
      await createType(o, o.host);
      const b = await book(o);
      const mailsOf = (source: string) =>
        rows<{ revision: string; startsAt: string; recipient: string }>(
          `SELECT payload->>'revision' AS revision, payload->>'startsAt' AS "startsAt", payload->>'recipient' AS recipient FROM crove_kernel.mail_message WHERE org_id = $1 AND source_id = $2 AND source = $3 ORDER BY payload->>'recipient'`,
          [o.orgId, b.id, source],
        );
      const newStart = at(b.day, 600);
      await app.execute('crm.booking.move', { bookingId: b.id, startsAt: newStart }, { actor: asUser(o.host), orgId: o.orgId });
      expect(await rows<{ revision: number }>('SELECT revision FROM crove_crm.booking WHERE id = $1', [b.id])).toEqual([{ revision: 1 }]);
      // Nothing was told yet: not the confirmation (held), and not the move (the visitor never heard of the first time).
      expect(await mailsOf('crm.booking.moved')).toEqual([]);
      expect(await mailsOf('crm.booking.confirmed')).toEqual([]);
      expect(await settle(o, { bookingId: b.id, url: MEET })).toEqual({ settled: true, state: 'ready' });
      expect(await mailsOf('crm.booking.confirmed')).toEqual([
        { revision: '1', startsAt: newStart, recipient: 'host' },
        { revision: '1', startsAt: newStart, recipient: 'visitor' },
      ]);
      expect(await mailsOf('crm.booking.moved')).toEqual([]);
      // A move once the Meet is settled is mailed as before.
      await app.execute('crm.booking.move', { bookingId: b.id, startsAt: at(b.day, 660) }, { actor: asUser(o.host), orgId: o.orgId });
      expect((await mailsOf('crm.booking.moved')).map((m) => m.recipient)).toContain('visitor');
    });

    it('is confirmed at once, with the fixed link and its mails, when the host cannot make a Meet (the connection is gone, or write-back is off), and for a type that is not a Meet one', async () => {
      const o = await org();
      const connectionId = await connect(o);
      const made = await createType(o, o.host);
      // The host turned write-back off after the type was set up.
      await app.execute('kernel.calendar.write_back.set', { connectionId, enabled: false }, { actor: asUser(o.host), orgId: o.orgId });
      const first = await book(o);
      // A Meet type whose host cannot make one is failed from the start, so the host is told (the mail and the badge) and the visitor has the fixed link.
      expect(await first.state()).toMatchObject({ meeting_state: 'failed', meeting_url: null });
      expect(await eventConference((await first.state()).calendar_event_id)).toBe(false);
      expect(await first.mails()).toEqual(['host', 'visitor']);
      expect(await mailData(o, first.id)).toMatchObject({ meeting: { state: 'failed', url: null } });
      // A type that is not a Meet one never asks.
      await app.execute('kernel.calendar.write_back.set', { connectionId, enabled: true }, { actor: asUser(o.host), orgId: o.orgId });
      await app.execute('crm.event_type.update', { eventTypeId: made.id, ...typeInput(o, { locationKind: 'video' }) }, { actor: asUser(o.host), orgId: o.orgId });
      const second = await book(o);
      expect(await second.state()).toMatchObject({ meeting_state: 'none' });
      expect(await second.mails()).toEqual(['host', 'visitor']);
    });

    it('keeps a link and its state together in the table, and only ever a Meet address', async () => {
      const o = await org();
      await connect(o);
      await createType(o, o.host);
      const b = await book(o);
      const set = (sql: string) => rows(`UPDATE crove_crm.booking SET ${sql} WHERE id = $1`, [b.id]);
      await expect(set("meeting_state = 'ready'")).rejects.toMatchObject({ code: '23514' });
      await expect(set("meeting_url = 'https://meet.google.com/abc-defg-hij'")).rejects.toMatchObject({ code: '23514' });
      await expect(set("meeting_state = 'ready', meeting_url = 'https://evil.example/abc-defg-hij'")).rejects.toMatchObject({ code: '23514' });
      await expect(set("meeting_state = 'ready', meeting_url = 'https://meet.google.com/abc-defg-hij?x=1'")).rejects.toMatchObject({ code: '23514' });
      await expect(set("meeting_state = 'made'")).rejects.toMatchObject({ code: '23514' });
      await expect(set("meeting_state = 'ready', meeting_url = 'https://meet.google.com/lookup/../x'")).rejects.toMatchObject({ code: '23514' });
      await set("meeting_state = 'ready', meeting_url = 'https://meet.google.com/abc-defg-hij'");
      // The form Google gives a conference a Workspace account made through the API is a Meet address too.
      await set("meeting_url = 'https://meet.google.com/lookup/abc123def456'");
    });
  });

  describe('the write-back job with a recorded adapter', () => {
    const writeAdapter = (answer: (conference: boolean | undefined) => CalendarWriteResult, writes: Array<{ id: string; conference: boolean | undefined }>): CalendarAdapter => ({
      provider: 'google',
      oauthProvider: 'google_calendar',
      pkce: true,
      authorizeUrl: () => 'https://example.test/',
      exchange: async () => {
        throw new Error('not used');
      },
      refresh: async () => ({ refused: 'not used' }),
      busy: async () => ({ busy: [] }),
      writeEvent: async (_secret, event) => (writes.push({ id: event.externalId, conference: event.conference }), answer(event.conference)),
      removeEvent: async () => ({ ok: true }),
      revoke: async () => ({ revoked: true }),
    });
    const job = (o: Org, adapter: CalendarAdapter) => runCalendarWriteBack({ runtime: worker, broker: vault, adapters: { google_calendar: adapter } }, { orgId: o.orgId });

    it('makes the Meet with the event, tells the booking, queues its mails, and does nothing more on the next run', async () => {
      const o = await org();
      await connect(o);
      await createType(o, o.host);
      const b = await book(o);
      const writes: Array<{ id: string; conference: boolean | undefined }> = [];
      const adapter = writeAdapter((conference) => (conference ? { ok: true, meetUrl: MEET } : { ok: true }), writes);
      expect(await job(o, adapter)).toMatchObject({ connections: 1, ran: 1 });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.conference).toBe(true);
      expect(await b.state()).toMatchObject({ meeting_state: 'ready', meeting_url: MEET });
      expect(await b.mails()).toEqual(['host', 'visitor']);
      // The event is written (a link of the connection), so the next run asks for nothing.
      await job(o, adapter);
      expect(writes).toHaveLength(1);
      expect(await b.mails()).toEqual(['host', 'visitor']);
    });

    it('tells the booking there is no Meet when the event was written without one, and leaves it pending when the write failed', async () => {
      const o = await org();
      await connect(o);
      await createType(o, o.host);
      const failed = await book(o);
      const writes: Array<{ id: string; conference: boolean | undefined }> = [];
      await job(o, writeAdapter(() => ({ ok: true, meetUrl: null }), writes));
      expect(await failed.state()).toMatchObject({ meeting_state: 'failed', meeting_url: null });
      expect(await failed.mails()).toEqual(['host', 'visitor']);
      const down = await book(o);
      await job(o, writeAdapter(() => ({ failed: 'backendError', transient: true }), writes));
      expect(await down.state()).toMatchObject({ meeting_state: 'pending' });
      expect(await down.mails()).toEqual([]);
    });
  });
});
