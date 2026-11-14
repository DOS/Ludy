// SPDX-License-Identifier: AGPL-3.0-only
// The consent gate of the meetings feature (ADR-0047 point 6, plan section 7). A recording starts only when the member
// named the meeting, chose how the participants were told and confirmed they agreed; creating the meeting is what stores
// that consent on the server, and no capture is opened before it. The same rule as the app's recorder (`startBlocker`),
// checked again in the background worker so a popup cannot skip it.
import { startBlocker } from '@crove/meeting-recorder';

// `in_call_chat`: the recorder pasted the recording notice in the call's chat (A1, #3159).
export const CONSENT_METHODS = ['told_at_start', 'in_invite', 'in_writing', 'in_call_chat'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export interface ConsentInput {
  title: string;
  consentMethod: string;
  consentAgreed: boolean;
}

export type ConsentBlocker = ReturnType<typeof startBlocker>;

// Why a recording cannot start yet, or null. An unknown consent method counts as none.
export function consentBlocker(input: ConsentInput): ConsentBlocker {
  const method = (CONSENT_METHODS as readonly string[]).includes(input.consentMethod) ? input.consentMethod : '';
  return startBlocker({ title: input.title, consentMethod: method, consentAgreed: input.consentAgreed });
}
