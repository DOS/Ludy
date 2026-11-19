// SPDX-License-Identifier: AGPL-3.0-only
// What each speaker of a meeting committed to or decided (#3954): the recorder's Vy lists, from the transcript, for each speaker the transcript has, up to five commitments or decisions, each with the second of the
// transcript line it rests on. The answer goes to the recorder's browser and is stored nowhere. The checks that decide what a line may be are code (packages/agent member-vy/meeting-commitments.ts); this file
// holds the shapes both sides share. There is no field for talk time, tone or any judgment of a person: a commitment or a decision is all an answer can say.
import { z } from 'zod';
import { CHAPTER_SECOND_MAX } from './meeting-chapters.ts';

export const COMMITMENT_SPEAKERS_MAX = 20;
export const COMMITMENT_LINES_MAX = 5;
export const COMMITMENT_TEXT_MIN = 3;
export const COMMITMENT_TEXT_MAX = 200;
// A speaker label is at most the transcript's own 80 characters.
export const COMMITMENT_LABEL_MAX = 80;
export const COMMITMENT_KINDS = ['commitment', 'decision'] as const;

export const COMMITMENT_STATES = ['listed', 'none', 'failed'] as const;
export const zCommitmentsAnswer = z.strictObject({
  state: z.enum(COMMITMENT_STATES),
  // The fixed code of a failure, a name and never the model's or the provider's words.
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  speakers: z
    .array(
      z.strictObject({
        // The speaker as the transcript spells it.
        label: z.string().min(1).max(COMMITMENT_LABEL_MAX),
        lines: z
          .array(
            z.strictObject({
              kind: z.enum(COMMITMENT_KINDS),
              text: z.string().min(COMMITMENT_TEXT_MIN).max(COMMITMENT_TEXT_MAX),
              // The whole start second of a transcript line this speaker says.
              seconds: z.number().int().min(0).max(CHAPTER_SECOND_MAX),
            }),
          )
          .min(1)
          .max(COMMITMENT_LINES_MAX),
      }),
    )
    .max(COMMITMENT_SPEAKERS_MAX),
  // How many proposed lines code removed (a count, never the text).
  dropped: z.number().int().min(0).max(1000),
});
export type CommitmentsAnswer = z.infer<typeof zCommitmentsAnswer>;
