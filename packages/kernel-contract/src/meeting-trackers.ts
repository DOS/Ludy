// SPDX-License-Identifier: AGPL-3.0-only
// Keyword trackers across meetings (#4818, plan docs/plan/meetings.md L22): an owner or admin keeps up to 20 keywords or phrases (competitor names, "giá", "hợp đồng"); each meeting shows how often
// each one came up and where, and a weekly view lists the hits. The hits are counted by code, in the viewer's own transaction, from the lines that viewer may read (a reader the published lines, the
// recorder the draft too), so no meeting text leaves its reader rule, and nothing about a hit is stored. No model call.
//
// This file holds the shapes and the limits both sides use. No database or network access here. A term is judged by the glossary's rules (the same shape: at most 40 characters, a letter, no address).
import { z } from 'zod';
import { zGlossaryTerm } from './meeting-glossary.ts';
import { zId } from './schemas.ts';

// Terms one organization tracks.
export const TRACKER_TERMS_MAX = 20;
// The seconds listed for one term in one meeting (the count says how many there were in all).
export const TRACKER_SECONDS_MAX = 20;
// A week looks at this many meetings at most (the ones that started first), and lists this many meetings under a term.
export const TRACKER_WEEK_MEETINGS_MAX = 60;
export const TRACKER_WEEK_LISTED_MAX = 10;
// How many weeks back the weekly view may go.
export const TRACKER_WEEKS_BACK_MAX = 12;

export const zTrackerList = z.strictObject({});
export const zTrackerAdd = z.strictObject({ term: zGlossaryTerm });
export const zTrackerRemove = z.strictObject({ termId: zId });
export const zTrackerDone = z.strictObject({ termId: zId });
export type TrackerDone = z.infer<typeof zTrackerDone>;

export const zTrackerTermView = z.strictObject({ id: zId, term: z.string() });
export const zTrackerTerms = z.strictObject({ terms: z.array(zTrackerTermView).max(TRACKER_TERMS_MAX) });
export type TrackerTerms = z.infer<typeof zTrackerTerms>;

// What one meeting says for the caller: how many terms the org tracks, and for each term that came up its count and the whole seconds of the lines (in the order of the transcript, at most
// TRACKER_SECONDS_MAX; `more` when there were more lines than that).
export const zTrackerMeetingInput = z.strictObject({ meetingId: zId });
export const zTrackerHit = z.strictObject({
  id: zId,
  term: z.string(),
  count: z.number().int().min(1),
  seconds: z.array(z.number().int().min(0)).max(TRACKER_SECONDS_MAX),
  more: z.boolean(),
});
export const zTrackerHits = z.strictObject({ meetingId: zId, tracked: z.number().int().min(0).max(TRACKER_TERMS_MAX), hits: z.array(zTrackerHit).max(TRACKER_TERMS_MAX) });
export type TrackerHits = z.infer<typeof zTrackerHits>;

// A week: for each term that came up in the meetings the caller reads, the count and the meetings it came up in (the most first, at most TRACKER_WEEK_LISTED_MAX).
export const zTrackerWeekInput = z.strictObject({ weeksBack: z.number().int().min(0).max(TRACKER_WEEKS_BACK_MAX).default(0) });
export const zTrackerWeekMeeting = z.strictObject({ meetingId: zId, title: z.string(), count: z.number().int().min(1) });
export const zTrackerWeekTerm = z.strictObject({
  id: zId,
  term: z.string(),
  count: z.number().int().min(1),
  meetings: z.array(zTrackerWeekMeeting).max(TRACKER_WEEK_LISTED_MAX),
  moreMeetings: z.number().int().min(0),
});
export const zTrackerWeek = z.strictObject({
  weekStart: z.string(),
  weekEnd: z.string(),
  tracked: z.number().int().min(0).max(TRACKER_TERMS_MAX),
  // The meetings of the week the caller reads and whose lines were counted.
  meetings: z.number().int().min(0),
  // True when the week had more meetings than were counted.
  cut: z.boolean(),
  terms: z.array(zTrackerWeekTerm).max(TRACKER_TERMS_MAX),
});
export type TrackerWeek = z.infer<typeof zTrackerWeek>;
