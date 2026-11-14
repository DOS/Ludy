// SPDX-License-Identifier: AGPL-3.0-only
// The member's own webhook for the minutes they publish (meetings integrations A6, issue #3164, plan docs/plan/meetings-integrations.md section 4.5): the address, the fields to
// send and the secret, as the screen and the API see them. The body that goes out is built by meeting-hook-body.ts and nothing else.
import { z } from 'zod';
import { zMcpWakeUrl } from './mcp.ts';

// What the member may tick beyond the always-sent part (the event id, the meeting id, the publish time, the meeting's date and length). Never the transcript, audio, video or attendee contact details.
export const MEETING_HOOK_FIELDS = ['title', 'summary', 'decisions', 'action_items'] as const;
export type MeetingHookField = (typeof MEETING_HOOK_FIELDS)[number];
export const zMeetingHookField = z.enum(MEETING_HOOK_FIELDS);

// Each field once, in the order above (the order the screen shows them).
const zFields = z
  .array(zMeetingHookField)
  .max(MEETING_HOOK_FIELDS.length)
  .refine((v) => new Set(v).size === v.length, 'Mỗi mục chỉ chọn một lần')
  .transform((v) => MEETING_HOOK_FIELDS.filter((f) => v.includes(f)));

// What the API receives to set the member's webhook: the address, the fields and whether it is on. The secret is made and sealed by the API.
export const zMeetingHookSet = z.strictObject({ url: zMcpWakeUrl, fields: zFields, enabled: z.boolean() });
export type MeetingHookSetInput = z.infer<typeof zMeetingHookSet>;

// The sealed secret the API hands the command: its key id, the envelope (base64) and the public id the receiver sees beside the secret.
export const zMeetingHookCredential = z.strictObject({
  keyId: z.string().min(1).max(64),
  envelope: z.string().min(16).max(2048).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  hint: z.string().regex(/^whk_[0-9a-f]{8}$/),
});
export type MeetingHookCredential = z.infer<typeof zMeetingHookCredential>;
export const zMeetingHookSetCommand = z.strictObject({ url: zMcpWakeUrl, fields: zFields, enabled: z.boolean(), credential: zMeetingHookCredential });
export const zMeetingHookRotateCommand = z.strictObject({ credential: zMeetingHookCredential });

export const zMeetingHookNone = z.strictObject({});

// The member's webhook as the screen shows it: everything but the secret (the address is the member's own). `secret` is the clear value, present only in the answer that made it.
export const zMeetingHookView = z.strictObject({
  url: z.string(),
  fields: z.array(zMeetingHookField),
  enabled: z.boolean(),
  pausedReason: z.literal('failing').nullable(),
  secretHint: z.string(),
  previousUntil: z.string().nullable(),
  failingSince: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  lastDeliveryAt: z.string().nullable(),
  lastStatus: z.enum(['sent', 'failed']).nullable(),
  createdAt: z.string(),
});
export type MeetingHookView = z.infer<typeof zMeetingHookView>;
export const zMeetingHookWithSecret = zMeetingHookView.extend({ secret: z.string().nullable() });
export type MeetingHookWithSecret = z.infer<typeof zMeetingHookWithSecret>;

// What the card needs: the owner's switch for the org, whether the deployment can seal a secret (a credential key is set), and the member's own webhook if any.
export const zMeetingHookState = z.strictObject({ switchOn: z.boolean(), sealing: z.boolean(), hook: zMeetingHookView.nullable() });
export type MeetingHookState = z.infer<typeof zMeetingHookState>;

export const zMeetingHookCleared = z.strictObject({ cleared: z.literal(true) });
export const zMeetingHookTested = z.strictObject({ eventId: z.string(), queued: z.literal(true) });

// The owner's switch (off by default): while it is off nothing is sent and no member can save an address.
export const zMeetingHooksSwitch = z.strictObject({ on: z.boolean() });
export type MeetingHooksSwitch = z.infer<typeof zMeetingHooksSwitch>;

// The delivery's own steps (worker only, none a procedure of the contract): the event id a delivery is stored under, the outcome of one attempt, and the hook a delivery goes to.
export const zMeetingHookEventRef = z.strictObject({ id: z.uuid() });
// 'expired': waited too long with no attempt made, so it fails without counting against the receiver.
export const zMeetingHookRecord = z.strictObject({ id: z.uuid(), outcome: z.enum(['sent', 'retry', 'failed', 'dropped', 'expired']), code: z.number().int().min(100).max(599).optional() });
export const zMeetingHookTargetRef = z.strictObject({ hookId: z.uuid() });

// What the delivery job reads (worker only): the stored delivery, and the address and sealed secrets a hook's delivery goes to. Types of the contract, so the kernel's job names no module file.
export interface MeetingHookDeliveryRow {
  id: string;
  hookId: string;
  type: 'meeting.result_published' | 'ping';
  body: Record<string, unknown> | null;
  status: 'queued' | 'sent' | 'failed' | 'dropped';
  attempts: number;
}
export interface MeetingHookTargetRow {
  // The member the secrets are sealed for (the binding of the credential broker).
  userId: string;
  url: string;
  sealed: { keyId: string; envelope: string };
  previous: { keyId: string; envelope: string } | null;
}
