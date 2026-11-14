// SPDX-License-Identifier: AGPL-3.0-only
// The popup's "Sắp họp" card (Meetings B2, #3166): the member's next calendar meetings, read from their own Ludy calendar cache through the extension token's `agenda` scope. The scope is
// asked for only when the member chooses it (one button, one more line on Ludy's consent page); a token without it never reads the calendar. Nothing here reads a page, starts a recording or
// joins a call: "Ghi cuộc họp này" only puts the event's title in the title field of the recording form, whose consent step runs as always.

// The scope the kernel knows. Not a Feature of the shell (it needs no browser permission and no module screen of its own), so the plain sign-in never asks for it.
export const AGENDA_SCOPE = 'agenda';

export interface AgendaEvent {
  title: string;
  startsAt: string;
  endsAt: string;
  // The host of the join address, never the address (meet.google.com, zoom.us, teams.microsoft.com), or null.
  joinHost: string | null;
}

export interface AgendaNext {
  // The member's own switch for reading their calendar is on (Ludy's Settings), so an empty list can be told from "not switched on".
  enabled: boolean;
  events: AgendaEvent[];
}

// The answer of meetings.agenda.next, checked, not trusted: a damaged answer is no card at all (null). At most 5 events, every field the right kind.
export function readAgendaNext(raw: unknown): AgendaNext | null {
  const body = typeof raw === 'object' && raw !== null && 'json' in raw ? (raw as { json: unknown }).json : raw;
  if (typeof body !== 'object' || body === null) return null;
  const { enabled, events } = body as { enabled?: unknown; events?: unknown };
  if (typeof enabled !== 'boolean' || !Array.isArray(events) || events.length > 5) return null;
  const out: AgendaEvent[] = [];
  for (const e of events) {
    if (typeof e !== 'object' || e === null) return null;
    const { title, startsAt, endsAt, joinHost } = e as Record<string, unknown>;
    if (typeof title !== 'string' || typeof startsAt !== 'string' || typeof endsAt !== 'string' || Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) return null;
    if (joinHost !== null && typeof joinHost !== 'string') return null;
    out.push({ title: title.slice(0, 200), startsAt, endsAt, joinHost: joinHost === null ? null : joinHost.slice(0, 100) });
  }
  return { enabled, events: out };
}

// The name of the service a join host belongs to, or null for a host the card does not name.
export function serviceOfHost(host: string | null): 'meet' | 'zoom' | 'teams' | null {
  if (!host) return null;
  const h = host.toLowerCase();
  if (h === 'meet.google.com') return 'meet';
  if (h === 'zoom.us' || h.endsWith('.zoom.us')) return 'zoom';
  if (h === 'teams.microsoft.com' || h === 'teams.live.com') return 'teams';
  return null;
}

// Brand names, the same in both languages.
export const SERVICE_NAMES = { meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams' } as const;

// The line of one card: "Sắp họp: <title> 09:00 (Google Meet)", the place only when the host is one of the three the card names. `time` is the start in the browser's own clock.
export function agendaLine(template: string, untitled: string, event: AgendaEvent, locale?: string): string {
  const service = serviceOfHost(event.joinHost);
  const time = new Date(event.startsAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  // One pass with function replacers: a title is data, so a `$&`, a `$'` or a `{time}` in it is shown as written and never read as part of the template.
  const values: Record<string, string> = { title: event.title.trim() === '' ? untitled : event.title, time, where: service ? ` (${SERVICE_NAMES[service]})` : '' };
  return template.replace(/\{(title|time|where)\}/g, (_match, key: string) => values[key] ?? '');
}

// The scopes a sign-in asks for: the features' own, plus the agenda scope only when the member chose it.
export function signInScopes(featureScopes: readonly string[], withAgenda: boolean): string[] {
  return withAgenda ? [...featureScopes, AGENDA_SCOPE] : [...featureScopes];
}
