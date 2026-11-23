// SPDX-License-Identifier: AGPL-3.0-only
// A member's own Google Calendar meetings, read to suggest "record this meeting" (Meetings B1, #3165, plan docs/plan/meetings-integrations.md section 5.1). The shapes of the module's queries and
// commands; the cache itself is crove_meetings.calendar_agenda (the member's own rows, never an invitee address, a description or an attachment). No model is involved anywhere: code finds the
// event a recording overlaps and a person confirms.
import { z } from 'zod';
import { zId } from './schemas.ts';

// How far a recording's time may be from an event's for the event to be suggested (the plan says 15 minutes), and the most events a list shows.
export const AGENDA_OVERLAP_MINUTES = 15;
export const AGENDA_LIST_MAX = 50;
export const AGENDA_UPCOMING_DAYS = 7;
// The most events one replace carries (the adapter's own cut).
export const AGENDA_REPLACE_MAX = 300;
// What the extension's "Sắp họp" card may read (B2, #3166): at most this many events, starting within this many minutes (or running now).
export const AGENDA_NEXT_MAX = 5;
export const AGENDA_NEXT_MINUTES = 30;

export const MEETING_PLATFORMS = ['meet', 'zoom', 'teams'] as const;
export const zMeetingPlatform = z.enum(MEETING_PLATFORMS);
export type MeetingPlatform = z.infer<typeof zMeetingPlatform>;

function parseSafeJoinUrl(url: string | null): { platform: MeetingPlatform; href: string } | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
  const host = parsed.hostname.toLowerCase();
  if (host === '' || host.split('.').some((label) => label.length === 0)) return null;
  let platform: MeetingPlatform | null = null;
  if (host === 'meet.google.com') platform = 'meet';
  else if (host === 'zoom.us' || host.endsWith('.zoom.us')) platform = 'zoom';
  else if (host === 'teams.microsoft.com' || host === 'teams.live.com') platform = 'teams';
  return platform === null ? null : { platform, href: parsed.href };
}

/** Identifies the video call platform from an https join URL; refuses non-https, ports, embedded credentials, empty DNS labels, or unrecognized hosts. */
export function joinServiceFromUrl(url: string | null): MeetingPlatform | null {
  return parseSafeJoinUrl(url)?.platform ?? null;
}

/** Returns the canonical URL when it is a safe https Meet, Zoom, or Teams address. */
export function safeJoinUrl(url: string | null): string | null {
  return parseSafeJoinUrl(url)?.href ?? null;
}

// How far a meeting/recording interval may extend when matching against calendar events or existing Ludy meetings (B1 15-minute rule).
export function meetingOverlapWindow(
  span: { startedAt: Date; endedAt?: Date | null; lengthSeconds?: number | null },
  overlapMinutes: number = AGENDA_OVERLAP_MINUTES,
): { startedAt: Date; endedAt: Date; windowStart: Date; windowEnd: Date } {
  const startedAt = span.startedAt;
  const seconds = span.lengthSeconds ?? null;
  const computedEnd = seconds !== null && seconds > 0 ? new Date(startedAt.getTime() + Number(seconds) * 1000) : startedAt;
  const rawEndedAt = span.endedAt ?? computedEnd;
  const endedAt = rawEndedAt.getTime() >= startedAt.getTime() ? rawEndedAt : startedAt;
  const slackMs = overlapMinutes * 60_000;
  return {
    startedAt,
    endedAt,
    windowStart: new Date(startedAt.getTime() - slackMs),
    windowEnd: new Date(endedAt.getTime() + slackMs),
  };
}

// A title is cut at 200 characters (code points) in the cache, so the answer's check counts code points too: an emoji is two UTF-16 units and a title of a hundred of them is still a valid one.
const zAgendaTitle = z.string().refine((title) => Array.from(title).length <= 200, 'title is at most 200 characters');

export const zAgendaEvent = z.strictObject({
  id: zId,
  title: zAgendaTitle,
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

// The member's list of today's or upcoming meetings. `enabled`: at least one of their connections reads its events (the switch is on and the grant carries the scope); without it the list is empty and the
// screen says how to turn it on.
export const zAgendaListInput = z.strictObject({
  range: z.enum(['today', 'upcoming']).optional(),
});
export const zAgendaList = z.strictObject({ enabled: z.boolean(), events: z.array(zAgendaEvent).max(AGENDA_LIST_MAX) });
export type AgendaList = z.infer<typeof zAgendaList>;

// The member's next meetings for the extension (the `agenda` token scope): the title, the start and end, and the host of the join address (never the address, an id or the invitees). `enabled` says whether
// the member reads their calendar at all (the B1 switch is on and the grant carries the scope), so the popup can tell "nothing soon" from "not switched on".
export const zAgendaNextInput = z.strictObject({});
export const zAgendaNextEvent = z.strictObject({
  title: zAgendaTitle,
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  joinHost: z.string().max(100).nullable(),
});
export const zAgendaNext = z.strictObject({ enabled: z.boolean(), events: z.array(zAgendaNextEvent).max(AGENDA_NEXT_MAX) });
export type AgendaNext = z.infer<typeof zAgendaNext>;

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
  // The provider's recurring event id when the event is an occurrence of one (#3542); the database keeps a hash of it. Absent or null: not part of a series.
  series: z.string().min(1).max(1024).nullable().default(null),
});
export const zAgendaReplace = z.strictObject({ connectionId: zId, from: z.iso.datetime({ offset: true }), events: z.array(zAgendaReplaceEvent).max(AGENDA_REPLACE_MAX) });
export const zAgendaReplaced = z.strictObject({ connectionId: zId, written: z.number().int().min(0) });
