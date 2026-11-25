// SPDX-License-Identifier: AGPL-3.0-only
// The place of a meeting (#5013, refs #3162): one line the recorder sets once and the biên bản prints. The shapes both sides share; the cleaning and the recorder-only rule are in
// modules/meetings/src/place.ts, the bounds are the title's (1 to 200 characters).
import { z } from 'zod';
import { zId } from './schemas.ts';

export const MEETING_PLACE_MAX = 200;

// `place: null` (or text that is empty once cleaned) clears the place.
export const zMeetingSetPlace = z.strictObject({ meetingId: zId, place: z.string().max(MEETING_PLACE_MAX * 4).nullable() });
export const zMeetingPlaceSet = z.strictObject({ meetingId: zId, place: z.string().min(1).max(MEETING_PLACE_MAX).nullable() });
export type MeetingPlaceSet = z.infer<typeof zMeetingPlaceSet>;
