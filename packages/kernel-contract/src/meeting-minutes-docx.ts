// SPDX-License-Identifier: AGPL-3.0-only
// The published biên bản as a Word file (#4774, plan docs/plan/meetings.md L17): the same minutes the printable page shows, laid out per the meeting's template, built on the server from the PUBLISHED rows only
// (the published result and the published action items, never a draft, a transcript or a model's output) and read under the caller's own row security. The file comes back inside the answer, as base64 (a
// minutes file is a few tens of KB), so no download route is needed. This file holds the shapes and the limits both sides use; no database or network access here.
import { z } from 'zod';
import { MEETING_PLACE_MAX } from './meeting-place.ts';
import { zMeetingLanguage } from './meetings.ts';
import { zId } from './schemas.ts';

export const MINUTES_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// The place typed on the page, as long as the page lets it be (the place's own bound, counted in code points, #5043); it is not stored.
export const MINUTES_DOCX_PLACE_MAX = MEETING_PLACE_MAX;
// A file name is cut to this many characters before the extension.
export const MINUTES_DOCX_NAME_MAX = 120;

export const zMinutesDocxInput = z.strictObject({
  meetingId: zId,
  place: z
    .string()
    .max(MINUTES_DOCX_PLACE_MAX * 2)
    .refine((text) => [...text].length <= MINUTES_DOCX_PLACE_MAX)
    .default(''),
  language: zMeetingLanguage.optional(),
});
export type MinutesDocxInput = z.infer<typeof zMinutesDocxInput>;

export const zMinutesDocx = z.strictObject({
  filename: z.string().min(1).max(MINUTES_DOCX_NAME_MAX + 8),
  mimeType: z.literal(MINUTES_DOCX_MIME),
  bytes: z.number().int().min(1),
  contentBase64: z.string().min(1),
});
export type MinutesDocx = z.infer<typeof zMinutesDocx>;
