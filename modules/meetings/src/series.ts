// SPDX-License-Identifier: AGPL-3.0-only
// A series of meetings (#3542, owner decision 2026-11-17). Two meetings are in one series when they come from the same recurring calendar event (the series id the sweep keeps on the
// calendar cache, copied onto the meeting when the recorder links the two, see agenda.ts) or when the recorder says one follows the other (meetings.series.set). No guess from titles.
//
// meetings.series.open_items   what the caller may read of the PREVIOUS meeting of the series that is still open: its published items, the accepted ones with the live status of their
//                              task (a done or cancelled task is not shown), the ones nobody accepted as "chưa giao". Nothing here is stored: it is a read. Row security shows the previous meeting
//                              only to a caller who reads it, so a reader of the new meeting who did not read the old one gets nothing of it, not even its title.
// meetings.series.set          the recorder's own click: this meeting follows an earlier one they also recorded, or (null) leaves its series.
//
// meetings.series.nudge        the worker's one in-app notice, about 30 minutes before the next meeting of a series: to a person with open items from the previous meeting, how many and a link.
//                              No title, no text (the notice's subject is the previous meeting; the app shows its title only to someone who reads it).
//
// No model is used and nothing here writes to Projects: the task is read, never changed.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { notifyMembers, uploaderEntity } from '@crove/kernel';
import { SERIES_ITEMS_MAX, SERIES_TASK_STATUSES, zSeriesNudge, zSeriesOpenItems, zSeriesOpenItemsInput, zSeriesSet, zSeriesSetResult, type SeriesOpenItems } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { vnDay } from './retention.ts';
import { ROLES, openMeeting, userOf } from './transcript.ts';

// What the caller may read of the previous meeting of this meeting's series that is still open (see the header).
export const seriesOpenItems = defineQuery({
  name: 'meetings.series.open_items',
  input: zSeriesOpenItemsInput,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<SeriesOpenItems> => {
    userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const current = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['series_id', sql<Date>`coalesce(started_at, created_at)`.as('at')])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirstOrThrow();
    const none = (inSeries: boolean) => zSeriesOpenItems.parse({ meetingId: input.meetingId, inSeries, previous: null, items: [] });
    if (current.series_id === null) return none(false);
    // The latest earlier meeting of the series that THIS caller reads: the meeting policy hides the others, so nothing of an unread meeting (not even that it exists) is told.
    const previous = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id', 'title', sql<Date>`coalesce(started_at, created_at)`.as('at')])
      .where('org_id', '=', ctx.orgId)
      .where('series_id', '=', current.series_id)
      .where('id', '<>', input.meetingId)
      .where(sql<boolean>`coalesce(started_at, created_at) < ${current.at}`)
      // A meeting whose text period has ended is gone for every reader, as for the current one (openMeeting); the nightly purge may not have run yet.
      .where(sql<boolean>`(text_retention_date IS NULL OR text_retention_date > ${vnDay(new Date())}::date)`)
      .orderBy(sql`coalesce(started_at, created_at)`, 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!previous) return none(true);
    // The previous meeting's published items, with the live task of an accepted one read in the caller's own context (a task the caller may not read has no visible status and stays listed).
    const rows = await ctx.trx
      .selectFrom('crove_meetings.action_item as i')
      .leftJoin('crove_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'i.org_id').onRef('t.id', '=', 'i.task_id'))
      // The seat the task is with NOW (it may have been given to someone else since the item was accepted) and who holds it.
      .leftJoin('crove_kernel.position as p', (join) => join.onRef('p.org_id', '=', 't.org_id').onRef('p.id', '=', 't.assignee_position_id').on('p.status', '=', 'active'))
      .select([
        'i.id',
        'i.title',
        'i.who_drafted',
        'i.who_parsed',
        'i.when_drafted',
        sql<string | null>`i.when_parsed::text`.as('when_parsed'),
        'i.status',
        'i.task_id',
        't.status as task_status',
        't.due as task_due',
        'p.title as seat_title',
        'p.holder_user_id as seat_holder',
      ])
      .where('i.org_id', '=', ctx.orgId)
      .where('i.meeting_id', '=', previous.id)
      .where('i.stage', '=', 'published')
      .orderBy('i.transcript_seconds')
      .orderBy('i.created_at')
      .orderBy('i.id')
      .execute();
    const open = rows.filter((r) => r.task_status === null || r.task_status === undefined || (SERIES_TASK_STATUSES as readonly string[]).includes(r.task_status)).slice(0, SERIES_ITEMS_MAX);
    return zSeriesOpenItems.parse({
      meetingId: input.meetingId,
      inSeries: true,
      previous: { meetingId: previous.id, title: previous.title, startedAt: previous.at.toISOString() },
      items: open.map((r) => ({
        id: r.id,
        title: r.title,
        who: r.who_drafted,
        // The person the task is with now: the holder of its seat when it has one, else the attendee the item was parsed to.
        whoUserId: r.seat_holder ?? r.who_parsed,
        assigneeSeat: r.seat_title ?? null,
        when: r.when_drafted,
        whenDate: r.when_parsed,
        assigned: r.status === 'accepted',
        taskStatus: r.task_status ?? null,
        due: r.task_due ? new Date(r.task_due).toISOString() : null,
      })),
    });
  },
});

