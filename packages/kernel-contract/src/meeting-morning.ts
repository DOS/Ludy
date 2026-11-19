// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in morning notice of the day's meetings (#3955, part B). A member who turns it on gets, once a day at the time they chose in their own time zone, one in-app notice and one mail that say only how
// many meetings they have today and link to the meetings page. The notice and the mail hold no title, no name and no word of a brief, so no copy of any of them exists to erase; nothing runs Vy.
//
// This file holds the shapes both sides use: the member's setting, the kind, the sweep's dispatch and the mail's merge data. No model call, database or network access here.
import { z } from 'zod';

export const MORNING_KIND = 'meetings.morning';
export const MORNING_MAIL_TEMPLATE = 'meetings.morning';
export const MORNING_MAIL_SOURCE = 'meetings.morning';
export const MORNING_DEFAULT_MINUTE = 7 * 60;

// An IANA time-zone name the runtime knows ("Asia/Ho_Chi_Minh"): the member's browser gives it when they turn the notice on.
export const zTimeZoneName = z
  .string()
  .min(1)
  .max(64)
  .refine((name) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: name });
      return true;
    } catch {
      return false;
    }
  }, 'not a time zone');

export const zMorningSet = z.strictObject({
  enabled: z.boolean(),
  // Minutes after midnight in `timeZone`: 420 is 07:00.
  minute: z.number().int().min(0).max(1439).default(MORNING_DEFAULT_MINUTE),
  timeZone: zTimeZoneName.default('Asia/Ho_Chi_Minh'),
  language: z.enum(['vi', 'en']).default('vi'),
});
export type MorningSet = z.infer<typeof zMorningSet>;

// What the member's own setting says now (never another member's): `enabled` false has no other field of use.
export const zMorningState = z.strictObject({ enabled: z.boolean(), minute: z.number().int().min(0).max(1439), timeZone: zTimeZoneName, language: z.enum(['vi', 'en']) });
export type MorningState = z.infer<typeof zMorningState>;
export const zMorningEmpty = z.strictObject({});

// The sweep's dispatch: a member and the day (in their zone) it is for. The ids are not trusted: the command derives the row again through the worker-only definer.
export const zMorningNotice = z.strictObject({ userId: z.uuid(), day: z.iso.date() });
export type MorningNotice = z.infer<typeof zMorningNotice>;

// The mail's merge data: the org's name, the number of meetings, the app path of the meetings page and the language. No other key can be stored.
// The most meetings the mail names: a day with more is told as this many (a member with that many events in a day is not a case the count has to be exact for; the mail must still be written).
export const MORNING_COUNT_MAX = 1000;
export const zMorningMail = z.strictObject({
  lang: z.enum(['vi', 'en']),
  org: z.string().trim().min(1).max(200),
  count: z.number().int().min(1).max(MORNING_COUNT_MAX),
  path: z.string().regex(/^\/o\/[a-z0-9][a-z0-9-]{0,62}\/meetings$/),
});
export type MorningMail = z.infer<typeof zMorningMail>;
