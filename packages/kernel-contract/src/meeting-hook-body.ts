// SPDX-License-Identifier: AGPL-3.0-only
// The only builder of a minutes-webhook body (meetings integrations A6, issue #3164). A strict object at every level, so a transcript, audio, video or an attendee's contact
// detail cannot ride in any field, whatever it is called: an unknown key is refused, and every value has a pinned shape. What the member ticked (title, summary, decisions, action
// items) is text the person approved by publishing; the always-sent part is ids, instants and the length. The delivery sends what this function returns.
import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const zId = z.string().regex(UUID);
const zInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const zActionItem = z.strictObject({ text: z.string().min(1).max(300), owner: z.string().max(200).nullable(), due: zDate.nullable() });
const zResultData = z.strictObject({
  meeting_id: zId,
  published_at: zInstant,
  started_at: zInstant,
  length_seconds: z.number().int().min(0).max(86400).nullable(),
  title: z.string().min(1).max(300).optional(),
  summary: z.string().min(1).max(8000).optional(),
  decisions: z.array(z.string().min(1).max(1000)).max(50).optional(),
  action_items: z.array(zActionItem).max(100).optional(),
});

const head = { id: zId, created_at: zInstant, org: zId };
const zEvent = z.discriminatedUnion('type', [
  z.strictObject({ ...head, type: z.literal('meeting.result_published'), data: zResultData }),
  z.strictObject({ ...head, type: z.literal('ping'), data: z.strictObject({}) }),
]);

export type MeetingHookEvent = z.infer<typeof zEvent>;

// The event as a plain object, in the order the receiver reads it, or a throw naming the first thing that does not fit.
export function meetingHookEvent(input: unknown): MeetingHookEvent {
  const parsed = zEvent.parse(input);
  return { id: parsed.id, type: parsed.type, created_at: parsed.created_at, org: parsed.org, data: parsed.data } as MeetingHookEvent;
}

// The text the receiver gets, and the delivery signs.
export function meetingHookBody(input: unknown): string {
  return JSON.stringify(meetingHookEvent(input));
}