// The recorder's click: this meeting follows an earlier one they also recorded (both then carry one series id), or, with null, leaves its series (the other meetings keep it).
export const seriesSet = defineCommand({
  name: 'meetings.series.set',
  input: zSeriesSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const meeting = await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    if (meeting.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can set its series');
    const seriesOf = async (id: string) =>
      (await ctx.trx.selectFrom('crove_meetings.meeting').select('series_id').where('org_id', '=', ctx.orgId).where('id', '=', id).executeTakeFirstOrThrow()).series_id;
    if (input.previousMeetingId === null) {
      await ctx.trx.updateTable('crove_meetings.meeting').set({ series_id: null }).where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).execute();
      ctx.audit({ meetingId: input.meetingId, inSeries: false });
      return zSeriesSetResult.parse({ meetingId: input.meetingId, inSeries: false });
    }
    if (input.previousMeetingId === input.meetingId) throw new DomainError('SERIES_SELF', 422, 'A meeting cannot follow itself');
    // The earlier meeting must be one the recorder also recorded: the answer for one they cannot read is the same as for one that is not there.
    const earlier = await openMeeting(ctx.trx, ctx.orgId, input.previousMeetingId);
    if (earlier.recorder_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'You can only follow a meeting you recorded');
    // It must have started before this one: a series runs forward in time, and the open items of a later meeting are no "previous".
    const times = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['id', sql<Date>`coalesce(started_at, created_at)`.as('at')])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', [input.meetingId, input.previousMeetingId])
      .execute();
    const at = (id: string) => times.find((t) => t.id === id)?.at.getTime() ?? 0;
    if (at(input.previousMeetingId) >= at(input.meetingId)) throw new DomainError('SERIES_ORDER', 422, 'The earlier meeting must have started before this one');
    const mine = await seriesOf(input.meetingId);
    const theirs = await seriesOf(input.previousMeetingId);
    // Two different series are not merged by one click: the recorder takes this meeting out of its own first.
    if (mine !== null && theirs !== null && mine !== theirs) throw new DomainError('SERIES_CONFLICT', 409, 'These two meetings already belong to different series');
    const id = mine ?? theirs ?? randomUUID();
    for (const meetingId of [input.meetingId, input.previousMeetingId]) {
      await ctx.trx.updateTable('crove_meetings.meeting').set({ series_id: id }).where('org_id', '=', ctx.orgId).where('id', '=', meetingId).execute();
    }
    ctx.audit({ meetingId: input.meetingId, previousMeetingId: input.previousMeetingId, inSeries: true });
    return zSeriesSetResult.parse({ meetingId: input.meetingId, inSeries: true });
  },
});

// The notification kind of the nudge; members turn it off like any kind (#671). Its detail holds the count only.
export const SERIES_OPEN_ITEMS = 'meetings.series_open_items';

// One nudge the sweep found: a notice for one member, once per series and day of the next meeting (the notice's key, so a replayed job or a second pass writes nothing). The job's ids are
// not trusted: crove_meetings.series_nudges_due derives the row again for this member, series and start (the event in their own calendar, the previous meeting they read, the open items that are
// theirs now), and a nudge that is no longer due (the event moved, the items done or given to someone else since the sweep) writes nothing.
export const seriesNudge = defineCommand({
  name: 'meetings.series.nudge',
  input: zSeriesNudge,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ sent: number }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới nhắc việc của chuỗi cuộc họp');
    const startsAt = new Date(input.startsAt).toISOString();
    const { rows } = await sql<{ previous_meeting_id: string; open_count: number }>`
      SELECT previous_meeting_id, open_count
      FROM crove_meetings.series_nudges_due(1::int, ${ctx.orgId}::uuid, ${input.userId}::uuid, ${input.seriesId}::uuid, ${startsAt}::timestamptz)`.execute(ctx.trx);
    const due = rows[0];
    // Nothing due any more (done since the sweep, already told, muted): nothing is written, not even an audit row.
    if (!due) return { sent: 0 };
    const sent = await notifyMembers(ctx, {
      kind: SERIES_OPEN_ITEMS,
      users: [input.userId],
      // The series and the Vietnam day of the start (the same text crove_meetings.series_nudges_due leaves out): an occurrence moved by minutes is one notice.
      key: `series:${input.seriesId}:${vnDay(new Date(startsAt))}`,
      subject: { type: 'meetings.meeting', id: due.previous_meeting_id },
      detail: { count: String(due.open_count) },
      legalEntityId: await uploaderEntity(ctx, input.userId),
    });
    ctx.audit({ seriesId: input.seriesId, startsAt, count: due.open_count, sent });
    return { sent };
  },
});

export const seriesCommands = [seriesSet, seriesNudge];
export const seriesQueries = [seriesOpenItems];
