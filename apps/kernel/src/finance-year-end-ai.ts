// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's note on the year-end checklist of the Kế toán screen (#5283), on the API side. finance.year_end runs in the member's own transaction and finds each item's state;
// the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The model is told which items are open and can be done
// now (an item that waits for the year to end is left out) and nothing else (no count, no date, no name, no amount), and its note is refused when it states a number, a date, a link, a
// promise, a certainty, a done step or advice about money, or when its order is not exactly those items (packages/agent year-end.ts), so what it writes can never state a fact the books do not hold.
//
// The note is read, never written: nothing here stores a text or changes the books, and it is not a command. When there is no model, the AI budget is spent, the member's calls are
// too frequent, the call fails or its answer is refused, the answer names the state (`ai`) with no words and the screen shows the checklist in its fixed order. An answer is kept for
// a while by the open items, so reopening the screen or changing the year does not pay for the same note twice. A failure is named, never quoted: neither the items nor the model's
// answer is logged.
import { AiBudgetExhaustedError, yearEndQuiet, type InboxReader, type YearEndFacts } from '@ludy/agent';
import { YEAR_END_ITEMS, type YearEnd, type YearEndNote } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface YearEndAi {
  reader: Pick<InboxReader, 'yearEndNote'> | null;
  budget: DraftBudget;
  // Notes by org, language and open items, with the time they were written.
  kept: Map<string, { text: string; order: YearEndNote['order']; at: number }>;
}

export const YEAR_END_KEEP_MS = 30 * 60 * 1000;
export const YEAR_END_KEEP_MAX = 200;

export function yearEndAi(reader: YearEndAi['reader'], budget: DraftBudget): YearEndAi {
  return { reader, budget, kept: new Map() };
}

// The facts the note is written from: the language and the keys of the open items that can be done now (not the ones waiting for the year to end), in the fixed order. Never a count or a date.
export function yearEndFacts(checklist: YearEnd, language: 'vi' | 'en'): YearEndFacts {
  const open = new Set(checklist.items.filter((item) => item.state === 'open' && !item.waiting).map((item) => item.key));
  return { language, open: YEAR_END_ITEMS.filter((key) => open.has(key)) };
}

export async function explainYearEnd(ai: YearEndAi, orgId: string, userId: string, checklist: YearEnd, language: 'vi' | 'en', now: () => number = Date.now): Promise<YearEndNote> {
  const answer = (state: YearEndNote['ai'], text: string | null = null, order: YearEndNote['order'] = []): YearEndNote => ({ ai: state, text, order });
  if (!ai.reader) return answer('off');
  const facts = yearEndFacts(checklist, language);
  if (yearEndQuiet(facts)) return answer('quiet');
  const key = `${orgId}\n${language}\n${facts.open.join(',')}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < YEAR_END_KEEP_MS) return answer('used', hit.text, hit.order);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.yearEndNote(facts);
    if (result.kind === 'none') {
      console.error(`[finance-year-end-ai] note refused: ${result.code}`);
      return answer('failed');
    }
    if (ai.kept.size >= YEAR_END_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text: result.text, order: result.order, at: now() });
    return answer('used', result.text, result.order);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-year-end-ai] note failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
