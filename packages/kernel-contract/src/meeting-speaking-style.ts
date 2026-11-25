// SPDX-License-Identifier: AGPL-3.0-only
// How each speaker spoke in a meeting (#4919, plan docs/plan/meetings.md): speaking pace, filler words and the longest stretch without a pause, per speaker label, counted by code from the transcript lines the
// caller reads (the recorder's draft while one exists, every other reader the published lines: the transcript page's reader rule, as the talk-time card). The answer is numbers and words of a fixed list
// only, never a transcript line. No model, no stored figure. This file holds the shapes both sides use; no database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';

// How many speakers one answer lists (most talk first); a meeting has a handful, the cap only bounds a pathological transcript.
export const SPEAKING_STYLE_SPEAKERS_MAX = 100;
// How many filler words are named for one speaker.
export const SPEAKING_STYLE_TOP = 3;

export const zSpeakingStyleInput = z.strictObject({ meetingId: zId });
export type SpeakingStyleInput = z.infer<typeof zSpeakingStyleInput>;

export const zFillerCount = z.strictObject({ word: z.string().min(1).max(40), count: z.number().int().min(1) });

export const zSpeakerStyle = z.strictObject({
  speaker: z.string().max(200),
  // Seconds this speaker talked (overlapping lines counted once) and the words they said in them.
  seconds: z.number().min(0),
  words: z.number().int().min(0),
  // Words per minute of talk time, whole; null while the speaker talked too little for a pace to mean anything.
  wordsPerMinute: z.number().int().min(0).nullable(),
  // The words of the fixed filler list among their words, the share of all their words they make (0 to 1), and the three most used.
  fillerWords: z.number().int().min(0),
  fillerShare: z.number().min(0).max(1),
  fillerTop: z.array(zFillerCount).max(SPEAKING_STYLE_TOP),
  // The longest run of this speaker's consecutive lines with no pause between them, from the start of its first line to the end of its last, in seconds.
  longestStretchSeconds: z.number().min(0),
});
export type SpeakerStyle = z.infer<typeof zSpeakerStyle>;

export const zSpeakingStyle = z.strictObject({
  meetingId: zId,
  // Which lines the figures rest on: the recorder's draft while one exists, else the published lines. Empty speakers: no line has text and a length.
  stage: z.enum(['draft', 'published']),
  speakers: z.array(zSpeakerStyle).max(SPEAKING_STYLE_SPEAKERS_MAX),
});
export type SpeakingStyle = z.infer<typeof zSpeakingStyle>;
