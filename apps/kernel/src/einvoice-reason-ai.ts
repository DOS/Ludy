// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's proposal of the reason code of an adjusting or replacing e-invoice, on the API side (#3690, the AI part of #2504). finance.einvoice.reason_source reads what the model may see in
// the member's own transaction: the list of Appendix XVII codes, the buyer's KIND and the original's lines without a price or an amount, never a buyer's name, tax code, address, email or ID. The model call then
// runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member), with the person's note, which is never stored, cached or logged.
//
// It is read, never written: nothing here saves a correction or picks a code for the person. The model answers a number into the list it was shown (packages/agent einvoice-reason.ts), so the code comes from
// the list; it is looked up in the list once more here, and a code that is not in it is dropped. The person changes or confirms the select, and starting the correction checks the code against the list again.
// With no list, no note, no model, a spent AI budget, too frequent calls, a failed call or a refused answer, the answer names the state (`ai`) with no code and the form works as it does with AI off. A failure is
// named, never quoted: neither the note nor the answer is logged.
import { AiBudgetExhaustedError, type EInvoiceReasonFacts, type InboxReader } from '@ludy/agent';
import type { EInvoiceReasonInput, EInvoiceReasonSource, EInvoiceReasonSuggested } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface EInvoiceReasonAi {
  reader: Pick<InboxReader, 'einvoiceReasonSuggestion'> | null;
  budget: DraftBudget;
}

export function einvoiceReasonAi(reader: EInvoiceReasonAi['reader'], budget: DraftBudget): EInvoiceReasonAi {
  return { reader, budget };
}

export async function suggestCorrectionReason(ai: EInvoiceReasonAi, orgId: string, userId: string, source: EInvoiceReasonSource, input: EInvoiceReasonInput): Promise<EInvoiceReasonSuggested> {
  const answer = (state: EInvoiceReasonSuggested['ai'], pick: { code: string; label: string; why: string } | null = null): EInvoiceReasonSuggested => ({
    ai: state,
    code: pick?.code ?? null,
    label: pick?.label ?? null,
    why: pick?.why ?? null,
  });
  // Nothing to propose from: no paid call, and no state that depends on the deployment.
  if (source.codes.length === 0) return answer('no_list');
  if (input.note.trim() === '') return answer('no_note');
  const ask = ai.reader?.einvoiceReasonSuggestion;
  if (!ask) return answer('off');
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const facts: EInvoiceReasonFacts = {
      codes: source.codes,
      adjustment: input.kind === 'adjustment',
      buyerKind: source.buyerKind,
      originalDate: source.originalDate,
      lines: source.lines,
      note: input.note,
    };
    const result = await ask(facts);
    if (result.kind === 'none') {
      console.error(`[einvoice-reason-ai] proposal refused: ${result.code}`);
      return answer('refused');
    }
    // The code is the list's, looked up again here: one that is not in the list is dropped.
    const picked = source.codes[result.index];
    if (!picked) {
      console.error('[einvoice-reason-ai] proposal refused: NOT_IN_LIST');
      return answer('refused');
    }
    return answer('used', { code: picked.code, label: picked.label, why: result.why });
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[einvoice-reason-ai] proposal failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
