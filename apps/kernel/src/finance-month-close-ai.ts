// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's note on the month-close checklist of the Kế toán screen, on the API side. finance.month_close runs in the member's own transaction and counts the items;
// the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The model is told which items are open
// and nothing else (no count, no date, no name, no amount), and its note is refused when it states a number, a date, a link, a promise or a done step, or when its order is not
// exactly the open items (packages/agent month-close.ts), so what it writes can never state a fact the books do not hold.
//
// The note is read, never written: nothing here stores a text or changes the books, and it is not a command. When there is no model, the AI budget is spent, the member's calls are
// too frequent, the call fails or its answer is refused, the answer names the state (`ai`) with no words and the screen shows the checklist in its fixed order. An answer is kept for
// a while by the open items, so reopening the screen or changing the month does not pay for the same note twice. A failure is named, never quoted: neither the items nor the model's
// answer is logged.
import { AiBudgetExhaustedError, monthCloseQuiet, type InboxReader, type MonthCloseFacts } from '@ludy/agent';
import { MONTH_CLOSE_ITEMS, type MonthClose, type MonthCloseNote } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface MonthCloseAi {
  reader: Pick<InboxReader, 'monthCloseNote'> | null;
  budget: DraftBudget;
  // Notes by org, language and open items, with the time they were written.
  kept: Map<string, { text: string; order: MonthCloseNote['order']; at: number }>;
}

export const MONTH_CLOSE_KEEP_MS = 30 * 60 * 1000;
export const MONTH_CLOSE_KEEP_MAX = 200;

export function monthCloseAi(reader: MonthCloseAi['reader'], budget: DraftBudget): MonthCloseAi {
  return { reader, budget, kept: new Map() };
}

// The facts the note is written from: the language and the keys of the open items, in the fixed order. Never a count.
export function monthCloseFacts(checklist: MonthClose, language: 'vi' | 'en'): MonthCloseFacts {
  const open = new Set(checklist.items.filter((item) => item.count > 0).map((item) => item.key));
  return { language, open: MONTH_CLOSE_ITEMS.filter((key) => open.has(key)) };
}

export async function explainMonthClose(ai: MonthCloseAi, orgId: string, userId: string, checklist: MonthClose, language: 'vi' | 'en', now: () => number = Date.now): Promise<MonthCloseNote> {
  const answer = (state: MonthCloseNote['ai'], text: string | null = null, order: MonthCloseNote['order'] = []): MonthCloseNote => ({ ai: state, text, order });
  if (!ai.reader) return answer('off');
  const facts = monthCloseFacts(checklist, language);
  if (monthCloseQuiet(facts)) return answer('quiet');
  const key = `${orgId}\n${language}\n${facts.open.join(',')}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < MONTH_CLOSE_KEEP_MS) return answer('used', hit.text, hit.order);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.monthCloseNote(facts);
    if (result.kind === 'none') {
      console.error(`[finance-month-close-ai] note refused: ${result.code}`);
      return answer('failed');
    }
    if (ai.kept.size >= MONTH_CLOSE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text: result.text, order: result.order, at: now() });
    return answer('used', result.text, result.order);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-month-close-ai] note failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
