// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in weekly notice of the week's meetings (#4967, Proposal 3 of the research on #932). A member who turns it on gets, each Monday at the time they chose in their own time zone, one in-app notice and one
// mail that say only how many meetings they read with something published in the last seven days, how many decisions were published, how many action items are still open and how many of those are overdue,
// and link to the "this week" card of the meetings page (meetings.digest.facts). The notice and the mail hold no title, no name and no word of a decision, so no copy of any of them exists to erase; the model
// is not called.
//
// This file holds the shapes both sides use: the member's setting, the kind, the sweep's dispatch and the mail's merge data. No model call, database or network access here.
import { z } from 'zod';
import { DIGEST_DECISIONS_MAX, DIGEST_ITEMS_MAX, DIGEST_MEETINGS_MAX } from './meeting-digest.ts';
import { zTimeZoneName } from './meeting-morning.ts';

export const WEEKLY_KIND = 'meetings.weekly';
export const WEEKLY_MAIL_TEMPLATE = 'meetings.weekly';
export const WEEKLY_MAIL_SOURCE = 'meetings.weekly';
export const WEEKLY_DEFAULT_MINUTE = 8 * 60;
// The most the tracked-word number says (#5019): the definer clamps there and the text says "at least" from it.
export const WEEKLY_TRACKED_MAX = 999;

export const zWeeklySet = z.strictObject({
  enabled: z.boolean(),
  // Minutes after midnight in `timeZone` on the Monday: 480 is 08:00.
  minute: z.number().int().min(0).max(1439).default(WEEKLY_DEFAULT_MINUTE),
  timeZone: zTimeZoneName.default('Asia/Ho_Chi_Minh'),
  language: z.enum(['vi', 'en']).default('vi'),
});
export type WeeklySet = z.infer<typeof zWeeklySet>;

// What the member's own setting says now (never another member's): `enabled` false has no other field of use.
export const zWeeklyState = z.strictObject({ enabled: z.boolean(), minute: z.number().int().min(0).max(1439), timeZone: zTimeZoneName, language: z.enum(['vi', 'en']) });
export type WeeklyState = z.infer<typeof zWeeklyState>;
export const zWeeklyEmpty = z.strictObject({});

// The sweep's dispatch: a member and the Monday (in their zone) it is for. The ids are not trusted: the command derives the row again through the worker-only definer.
// `at` is the instant the numbers are read at: the sweep leaves it out (the clock), the tests set it to a Monday.
export const zWeeklyNotice = z.strictObject({ userId: z.uuid(), day: z.iso.date(), at: z.iso.datetime().optional() });
export type WeeklyNotice = z.infer<typeof zWeeklyNotice>;

// The notice's own numbers and the mail's merge data. They are the card's: at most as many meetings, decisions and open items as the card lists (DIGEST_*_MAX), and `cut` says a limit held some back, so the
// text says "at least". The overdue count is part of the open one. `tracked` (#5019) is how often the org's tracked words came up in those meetings' published lines: absent when the org keeps none or none
// came up, a number and never a word, a line or a meeting. No other key can be stored.
export const zWeeklyCounts = z.strictObject({
  meetings: z.number().int().min(1).max(DIGEST_MEETINGS_MAX),
  decisions: z.number().int().min(0).max(DIGEST_DECISIONS_MAX),
  open: z.number().int().min(0).max(DIGEST_ITEMS_MAX),
  overdue: z.number().int().min(0).max(DIGEST_ITEMS_MAX),
  cut: z.boolean(),
  tracked: z.number().int().min(1).max(WEEKLY_TRACKED_MAX).optional(),
});
export type WeeklyCounts = z.infer<typeof zWeeklyCounts>;

// The path the notice and the mail open: the meetings page with the "this week" card open (the page reads ?tool=digest).
export const WEEKLY_LINK_QUERY = '?tool=digest';
export const zWeeklyMail = zWeeklyCounts.extend({
  lang: z.enum(['vi', 'en']),
  org: z.string().trim().min(1).max(200),
  path: z.string().regex(/^\/o\/[a-z0-9][a-z0-9-]{0,62}\/meetings\?tool=digest$/),
});
export type WeeklyMail = z.infer<typeof zWeeklyMail>;
