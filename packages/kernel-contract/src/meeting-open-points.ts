// SPDX-License-Identifier: AGPL-3.0-only
// What a meeting left open (#4768): the recorder's Vy lists, from the transcript, the questions that were asked and not answered and the topics where a decision was raised and not taken, each with the second
// of the transcript line it rests on. The answer goes to the recorder's browser and is stored nowhere (the run's result row holds counts only); the recorder may append lines to their own notes, which go with
// the meeting. The checks that decide what a line may be are code (packages/agent member-vy/meeting-open-points.ts); this file holds the shapes both sides share. There is no field for a person, tone or judgment:
// an open question or an open decision is all an answer can say.
import { z } from 'zod';
import { CHAPTER_SECOND_MAX } from './meeting-chapters.ts';

export const OPEN_POINTS_PER_KIND_MAX = 5;
export const OPEN_POINT_TEXT_MIN = 3;
export const OPEN_POINT_TEXT_MAX = 200;
export const OPEN_POINT_KINDS = ['question', 'decision'] as const;

export const OPEN_POINTS_STATES = ['listed', 'none', 'failed'] as const;
const zOpenPoint = z.strictObject({
  text: z.string().min(OPEN_POINT_TEXT_MIN).max(OPEN_POINT_TEXT_MAX),
  // The whole start second of a transcript line the point rests on.
  seconds: z.number().int().min(0).max(CHAPTER_SECOND_MAX),
});
export const zOpenPointsAnswer = z.strictObject({
  state: z.enum(OPEN_POINTS_STATES),
  // The fixed code of a failure, a name and never the model's or the provider's words.
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
  // Questions asked and not answered in the meeting, in order of time.
  questions: z.array(zOpenPoint).max(OPEN_POINTS_PER_KIND_MAX),
  // Topics where a decision was raised and not taken, in order of time.
  decisions: z.array(zOpenPoint).max(OPEN_POINTS_PER_KIND_MAX),
  // How many proposed lines code removed (a count, never the text).
  dropped: z.number().int().min(0).max(1000),
});
export type OpenPointsAnswer = z.infer<typeof zOpenPointsAnswer>;
export type OpenPoint = z.infer<typeof zOpenPoint>;
