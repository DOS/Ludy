// SPDX-License-Identifier: AGPL-3.0-only
// The Today view of the meetings page, the module's side (#3955). One read for the whole page: the member's own agenda for today (the same events and rules as `meetings.agenda.list`), the total time of the events
// and, for each event, the facts of its brief (the same read as `meetings.brief.facts`, so a day's briefs are exactly the briefs the member would open one by one, under the same row security and through the CRM
// module's own queries). Nothing is stored, no model is called and nothing runs in the background: Vy's few sentences of a brief remain the member's own click on `meetings.brief.write`.
//
// The member reads only their own agenda: `calendar_agenda` rows are the member's own, and an owner, an admin, another member, an agent context and the system context read none of it.
import { zBriefEmpty, zBriefFacts, zMeetingsTodayFacts, type MeetingsTodayFacts } from '@crove/kernel-contract';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { todaysAgenda } from './agenda.ts';
import { briefFactsOf } from './brief.ts';
import { ROLES, userOf } from './transcript.ts';

const MINUTE_MS = 60_000;
const NONE = zBriefFacts.parse({ previous: null, decisions: [], items: [], customer: null, deals: [], empty: true });

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
    for (const event of agenda.events) {
      // A recorded event is briefed from its meeting (which the member may no longer read, or whose text is gone): no facts then, and never an error for the whole page.
      let brief = NONE;
      try {
        brief = await briefFactsOf(ctx, event.meetingId !== null ? { meetingId: event.meetingId, agendaId: null } : { meetingId: null, agendaId: event.id });
      } catch (error) {
        if (!(error instanceof DomainError && (error.code === 'MEETING_NOT_FOUND' || error.code === 'AGENDA_NOT_FOUND'))) throw error;
      }
      items.push({ event, brief });
    }
    const totalMinutes = agenda.events.reduce((sum, e) => sum + Math.max(0, Math.round((Date.parse(e.endsAt) - Date.parse(e.startsAt)) / MINUTE_MS)), 0);
    return zMeetingsTodayFacts.parse({ enabled: true, totalMinutes, items });
  },
});

export const todayQueries = [todayFacts];
