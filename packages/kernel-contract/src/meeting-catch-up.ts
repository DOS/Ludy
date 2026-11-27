// SPDX-License-Identifier: AGPL-3.0-only
// Catch-up summary for a member who missed a meeting (L33, #5130, ADR-0049): published minutes and action items assigned to the reader
// (`yourItems`, built in code and shown even with AI off) plus Vy's cited catch-up lines ("Cập nhật nhanh cho tôi"). Lines are tainted,
// returned to the member alone and never persisted (member_vy_result stores counts only).
import { z } from 'zod';
import { zBriefStatus } from './meeting-brief.ts';
import { zId } from './schemas.ts';

export const CATCH_UP_LINES_MAX = 5;
export const CATCH_UP_LINE_MIN = 3;
export const CATCH_UP_LINE_MAX = 240;
export const CATCH_UP_YOUR_ITEMS_MAX = 25;
export const CATCH_UP_ESTIMATE = { inputTokens: 1_800, outputTokens: 350 } as const;

export const zCatchUpCitation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('decision'), index: z.number().int().min(1).max(200) }),
  z.strictObject({ kind: z.literal('item'), itemId: zId }),
]);
export type CatchUpCitation = z.infer<typeof zCatchUpCitation>;

export const zCatchUpLine = z.strictObject({
  text: z.string().min(CATCH_UP_LINE_MIN).max(CATCH_UP_LINE_MAX),
  cite: zCatchUpCitation,
});
export type CatchUpLine = z.infer<typeof zCatchUpLine>;

export const zCatchUpYourItem = z.strictObject({
  itemId: zId,
  title: z.string(),
  who: z.string(),
  when: z.string(),
  whenDate: z.string().nullable(),
  status: z.enum(['suggested', 'accepted']),
  taskId: zId.nullable(),
  matchedBy: z.enum(['user_id', 'name']),
});
export type CatchUpYourItem = z.infer<typeof zCatchUpYourItem>;

export const zCatchUpStatus = z.strictObject({
  meetingId: zId,
  available: z.boolean(),
  reason: z.enum(['off', 'is_recorder', 'not_published', 'redacted', 'forbidden', 'paused', 'budget']).nullable(),
  yourItems: z.array(zCatchUpYourItem).max(CATCH_UP_YOUR_ITEMS_MAX),
  estimate: zBriefStatus.shape.estimate,
});
export type CatchUpStatus = z.infer<typeof zCatchUpStatus>;

export const zCatchUpAnswer = z.strictObject({
  state: z.enum(['written', 'none', 'failed']),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
  lines: z.array(zCatchUpLine).max(CATCH_UP_LINES_MAX),
  dropped: z.number().int().min(0).max(1000),
});
export type CatchUpAnswer = z.infer<typeof zCatchUpAnswer>;

export const zCatchUpFacts = z.strictObject({
  meetingId: zId,
  language: z.enum(['vi', 'en']),
  askerName: z.string(),
  summary: z.string(),
  decisions: z.array(z.string()),
  items: z.array(
    z.strictObject({
      id: zId,
      title: z.string(),
      who: z.string(),
      when: z.string(),
      isYours: z.boolean(),
    }),
  ),
});
export type CatchUpFacts = z.infer<typeof zCatchUpFacts>;

export const zCatchUpStarted = z.strictObject({
  meetingId: zId,
  runId: zId,
});
