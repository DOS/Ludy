// SPDX-License-Identifier: AGPL-3.0-only
// The Today view of the meetings page (#3955): the member's own agenda for today (Vietnam time, from the calendar they let Ludy read), the total time of those events, and for each event the facts of its brief
// (what was decided at the previous meeting of its series, what is still open, the linked customer's open deals), read by code as the member in one call. They work with AI off. Vy's few sentences of a brief stay
// the existing click (`meetings.brief.write`): nothing here runs a model.
//
// This file holds the shapes both sides use. No model call, database or network access here.
import { z } from 'zod';
import { AGENDA_LIST_MAX, zAgendaEvent } from './meeting-agenda.ts';
import { zBriefFacts } from './meeting-brief.ts';

// One event of today with the facts of its brief (`empty` when the event has no series, no last decision and no linked customer).
export const zMeetingsTodayItem = z.strictObject({ event: zAgendaEvent, brief: zBriefFacts });
export type MeetingsTodayItem = z.infer<typeof zMeetingsTodayItem>;

// `enabled` is false when no calendar of the member reads events (the page then says how to turn it on). `totalMinutes` is the time the events occupy: events that overlap or touch count once (#4086).
export const zMeetingsTodayFacts = z.strictObject({
  enabled: z.boolean(),
  totalMinutes: z.number().int().min(0),
  items: z.array(zMeetingsTodayItem).max(AGENDA_LIST_MAX),
});
export type MeetingsTodayFacts = z.infer<typeof zMeetingsTodayFacts>;
