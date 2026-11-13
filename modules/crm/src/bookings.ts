// Bookings of the public booking page (issue #1318, plan docs/plan/calendar.md §3.3). The page records a pending
// booking through crove_crm.booking_request (the API's login cannot enter an org's system context); the worker then
// runs crm.booking.confirm here as a system actor: it checks the time is still one of the type's free slots, holds an
// event on the host's calendar, links the booking to a party (matched by email, else created) with an activity on its
// timeline, and marks the booking confirmed, or refused when the time was taken or is no longer offered.
//
// A Google Meet per booking (C7, #1375): a booking of a google_meet type whose host has a Google connection that can write to their calendar is confirmed
// with meeting_state pending and its calendar event asking for a conference; the C6 write-back job makes the Meet with the event and the worker tells the
// booking the outcome (crm.booking.meeting_settle: the join link, or none). The confirmation mails are queued then, so the first mail already carries the
// link; a booking still pending after a few minutes is settled as failed by a delayed job, and the fixed link of the type, if there is one, is used.
//
// Mails and links (#1319, step C4): a confirmation queues a mail to the visitor and one to the host (template
// crm.booking, with an .ics event) and emits crm.booking.scheduled, from which the worker queues the reminders (24 hours
// and 1 hour before; crm.booking.remind sends one only while the booking still starts then). The visitor's mails carry
// a manage link (crove_crm.booking_manage_token, minted at send time through crm.booking.mail_data): the page records
// an ask with crove_crm.booking_manage_request, and crm.booking.manage carries it out here. A cancel or a move raises
// the booking's revision, which ends every link minted before it.
//
// Confirmations and moves of one host run one at a time (an advisory lock), so the slot check sees every earlier
// booking; the exclusion constraint on crove_kernel.calendar_event stays the last line against any other writer.
//
// Team types (#1373, step C8): a round-robin booking lands on one free host of the type (the one with the fewest
// upcoming bookings of it, ties by member id); a collective booking holds an event on every host's calendar, the
// lead's (or the first host's still able to host) in calendar_event_id and the others in hold_event_ids. Hosts who
// may no longer host (they left the org, or became viewers) are skipped. A cancel or a move acts on every held event.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'kysely';
import { BOOKING_DEAL_LIST_MAX, GOOGLE_CALENDAR_EVENTS_SCOPE, MEET_URL, freeSlots, zBookingCancel, zBookingDealLink, zBookingDealUnlink, zBookingListQuery, zBookingMove, zDealBookingsQuery, zId, zonedDate, zoneOffsetMs, type BookingDealChanged, type BookingItem, type DealBookings, type Interval, type WorkingHours } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { busyOf, createMailMessage, workingHoursOf } from '@crove/kernel';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { openDealsFor, suggestDeals } from './booking-deals.ts';

const DAY_MS = 86_400_000;
// Who may still host a booking: anyone who can change their own calendar.
const HOST_ROLES = new Set(['owner', 'admin', 'member']);
export const BOOKING_MAIL_TEMPLATE = 'crm.booking';

type Outcome = { bookingId: string; status: 'confirmed' | 'refused' | 'pending' | 'cancelled'; refusal?: 'taken' | 'unavailable' };

// Takes every host's lock, in one order, so two bookings of overlapping teams cannot wait on each other.
async function lockHosts(ctx: CommandContext, hostUserIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(hostUserIds)].sort()) {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_crm.booking:${ctx.orgId}:${id}`}, 0))`.execute(ctx.trx);
  }
}

