// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker on the lines of a quote, on the API side (#2698, plan docs/plan/crm-quotes.md section 7). crm.quote.suggest_source runs in the member's own transaction and says what the model
// may see (the deal's title and amount, the customer's name, the customer's latest messages while the org's switch for AI on customers' words is on, and the lines of earlier quotes to them: no
// address, tax code, credential or bank account); the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member).
//
// It is read, never written: nothing here saves a quote, makes a link, sends, accepts or creates an order, and no agent runs it. The answer is proposals that a person applies or drops line by line;
// each applied line becomes a quote line only through that person's crm.quote.save. What the model wrote is checked in code first (packages/agent quote-lines.ts: a figure or link no source holds, a VAT
// rate a line cannot carry refuse the whole proposal; a quantity no source holds drops the line; a price no source holds is left empty). Totals are never here: the editor and the server compute them.
// When the org's switch is off nothing of the customer reaches the model and the answer says so (`words_off`). When the model is off, the AI budget is spent, the member's calls are too frequent, the
// call fails or its answer is refused, the answer names the state (`ai`) and gives nothing to apply, so the editor works as it does with AI off. A failure is named, never quoted: neither the customer's
// words nor the model's answer is logged.
import { AiBudgetExhaustedError, type InboxReader, type QuoteSuggestRequest } from '@crove/agent';
import type { QuoteSuggested } from '@crove/kernel-contract';
import type { QuoteSuggestSource } from '@crove/mod-crm';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface QuoteAi {
  reader: Partial<Pick<InboxReader, 'quoteLines'>> | null;
  budget: DraftBudget;
}

export function quoteAi(reader: QuoteAi['reader'], budget: DraftBudget): QuoteAi {
  return { reader, budget };
}

export async function suggestQuoteLines(ai: QuoteAi, orgId: string, userId: string, source: QuoteSuggestSource): Promise<QuoteSuggested> {
  const answer = (state: QuoteSuggested['ai'], lines: QuoteSuggested['lines'] = []): QuoteSuggested => ({ ai: state, lines });
  const ask = ai.reader?.quoteLines;
  if (!ask) return answer('off');
  // The org's switch comes first: with it off no word of a customer is read, so none reaches the model.
  if (!source.wordsAllowed) return answer('words_off');
  if (source.messages.length === 0) return answer('no_text');
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const request: QuoteSuggestRequest = { dealTitle: source.dealTitle, dealAmount: source.dealAmount, partyName: source.partyName, messages: source.messages, earlier: source.earlier };
    const result = await ask(request);
    if (result.kind === 'none') {
      console.error(`[quote-ai] suggestion refused: ${result.code}`);
      return answer('refused');
    }
    return answer('used', result.lines);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[quote-ai] suggestion failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
