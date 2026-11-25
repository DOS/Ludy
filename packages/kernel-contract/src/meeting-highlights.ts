// SPDX-License-Identifier: AGPL-3.0-only
// Highlights on a transcript line or range (#4819, plan docs/plan/meetings.md L21): a reader of a meeting, or its recorder, marks a line or a run of lines, and the meeting's readers see the mark. A
// highlight is an anchor (the start second of the first and of the last line) and who marked it, nothing else: the lines are read from the transcript when they are shown, so a redacted line shows
// redacted, and the highlights go with the meeting like the transcript does.
//
// This file holds the shapes and the limits both sides use. No database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';

// How many marks one member may have in one meeting.
export const HIGHLIGHTS_PER_MEMBER_MAX = 50;
// The seconds a transcript line may start at: a day (as the chapters').
export const HIGHLIGHT_SECOND_MAX = 86_400;

const zSecond = z.number().int().min(0).max(HIGHLIGHT_SECOND_MAX);

export const zHighlightAdd = z
  .strictObject({ meetingId: zId, startSeconds: zSecond, endSeconds: zSecond })
  .refine((v) => v.endSeconds >= v.startSeconds, { message: 'The range ends before it starts', path: ['endSeconds'] });
export type HighlightAdd = z.infer<typeof zHighlightAdd>;

// `created` is false when the same member had already marked the same range (one mark, not two).
export const zHighlightAdded = z.strictObject({ meetingId: zId, highlightId: zId, created: z.boolean() });
export type HighlightAdded = z.infer<typeof zHighlightAdded>;

export const zHighlightRemove = z.strictObject({ meetingId: zId, highlightId: zId });
export type HighlightRemove = z.infer<typeof zHighlightRemove>;

export const zHighlightRemoved = z.strictObject({ meetingId: zId, highlightId: zId });
export type HighlightRemoved = z.infer<typeof zHighlightRemoved>;

// One mark. `mine` is true for the caller's own. `markedBy` is the display name the org knows the member by, or null for the caller's own marks and for a member with no display name (the page says "you" and "a member").
export const zHighlight = z.strictObject({
  id: zId,
  startSeconds: zSecond,
  endSeconds: zSecond,
  mine: z.boolean(),
  markedBy: z.string().nullable(),
});
export type Highlight = z.infer<typeof zHighlight>;

// The marks of a meeting the caller may read, in the order of the transcript (start, then end, then who marked first).
export const zHighlights = z.strictObject({ meetingId: zId, highlights: z.array(zHighlight) });
export type Highlights = z.infer<typeof zHighlights>;
