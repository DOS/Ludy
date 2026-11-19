// SPDX-License-Identifier: AGPL-3.0-only
// The title of a meeting (#3947): the recorder's Vy suggests up to three candidates from the transcript, shown to the recorder and never stored, and a pick (or any title the recorder types) is set by the rename
// command. The checks that decide what a candidate may be are code (packages/agent member-vy/meeting-title.ts); this file holds the shapes both sides share.
import { z } from 'zod';
import { zId } from './schemas.ts';

// A suggestion is 3 to 80 characters (UTF-16 units, as the database counts), at most three of them.
export const TITLE_SUGGEST_MAX = 3;
export const TITLE_SUGGEST_CHARS_MIN = 3;
export const TITLE_SUGGEST_CHARS_MAX = 80;
// What a meeting's title may be, whoever chose it: the same 1 to 200 as when it is created (zMeetingCreate).
export const MEETING_TITLE_MAX = 200;

export const TITLE_STATES = ['suggested', 'none', 'failed'] as const;
export const zTitleAnswer = z.strictObject({
  state: z.enum(TITLE_STATES),
  // The fixed code of a failure, a name and never the model's or the provider's words.
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  titles: z.array(z.string().min(TITLE_SUGGEST_CHARS_MIN).max(TITLE_SUGGEST_CHARS_MAX)).max(TITLE_SUGGEST_MAX),
  // How many candidates code removed (a count, never the text).
  dropped: z.number().int().min(0).max(100),
});
export type TitleAnswer = z.infer<typeof zTitleAnswer>;

export const zMeetingRename = z.strictObject({ meetingId: zId, title: z.string().trim().min(1).max(MEETING_TITLE_MAX) });
export const zMeetingRenamed = z.strictObject({ meetingId: zId, title: z.string().min(1).max(MEETING_TITLE_MAX) });
export type MeetingRenamed = z.infer<typeof zMeetingRenamed>;
