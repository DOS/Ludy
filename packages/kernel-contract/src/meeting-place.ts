// SPDX-License-Identifier: AGPL-3.0-only
// The place of a meeting (#5013, refs #3162): one line the recorder sets once and the biên bản prints. The shapes both sides share; the cleaning and the recorder-only rule are in
// modules/meetings/src/place.ts, the bounds are the title's (1 to 200 characters, counted in code points like the database's char_length).
import { z } from 'zod';
import { zId } from './schemas.ts';

export const MEETING_PLACE_MAX = 200;

// A place's length is counted in code points (the command, the database's char_length and the erase's left(..., 200)), so an astral character is one: the schema bounds the UTF-16 length
// loosely (two units a character at most) and counts code points, the way a label does (zLabelValue, #5021). #5043.
export const zPlaceValue = z
  .string()
  .min(1)
  .max(MEETING_PLACE_MAX * 2)
  .refine((text) => [...text].length <= MEETING_PLACE_MAX);

// `place: null` (or text that is empty once cleaned) clears the place.
export const zMeetingSetPlace = z.strictObject({ meetingId: zId, place: z.string().max(MEETING_PLACE_MAX * 4).nullable() });
export const zMeetingPlaceSet = z.strictObject({ meetingId: zId, place: zPlaceValue.nullable() });
export type MeetingPlaceSet = z.infer<typeof zMeetingPlaceSet>;
