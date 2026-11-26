// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in morning notice and daily briefing of the day's meetings (#3955 part B, #5080). A member who turns it on gets, once a day at the time they chose in their own time zone, one in-app
// notice and one mail. Existing count-only opt-ins keep `content: 'count'` until the member chooses `content: 'full'`. Stored mail payloads hold only non-sensitive metadata (never meeting titles,
// attendee names, decisions, items, CRM deals, or Vy lines); full briefing content is fetched at render time in the member-scoped read-only `member_briefing` context.
//
// This file holds the shapes both sides use: the member's setting, the kind, the sweep's dispatch, the stored mail payload, and the strict render-time briefing content caps and schemas.
// No model call, database or network access here.
import { z } from 'zod';
import { zDealAmount } from './crm-deals.ts';
import { zId } from './schemas.ts';

export const MORNING_KIND = 'meetings.morning';
export const MORNING_MAIL_TEMPLATE = 'meetings.morning';
export const MORNING_MAIL_SOURCE = 'meetings.morning';
export const MORNING_MAIL_CONTENT_COMMAND = 'meetings.morning.mail_content';
export const MORNING_DEFAULT_MINUTE = 7 * 60;

export const MORNING_CONTENT_MODES = ['count', 'full'] as const;
export type MorningContentMode = (typeof MORNING_CONTENT_MODES)[number];
export const zMorningContentMode = z.enum(MORNING_CONTENT_MODES);

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

export const zMorningSet = z
  .strictObject({
    enabled: z.boolean(),
    // Minutes after midnight in `timeZone`: 420 is 07:00.
    minute: z.number().int().min(0).max(1439).default(MORNING_DEFAULT_MINUTE),
    timeZone: zTimeZoneName.default('Asia/Ho_Chi_Minh'),
    language: z.enum(['vi', 'en']).default('vi'),
    // Consent mode (#5080): existing opt-ins stay count-only until the member explicitly switches to full content.
    content: zMorningContentMode.default('count'),
    // Separate opt-in switch for Vy's daily prep lines (#5080 O3, #5073): off by default.
    vyLines: z.boolean().default(false),
  })
  .refine((v) => !v.enabled || !v.vyLines || v.content === 'full', {
    message: 'vyLines requires content=full when enabled',
    path: ['vyLines'],
  });
export type MorningSet = z.infer<typeof zMorningSet>;

// What the member's own setting says now (never another member's): `enabled` false has no other field of use.
// `content` and `vyLines` remain optional until the database columns and settings UI are wired.
export const zMorningState = z.strictObject({
  enabled: z.boolean(),
  minute: z.number().int().min(0).max(1439),
  timeZone: zTimeZoneName,
  language: z.enum(['vi', 'en']),
  content: zMorningContentMode.optional(),
  vyLines: z.boolean().optional(),
});
export type MorningState = z.infer<typeof zMorningState>;
export const zMorningEmpty = z.strictObject({});

// The sweep's dispatch: a member and the day (in their zone) it is for. The ids are not trusted: the command derives the row again through the worker-only definer.
export const zMorningNotice = z.strictObject({ userId: z.uuid(), day: z.iso.date() });
export type MorningNotice = z.infer<typeof zMorningNotice>;

// The mail's stored merge data (`mail_message.payload`): non-sensitive render metadata only.
// Disjoint union between v1 count-only payloads (`{ lang, org, count, path }`) and v2 full briefing render-time payloads
// per ADR-0049 amendment #5108 (`{ lang, org, path, day }`), keeping each variant strictly to its 4 fields.
// Strict objects: meeting titles, attendee names, decisions, items, CRM deals, and Vy lines must never be stored here.
// The most meetings the mail names: a day with more is told as this many (a member with that many events in a day is not a case the count has to be exact for; the mail must still be written).
export const MORNING_COUNT_MAX = 1000;
const zMorningMailPath = z.string().regex(/^\/o\/[a-z0-9][a-z0-9-]{0,62}\/meetings$/);

export const zMorningCountMail = z.strictObject({
  lang: z.enum(['vi', 'en']),
  org: z.string().trim().min(1).max(200),
  count: z.number().int().min(1).max(MORNING_COUNT_MAX),
  path: zMorningMailPath,
});
export type MorningCountMail = z.infer<typeof zMorningCountMail>;

export const zMorningBriefingMail = z.strictObject({
  lang: z.enum(['vi', 'en']),
  org: z.string().trim().min(1).max(200),
  path: zMorningMailPath,
  day: z.iso.date(),
});
export type MorningBriefingMail = z.infer<typeof zMorningBriefingMail>;

export const zMorningMail = z.union([zMorningCountMail, zMorningBriefingMail]);
export type MorningMail = z.infer<typeof zMorningMail>;

