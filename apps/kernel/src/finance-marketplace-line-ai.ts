// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's one line on the Sàn screen, on the API side (#2516 slice E). finance.marketplace.facts reads the facts from the books in the caller's own transaction; the model call then
// runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The model is told four numbers (settlements waiting to be posted, platforms
// linked, what the platforms still owe, fees awaiting an invoice) and nothing else, and its text is refused when it states a number the facts do not hold, a link, or says something was posted,
// approved or paid (packages/agent marketplace-line.ts), so what it writes can never state a fact the books do not hold.
//
// The line is read, never written: nothing here stores a text or changes the books, and it is not a command. With nothing waiting there is no call (`none`). When there is no model, the AI budget is
// spent, the member's calls are too frequent, the call fails or its text is refused, the answer names the state (`ai`) with no words and the screen shows the facts alone. An answer is kept for a
// while by its facts, so reopening the screen does not pay for the same line twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, marketplaceLineFactsText, marketplaceLineHasNews, type InboxReader, type MarketplaceLineFacts } from '@crove/agent';
import type { MarketplaceFacts, MarketplaceLine } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface MarketplaceLineAi {
  reader: Pick<InboxReader, 'marketplaceLineSentence'> | null;
  budget: DraftBudget;
  // Sentences by org and facts, with the time they were written.
  kept: Map<string, { text: string; at: number }>;
}

export const MARKETPLACE_LINE_KEEP_MS = 30 * 60 * 1000;
export const MARKETPLACE_LINE_KEEP_MAX = 200;

export function marketplaceLineAi(reader: MarketplaceLineAi['reader'], budget: DraftBudget): MarketplaceLineAi {
  return { reader, budget, kept: new Map() };
}

// The facts the sentence is written from: the four numbers of the read, nothing else.
export function marketplaceLineFacts(facts: MarketplaceFacts, language: 'vi' | 'en'): MarketplaceLineFacts {
  return { language, settlementsToPost: facts.settlementsToPost, platforms: facts.platforms, awaitingPayout: facts.awaitingPayout, feesAwaitingInvoice: facts.feesAwaitingInvoice };
}

export async function explainMarketplaceLine(
  ai: MarketplaceLineAi,
  orgId: string,
  userId: string,
  facts: MarketplaceFacts,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<MarketplaceLine> {
  const answer = (state: MarketplaceLine['ai'], text: string | null = null): MarketplaceLine => ({ facts, ai: state, text });
  const told = marketplaceLineFacts(facts, language);
  if (!marketplaceLineHasNews(told)) return answer('none');
  if (!ai.reader) return answer('off');
  const key = `${orgId}\n${language}\n${marketplaceLineFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < MARKETPLACE_LINE_KEEP_MS) return answer('used', hit.text);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.marketplaceLineSentence(told);
    if (result.kind === 'none') {
      console.error(`[finance-marketplace-line-ai] sentence refused: ${result.code}`);
      return answer('failed');
    }
    if (ai.kept.size >= MARKETPLACE_LINE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text: result.text, at: now() });
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-marketplace-line-ai] sentence failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
