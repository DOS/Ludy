// SPDX-License-Identifier: AGPL-3.0-only
// Sales call insights for a meeting linked to an open deal (L26, #4920, ADR-0049): on the recorder's click, their own Vy extracts customer concerns/objections, buying signals and agreed next steps
// with owners from the transcript, each citing at least one existing transcript line ID. Customer talk-time share is computed in code from mapped speaker labels. Results are tainted, returned to the
// recorder alone and stored nowhere (member_vy_result holds counts only); the deal is never mutated.
import { z } from 'zod';
import { CHAPTER_SECOND_MAX } from './meeting-chapters.ts';
import { zId } from './schemas.ts';

export const SALES_INSIGHT_ITEMS_MAX = 5;
export const SALES_INSIGHT_TEXT_MIN = 3;
export const SALES_INSIGHT_TEXT_MAX = 200;
export const SALES_INSIGHT_OWNER_MAX = 80;
export const SALES_INSIGHT_SPEAKER_LABEL_MAX = 120;
export const SALES_INSIGHT_CITATIONS_MAX = 5;

export const SALES_INSIGHT_STATES = ['ready', 'none', 'off', 'paused', 'budget', 'failed'] as const;
export const SALES_INSIGHT_STATUS_REASONS = ['off', 'forbidden', 'paused', 'budget', 'not_recorder', 'no_crm', 'no_deal', 'deal_closed', 'no_transcript', 'transcribe_running'] as const;

export const zSalesInsightCitation = z.strictObject({
  lineId: zId,
  seconds: z.number().int().min(0).max(CHAPTER_SECOND_MAX),
  speakerLabel: z.string().max(SALES_INSIGHT_SPEAKER_LABEL_MAX).optional(),
});
export type SalesInsightCitation = z.infer<typeof zSalesInsightCitation>;

export const zSalesInsightItem = z.strictObject({
  text: z.string().min(SALES_INSIGHT_TEXT_MIN).max(SALES_INSIGHT_TEXT_MAX),
  citations: z.array(zSalesInsightCitation).min(1).max(SALES_INSIGHT_CITATIONS_MAX),
});
export type SalesInsightItem = z.infer<typeof zSalesInsightItem>;

export const zSalesInsightNextStep = z.strictObject({
  text: z.string().min(SALES_INSIGHT_TEXT_MIN).max(SALES_INSIGHT_TEXT_MAX),
  owner: z.string().min(1).max(SALES_INSIGHT_OWNER_MAX).nullable(),
  citations: z.array(zSalesInsightCitation).min(1).max(SALES_INSIGHT_CITATIONS_MAX),
});
export type SalesInsightNextStep = z.infer<typeof zSalesInsightNextStep>;

export const zSalesInsightTalkShare = z.strictObject({
  customerPercent: z.number().int().min(0).max(100),
  internalPercent: z.number().int().min(0).max(100),
  customerSeconds: z.number().min(0).max(CHAPTER_SECOND_MAX * 4),
  totalSeconds: z.number().min(0).max(CHAPTER_SECOND_MAX * 4),
  customerSpeakers: z.array(z.string().max(SALES_INSIGHT_SPEAKER_LABEL_MAX)).max(20),
});
export type SalesInsightTalkShare = z.infer<typeof zSalesInsightTalkShare>;

export const zSalesInsightDeal = z.strictObject({
  id: zId,
  title: z.string(),
  stage: z.string(),
});
export type SalesInsightDeal = z.infer<typeof zSalesInsightDeal>;

export const zSalesInsightStatus = z.strictObject({
  meetingId: zId,
  available: z.boolean(),
  enabled: z.boolean(),
  reason: z.enum(SALES_INSIGHT_STATUS_REASONS).nullable(),
  deal: zSalesInsightDeal.nullable(),
});
export type SalesInsightStatus = z.infer<typeof zSalesInsightStatus>;

export const zSalesInsightAnswer = z.strictObject({
  state: z.enum(SALES_INSIGHT_STATES),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
  deal: zSalesInsightDeal.nullable(),
  customerTalkShare: zSalesInsightTalkShare.nullable(),
  concerns: z.array(zSalesInsightItem).max(SALES_INSIGHT_ITEMS_MAX),
  buyingSignals: z.array(zSalesInsightItem).max(SALES_INSIGHT_ITEMS_MAX),
  nextSteps: z.array(zSalesInsightNextStep).max(SALES_INSIGHT_ITEMS_MAX),
  dropped: z.number().int().min(0).max(1000),
});
export type SalesInsightAnswer = z.infer<typeof zSalesInsightAnswer>;
