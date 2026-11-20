// SPDX-License-Identifier: AGPL-3.0-only
// The Today view of the meetings page, the module's side (#3955). One read for the whole page: the member's own agenda for today (the same events and rules as `meetings.agenda.list`), the total time of the events
// and, for each event, the facts of its brief (the same read as `meetings.brief.facts`, so a day's briefs are exactly the briefs the member would open one by one, under the same row security and through the CRM
// module's own queries). Nothing is stored, no model is called and nothing runs in the background: Vy's few sentences of a brief remain the member's own click on `meetings.brief.write`.
//
// The member reads only their own agenda: `calendar_agenda` rows are the member's own, and an owner, an admin, another member, an agent context and the system context read none of it.
import { zBriefEmpty, zBriefFacts, zMeetingsTodayFacts, type MeetingsTodayFacts } from '@crove/kernel-contract';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { todaysAgenda } from './agenda.ts';
import { briefFactsOf, stageNamesOnce } from './brief.ts';
import { ROLES, userOf } from './transcript.ts';

const MINUTE_MS = 60_000;
// The facts of at most this many events are read (each is several reads and a few CRM calls); a day with more shows the rest as events with nothing to say.
const BRIEFS_MAX = 20;
const NONE = zBriefFacts.parse({ previous: null, decisions: [], items: [], customer: null, deals: [], empty: true });

/**
 * The minutes of the day the events occupy: events that overlap (or touch) count once, so two meetings at the same hour are one hour, not two. (A plain sum of the lengths made the "in all" line of the Today
 * view read longer than the day the member has.) Pure; an event that ends before it starts counts nothing.
 */
export function occupiedMinutes(events: ReadonlyArray<{ startsAt: string; endsAt: string }>): number {
  const spans = events
    .map((e) => ({ from: Date.parse(e.startsAt), to: Date.parse(e.endsAt) }))
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to > s.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  let total = 0;
  let open: { from: number; to: number } | undefined;
  for (const span of spans) {
    if (open && span.from <= open.to) open.to = Math.max(open.to, span.to);
    else {
      if (open) total += Math.round((open.to - open.from) / MINUTE_MS);
      open = { ...span };
    }
  }
  if (open) total += Math.round((open.to - open.from) / MINUTE_MS);
  return total;
}

export const todayFacts = defineQuery({
  name: 'meetings.today.facts',
  input: zBriefEmpty,
  access: ROLES,
  sensitive: true,
  handler: async (ctx): Promise<MeetingsTodayFacts> => {
    const userId = userOf(ctx.actor);
    const agenda = await todaysAgenda(ctx.trx, ctx.orgId, userId);
    if (!agenda.enabled) return zMeetingsTodayFacts.parse({ enabled: false, totalMinutes: 0, items: [] });
    const items: MeetingsTodayFacts['items'] = [];
    // The CRM stage names are read once for the whole day, and only if some brief has a deal to name.
    const stageNames = stageNamesOnce(ctx);
    for (const [index, event] of agenda.events.entries()) {
      // A recorded event is briefed from its meeting (which the member may no longer read, or whose text is gone): no facts then, and never an error for the whole page.
      let brief = NONE;
      if (index >= BRIEFS_MAX) {
        items.push({ event, brief });
        continue;
      }
      try {
        brief = await briefFactsOf(ctx, event.meetingId !== null ? { meetingId: event.meetingId, agendaId: null } : { meetingId: null, agendaId: event.id }, stageNames);
      } catch (error) {
        if (!(error instanceof DomainError && (error.code === 'MEETING_NOT_FOUND' || error.code === 'AGENDA_NOT_FOUND'))) throw error;
      }
      items.push({ event, brief });
    }
    const totalMinutes = occupiedMinutes(agenda.events);
    return zMeetingsTodayFacts.parse({ enabled: true, totalMinutes, items });
  },
});

export const todayQueries = [todayFacts];
