// SPDX-License-Identifier: AGPL-3.0-only
// The company a contact may work at (#2438, CRM-Q5 of docs/plan/crm.md, PR 3): the sales coworker's suggestion on a person's panel. The candidates come from
// what the org already knows, in this order: a company tax code the person wrote in their conversations, a company that writes from the same email domain, and
// a company whose name carries the word at the heart of the person's address; the model, when it is on, only orders the last group. A suggestion is read, never
// written: a person links with a click (kernel.party.set_company), and with the model off the first two groups and the names in their own order still show.
import { z } from 'zod';
import { CONVERSATION_AI_STATES } from './conversations.ts';
import { zId } from './schemas.ts';

export const COMPANY_SUGGESTIONS_MAX = 5;
export const COMPANY_SUGGESTION_REASONS = ['tax_code', 'email_domain', 'name'] as const;
export type CompanySuggestionReason = (typeof COMPANY_SUGGESTION_REASONS)[number];

export const zCompanySuggest = z.strictObject({ partyId: zId });
export const zCompanySuggested = z.strictObject({
  ai: z.enum(CONVERSATION_AI_STATES),
  candidates: z
    .array(z.strictObject({ partyId: zId, name: z.string(), reason: z.enum(COMPANY_SUGGESTION_REASONS) }))
    .max(COMPANY_SUGGESTIONS_MAX),
});
export type CompanySuggested = z.infer<typeof zCompanySuggested>;

// What crm.contact.company_candidates found, before the model: the contact's name, the word at the heart of their email domain (null when they write from a
// free mail or have no address), and the companies each rule found.
export interface CompanyCandidates {
  personName: string;
  label: string | null;
  taxCode: Array<{ partyId: string; name: string }>;
  emailDomain: Array<{ partyId: string; name: string }>;
  names: Array<{ partyId: string; name: string }>;
}
