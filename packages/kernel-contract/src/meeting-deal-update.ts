// SPDX-License-Identifier: AGPL-3.0-only
// Vy proposing the update of a deal after a meeting linked to it (#4766, ADR-0048, ADR-0049): once a meeting linked to a deal has published minutes, the recorder may ask their own Vy for the
// deal's next step (what, and the day when the meeting wrote one) and a short note. Nothing is written until the recorder confirms the proposal, edited or not, with the exact text on screen:
//   meetings.deal_update.status   whether the button shows (a deal linked, minutes published, the deal open, Vy allowed now)
//   meetings.deal_update.propose  the one model call (apps/kernel member-vy-ports.ts), the answer checked by code, nothing stored but counts
//   meetings.deal_update.confirm  the recorder's command: re-reads the minutes and the link, checks the texts again, then crm.deal.meeting_update.apply writes the next step as a task, the note
//                                 as a comment of that task, and closes the stale-deal reminder
// The model never writes the day: it is the parsed date of the action item the next step is about.
import { z } from 'zod';
import { FOLLOWUP_NOTE_STATES, followupNoteProblem, type FollowupTextProblem } from './meeting-followup.ts';
import { zMeetingRef } from './meetings.ts';
import { zId } from './schemas.ts';

export const DEAL_UPDATE_STEP_MAX = 160;
export const DEAL_UPDATE_NOTE_MAX = 500;
// The kind of the one line of fixed words the update leaves on the contact's timeline.
export const DEAL_UPDATE_ACTIVITY_KIND = 'crm.deal.meeting_update';

const lengthOf = (text: string): number => Array.from(text).length;

/** Why a next step or a note typed or edited by the recorder may not be saved, or null (the text is the cleaned one, one line). The checks the follow-up note has, with the bounds of a deal update. */
export function dealUpdateTextProblem(clean: string, max: number): FollowupTextProblem | null {
  if (clean === '') return 'EMPTY';
  if (lengthOf(clean) > max) return 'TOO_LONG';
  return followupNoteProblem(clean);
}

export const DEAL_UPDATE_STATUS_REASONS = ['off', 'forbidden', 'paused', 'budget', 'not_recorder', 'no_crm', 'no_deal', 'no_minutes', 'deal_closed'] as const;
export const zDealUpdateStatus = z.strictObject({
  meetingId: zId,
  // Whether the card shows at all: a deal is linked, the minutes are published and the deal is open. False: nothing to offer (reason says why).
  available: z.boolean(),
  // Whether Vy may be asked now.
  enabled: z.boolean(),
  reason: z.enum(DEAL_UPDATE_STATUS_REASONS).nullable(),
  deal: z.strictObject({ id: zId, title: z.string(), stage: z.string() }).nullable(),
  // The published minutes as they stand now (a hash), for a recorder who writes the update by hand: confirm refuses it when the minutes changed since.
  minutesKey: z.string().max(80).nullable(),
});
export type DealUpdateStatus = z.infer<typeof zDealUpdateStatus>;

export const zDealUpdateAsk = zMeetingRef;
export type DealUpdateAsk = z.infer<typeof zDealUpdateAsk>;

export const zDealUpdateNextStep = z.strictObject({
  text: z.string(),
  // A calendar day (YYYY-MM-DD) the meeting itself wrote for the action item, or null.
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
});
export type DealUpdateNextStep = z.infer<typeof zDealUpdateNextStep>;

export const zDealUpdateAnswer = z.strictObject({
  ai: z.enum(FOLLOWUP_NOTE_STATES),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u).nullable(),
  dealId: zId.nullable(),
  // The minutes the proposal was written from (a hash): confirm refuses it when the minutes changed since.
  minutesKey: z.string().max(80).nullable(),
  nextStep: zDealUpdateNextStep.nullable(),
  note: z.string().nullable(),
  dropped: z.number().int().min(0).max(100),
});
export type DealUpdateAnswer = z.infer<typeof zDealUpdateAnswer>;

export const zDealUpdateConfirm = zMeetingRef.extend({
  dealId: zId,
  minutesKey: z.string().min(1).max(80),
  nextStep: zDealUpdateNextStep.nullable(),
  note: z.string().max(DEAL_UPDATE_NOTE_MAX * 4).nullable(),
});
export type DealUpdateConfirm = z.infer<typeof zDealUpdateConfirm>;
// The route's input: one idempotency key per confirm click, so a double click or a retry gets the first answer and never a second task.
export const zDealUpdateConfirmCall = zDealUpdateConfirm.extend({ idempotencyKey: zId });

// What the CRM command takes: the recorder's confirmed texts, already cleaned and checked by the meetings command. It has no route of its own.
export const zDealMeetingUpdateApply = z.strictObject({
  dealId: zId,
  meetingId: zId,
  nextStep: zDealUpdateNextStep.nullable(),
  note: z.string().nullable(),
  // The offset-bearing instant the task is due, from the day above (set by the meetings command).
  due: z.iso.datetime({ offset: true }).nullable(),
});
export type DealMeetingUpdateApply = z.infer<typeof zDealMeetingUpdateApply>;

export const zDealUpdateConfirmed = z.strictObject({
  dealId: zId,
  // The task the update became (the next step, or a task of fixed title that holds the note as a comment).
  taskId: zId,
  noteSaved: z.boolean(),
  // How many open stale-deal reminders the update closed.
  remindersClosed: z.number().int().min(0).max(100),
});
export type DealUpdateConfirmed = z.infer<typeof zDealUpdateConfirmed>;
