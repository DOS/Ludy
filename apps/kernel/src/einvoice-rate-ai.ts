// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's explanation of the VAT rate a correcting e-invoice proposes, on the API side (#3709). finance.einvoice.correction_rate reads the proposal in the member's own transaction:
// the basis, the rate and the fixed reason are the CODE's. The model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member).
// The model is told the nature of the correction, the two dates, the day the 8% rate ended and the rates that change or stay: no buyer, no amount, no invoice number (packages/agent einvoice-rate.ts), and
// its text is refused when it states a figure or a rate the facts do not hold, a link, or is too long.
//
// It is read, never written: nothing here stores a text, decides a rate or starts a correction; a person confirms the proposal by starting it. When there is no model, the member's calls are too frequent,
// the AI budget is spent, the call fails or its text is refused, the answer names the state (`ai`) with no words and the screen shows the fixed reason alone, so everything works with AI off. A text is kept for a while
// by its facts, so choosing the same nature again does not pay twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, einvoiceRateFactsText, type EInvoiceRateFacts, type InboxReader } from '@crove/agent';
import type { EInvoiceCorrectionRate, EInvoiceCorrectionRateExplained } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface EInvoiceRateAi {
  reader: Pick<InboxReader, 'einvoiceRateExplanation'> | null;
  budget: DraftBudget;
  // Texts by org and facts, with the time they were written; `text` null is a refusal, kept shorter so a fact set the check always refuses does not pay again on every choice.
  kept: Map<string, { text: string | null; at: number }>;
}

export const EINVOICE_RATE_KEEP_MS = 30 * 60 * 1000;
export const EINVOICE_RATE_REFUSED_KEEP_MS = 5 * 60 * 1000;
export const EINVOICE_RATE_KEEP_MAX = 200;

export function einvoiceRateAi(reader: EInvoiceRateAi['reader'], budget: DraftBudget): EInvoiceRateAi {
  return { reader, budget, kept: new Map() };
}

// The facts the explanation is written from: the proposal's nature, dates and rates, nothing else.
export function einvoiceRateFacts(rate: EInvoiceCorrectionRate): EInvoiceRateFacts {
  return { nature: rate.nature, basis: rate.basis, originalDate: rate.originalDate, correctionDate: rate.correctionDate, reducedUntil: rate.reducedUntil, changes: rate.changes, kept: rate.kept };
}

export async function explainCorrectionRate(ai: EInvoiceRateAi, orgId: string, userId: string, rate: EInvoiceCorrectionRate, now: () => number = Date.now): Promise<EInvoiceCorrectionRateExplained> {
  const answer = (state: EInvoiceCorrectionRateExplained['ai'], explanation: string | null = null): EInvoiceCorrectionRateExplained => ({ ...rate, ai: state, explanation });
  if (!ai.reader) return answer('off');
  const told = einvoiceRateFacts(rate);
  const key = `${orgId}\n${einvoiceRateFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < (hit.text === null ? EINVOICE_RATE_REFUSED_KEEP_MS : EINVOICE_RATE_KEEP_MS)) return hit.text === null ? answer('refused') : answer('used', hit.text);
  const remember = (text: string | null) => {
    if (ai.kept.size >= EINVOICE_RATE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text, at: now() });
  };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.einvoiceRateExplanation(told);
    if (result.kind === 'none') {
      console.error(`[einvoice-rate-ai] explanation refused: ${result.code}`);
      remember(null);
      return answer('refused');
    }
    remember(result.text);
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[einvoice-rate-ai] explanation failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