// Strict render-time caps for the full daily briefing email (#5080, ADR-0049 amendment #5108).
const BRIEFING_SLUG_PART = '[a-z0-9][a-z0-9-]{0,62}';
const BRIEFING_UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const MORNING_BRIEFING_CAPS = {
  meetingsMax: 12,
  titleMax: 120,
  nameMax: 80,
  orgNamesMax: 8,
  decisionTextMax: 240,
  decisionsPerMeetingMax: 5,
  actionItemTextMax: 240,
  actionItemsPerMeetingMax: 8,
  dealTitleMax: 120,
  dealStageMax: 80,
  dealsPerMeetingMax: 3,
  vyLineTextMax: 240,
  vyLinesPerMeetingMax: 3,
  vyMeetingsMax: 5,
  pathRegex: new RegExp(`^/o/${BRIEFING_SLUG_PART}/(?:meetings(?:/(?:${BRIEFING_UUID_PART}|record))?|deals|settings/notifications)$`),
} as const;

function codePointLengthInRange(value: string, min: number, max: number): boolean {
  let count = 0;
  for (let i = 0; i < value.length; ) {
    const cp = value.codePointAt(i) ?? 0;
    i += cp > 0xffff ? 2 : 1;
    count += 1;
    if (count > max) return false;
  }
  return count >= min;
}

const zBoundedText = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .max(max * 4)
    .refine((value) => codePointLengthInRange(value, min, max), `must be ${min} to ${max} characters`);

export const zMorningBriefingOpenItem = z.strictObject({
  text: zBoundedText(MORNING_BRIEFING_CAPS.actionItemTextMax, 1),
  dueOn: z.iso.date().nullable().optional(),
  overdue: z.boolean().default(false),
  mine: z.boolean().default(false),
});
export type MorningBriefingOpenItem = z.infer<typeof zMorningBriefingOpenItem>;

export const zMorningBriefingDeal = z.strictObject({
  id: zId,
  title: zBoundedText(MORNING_BRIEFING_CAPS.dealTitleMax, 1),
  stage: zBoundedText(MORNING_BRIEFING_CAPS.dealStageMax, 0),
  stageKind: z.literal('open').optional(),
  // Decimal string only, never a JS number.
  amount: zDealAmount.nullable().optional(),
  expectedClose: z.iso.date().nullable().optional(),
});
export type MorningBriefingDeal = z.infer<typeof zMorningBriefingDeal>;

export const zMorningBriefingMeeting = z.strictObject({
  id: zId,
  path: z.string().regex(MORNING_BRIEFING_CAPS.pathRegex).optional(),
  title: zBoundedText(MORNING_BRIEFING_CAPS.titleMax, 0),
  startAt: z.iso.datetime({ offset: true }).max(64),
  endAt: z.iso.datetime({ offset: true }).max(64),
  timeZone: zTimeZoneName,
  // External/calendar invitee count only (O2: no external invitee names stored).
  inviteeCount: z.number().int().min(0).max(MORNING_COUNT_MAX),
  // Org members who can read the recorded meeting (O2), capped at orgNamesMax.
  readerNames: z.array(zBoundedText(MORNING_BRIEFING_CAPS.nameMax, 1)).max(MORNING_BRIEFING_CAPS.orgNamesMax).default([]),
  extraReadersCount: z.number().int().min(0).max(MORNING_COUNT_MAX).default(0),
  // Published decisions from the previous meeting in the series.
  previousDecisions: z.array(zBoundedText(MORNING_BRIEFING_CAPS.decisionTextMax, 1)).max(MORNING_BRIEFING_CAPS.decisionsPerMeetingMax).default([]),
  openItems: z.array(zMorningBriefingOpenItem).max(MORNING_BRIEFING_CAPS.actionItemsPerMeetingMax).default([]),
  // Related open CRM deals (O5).
  deals: z.array(zMorningBriefingDeal).max(MORNING_BRIEFING_CAPS.dealsPerMeetingMax).default([]),
  // Checked Vy prep lines (O3): omitted or empty when AI is off or lines are not ready.
  vyLines: z.array(zBoundedText(MORNING_BRIEFING_CAPS.vyLineTextMax, 1)).max(MORNING_BRIEFING_CAPS.vyLinesPerMeetingMax).optional(),
});
export type MorningBriefingMeeting = z.infer<typeof zMorningBriefingMeeting>;

export const zMorningBriefingContent = z
  .strictObject({
    day: z.iso.date(),
    totalMeetings: z.number().int().min(0).max(MORNING_COUNT_MAX),
    meetings: z.array(zMorningBriefingMeeting).max(MORNING_BRIEFING_CAPS.meetingsMax),
  })
  .refine((value) => value.totalMeetings >= value.meetings.length, {
    message: 'totalMeetings must be at least meetings.length',
    path: ['totalMeetings'],
  })
  .refine(
    (value) => value.meetings.filter((meeting) => (meeting.vyLines?.length ?? 0) > 0).length <= MORNING_BRIEFING_CAPS.vyMeetingsMax,
    {
      message: `at most ${MORNING_BRIEFING_CAPS.vyMeetingsMax} meetings may carry vyLines`,
      path: ['meetings'],
    },
  );
export type MorningBriefingContent = z.infer<typeof zMorningBriefingContent>;
