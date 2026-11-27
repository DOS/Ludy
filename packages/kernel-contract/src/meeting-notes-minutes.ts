// SPDX-License-Identifier: AGPL-3.0-only
// Schemas for drafting structured minutes from the recorder's typed notes when a meeting has no audio recording (#5129, L32).
import { z } from 'zod';
import { zBriefStatus } from './meeting-brief.ts';
import {
  ITEM_TEXT_MAX,
  ITEM_TITLE_MAX,
  NOTES_BODY_MAX,
  RESULT_DECISION_MAX,
  zId,
  zMeetingLanguage,
} from './meetings.ts';

export const NOTES_MINUTES_LINES_MAX = NOTES_BODY_MAX;
export const NOTES_MINUTES_SUMMARY_MAX = 1200;
export const NOTES_MINUTES_DECISIONS_MAX = 20;
export const NOTES_MINUTES_ITEMS_MAX = 20;

// Rough projected cost of one draft-minutes-from-notes call (used to show cost to the recorder before they click and for budget admission).
export const NOTES_MINUTES_ESTIMATE = { inputTokens: 1_800, outputTokens: 600 } as const;

export const zNotesMinutesReason = z.enum([
  'not_recorder',
  'has_transcript',
  'no_notes',
  'redacted',
  'off',
  'forbidden',
  'paused',
  'budget',
]);
export type NotesMinutesReason = z.infer<typeof zNotesMinutesReason>;

export const zNotesMinutesStatus = z.strictObject({
  meetingId: zId,
  available: z.boolean(),
  reason: zNotesMinutesReason.nullable(),
  estimate: zBriefStatus.shape.estimate,
});
export type NotesMinutesStatus = z.infer<typeof zNotesMinutesStatus>;

export const zNotesMinutesDecision = z.strictObject({
  text: z.string().min(1).max(RESULT_DECISION_MAX),
  noteLine: z.number().int().min(1).max(NOTES_MINUTES_LINES_MAX),
});
export type NotesMinutesDecision = z.infer<typeof zNotesMinutesDecision>;

export const zNotesMinutesItem = z.strictObject({
  title: z.string().min(1).max(ITEM_TITLE_MAX),
  who: z.string().max(ITEM_TEXT_MAX),
  when: z.string().max(ITEM_TEXT_MAX),
  noteLine: z.number().int().min(1).max(NOTES_MINUTES_LINES_MAX),
});
export type NotesMinutesItem = z.infer<typeof zNotesMinutesItem>;

export const zNotesMinutesAnswer = z.strictObject({
  state: z.enum(['drafted', 'none', 'failed']),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  summary: z.string().max(NOTES_MINUTES_SUMMARY_MAX),
  decisions: z.array(zNotesMinutesDecision).max(NOTES_MINUTES_DECISIONS_MAX),
  items: z.array(zNotesMinutesItem).max(NOTES_MINUTES_ITEMS_MAX),
  dropped: z.number().int().min(0).max(1000),
});
export type NotesMinutesAnswer = z.infer<typeof zNotesMinutesAnswer>;

export const zNotesMinutesFacts = z.strictObject({
  meetingId: zId,
  language: zMeetingLanguage,
  noteLines: z.array(z.string().min(1).max(NOTES_BODY_MAX)).min(1).max(NOTES_MINUTES_LINES_MAX),
  attendees: z.array(z.string().min(1).max(ITEM_TEXT_MAX)).max(100),
  glossary: z.array(z.string().min(1).max(120)).max(200),
});
export type NotesMinutesFacts = z.infer<typeof zNotesMinutesFacts>;

export const zNotesMinutesStarted = z.strictObject({
  meetingId: zId,
  runId: zId,
});
export type NotesMinutesStarted = z.infer<typeof zNotesMinutesStarted>;
