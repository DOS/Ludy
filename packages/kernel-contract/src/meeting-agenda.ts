// SPDX-License-Identifier: AGPL-3.0-only
// A member's own Google Calendar meetings, read to suggest "record this meeting" (Meetings B1, #3165, plan docs/plan/meetings-integrations.md section 5.1). The shapes of the module's queries and
// commands; the cache itself is crove_meetings.calendar_agenda (the member's own rows, never an invitee address, a description or an attachment). No model is involved anywhere: code finds the
// event a recording overlaps and a person confirms.
import { z } from 'zod';
import { zId } from './schemas.ts';

// How far a recording's time may be from an event's for the event to be suggested (the plan says 15 minutes), and the most events a list shows.
export const AGENDA_OVERLAP_MINUTES = 15;
export const AGENDA_LIST_MAX = 50;
// The most events one replace carries (the adapter's own cut).
export const AGENDA_REPLACE_MAX = 300;

export const zAgendaEvent = z.strictObject({
  id: zId,
  title: z.string().max(200),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  timeZone: z.string().min(1).max(64),
  // A Meet, Zoom or Teams address (https), or null.
  joinUrl: z.string().max(500).nullable(),
  invitees: z.number().int().min(0).max(1000),
  // The meeting recorded from this event, once the member linked it.
  meetingId: zId.nullable(),
});
export type AgendaEvent = z.infer<typeof zAgendaEvent>;

// The member's list of today's meetings. `enabled`: at least one of their connections reads its events (the switch is on and the grant carries the scope); without it the list is empty and the
// screen says how to turn it on.
export const zAgendaListInput = z.strictObject({});
export const zAgendaList = z.strictObject({ enabled: z.boolean(), events: z.array(zAgendaEvent).max(AGENDA_LIST_MAX) });
export type AgendaList = z.infer<typeof zAgendaList>;

export const zAgendaSuggestInput = z.strictObject({ meetingId: zId });
// For a meeting the member recorded: the event it is linked to, or the one event that overlaps its time (when exactly one does and it is not linked elsewhere); both null otherwise.
export const zAgendaSuggestion = z.strictObject({ meetingId: zId, linked: zAgendaEvent.nullable(), suggestion: zAgendaEvent.nullable() });
export type AgendaSuggestion = z.infer<typeof zAgendaSuggestion>;

export const zAgendaSetReadEvents = z.strictObject({ connectionId: zId, enabled: z.boolean() });
export const zAgendaReadEventsSet = z.strictObject({ connectionId: zId, readEvents: z.boolean() });
export const zAgendaClear = z.strictObject({ connectionId: zId });
export const zAgendaCleared = z.strictObject({ connectionId: zId, cleared: z.number().int().min(0) });
// The member's click "Gắn vào sự kiện lịch này": the cached event and the meeting the member recorded (or null to take the link away).
export const zAgendaLink = z.strictObject({ agendaId: zId, meetingId: zId.nullable() });
export const zAgendaLinked = z.strictObject({ agendaId: zId, meetingId: zId.nullable() });

// What the sweep writes (system only): the events it read, the start of the window (rows that ended before it go), as agenda_replace takes them.
export const zAgendaReplaceEvent = z.strictObject({
  id: z.string().min(1).max(1024),
  title: z.string().max(200),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  timeZone: z.string().min(1).max(64),
  joinUrl: z.string().max(500).nullable(),
  invitees: z.number().int().min(0).max(1000),
});
export const zAgendaReplace = z.strictObject({ connectionId: zId, from: z.iso.datetime({ offset: true }), events: z.array(zAgendaReplaceEvent).max(AGENDA_REPLACE_MAX) });
export const zAgendaReplaced = z.strictObject({ connectionId: zId, written: z.number().int().min(0) });
