// SPDX-License-Identifier: AGPL-3.0-only
// Spoken cues to Vy (#4807, plan docs/plan/meetings.md L19): "Vy ơi, ghi lại việc này cho anh Nam, hạn thứ Sáu" in the transcript becomes a DRAFT action item, marked as asked for out loud ('asked_aloud' in
// the item's flags) and citing the second of the line. Found by code (no model call); the recorder's own click makes the drafts and the recorder confirms each one as any other Vy item. This file holds the
// shapes and the limits both sides use. No database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';

// At most this many cues are turned into items by one click (the per-meeting item limit applies as well).
export const VOICE_CUES_MAX = 50;

export const zVoiceCueDraft = z.strictObject({ meetingId: zId });
export type VoiceCueDraft = z.infer<typeof zVoiceCueDraft>;

// What one click did: how many cues the transcript holds, how many became items, and why the rest did not (an item already exists for that line, the cue said nothing to write down, the meeting is full).
export const zVoiceCueDrafted = z.strictObject({
  meetingId: zId,
  found: z.number().int().min(0),
  created: z.number().int().min(0),
  duplicate: z.number().int().min(0),
  empty: z.number().int().min(0),
  full: z.number().int().min(0),
});
export type VoiceCueDrafted = z.infer<typeof zVoiceCueDrafted>;
