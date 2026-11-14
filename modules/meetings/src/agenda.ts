// SPDX-License-Identifier: AGPL-3.0-only
// A member's own Google Calendar meetings, read to suggest "record this meeting" (Meetings B1, #3165, plan docs/plan/meetings-integrations.md section 5.1). The cache is
// crove_meetings.calendar_agenda: the member's own rows (title, start, end, time zone, a Meet, Zoom or Teams address and the number of invitees; never an invitee address, a description or
// an attachment), read by the member alone (row security refuses an owner, an admin, another member, an agent context and the system context), deleted at once when the member switches the
// read off or disconnects the calendar, and written by nobody but the worker's sweep through crove_meetings.agenda_replace, a definer that returns a count and never text.
//
// Nothing here uses a model and nothing starts a recording or joins a call. Code finds the event a recording overlaps (within 15 minutes, and only when exactly one does) and a person confirms
// with a click; "Ghi cuộc họp này" only fills the title of the normal new-meeting form, whose consent step always runs.
import { sql } from 'kysely';
import {
  AGENDA_LIST_MAX,
  AGENDA_OVERLAP_MINUTES,
  zAgendaClear,
  zAgendaCleared,
  zAgendaLink,
  zAgendaLinked,
  zAgendaList,
  zAgendaReadEventsSet,
  zAgendaReplace,
  zAgendaReplaced,
  zAgendaSetReadEvents,
  zAgendaSuggestInput,
  zAgendaSuggestion,
  zAgendaListInput,
  type AgendaEvent,
  type AgendaList,
  type AgendaSuggestion,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { vnDay, vnDayStart } from './retention.ts';
import { ROLES, userOf } from './transcript.ts';

type Trx = QueryContext['trx'];
const DAY_MS = 86_400_000;

interface AgendaRow {
  id: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  time_zone: string;
  join_url: string | null;
  invitee_count: number;
  meeting_id: string | null;
}
const toEvent = (r: AgendaRow): AgendaEvent => ({
  id: r.id,
  title: r.title,
  startsAt: r.starts_at.toISOString(),
  endsAt: r.ends_at.toISOString(),
  timeZone: r.time_zone,
  joinUrl: r.join_url,
  invitees: r.invitee_count,
  meetingId: r.meeting_id,
});

// The member's cached events of connections that read them now (active, switch on): a row of a connection that is on its way out, or whose switch went off, is not shown even before it is
// deleted. Row security shows the member their own rows only.
function agendaOf(trx: Trx, orgId: string, userId: string) {
  return trx
    .selectFrom('crove_meetings.calendar_agenda as a')
    .innerJoin('crove_kernel.calendar_connection as c', (join) => join.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.connection_id'))
    .select(['a.id', 'a.title', 'a.starts_at', 'a.ends_at', 'a.time_zone', 'a.join_url', 'a.invitee_count', 'a.meeting_id'])
    .where('a.org_id', '=', orgId)
    .where('a.user_id', '=', userId)
    .where('c.status', '=', 'active')
    .where('c.read_events', '=', true);
}

// Today's meetings (Vietnam time) of the member's own calendar, the earliest first, with the ones already recorded marked by their meeting.
export const agendaList = defineQuery({
  name: 'meetings.agenda.list',
  input: zAgendaListInput,
  access: ROLES,
  handler: async (ctx): Promise<AgendaList> => {
    const userId = userOf(ctx.actor);
    const enabled = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('read_events', '=', true)
      .limit(1)
      .executeTakeFirst();
    if (!enabled) return zAgendaList.parse({ enabled: false, events: [] });
    const start = new Date(vnDayStart(vnDay(new Date())));
    const rows = await agendaOf(ctx.trx, ctx.orgId, userId)
      .where('a.starts_at', '>=', start)
      .where('a.starts_at', '<', new Date(start.getTime() + DAY_MS))
      .orderBy('a.starts_at')
      .orderBy('a.id')
      .limit(AGENDA_LIST_MAX)
      .execute();
    return zAgendaList.parse({ enabled: true, events: rows.map(toEvent) });
  },
});

// For a meeting the member recorded: the event it is linked to, else the one event that overlaps the recording within 15 minutes, when exactly one does. Time overlap is the whole rule (a
// title is never compared with anything); a person confirms with a click. Another member's meeting is refused, as the cache shows them none of this member's events.
export const agendaSuggest = defineQuery({
  name: 'meetings.agenda.suggest',
  input: zAgendaSuggestInput,
  access: ROLES,
  handler: async (ctx, input): Promise<AgendaSuggestion> => {
    const userId = userOf(ctx.actor);
    const meeting = await ctx.trx
      .selectFrom('crove_meetings.meeting')
      .select(['recorder_user_id', 'started_at', 'ended_at', 'length_seconds'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting || meeting.recorder_user_id !== userId) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    const linked = await agendaOf(ctx.trx, ctx.orgId, userId).where('a.meeting_id', '=', input.meetingId).executeTakeFirst();
    if (linked) return zAgendaSuggestion.parse({ meetingId: input.meetingId, linked: toEvent(linked), suggestion: null });
    const startedAt = meeting.started_at;
    const endedAt = meeting.ended_at ?? (startedAt && meeting.length_seconds ? new Date(startedAt.getTime() + Number(meeting.length_seconds) * 1000) : startedAt);
    if (!startedAt || !endedAt) return zAgendaSuggestion.parse({ meetingId: input.meetingId, linked: null, suggestion: null });
    const slack = AGENDA_OVERLAP_MINUTES * 60_000;
    const rows = await agendaOf(ctx.trx, ctx.orgId, userId)
      .where('a.meeting_id', 'is', null)
      .where('a.starts_at', '<', new Date(endedAt.getTime() + slack))
      .where('a.ends_at', '>', new Date(startedAt.getTime() - slack))
      .orderBy('a.starts_at')
      .limit(2)
      .execute();
    return zAgendaSuggestion.parse({ meetingId: input.meetingId, linked: null, suggestion: rows.length === 1 && rows[0] ? toEvent(rows[0]) : null });
  },
});

// The member's switch for reading the names and times of their own meetings. On: the kernel's command checks the connection is theirs, active and carries the events-read scope. Off: the kernel
// turns it off and the member's cached rows of that connection are deleted in the same transaction (a link to a meeting goes with them).
export const agendaSetReadEvents = defineCommand({
  name: 'meetings.agenda.set_read_events',
  input: zAgendaSetReadEvents,
  risk: 'R2',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    const done = await ctx.run<{ connectionId: string; readEvents: boolean }>('kernel.calendar.read_events.set', { connectionId: input.connectionId, enabled: input.enabled });
    let cleared = 0;
    if (!input.enabled) cleared = await deleteOwn(ctx, input.connectionId);
    ctx.audit({ connectionId: input.connectionId, readEvents: input.enabled, cleared });
    return zAgendaReadEventsSet.parse({ connectionId: done.connectionId, readEvents: done.readEvents });
  },
});

async function deleteOwn(ctx: CommandContext, connectionId: string): Promise<number> {
  const userId = userOf(ctx.actor);
  const removed = await ctx.trx
    .deleteFrom('crove_meetings.calendar_agenda')
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', userId)
    .where('connection_id', '=', connectionId)
    .returning('id')
    .execute();
  return removed.length;
}

// Deletes the member's cached events of a connection at once: after a disconnect, and after connecting again without the events-read scope. The member's own rows only (row security).
export const agendaClear = defineCommand({
  name: 'meetings.agenda.clear',
  input: zAgendaClear,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input) => {
    const cleared = await deleteOwn(ctx, input.connectionId);
    ctx.audit({ connectionId: input.connectionId, cleared });
    return zAgendaCleared.parse({ connectionId: input.connectionId, cleared });
  },
});

// "Gắn vào sự kiện lịch này": the member links a meeting they recorded to a cached event of their own (one event a meeting), or takes the link away. Row security checks that the event is theirs
// and that the meeting is one they recorded; the unique key refuses a second event for the same meeting.
export const agendaLink = defineCommand({
  name: 'meetings.agenda.link',
  input: zAgendaLink,
  risk: 'R1',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const row = await agendaOf(ctx.trx, ctx.orgId, userId).where('a.id', '=', input.agendaId).executeTakeFirst();
    if (!row) throw new DomainError('AGENDA_NOT_FOUND', 404, 'That calendar event is not in your calendar any more');
    // An event linked to another meeting is not taken over silently (a stale address or a second tab): the member removes the old link first.
    if (input.meetingId !== null && row.meeting_id !== null && row.meeting_id !== input.meetingId) throw new DomainError('AGENDA_EVENT_LINKED', 409, 'This calendar event is already linked to another meeting');
    if (input.meetingId !== null) {
      const meeting = await ctx.trx.selectFrom('crove_meetings.meeting').select('recorder_user_id').where('org_id', '=', ctx.orgId).where('id', '=', input.meetingId).executeTakeFirst();
      if (!meeting || meeting.recorder_user_id !== userId) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    }
    try {
      await ctx.trx.updateTable('crove_meetings.calendar_agenda').set({ meeting_id: input.meetingId }).where('org_id', '=', ctx.orgId).where('id', '=', input.agendaId).execute();
    } catch (error: unknown) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('AGENDA_MEETING_LINKED', 409, 'This meeting is already linked to a calendar event');
      throw error;
    }
    ctx.audit({ agendaId: input.agendaId, meetingId: input.meetingId });
    return zAgendaLinked.parse({ agendaId: input.agendaId, meetingId: input.meetingId });
  },
});

// The worker's sweep writes what it read (system only; the kernel's calendar sweep calls it for a connection whose switch is on). The definer writes nothing for a connection that is gone, not
// active or switched off, keeps the rows linked to a meeting, and answers how many events it wrote.
export const agendaReplace = defineCommand({
  name: 'meetings.agenda.replace',
  input: zAgendaReplace,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Only a system actor may do this');
    const { rows } = await sql<{ n: number }>`
      SELECT crove_meetings.agenda_replace(${input.connectionId}::uuid, ${input.from}::timestamptz, ${JSON.stringify(input.events)}::jsonb) AS n`.execute(ctx.trx);
    const written = Number(rows[0]?.n ?? 0);
    ctx.audit({ connectionId: input.connectionId, written });
    return zAgendaReplaced.parse({ connectionId: input.connectionId, written });
  },
});

export const agendaCommands = [agendaSetReadEvents, agendaClear, agendaLink, agendaReplace];
export const agendaQueries = [agendaList, agendaSuggest];
