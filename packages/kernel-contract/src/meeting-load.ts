// SPDX-License-Identifier: AGPL-3.0-only
// How much of a week goes to meetings, and which recurring meetings may be worth trimming (#4770, plan docs/plan/meetings.md L16), for an owner or an admin. Worked out by code from the meetings the caller
// reads (the same row security as every member: an owner or an admin has no extra right to read a meeting), so a meeting the caller is no reader of is not counted. No meeting text, no model call and nothing stored.
//
// This file holds the shapes and the thresholds both sides use. No database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The week asked for is this one (0) or up to this many weeks back.
export const LOAD_WEEKS_BACK_MAX = 12;
// A recurring series is looked at over this many weeks up to now, and only with at least this many meetings in them.
export const LOAD_SERIES_WEEKS = 8;
export const LOAD_SERIES_MIN_MEETINGS = 3;
// At most this many series are listed (the ones with most signals first); the answer says when it cut.
export const LOAD_SERIES_MAX = 20;
// "Open items piling up" means each of the last two meetings of a series still has at least this many open published items.
export const LOAD_ITEMS_PILING = 3;

// Why a series may be worth trimming. `few_people`: in at least half of its meetings nobody but the recorder is in the meeting (an attendees-only meeting with no reader added; an org-wide meeting is read by everyone, so who attended is unknown and it never counts). `no_minutes`: fewer than half of its meetings have published
// minutes (a published summary, decision or action item). `items_piling`: open published items stay open meeting after meeting.
export const LOAD_SIGNALS = ['few_people', 'no_minutes', 'items_piling'] as const;
export type LoadSignal = (typeof LOAD_SIGNALS)[number];

export const zLoadWeekInput = z.strictObject({ weeksBack: z.number().int().min(0).max(LOAD_WEEKS_BACK_MAX).default(0) });
export type LoadWeekInput = z.infer<typeof zLoadWeekInput>;

// One member's week: the meetings they were in (as the recorder, or a reader the recorder added) and the minutes those meetings took, an overlap counted once.
export const zLoadMember = z.strictObject({
  userId: zId,
  meetings: z.number().int().min(1),
  minutes: z.number().int().min(0),
});
export type LoadMember = z.infer<typeof zLoadMember>;

// A recurring series with at least one signal: its latest meeting (the title and link a reader of it already has) and the figures the signals rest on.
export const zLoadSeries = z.strictObject({
  seriesId: zId,
  latestMeetingId: zId,
  title: z.string(),
  // The meetings of the series in the last LOAD_SERIES_WEEKS weeks the caller reads.
  meetings: z.number().int().min(LOAD_SERIES_MIN_MEETINGS),
  // The average length of those that have one, in minutes.
  averageMinutes: z.number().int().min(0),
  // How many of them had nobody but the recorder, and how many have published minutes.
  soloMeetings: z.number().int().min(0),
  withMinutes: z.number().int().min(0),
  // The open published items of the last two meetings, latest first.
  openItems: z.array(z.number().int().min(0)).length(2),
  signals: z.array(z.enum(LOAD_SIGNALS)).min(1).max(LOAD_SIGNALS.length),
});
export type LoadSeries = z.infer<typeof zLoadSeries>;

export const zLoadWeek = z.strictObject({
  weeksBack: z.number().int().min(0).max(LOAD_WEEKS_BACK_MAX),
  // The Monday and the Sunday of the week, as Vietnam calendar days (YYYY-MM-DD).
  weekStart: z.string(),
  weekEnd: z.string(),
  // The meetings of the week the caller reads that have a length, and the minutes of all the people in them added up.
  meetings: z.number().int().min(0),
  personMinutes: z.number().int().min(0),
  // Most minutes first.
  members: z.array(zLoadMember),
  series: z.array(zLoadSeries).max(LOAD_SERIES_MAX),
  seriesCut: z.boolean(),
});
export type LoadWeek = z.infer<typeof zLoadWeek>;
