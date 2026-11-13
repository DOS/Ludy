// SPDX-License-Identifier: AGPL-3.0-only
// Dy's draft of the follow-up message for a "Cần theo dõi" step (issue #3101, docs/plan/crm.md 4.4a and docs/plan/crm-quotes.md section 7): a quiet deal, a deal past its
// expected close, or a sent quote with no answer or about to expire. The facts of the message (the contact's name, the quote's number, its total as a decimal string, its link,
// the days quiet) are built by code; the model writes only a lead-in and a closing around them. The answer is a text for the person to read, edit and send: nothing is stored
// or sent by it. A person presses Send in the reply box of the conversation, or sends the email from their own mail program.
import { z } from 'zod';
import { DEAL_NEXT_STEP_REASONS } from './crm-deals.ts';
import { zId } from './schemas.ts';

// What a person may type to steer the tone: one line.
export const CRM_FOLLOWUP_HINT_MAX = 200;
export const CRM_FOLLOWUP_TEXT_MAX = 4000;
// used: Dy wrote the lead-in and the closing. off, busy, budget, failed: the fixed template words stand (the model is off, the member asked too often, the AI budget is spent,
// the call failed or its words were refused by the checks).
export const CRM_FOLLOWUP_STATES = ['used', 'off', 'busy', 'budget', 'failed'] as const;
export type CrmFollowupState = (typeof CRM_FOLLOWUP_STATES)[number];

export const zFollowupDraftInput = z.strictObject({
  nextStepId: zId,
  hint: z.string().trim().max(CRM_FOLLOWUP_HINT_MAX).optional(),
});
export type FollowupDraftInput = z.infer<typeof zFollowupDraftInput>;

export const zFollowupDrafted = z.strictObject({
  ai: z.enum(CRM_FOLLOWUP_STATES),
  reason: z.enum(DEAL_NEXT_STEP_REASONS),
  // The subject of an email draft, and the text of the message (greeting, words, facts, closing). The person edits both.
  subject: z.string().max(200),
  text: z.string().min(1).max(CRM_FOLLOWUP_TEXT_MAX),
  // Where an email draft goes: the contact's address, or null when the contact has none.
  email: z.string().max(254).nullable(),
  // The quote the facts and the link are about, or null for a deal with no sent quote.
  quoteId: zId.nullable(),
  // Whether the text carries a link to the quote (made for this draft; the person can revoke it with the quote's other links).
  hasLink: z.boolean(),
});
export type FollowupDrafted = z.infer<typeof zFollowupDrafted>;
