// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentence naming the late sales invoices of a VAT working, on the API side (#3540, the AI part of #3535). finance.vat.period runs in the member's own
// transaction and gives the working's lists; the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the
// member). The model is told invoice numbers, periods and two yes/no facts and nothing else (no buyer, tax code, amount or date), and its text is refused when it names an invoice or
// period the lists do not hold, leaves one out, states another figure or claims a declaration (packages/agent vat-late.ts).
//
// The sentence is read, never written: nothing here stores a text, declares or posts anything, and it is not a command; a person decides the supplementary declaration. When there is
// no late sale, no model, the AI budget is spent, the member's calls are too frequent, the call fails or its text is refused, the answer names the state (`ai`) with no words and
// the screen shows the template sentence built from the same lists. An answer is kept for a while by its facts. A failure is named, never quoted.
import { AiBudgetExhaustedError, VAT_LATE_ASK_MAX, vatLateFactsText, vatLateQuiet, type InboxReader, type VatLateFacts } from '@crove/agent';
import { vatLateFacts, type VatLateExplanation, type VatLateSource } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface VatLateAi {
  reader: Pick<InboxReader, 'vatLateSentence'> | null;
  budget: DraftBudget;
  // Sentences by org and facts, with the time they were written.
  kept: Map<string, { text: string; at: number }>;
}

export const VAT_LATE_KEEP_MS = 30 * 60 * 1000;
export const VAT_LATE_KEEP_MAX = 200;

export function vatLateAi(reader: VatLateAi['reader'], budget: DraftBudget): VatLateAi {
  return { reader, budget, kept: new Map() };
}

// What the sentence is written from: the working's late invoices, as the lists name them.
export function vatLateAgentFacts(report: VatLateSource, language: 'vi' | 'en'): VatLateFacts {
  return { language, items: vatLateFacts(report) };
}

export async function explainVatLate(ai: VatLateAi, orgId: string, userId: string, report: VatLateSource, language: 'vi' | 'en', now: () => number = Date.now): Promise<VatLateExplanation> {
  const answer = (state: VatLateExplanation['ai'], text: string | null = null): VatLateExplanation => ({ ai: state, text });
  const facts = vatLateAgentFacts(report, language);
  // Nothing late, or more than the model is asked about (VAT_LATE_ASK_MAX): the template alone says it.
  if (facts.items.length === 0 || facts.items.length > VAT_LATE_ASK_MAX) return answer('quiet');
  if (!ai.reader || vatLateQuiet(facts)) return answer(ai.reader ? 'quiet' : 'off');
  const key = `${orgId}\n${language}\n${vatLateFactsText(facts)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < VAT_LATE_KEEP_MS) return answer('used', hit.text);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.vatLateSentence(facts);
    if (result.kind === 'none') {
      console.error(`[finance-vat-ai] sentence refused: ${result.code}`);
      return answer('failed');
    }
    if (ai.kept.size >= VAT_LATE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text: result.text, at: now() });
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-vat-ai] sentence failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
