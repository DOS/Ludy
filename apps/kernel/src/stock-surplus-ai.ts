// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's explanation of the surplus of a confirmed count of stock, on the API side (#3712 slice 2b). finance.stock_count.surplus_source reads the facts in the member's own
// transaction: the items, the total, the supplier hint and the manual-entry flag are the CODE's. The model call then runs here, outside any transaction, through the AI budget meter (the request's
// AI scope names the org and the member). The model is told the count date, at most eight items, the total and, when code found one, a supplier's name and the date of the last receipt: no id, tax
// code, balance or voucher (packages/agent stock-surplus-note.ts), and its text is refused when it states a figure the facts do not hold, a link, a claim that a step was done, or advice on the account.
//
// It is read, never written: nothing here stores a text, chooses an account or a supplier, or starts a resolution; a person picks and a person approves the voucher. When there is no model, the
// member's calls are too frequent, the AI budget is spent, the call fails or its text is refused, the answer names the state (`ai`) with no words and the screen shows its own template, so
// everything works with AI off. A text is kept for a while by its facts, so opening the same count again does not pay twice. A failure is named, never quoted.
import { AiBudgetExhaustedError, stockSurplusFactsText, type InboxReader, type StockSurplusFacts } from '@crove/agent';
import type { StockSurplusNote, StockSurplusSource } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface StockSurplusAi {
  reader: Pick<InboxReader, 'stockSurplusNote'> | null;
  budget: DraftBudget;
  // Texts by org and facts, with the time they were written; `text` null is a refusal, kept shorter so a fact set the check always refuses does not pay again on every visit.
  kept: Map<string, { text: string | null; at: number }>;
}

export const STOCK_SURPLUS_KEEP_MS = 30 * 60 * 1000;
export const STOCK_SURPLUS_REFUSED_KEEP_MS = 5 * 60 * 1000;
export const STOCK_SURPLUS_KEEP_MAX = 200;

export function stockSurplusAi(reader: StockSurplusAi['reader'], budget: DraftBudget): StockSurplusAi {
  return { reader, budget, kept: new Map() };
}

// The facts the explanation is written from: nothing the source holds beyond the date, the items, the total and the supplier's name and receipt date.
export function stockSurplusFacts(source: StockSurplusSource, language: 'vi' | 'en'): StockSurplusFacts {
  return {
    language,
    countDate: source.countDate,
    items: source.items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
    moreItems: source.moreItems,
    total: source.total,
    supplier: source.supplier ? { name: source.supplier.name, lastReceived: source.supplier.lastReceived } : null,
  };
}

export async function explainSurplus(ai: StockSurplusAi, orgId: string, userId: string, source: StockSurplusSource, language: 'vi' | 'en', now: () => number = Date.now): Promise<StockSurplusNote> {
  const answer = (state: StockSurplusNote['ai'], explanation: string | null = null): StockSurplusNote => ({ ...source, ai: state, explanation });
  if (!ai.reader) return answer('off');
  const told = stockSurplusFacts(source, language);
  const key = `${orgId}\n${language}\n${stockSurplusFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < (hit.text === null ? STOCK_SURPLUS_REFUSED_KEEP_MS : STOCK_SURPLUS_KEEP_MS)) return hit.text === null ? answer('refused') : answer('used', hit.text);
  const remember = (text: string | null) => {
    if (ai.kept.size >= STOCK_SURPLUS_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text, at: now() });
  };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.stockSurplusNote(told);
    if (result.kind === 'none') {
      console.error(`[stock-surplus-ai] explanation refused: ${result.code}`);
      remember(null);
      return answer('refused');
    }
    remember(result.text);
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[stock-surplus-ai] explanation failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
