// SPDX-License-Identifier: AGPL-3.0-only
// What the correction panel does with the accounting coworker's answer on the reason code (#3690): the select is filled only with a code the select holds, the why shows only with such a code, and the button
// stays off once an answer says the model is off or the AI budget is spent. Pure, so it is tested without a DOM.
import type { EInvoiceReasonSuggested } from '@ludy/kernel-contract';

/** The code to fill the select with and the why to show, or nothing: only an answer that was used and whose code is one of the codes the select holds fills anything. */
export function reasonFill(answer: EInvoiceReasonSuggested, held: ReadonlyArray<{ code: string }>): { code: string; why: string } | null {
  if (answer.ai !== 'used' || answer.code === null || answer.why === null) return null;
  return held.some((c) => c.code === answer.code) ? { code: answer.code, why: answer.why } : null;
}

/** Whether the "Gợi ý lý do" button is off: nothing described yet, a call in flight, or an earlier answer said the model is off or the budget is spent. */
export function reasonButtonOff(input: { note: string; pending: boolean; last: EInvoiceReasonSuggested['ai'] | null }): boolean {
  return input.note.trim() === '' || input.pending || input.last === 'off' || input.last === 'budget';
}