// "09:30 ngày 02/11/2026" on the host's wall clock, for the party's timeline.
function wallTime(timeZone: string, at: number): string {
  const date = zonedDate(timeZone, at);
  const minutes = Math.round(((at + zoneOffsetMs(timeZone, at)) % DAY_MS) / 60_000);
  const [y, m, d] = date.split('-');
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ngày ${d}/${m}/${y}`;
}

// The party with this email in the org, or a new person with the visitor's name, email and phone. Confirmations for
// different hosts run in parallel, so the same visitor booking two of them at once takes this lock first.
async function partyFor(ctx: CommandContext, name: string, email: string, phone: string | null): Promise<string> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_crm.party:${ctx.orgId}:${email.toLowerCase()}`}, 0))`.execute(ctx.trx);
  const existing = await ctx.trx
    .selectFrom('crove_kernel.party')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (existing) return existing.id;
  // The id is given here and the row inserted without RETURNING (see crove_kernel.party_link_new, #1280).
  const created = { id: randomUUID() };
  await ctx.trx.insertInto('crove_kernel.party').values({ id: created.id, org_id: ctx.orgId, kind: 'person', name, email, phone, source_trust: 'external' }).execute();
  await ctx.activity('kernel.party', created.id, 'party.created', 'Thêm khách hàng từ trang đặt lịch');
  return created.id;
}

type EventType = Awaited<ReturnType<typeof eventTypeOf>>;
const eventTypeOf = (ctx: Pick<CommandContext, 'trx' | 'orgId'>, id: string) =>
  ctx.trx.selectFrom('crove_crm.event_type').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', id).executeTakeFirstOrThrow();

// The type's hosts who may still be booked (members who keep a calendar), lead first: the lead alone for a single
// type. None when the type is archived.
async function hostsOf(ctx: Pick<CommandContext, 'trx' | 'orgId'>, type: EventType): Promise<string[]> {
  if (!type.active) return [];
  const ids = type.assignment === 'single' ? [type.host_user_id] : [type.host_user_id, ...type.co_host_user_ids];
  const members = await ctx.trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', ctx.orgId)
    .where('user_id', 'in', ids)
    .execute();
  const able = new Set(members.filter((m) => HOST_ROLES.has(m.role)).map((m) => m.user_id));
  return ids.filter((id) => able.has(id));
}

// Whether the host's Google connection can make a Meet now: active, with write-back on and the permission to write events. The system sees every member's
// connection; nothing of it but this yes or no is used.
async function meetReady(ctx: CommandContext, userId: string): Promise<boolean> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.calendar_connection')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', userId)
    .where('provider', '=', 'google')
    .where('status', '=', 'active')
    .where('write_back', '=', true)
    .where(sql<boolean>`scopes @> ARRAY[${GOOGLE_CALENDAR_EVENTS_SCOPE}]::text[]`)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

// Of the round-robin hosts free at a time, the one with the fewest upcoming bookings of the type (ties by member id).
async function leastBooked(ctx: CommandContext, type: EventType, free: readonly string[]): Promise<string> {
  const counts = await ctx.trx
    .selectFrom('crove_crm.booking as b')
    .innerJoin('crove_kernel.calendar_event as ev', (j) => j.onRef('ev.org_id', '=', 'b.org_id').onRef('ev.id', '=', 'b.calendar_event_id'))
    .select(['ev.user_id', (eb) => eb.fn.countAll<string>().as('n')])
    .where('b.org_id', '=', ctx.orgId)
    .where('b.event_type_id', '=', type.id)
    .where('b.status', '=', 'confirmed')
    .where('b.starts_at', '>=', ctx.now)
    .where('ev.user_id', 'in', free)
    .groupBy('ev.user_id')
    .execute();
  const load = new Map(counts.map((c) => [c.user_id, Number(c.n)]));
  return [...free].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))[0] as string;
}

// Whether [start, end) is one of the type's free slots of this host now: 'free', or why not. A booking being moved passes its own
// calendar event and its own row, so it does not stand in its own way.
async function slotCheck(
  ctx: CommandContext,
  type: EventType,
  hostUserId: string,
  hours: WorkingHours,
  start: number,
  end: number,
  own?: { eventId: string; bookingId: string },
): Promise<'free' | 'taken' | 'unavailable'> {
  const from = new Date(start - DAY_MS);
  const to = new Date(end + DAY_MS);
  const busy = await busyOf(ctx, hostUserId, from, to, own?.eventId);
  const booked = await ctx.trx
    .selectFrom('crove_crm.booking')
    .select('starts_at')
    .where('org_id', '=', ctx.orgId)
    .where('event_type_id', '=', type.id)
    .where('status', '=', 'confirmed')
    .where('starts_at', '>=', from)
    .where('starts_at', '<', to)
    .$if(own !== undefined, (q) => q.where('id', '<>', own?.bookingId as string))
    .execute();
  const bookedPerDay = new Map<string, number>();
  for (const b of booked) {
    const day = zonedDate(hours.timeZone, new Date(b.starts_at).getTime());
    bookedPerDay.set(day, (bookedPerDay.get(day) ?? 0) + 1);
  }
  const slots = freeSlots({
    hours,
    busy,
    skipVietnamHolidays: true,
    rules: {
      durationMin: type.duration_min,
      bufferBeforeMin: type.buffer_before_min,
      bufferAfterMin: type.buffer_after_min,
      minNoticeMin: type.min_notice_min,
      horizonDays: type.horizon_days,
      dailyLimit: type.daily_limit,
    },
    from: from.getTime(),
    to: to.getTime(),
    now: ctx.now.getTime(),
    bookedPerDay,
  });
  if (slots.some((s) => s.start === start && s.end === end)) return 'free';
  const overlaps = (b: Interval) => b.start < end + type.buffer_after_min * 60_000 && b.end > start - type.buffer_before_min * 60_000;
  return busy.some(overlaps) ? 'taken' : 'unavailable';
}

export type BookingMailKind = 'confirmed' | 'moved' | 'cancelled' | 'reminder';
interface BookingForMail {
  id: string;
  revision: number;
  starts_at: Date | string;
  ends_at: Date | string;
  time_zone: string;
  visitor_name: string | null;
  email: string | null;
}

// Subjects name the event type only: the stored subject and merge data stay free of the visitor's details, which the
// template reads when it sends the mail (crm.booking.mail_data), so an erasure of the visitor reaches queued mail too.
const SUBJECTS: Record<BookingMailKind, { visitor: (title: string) => string; host: (title: string) => string }> = {
  confirmed: { visitor: (t) => `Đã xác nhận lịch hẹn: ${t}`, host: (t) => `Lịch hẹn mới: ${t}` },
  moved: { visitor: (t) => `Lịch hẹn đã đổi giờ: ${t}`, host: (t) => `Lịch hẹn đã đổi giờ: ${t}` },
  cancelled: { visitor: (t) => `Lịch hẹn đã hủy: ${t}`, host: (t) => `Lịch hẹn đã hủy: ${t}` },
  reminder: { visitor: (t) => `Nhắc lịch hẹn: ${t}`, host: (t) => `Nhắc lịch hẹn: ${t}` },
};

// A host the booking holds: whose calendar, which event there, and their working hours (whose zone their mails use).
interface Held {
  userId: string;
  eventId: string;
  hours: WorkingHours;
}

// Queues the booking's mails of one kind (template crm.booking): to the visitor, and to each host it holds. The merge
// data holds no secret and no detail of the visitor; the template reads those, and mints the visitor's manage link, at
// send time.
async function queueBookingMails(
  ctx: CommandContext,
  kind: BookingMailKind,
  booking: BookingForMail,
  type: EventType,
  hosts: readonly Pick<Held, 'userId' | 'hours'>[],
  toHost = true,
): Promise<void> {
  if (!booking.email || !booking.visitor_name) return;
  const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  // The hosts' addresses while they are members (the worker's member_emails: no name, no other account column). Only
  // the worker mails the hosts: a change a host made in the app mails the visitor alone.
  const emails = toHost
    ? new Map(
        (
          await sql<{ user_id: string; email: string | null }>`SELECT user_id, email FROM crove_kernel.member_emails(${hosts.map((h) => h.userId)}::uuid[])`.execute(ctx.trx)
        ).rows.map((r) => [r.user_id, r.email]),
      )
    : new Map<string, string | null>();
  const common = {
    kind,
    bookingId: booking.id,
    revision: booking.revision,
    org: tenant.slug,
    orgName: tenant.name,
    type: type.slug,
    title: type.title,
    startsAt: new Date(booking.starts_at).toISOString(),
    endsAt: new Date(booking.ends_at).toISOString(),
    locationKind: type.location_kind,
    location: type.location_value,
  };
  const source = `crm.booking.${kind}`;
  const subject = SUBJECTS[kind];
  const visitor = await createMailMessage(ctx, {
    stream: 'transactional',
    source,
    sourceId: booking.id,
    templateKey: BOOKING_MAIL_TEMPLATE,
    to: booking.email,
    subject: subject.visitor(type.title).slice(0, 300),
    payload: { ...common, recipient: 'visitor', timeZone: booking.time_zone },
    status: 'queued',
  });
  const sent: Record<string, string> = { visitor: visitor.status };
  const hostStatus: string[] = [];
  for (const host of hosts) {
    const email = emails.get(host.userId);
    if (!email) continue;
    const mail = await createMailMessage(ctx, {
      stream: 'transactional',
      source,
      sourceId: booking.id,
      templateKey: BOOKING_MAIL_TEMPLATE,
      to: email,
      subject: subject.host(type.title).slice(0, 300),
      payload: { ...common, recipient: 'host', timeZone: host.hours.timeZone },
      status: 'queued',
    });
    hostStatus.push(mail.status);
  }
  if (hostStatus.length === 1) sent.host = hostStatus[0] as string;
  else if (hostStatus.length > 1) sent.hosts = hostStatus.join(',');
  ctx.audit({ bookingId: booking.id, mails: kind, ...sent });
}

const scheduled = (ctx: CommandContext, bookingId: string, startsAt: Date | string) =>
  ctx.emit('crm.booking.scheduled', { booking_id: bookingId, starts_at: new Date(startsAt).toISOString() });

export const bookingConfirm = defineCommand({
  name: 'crm.booking.confirm',
  input: z.strictObject({ bookingId: zId }),
  // It queues the confirmation mail to the visitor and the hosts (plan §4.7: a send derives R2; #1579). A system
  // command, so the worker runs it as before.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<Outcome> => {
    const booking = await ctx.trx
      .selectFrom('crove_crm.booking')
      .select(['id', 'event_type_id', 'starts_at', 'ends_at', 'status', 'visitor_name', 'email', 'phone', 'time_zone', 'revision'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.bookingId)
      .forUpdate()
      .executeTakeFirst();
    // Already decided (a replayed job): nothing to do.
    if (!booking || booking.status !== 'pending') {
      return { bookingId: input.bookingId, status: booking?.status ?? 'refused', ...(booking ? {} : { refusal: 'unavailable' as const }) };
    }
    const type = await eventTypeOf(ctx, booking.event_type_id);
    const hosts = await hostsOf(ctx, type);
    await lockHosts(ctx, hosts);

    const refuse = async (refusal: 'taken' | 'unavailable'): Promise<Outcome> => {
      await ctx.trx
        .updateTable('crove_crm.booking')
        .set({ status: 'refused', refusal, decided_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', booking.id)
        .execute();
      ctx.audit({ bookingId: booking.id, eventTypeId: type.id, status: 'refused', refusal });
      return { bookingId: booking.id, status: 'refused', refusal };
    };

    if (hosts.length === 0 || !booking.visitor_name || !booking.email) return refuse('unavailable');
    const start = new Date(booking.starts_at).getTime();
    const end = new Date(booking.ends_at).getTime();
    const checked: { userId: string; hours: WorkingHours; check: 'free' | 'taken' | 'unavailable' }[] = [];
    for (const userId of hosts) {
      const { hours } = await workingHoursOf(ctx, userId);
      checked.push({ userId, hours, check: await slotCheck(ctx, type, userId, hours, start, end) });
    }
    const free = checked.filter((c) => c.check === 'free');
    // A collective booking needs every host; any other needs one.
    if (type.assignment === 'collective' ? free.length !== checked.length : free.length === 0) {
      return refuse(checked.some((c) => c.check === 'taken') ? 'taken' : 'unavailable');
    }
    let holding = free;
    if (type.assignment === 'round_robin' && free.length > 1) {
      const pick = await leastBooked(ctx, type, free.map((c) => c.userId));
      holding = free.filter((c) => c.userId === pick);
    }

    // A Meet is made only for a single-host type, through its host's own Google connection. A type that asks for one when the host cannot make it now (the
    // connection is gone, or write-back is off) is `failed` from the start, so the host is told and the visitor gets the type's fixed link, if it has one.
    const wantsMeet = type.location_kind === 'google_meet';
    const meet = wantsMeet && type.assignment === 'single' && holding.length === 1 && (await meetReady(ctx, (holding[0] as { userId: string }).userId));
    const held: Held[] = [];
    for (const host of holding) {
      const event = await ctx.trx
        .insertInto('crove_kernel.calendar_event')
        .values({
          org_id: ctx.orgId,
          user_id: host.userId,
          starts_at: booking.starts_at,
          ends_at: booking.ends_at,
          time_zone: host.hours.timeZone,
          title: `${type.title}: ${booking.visitor_name}`.slice(0, 200),
          kind: 'booking',
          conference: meet,
          created_by: host.userId,
          created_at: ctx.now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      held.push({ userId: host.userId, eventId: event.id, hours: host.hours });
    }
    const [primary, ...more] = held as [Held, ...Held[]];
    const partyId = await partyFor(ctx, booking.visitor_name, booking.email, booking.phone);
    await ctx.activity('kernel.party', partyId, 'crm.booking.confirmed', `Đặt lịch hẹn ${type.title} lúc ${wallTime(primary.hours.timeZone, start)}`);
    await ctx.trx
      .updateTable('crove_crm.booking')
      .set({ status: 'confirmed', calendar_event_id: primary.eventId, hold_event_ids: more.map((h) => h.eventId), party_id: partyId, decided_at: ctx.now, meeting_state: meet ? 'pending' : wantsMeet ? 'failed' : 'none' })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', booking.id)
      .execute();
    ctx.audit({
      bookingId: booking.id,
      eventTypeId: type.id,
      status: 'confirmed',
      calendarEventId: primary.eventId,
      ...(more.length > 0 ? { holdEventIds: more.map((h) => h.eventId) } : {}),
      hostUserIds: held.map((h) => h.userId),
      partyId,
      ...(wantsMeet ? { meet: meet ? 'pending' : 'failed' } : {}),
    });
    // A booking waiting for its Meet has its mails queued when the outcome is known (crm.booking.meeting_settle); the delayed job of crm.booking.meeting_pending
    // settles it as failed if no outcome comes.
    if (meet) await ctx.emit('crm.booking.meeting_pending', { booking_id: booking.id });
    else await queueBookingMails(ctx, 'confirmed', booking, type, held);
    await scheduled(ctx, booking.id, booking.starts_at);
    return { bookingId: booking.id, status: 'confirmed' };
  },
});

export interface BookingMailData {
  // The manage token for the booking's current revision; null once it is cancelled.
  token: string | null;
  // The visitor's details as the booking holds them now (null fields once erased).
  visitor: { name: string | null; email: string | null; phone: string | null; note: string | null } | null;
  // The Google Meet of the booking as it is now (C7, #1375): ready with the join link, failed (the fixed link is used), or none.
  meeting: { state: 'none' | 'pending' | 'ready' | 'failed'; url: string | null };
}

// What a booking mail being sent now needs beyond its merge data (the worker's mail template asks for it): the
// visitor's manage token and the visitor's details, read at send time.
export const bookingMailData = defineCommand({
  name: 'crm.booking.mail_data',
  input: z.strictObject({ bookingId: zId, revision: z.number().int().min(0) }),
  // It reads the merge data of a mail being sent and writes nothing (#1579).
  risk: 'R1',
  sideEffect: 'none',
  access: 'system',
  handler: async (ctx, input): Promise<BookingMailData> => {
    const booking = await ctx.trx
      .selectFrom('crove_crm.booking')
      .select(['revision', 'visitor_name', 'email', 'phone', 'note', 'meeting_state', 'meeting_url'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.bookingId)
      // Held until the token is read, so a move cannot commit between the revision check and the token.
      .forShare()
      .executeTakeFirst();
    const { rows } = await sql<{ token: string | null }>`SELECT crove_crm.booking_manage_token(${input.bookingId}::uuid) AS token`.execute(ctx.trx);
    return {
      // A mail of an earlier revision (sent after a move) carries no link: links of earlier revisions are dead.
      token: booking?.revision === input.revision ? (rows[0]?.token ?? null) : null,
      visitor: booking ? { name: booking.visitor_name, email: booking.email, phone: booking.phone, note: booking.note } : null,
      meeting: { state: booking?.meeting_state ?? 'none', url: booking?.meeting_url ?? null },
    };
  },
});

// The outcome of a booking's Google Meet (C7, #1375), told by the worker: after the write-back made the event, with the join link (or none: Google would not make
// one), or by the delayed job when nothing came in time (no link). Only a booking that is still pending is settled, once; it then stands with the link (ready) or
// without (failed, and its event no longer asks for a conference), and the confirmation mails, held back until now, are queued. A booking found by its event
// (the write-back's) or by its id (the delayed job's).
export const bookingMeetingSettle = defineCommand({
  name: 'crm.booking.meeting_settle',
  input: z
    .strictObject({ calendarEventId: zId.optional(), bookingId: zId.optional(), url: z.string().max(200).nullable() })
    .refine((i) => (i.calendarEventId === undefined) !== (i.bookingId === undefined), 'name the event or the booking'),
  // It queues the confirmation mails (a send derives R2; #1579). A system command, like confirm.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<{ settled: boolean; state?: 'ready' | 'failed' }> => {
    const found = await ctx.trx
      .selectFrom('crove_crm.booking')
      .select(['id', 'event_type_id', 'starts_at', 'ends_at', 'status', 'time_zone', 'revision', 'visitor_name', 'email', 'calendar_event_id', 'hold_event_ids', 'meeting_state'])
      .where('org_id', '=', ctx.orgId)
      .$if(input.calendarEventId !== undefined, (q) => q.where('calendar_event_id', '=', input.calendarEventId as string))
      .$if(input.bookingId !== undefined, (q) => q.where('id', '=', input.bookingId as string))
      .forUpdate()
      .executeTakeFirst();
    // Not a booking waiting for its Meet (settled before, cancelled, or the event is not a booking's): nothing to do.
    if (!found || found.meeting_state !== 'pending' || found.status !== 'confirmed') return { settled: false };
    const url = input.url !== null && MEET_URL.test(input.url) ? input.url : null;
    const state = url === null ? ('failed' as const) : ('ready' as const);
    await ctx.trx.updateTable('crove_crm.booking').set({ meeting_state: state, meeting_url: url }).where('org_id', '=', ctx.orgId).where('id', '=', found.id).execute();
    // The event stops asking for a conference either way: a failed one makes none, and a ready one keeps the Meet Google made (a later write of the event, a move,
    // leaves its conference data alone), so the request is not sent again.
    if (found.calendar_event_id) {
      await ctx.trx.updateTable('crove_kernel.calendar_event').set({ conference: false }).where('org_id', '=', ctx.orgId).where('id', '=', found.calendar_event_id).execute();
    }
    const type = await eventTypeOf(ctx, found.event_type_id);
    const held = await holdHosts(ctx, await eventsOf(ctx, { calendar_event_id: found.calendar_event_id, hold_event_ids: found.hold_event_ids }));
    ctx.audit({ bookingId: found.id, eventTypeId: type.id, meeting: state });
    // The confirmation mails held back until now go out with the booking as it stands: a booking moved while it waited was never announced (the move held its mail
    // too), so the visitor's first mail names the new time, and its manage link is for the current revision. A booking cancelled meanwhile is not settled at all.
    if (held.length > 0) await queueBookingMails(ctx, 'confirmed', found, type, held);
    return { settled: true, state };
  },
});

export type ManageOutcome = 'cancelled' | 'moved' | 'taken' | 'unavailable' | 'none';

const lockBooking = (ctx: CommandContext, bookingId: string) =>
  ctx.trx.selectFrom('crove_crm.booking').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', bookingId).forUpdate().executeTakeFirst();
type HeldBooking = NonNullable<Awaited<ReturnType<typeof lockBooking>>> & { calendar_event_id: string };
// Who cancels or moves a booking: the visitor from a manage link, or the host (or an owner or admin) in the app.
type ChangedBy = 'visitor' | 'host';
const BY_TEXT: Record<ChangedBy, string> = { visitor: 'Khách', host: 'Người chủ trì' };

// Whether a booking may still be cancelled or moved: confirmed, holding its event, and not started.
const changeable = (ctx: CommandContext, b: NonNullable<Awaited<ReturnType<typeof lockBooking>>>): b is HeldBooking =>
  b.status === 'confirmed' && b.calendar_event_id !== null && new Date(b.starts_at).getTime() > ctx.now.getTime();

// The calendar events a booking holds and whose calendars they are on: its own event first, then a collective
// booking's holds. None before the worker confirmed it.
async function eventsOf(ctx: Pick<CommandContext, 'trx' | 'orgId'>, booking: { calendar_event_id: string | null; hold_event_ids: string[] }): Promise<Omit<Held, 'hours'>[]> {
  if (booking.calendar_event_id === null) return [];
  const ids = [booking.calendar_event_id, ...booking.hold_event_ids];
  const events = await ctx.trx.selectFrom('crove_kernel.calendar_event').select(['id', 'user_id']).where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
  const owner = new Map(events.map((e) => [e.id, e.user_id]));
  return ids.flatMap((eventId) => {
    const userId = owner.get(eventId);
    return userId ? [{ userId, eventId }] : [];
  });
}

// Locks the hosts of these events and reads their working hours: what a cancel or a move of the booking needs.
async function holdHosts(ctx: CommandContext, events: readonly Omit<Held, 'hours'>[]): Promise<Held[]> {
  await lockHosts(ctx, events.map((e) => e.userId));
  const held: Held[] = [];
  for (const e of events) held.push({ ...e, hours: (await workingHoursOf(ctx, e.userId)).hours });
  return held;
}

// Cancels a held booking: its calendar events are cancelled (the slots are free again), the revision rises (earlier
// links stop working), the party's timeline says so, and the visitor is mailed (the hosts too when the visitor
// cancelled).
async function cancelHeld(ctx: CommandContext, booking: HeldBooking, type: EventType, held: readonly Held[], by: ChangedBy): Promise<void> {
  const hours = (held[0] as Held).hours;
  await ctx.trx
    .updateTable('crove_kernel.calendar_event')
    .set({ status: 'cancelled', cancelled_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', held.map((h) => h.eventId))
    .where('status', '=', 'active')
    .execute();
  await ctx.trx
    .updateTable('crove_crm.booking')
    .set({ status: 'cancelled', cancelled_at: ctx.now, revision: booking.revision + 1 })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', booking.id)
    .execute();
  if (booking.party_id) {
    await ctx.activity('kernel.party', booking.party_id, 'crm.booking.cancelled', `${BY_TEXT[by]} hủy lịch hẹn ${type.title} lúc ${wallTime(hours.timeZone, new Date(booking.starts_at).getTime())}`);
  }
  await queueBookingMails(ctx, 'cancelled', { ...booking, revision: booking.revision + 1 }, type, held, by === 'visitor');
  // A visitor's cancel also gives the crm.scheduler agent a task (#1434): the next free slots, for a person to invite
  // the client again. Its title is a fixed template, never the visitor or the type's title (#1970): every member reads
  // tasks, and the event outlives every erasure. Tainted, as it comes from a visitor's action.
  await ctx.emit('crm.booking.cancelled', {
    booking_id: booking.id,
    by,
    // The task's ref leads to the booking and its type.
    ...(by === 'visitor' ? { agent_task: { title: 'Khách hủy lịch hẹn', ref: { type: 'crm.booking', id: booking.id }, tainted: true } } : {}),
  });
}

// Moves a held booking to [start, start + duration) when that is still a free slot of the type for every host it holds
// (the booking's own events and row set aside): the events and the booking move, the revision rises, the reminders
// follow, and the visitor is mailed (the hosts too when the visitor moved it). It stays with the same hosts: a
// round-robin booking is not handed to another host. Otherwise nothing changes and the answer says why.
async function moveHeld(
  ctx: CommandContext,
  booking: HeldBooking,
  type: EventType,
  held: readonly Held[],
  start: number,
  by: ChangedBy,
): Promise<'moved' | 'taken' | 'unavailable'> {
  const end = start + type.duration_min * 60_000;
  const hosts = new Set(await hostsOf(ctx, type));
  if (held.length === 0 || held.some((h) => !hosts.has(h.userId))) return 'unavailable';
  const checks: ('free' | 'taken' | 'unavailable')[] = [];
  for (const h of held) checks.push(await slotCheck(ctx, type, h.userId, h.hours, start, end, { eventId: h.eventId, bookingId: booking.id }));
  if (checks.some((c) => c !== 'free')) return checks.includes('taken') ? 'taken' : 'unavailable';
  const hours = (held[0] as Held).hours;
  const startsAt = new Date(start);
  const endsAt = new Date(end);
  for (const h of held) {
    await ctx.trx
      .updateTable('crove_kernel.calendar_event')
      .set({ starts_at: startsAt, ends_at: endsAt, time_zone: h.hours.timeZone })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', h.eventId)
      .execute();
  }
  await ctx.trx
    .updateTable('crove_crm.booking')
    .set({ starts_at: startsAt, ends_at: endsAt, revision: booking.revision + 1 })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', booking.id)
    .execute();
  if (booking.party_id) {
    await ctx.activity('kernel.party', booking.party_id, 'crm.booking.moved', `${BY_TEXT[by]} đổi lịch hẹn ${type.title} sang ${wallTime(hours.timeZone, start)}`);
  }
  // A booking still waiting for its Meet has told nobody anything yet (its confirmation is held back): the confirmation, sent when the Meet is settled, names the new time.
  if (booking.meeting_state !== 'pending') await queueBookingMails(ctx, 'moved', { ...booking, starts_at: startsAt, ends_at: endsAt, revision: booking.revision + 1 }, type, held, by === 'visitor');
  await scheduled(ctx, booking.id, startsAt);
  return 'moved';
}

// Carries out a visitor's ask from a manage link (recorded by crove_crm.booking_manage_request): the ask `requestId`
// names, while it is still the booking's last and unanswered. A cancel frees the slot; a move holds the new time if it
// is still a free slot of the type, else the answer says why and the link keeps working.
export const bookingManage = defineCommand({
  name: 'crm.booking.manage',
  input: z.strictObject({ bookingId: zId, requestId: zId }),
  // It cancels or moves the booking and queues the mail to the visitor and the hosts (a send derives R2; #1579). A
  // system command.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<{ bookingId: string; outcome: ManageOutcome }> => {
    const booking = await lockBooking(ctx, input.bookingId);
    if (!booking || booking.manage_request_id !== input.requestId || booking.manage_outcome !== null || !booking.manage_action) {
      return { bookingId: input.bookingId, outcome: 'none' };
    }
    const type = await eventTypeOf(ctx, booking.event_type_id);
    const answer = async (outcome: Exclude<ManageOutcome, 'none'>) => {
      await ctx.trx.updateTable('crove_crm.booking').set({ manage_outcome: outcome }).where('org_id', '=', ctx.orgId).where('id', '=', booking.id).execute();
      ctx.audit({ bookingId: booking.id, action: booking.manage_action, outcome });
      return { bookingId: booking.id, outcome };
    };
    // Cancelled meanwhile (by the host, or an earlier ask), or reached after the booking started: too late.
    if (!changeable(ctx, booking)) return answer('unavailable');
    const held = await holdHosts(ctx, await eventsOf(ctx, booking));
    if (held.length === 0) return answer('unavailable');
    if (booking.manage_action === 'cancel') {
      await cancelHeld(ctx, booking, type, held, 'visitor');
      return answer('cancelled');
    }
    return answer(await moveHeld(ctx, booking, type, held, new Date(booking.manage_starts_at as Date).getTime(), 'visitor'));
  },
});

// The host's side (#1320): the member who leads the booking's type, a host the booking holds (#1373), or an owner or
// admin cancels or moves it in the app. The visitor is mailed with a new link; a manage link from before stops working.
const STAFF: readonly MemberRole[] = ['owner', 'admin', 'member'];

async function hostBooking(ctx: CommandContext, bookingId: string): Promise<{ booking: HeldBooking; type: EventType; held: Held[] }> {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  const userId = ctx.actor.userId;
  const booking = await lockBooking(ctx, bookingId);
  if (!booking) throw new DomainError('BOOKING_NOT_FOUND', 404, 'Không tìm thấy lịch hẹn này');
  const type = await eventTypeOf(ctx, booking.event_type_id);
  const events = await eventsOf(ctx, booking);
  if (ctx.role !== 'owner' && ctx.role !== 'admin' && type.host_user_id !== userId && !events.some((e) => e.userId === userId)) {
    throw new DomainError('BOOKING_HOST_FORBIDDEN', 403, 'Bạn chỉ đổi được lịch hẹn do chính mình chủ trì');
  }
  if (!changeable(ctx, booking) || events.length === 0) throw new DomainError('BOOKING_NOT_CHANGEABLE', 409, 'Lịch hẹn này đã hủy hoặc đã bắt đầu');
  return { booking, type, held: await holdHosts(ctx, events) };
}

export const bookingCancel = defineCommand({
  name: 'crm.booking.cancel',
  input: zBookingCancel,
  // It queues the cancellation mail to the visitor (a send derives R2; #1579). No agent runs it.
  risk: 'R2',
  sideEffect: 'external',
  access: STAFF,
  handler: async (ctx, input): Promise<{ bookingId: string; status: 'cancelled' }> => {
    const { booking, type, held } = await hostBooking(ctx, input.bookingId);
    await cancelHeld(ctx, booking, type, held, 'host');
    ctx.audit({ bookingId: booking.id, eventTypeId: type.id, status: 'cancelled' });
    return { bookingId: booking.id, status: 'cancelled' };
  },
});

export const bookingMove = defineCommand({
  name: 'crm.booking.move',
  input: zBookingMove,
  // It queues the mail of the new time to the visitor (a send derives R2; #1579). No agent runs it.
  risk: 'R2',
  sideEffect: 'external',
  access: STAFF,
  handler: async (ctx, input): Promise<{ bookingId: string; startsAt: string }> => {
    const { booking, type, held } = await hostBooking(ctx, input.bookingId);
    const outcome = await moveHeld(ctx, booking, type, held, Date.parse(input.startsAt), 'host');
    if (outcome === 'taken') throw new DomainError('BOOKING_TIME_TAKEN', 409, 'Giờ này đã có lịch khác');
    if (outcome === 'unavailable') throw new DomainError('BOOKING_TIME_UNAVAILABLE', 409, 'Khung giờ này không còn nhận đặt lịch');
    ctx.audit({ bookingId: booking.id, eventTypeId: type.id, moved: true });
    return { bookingId: booking.id, startsAt: new Date(input.startsAt).toISOString() };
  },
});

// Linking a booking to a deal (#3103, docs/plan/calendar.md "Deal links"). The deal's panel lists its bookings, and a person confirms Dy's suggestion (booking-deals.ts) with
// a click. Whoever may read a booking may link it or take its link off: the host of its type, a host it holds, or an owner or admin; the deal is any deal of the org (deals are
// read by every role). Past and cancelled bookings can be linked too, so the deal's history is complete. Nothing is mailed and no calendar event changes. A booking made
// from a deal's "Đặt lịch" link carries the deal from the start (crove_crm.booking_request_deal); these commands are the only other writers of crove_crm.booking.deal_id.
async function bookingOfCaller(ctx: CommandContext, bookingId: string): Promise<NonNullable<Awaited<ReturnType<typeof lockBooking>>>> {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  const userId = ctx.actor.userId;
  const booking = await lockBooking(ctx, bookingId);
  // A request the worker has not decided or refused is not a booking: the screen never lists it.
  if (!booking || (booking.status !== 'confirmed' && booking.status !== 'cancelled') || booking.calendar_event_id === null) {
    throw new DomainError('BOOKING_NOT_FOUND', 404, 'Không tìm thấy lịch hẹn này');
  }
  if (ctx.role !== 'owner' && ctx.role !== 'admin') {
    const type = await eventTypeOf(ctx, booking.event_type_id);
    const events = await eventsOf(ctx, booking);
    if (type.host_user_id !== userId && !events.some((e) => e.userId === userId)) {
      throw new DomainError('BOOKING_HOST_FORBIDDEN', 403, 'Bạn chỉ liên kết được lịch hẹn do chính mình chủ trì');
    }
  }
  return booking;
}

export const bookingLinkDeal = defineCommand({
  name: 'crm.booking.link_deal',
  input: zBookingDealLink,
  // It writes one internal column and sends nothing (R1).
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF,
  target: (input) => ({ type: 'crm.booking', id: input.bookingId }),
  handler: async (ctx, input): Promise<BookingDealChanged> => {
    // The deal is read in this org alone and held (a key share, which only a delete of it conflicts with) before the booking row is locked, the order a delete of a deal takes
    // (the deal, then the bookings its key clears), so the two cannot wait on each other, and a deal deleted at the same moment cannot leave a link to nothing.
    const deal = await ctx.trx.selectFrom('crove_crm.deal').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.dealId).forKeyShare().executeTakeFirst();
    if (!deal) throw new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
    const booking = await bookingOfCaller(ctx, input.bookingId);
    if (booking.deal_id !== deal.id) {
      await ctx.trx.updateTable('crove_crm.booking').set({ deal_id: deal.id }).where('org_id', '=', ctx.orgId).where('id', '=', booking.id).execute();
    }
    // Ids only: the deal's title and the guest's details stay out of the audit row.
    ctx.audit({ bookingId: booking.id, dealId: deal.id, previousDealId: booking.deal_id, linked: booking.deal_id !== deal.id });
    return { bookingId: booking.id, dealId: deal.id };
  },
});

export const bookingUnlinkDeal = defineCommand({
  name: 'crm.booking.unlink_deal',
  input: zBookingDealUnlink,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF,
  target: (input) => ({ type: 'crm.booking', id: input.bookingId }),
  handler: async (ctx, input): Promise<BookingDealChanged> => {
    const booking = await bookingOfCaller(ctx, input.bookingId);
    if (booking.deal_id !== null) {
      await ctx.trx.updateTable('crove_crm.booking').set({ deal_id: null }).where('org_id', '=', ctx.orgId).where('id', '=', booking.id).execute();
    }
    ctx.audit({ bookingId: booking.id, previousDealId: booking.deal_id, unlinked: booking.deal_id !== null });
    return { bookingId: booking.id, dealId: null };
  },
});

// One reminder before a booking (a job the worker queued from crm.booking.scheduled): mailed to the visitor only while
// the booking is confirmed and still starts at the time the job was queued for, and once per lead and time.
export const bookingRemind = defineCommand({
  name: 'crm.booking.remind',
  input: z.strictObject({ bookingId: zId, startsAt: z.iso.datetime(), lead: z.enum(['24h', '1h']) }),
  // It queues the reminder mail to the visitor (a send derives R2; #1579). A system command.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<{ sent: boolean }> => {
    const booking = await ctx.trx
      .selectFrom('crove_crm.booking')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!booking || booking.status !== 'confirmed' || new Date(booking.starts_at).getTime() !== Date.parse(input.startsAt)) return { sent: false };
    if (new Date(booking.starts_at).getTime() <= ctx.now.getTime()) return { sent: false };
    // A booking still waiting for its Google Meet has told the visitor nothing yet: its confirmation (held back, sent when the Meet is settled, within minutes) is the
    // first mail, and a reminder before it would name no link and could arrive first.
    if (booking.meeting_state === 'pending') return { sent: false };
    const source = `crm.booking.remind_${input.lead}`;
    const earlier = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('source', '=', source)
      .where('source_id', '=', booking.id)
      .where(sql<boolean>`payload ->> 'startsAt' = ${new Date(booking.starts_at).toISOString()}`)
      .executeTakeFirst();
    if (earlier) return { sent: false };
    const type = await eventTypeOf(ctx, booking.event_type_id);
    if (!booking.email || !booking.visitor_name) return { sent: false };
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const mail = await createMailMessage(ctx, {
      stream: 'transactional',
      source,
      sourceId: booking.id,
      templateKey: BOOKING_MAIL_TEMPLATE,
      to: booking.email,
      subject: SUBJECTS.reminder.visitor(type.title).slice(0, 300),
      payload: {
        kind: 'reminder',
        recipient: 'visitor',
        bookingId: booking.id,
        revision: booking.revision,
        org: tenant.slug,
        orgName: tenant.name,
        type: type.slug,
        title: type.title,
        startsAt: new Date(booking.starts_at).toISOString(),
        endsAt: new Date(booking.ends_at).toISOString(),
        timeZone: booking.time_zone,
        locationKind: type.location_kind,
        location: type.location_value,
      },
      status: 'queued',
    });
    ctx.audit({ bookingId: booking.id, reminder: input.lead, mail: mail.status });
    return { sent: mail.status === 'queued' };
  },
});

// The bookings a member sees (#1320): confirmed and cancelled ones (requests the worker refused are not bookings), of
// the types the member leads or held on their calendar (#1373), or of the whole org for owners and admins (scope
// 'org'). The screen pages them by period; a record that names one (a note's link, #1672) reads it by id; a deal's panel
// reads the ones linked to it (#3103). Each item says its deal; `suggest` also looks for the open deals of the guest of
// each booking that has none (Dy's rule, booking-deals.ts), which the Home read does not need.
async function loadBookings(
  ctx: QueryContext,
  userId: string,
  filter: { scope: 'mine' | 'org'; period: 'upcoming' | 'past'; dealId?: string } | { scope: 'mine' | 'org'; id: string } | { scope: 'mine'; day: { from: Date; to: Date } },
  options: { suggest?: boolean; limit?: number } = {},
): Promise<BookingItem[]> {
  // A day (the Home read, today.ts): the confirmed bookings that start in it and have not ended, earliest first.
  const upcoming = ('period' in filter && filter.period === 'upcoming') || 'day' in filter;
  let query = ctx.trx
    .selectFrom('crove_crm.booking as b')
    .innerJoin('crove_crm.event_type as e', (j) => j.onRef('e.org_id', '=', 'b.org_id').onRef('e.id', '=', 'b.event_type_id'))
    // Confirmed and cancelled bookings always hold their event (booking_confirmed_event).
    .innerJoin('crove_kernel.calendar_event as ev', (j) => j.onRef('ev.org_id', '=', 'b.org_id').onRef('ev.id', '=', 'b.calendar_event_id'))
    // The linked deal, when there is one (#3103).
    .leftJoin('crove_crm.deal as dl', (j) => j.onRef('dl.org_id', '=', 'b.org_id').onRef('dl.id', '=', 'b.deal_id'))
    .leftJoin('crove_crm.pipeline_stage as ds', (j) => j.onRef('ds.org_id', '=', 'dl.org_id').onRef('ds.id', '=', 'dl.stage_id'))
    .select([
      'b.id',
      'b.status',
      'b.starts_at',
      'b.ends_at',
      'b.time_zone',
      'b.visitor_name',
      'b.email',
      'b.phone',
      'b.note',
      'b.party_id',
      'b.calendar_event_id',
      'b.meeting_state',
      'b.meeting_url',
      'b.deal_id',
      'dl.title as deal_title',
      'ds.name as deal_stage',
      'ds.kind as deal_status',
      'e.id as type_id',
      'e.slug',
      'e.title',
      'e.active',
      'ev.user_id as host_user_id',
      sql<string[]>`coalesce((SELECT array_agg(h.user_id ORDER BY array_position(b.hold_event_ids, h.id)) FROM crove_kernel.calendar_event h
        WHERE h.org_id = b.org_id AND h.id = ANY (b.hold_event_ids)), '{}')`.as('hold_user_ids'),
    ])
    .where('b.org_id', '=', ctx.orgId)
    .where('b.status', 'in', 'day' in filter ? ['confirmed'] : ['confirmed', 'cancelled'])
    .$if(filter.scope === 'mine', (q) =>
      q.where((eb) =>
        eb.or([
          eb('e.host_user_id', '=', userId),
          eb('ev.user_id', '=', userId),
          sql<boolean>`EXISTS (SELECT 1 FROM crove_kernel.calendar_event h WHERE h.org_id = b.org_id AND h.id = ANY (b.hold_event_ids) AND h.user_id = ${userId})`,
        ]),
      ),
    );
  if ('id' in filter) query = query.where('b.id', '=', filter.id);
  else if ('day' in filter) query = query.where('b.starts_at', '>=', filter.day.from).where('b.starts_at', '<', filter.day.to).where('b.ends_at', '>', new Date());
  else {
    query = query.where('b.ends_at', upcoming ? '>' : '<=', new Date());
    if (filter.dealId !== undefined) query = query.where('b.deal_id', '=', filter.dealId);
  }
  const rows = await query
    .orderBy('b.starts_at', upcoming ? 'asc' : 'desc')
    .orderBy('b.id')
    .limit(options.limit ?? 200)
    .execute();
  // Dy's suggestions (#3103): one read of the open deals that might fit any unlinked booking of the page, then the fixed rule per booking.
  const unlinked = options.suggest === true ? rows.filter((r) => r.deal_id === null) : [];
  const candidates = await openDealsFor(ctx, unlinked.map((r) => ({ partyId: r.party_id, email: r.email, phone: r.phone })));
  return rows.map((r) => ({
    id: r.id,
    eventType: { id: r.type_id, slug: r.slug, title: r.title, active: r.active },
    hostUserId: r.host_user_id,
    hostUserIds: [r.host_user_id, ...r.hold_user_ids],
    status: r.status,
    startsAt: new Date(r.starts_at).toISOString(),
    endsAt: new Date(r.ends_at).toISOString(),
    timeZone: r.time_zone,
    visitor: { name: r.visitor_name, email: r.email, phone: r.phone, note: r.note },
    partyId: r.party_id,
    calendarEventId: r.calendar_event_id as string,
    meeting: { state: r.meeting_state, url: r.meeting_url },
    deal: r.deal_id !== null && r.deal_title !== null && r.deal_stage !== null && r.deal_status !== null ? { id: r.deal_id, title: r.deal_title, stage: r.deal_stage, status: r.deal_status } : null,
    dealSuggestions: r.deal_id === null && options.suggest === true ? suggestDeals({ partyId: r.party_id, email: r.email, phone: r.phone }, candidates) : [],
  }));
}

// The member's own bookings that start between two instants and have not ended: the types they lead or held on their calendar, the same rule as the
// screen's "mine" (the Home read, today.ts).
export const bookingsOfDay = (ctx: QueryContext, userId: string, from: Date, to: Date): Promise<BookingItem[]> => loadBookings(ctx, userId, { scope: 'mine', day: { from, to } });

function bookingUser(ctx: QueryContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

const manages = (ctx: QueryContext) => ctx.role === 'owner' || ctx.role === 'admin';

// The bookings of the screen (#1320), at most 200 a page.
export const bookingList = defineQuery({
  name: 'crm.booking.list',
  input: zBookingListQuery,
  access: STAFF,
  handler: async (ctx, input): Promise<BookingItem[]> => {
    const userId = bookingUser(ctx);
    if (input.scope === 'org' && !manages(ctx)) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới xem được lịch hẹn của cả tổ chức');
    }
    return loadBookings(ctx, userId, { scope: input.scope, period: input.period }, { suggest: input.withSuggestions === true });
  },
});

// One booking, as the screen would show it to the caller: any of the org's for owners and admins, otherwise one of
// the types they lead or held on their calendar. Any other booking, or one of another org, is not found.
export const bookingGet = defineQuery({
  name: 'crm.booking.get',
  input: z.strictObject({ id: zId }),
  access: STAFF,
  handler: async (ctx, input): Promise<BookingItem> => {
    const userId = bookingUser(ctx);
    const [booking] = await loadBookings(ctx, userId, { scope: manages(ctx) ? 'org' : 'mine', id: input.id }, { suggest: true });
    if (!booking) throw new DomainError('BOOKING_NOT_FOUND', 404, 'Không tìm thấy lịch hẹn');
    return booking;
  },
});

// The deal panel's read (#3103): the bookings linked to the deal that the caller may read (the same rule as the screen: the types they lead or hold, or the whole org for
// owners and admins), upcoming first to last and past last to first. Roles that read no booking get nothing; a deal of another org is not found.
export const dealBookings = defineQuery({
  name: 'crm.deal.bookings',
  input: zDealBookingsQuery,
  access: STAFF,
  handler: async (ctx, input): Promise<DealBookings> => {
    const userId = bookingUser(ctx);
    const deal = await ctx.trx.selectFrom('crove_crm.deal').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.dealId).executeTakeFirst();
    if (!deal) throw new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
    const scope = manages(ctx) ? 'org' : 'mine';
    const upcoming = await loadBookings(ctx, userId, { scope, period: 'upcoming', dealId: deal.id }, { limit: BOOKING_DEAL_LIST_MAX });
    const past = await loadBookings(ctx, userId, { scope, period: 'past', dealId: deal.id }, { limit: BOOKING_DEAL_LIST_MAX });
    return { upcoming, past };
  },
});

// What the worker checks at the hosts' connected calendars before it decides a booking (#2139): the hosts whose calendars
// the decision depends on, and the window the slot needs free (the slot with the type's buffers). For a pending booking
// the type's hosts who may still host it; for a visitor's ask to move a held booking, the hosts it holds. Null when there
// is nothing to decide (decided already, a cancel, an ask that is no longer the booking's last).
export const bookingLiveTarget = defineQuery({
  name: 'crm.booking.live_target',
  input: z.strictObject({ bookingId: zId, requestId: zId.optional() }),
  access: 'system',
  handler: async (ctx, input): Promise<{ hostUserIds: string[]; from: string; to: string } | null> => {
    const booking = await ctx.trx.selectFrom('crove_crm.booking').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', input.bookingId).executeTakeFirst();
    if (!booking) return null;
    const type = await eventTypeOf(ctx, booking.event_type_id);
    const window = (start: number, end: number) => ({ from: new Date(start - type.buffer_before_min * 60_000).toISOString(), to: new Date(end + type.buffer_after_min * 60_000).toISOString() });
    if (input.requestId === undefined) {
      if (booking.status !== 'pending') return null;
      return { hostUserIds: await hostsOf(ctx, type), ...window(new Date(booking.starts_at).getTime(), new Date(booking.ends_at).getTime()) };
    }
    if (booking.manage_request_id !== input.requestId || booking.manage_outcome !== null || booking.manage_action !== 'move' || booking.manage_starts_at === null) return null;
    // Only a booking that can still be moved: confirmed and not started (manage answers any other ask without a slot to check).
    if (booking.status !== 'confirmed' || new Date(booking.starts_at).getTime() <= Date.now()) return null;
    const start = new Date(booking.manage_starts_at).getTime();
    const held = await eventsOf(ctx, booking);
    return { hostUserIds: [...new Set(held.map((h) => h.userId))], ...window(start, start + type.duration_min * 60_000) };
  },
});
export const bookingQueries = [bookingList, bookingGet, dealBookings, bookingLiveTarget];

export const bookingCommands = [bookingConfirm, bookingMailData, bookingMeetingSettle, bookingManage, bookingRemind, bookingCancel, bookingMove, bookingLinkDeal, bookingUnlinkDeal];
