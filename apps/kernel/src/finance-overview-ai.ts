// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentence on the Tổng quan of the Kế toán app, on the API side (#2631). finance.overview runs in the member's own transaction and
// gives the aggregated figures; the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and
// the member). The model is told the figures and nothing else (no name, tax code or document text), and its text is refused when it states a number the
// figures do not hold (packages/agent overview.ts), so what it writes can never state a fact the books do not hold.
//
// The sentence is read, never written: nothing here stores a text or changes the books, and it is not a command. When there is no model, the AI budget is spent,
// the member's calls are too frequent, the call fails or its text is refused, the answer names the state (`ai`) with no words and the screen shows the figures
// alone. An answer is kept for a while by its figures, so reopening the screen or changing tabs does not pay for the same sentence twice. A failure is named,
// never quoted: neither the figures nor the model's answer is logged.
import { AiBudgetExhaustedError, overviewFactsText, overviewQuiet, type InboxReader, type OverviewFacts } from '@crove/agent';
import type { FinanceOverview, OverviewExplanation } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface OverviewAi {
  reader: Pick<InboxReader, 'overviewSentence'> | null;
  budget: DraftBudget;
  // Sentences by org and figures, with the time they were written.
  kept: Map<string, { text: string; at: number }>;
}

export const OVERVIEW_KEEP_MS = 30 * 60 * 1000;
export const OVERVIEW_KEEP_MAX = 200;

export function overviewAi(reader: OverviewAi['reader'], budget: DraftBudget): OverviewAi {
  return { reader, budget, kept: new Map() };
}

// The figures the sentence is written from: the four cards and the five cost groups, now and in the period before.
export function overviewFacts(overview: FinanceOverview, language: 'vi' | 'en'): OverviewFacts {
  return {
    language,
    figures: (['cash', 'profit', 'receivables', 'payables'] as const).map((key) => ({ key, amount: overview[key].amount, previous: overview[key].previous })),
    expenses: overview.expenses.map((e) => ({ code: e.group, amount: e.amount, previous: e.previous })),
  };
}

export async function explainOverview(
  ai: OverviewAi,
  orgId: string,
  userId: string,
  overview: FinanceOverview,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<OverviewExplanation> {
  const answer = (state: OverviewExplanation['ai'], text: string | null = null): OverviewExplanation => ({ ai: state, text });
  if (!ai.reader) return answer('off');
  const facts = overviewFacts(overview, language);
  if (overview.empty || overviewQuiet(facts)) return answer('quiet');
  const key = `${orgId}\n${language}\n${overviewFactsText(facts)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < OVERVIEW_KEEP_MS) return answer('used', hit.text);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.overviewSentence(facts);
    if (result.kind === 'none') {
      console.error(`[finance-overview-ai] sentence refused: ${result.code}`);
      return answer('failed');
    }
    if (ai.kept.size >= OVERVIEW_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text: result.text, at: now() });
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-overview-ai] sentence failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
