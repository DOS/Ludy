// SPDX-License-Identifier: AGPL-3.0-only
// Dy's brief before a booking linked to a deal (issue #3115, docs/plan/calendar.md "Deal links as built"): the facts of the meeting (the deal's stage, amount as a decimal string and expected close, its open
// next steps, the latest sent quote, the customer's latest words that the member may read), built by code, and, when the model is on and its words pass the checks, a short summary and 2 to 3 points to
// raise. Computed when it is read: nothing is stored or sent by it. When the model is off, spent, busy, failing or refused, `summary` is null and `points` is empty: the person reads the facts alone.
import { z } from 'zod';
import { DEAL_NEXT_STEP_REASONS, DEAL_STAGE_KINDS } from './crm-deals.ts';
import { zId } from './schemas.ts';

// used: Dy wrote the summary and the points. off, busy, budget, failed: the facts list stands alone (the model is off, the member asked too often, the AI budget is spent, the call failed or its words were refused by the checks).
export const MEETING_BRIEF_STATES = ['used', 'off', 'busy', 'budget', 'failed'] as const;
export type MeetingBriefState = (typeof MEETING_BRIEF_STATES)[number];

// A quote that was sent (a draft has no number and is never the brief's quote).
export const MEETING_BRIEF_QUOTE_STATUSES = ['sent', 'accepted', 'declined', 'superseded'] as const;

export const zMeetingBriefInput = z.strictObject({ bookingId: zId });
export type MeetingBriefInput = z.infer<typeof zMeetingBriefInput>;

export const zMeetingBrief = z.strictObject({
  ai: z.enum(MEETING_BRIEF_STATES),
  bookingId: zId,
  dealId: zId,
  meeting: z.strictObject({ title: z.string(), startsOn: z.string(), startsTime: z.string(), guestName: z.string().nullable() }),
  deal: z.strictObject({
    title: z.string(),
    stage: z.string(),
    status: z.enum(DEAL_STAGE_KINDS),
    // A decimal string; null for a deal with no amount yet.
    amount: z.string().nullable(),
    expectedClose: z.string().nullable(),
    contactName: z.string(),
  }),
  nextSteps: z.array(z.strictObject({ reason: z.enum(DEAL_NEXT_STEP_REASONS), sinceOn: z.string() })),
  quote: z.strictObject({ label: z.string(), total: z.string(), status: z.enum(MEETING_BRIEF_QUOTE_STATUSES), validUntil: z.string(), expired: z.boolean(), sentOn: z.string().nullable() }).nullable(),
  // The customer's latest words that this member may read, oldest first: none when they may not read the conversation.
  messages: z.array(z.string()),
  // Dy's words: null unless `ai` is 'used'.
  summary: z.string().nullable(),
  points: z.array(z.string()).max(3),
});
export type MeetingBrief = z.infer<typeof zMeetingBrief>;
