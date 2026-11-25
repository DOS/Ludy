// SPDX-License-Identifier: AGPL-3.0-only
// The second-language version of a meeting's published minutes (Meetings, #4777). A member's translation of the summary is private to them (E1, #3184); this is the recorder's own
// reviewed text of it, published beside the original by their click, which every reader of the meeting reads (a language switch on the published minutes, and the text a mail or a
// document for a partner can use). The segments are the translation run's: 'summary', 'decision:<n>' and 'item:<id>' of the published original. The original stays the record.
import { z } from 'zod';
import { TRANSLATION_SEGMENTS_MAX, TRANSLATION_SEGMENT_TEXT_MAX, zMeetingLanguage, zTranslationHash, zTranslationKey, zTranslationTarget } from './meetings.ts';
import { zId } from './schemas.ts';

export const zMinutesVersionSegment = z.strictObject({ key: zTranslationKey, text: z.string().trim().min(1).max(TRANSLATION_SEGMENT_TEXT_MAX) });
export type MinutesVersionSegment = z.infer<typeof zMinutesVersionSegment>;

// The recorder's click: the language, the hash of the published original they reviewed it against (a changed original is refused as stale), the run of their Vy it began from when it
// did (an id for the audit trail; the text is never read from it here) and the text they approved, per segment of the original.
export const zMinutesVersionPublish = z.strictObject({
  meetingId: zId,
  language: zTranslationTarget,
  hash: zTranslationHash,
  runId: zId.optional(),
  segments: z.array(zMinutesVersionSegment).min(1).max(TRANSLATION_SEGMENTS_MAX),
});
export const zMinutesVersionPublished = z.strictObject({ meetingId: zId, language: zTranslationTarget, segments: z.number().int().min(1) });
export const zMinutesVersionUnpublish = z.strictObject({ meetingId: zId, language: zTranslationTarget });
export const zMinutesVersionUnpublished = z.strictObject({ meetingId: zId, language: zTranslationTarget, removed: z.boolean() });
export const zMinutesVersionRef = z.strictObject({ meetingId: zId });

// What a reader reads: each published version of the meeting, with the language of the original it is beside.
export const zMinutesVersion = z.strictObject({
  language: zTranslationTarget,
  publishedAt: z.string(),
  segments: z.array(zMinutesVersionSegment).min(1).max(TRANSLATION_SEGMENTS_MAX),
});
export type MinutesVersion = z.infer<typeof zMinutesVersion>;
export const zMinutesVersions = z.strictObject({ meetingId: zId, from: zMeetingLanguage, versions: z.array(zMinutesVersion).max(5) });
export type MinutesVersions = z.infer<typeof zMinutesVersions>;
