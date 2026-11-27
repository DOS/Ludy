// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's sentences on the quarter card, on the API side (#5183). finance.quarter_summary runs in the member's own transaction and gives every figure with how each moved; the model call then runs
// here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). CODE picks the rows worth a sentence (the figures that moved the same way against both bases first,
// then the ones that moved against either, then the steady ones; at most QUARTER_SUMMARY_MAX_NOTES) and builds the facts from the read, never from the caller. The facts carry no figure, date, code or name at all:
// a fixed row name and two movement labels per row, and whether sales invoices were overdue at the end (packages/agent quarter-summary.ts). A sentence is dropped when it states any of those, a cause, a promise or
// advice, or says a direction its row does not have, and a set below its floor is dropped whole.
//
// The sentences are read, never written: nothing here stores a text or changes the books, and it is not a command. When there is no model, the AI budget is spent, the member's calls are too frequent, the call
// fails or the set is refused, the answer names the state (`ai`) with no sentences and the card shows the same figures without any. An answer is kept for a while by its facts, so reopening the card does not pay for
// the same sentences twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, quarterSummaryFactsText, type InboxReader, type QuarterSummaryNoteFacts } from '@ludy/agent';
import { QUARTER_SUMMARY_MAX_NOTES, QUARTER_SUMMARY_ROWS, type FinanceQuarterSummary, type QuarterSummaryExplanation, type QuarterSummaryFigure, type QuarterSummaryRow, type QuarterTrend } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface QuarterSummaryAi {
  reader: Pick<InboxReader, 'quarterSummaryNotes'> | null;
  budget: DraftBudget;
  // Sentences by org and facts, with the time they were written.
  kept: Map<string, { notes: QuarterSummaryExplanation['notes']; at: number }>;
}

export const QUARTER_SUMMARY_KEEP_MS = 30 * 60 * 1000;
export const QUARTER_SUMMARY_KEEP_MAX = 200;

export function quarterSummaryAi(reader: QuarterSummaryAi['reader'], budget: DraftBudget): QuarterSummaryAi {
  return { reader, budget, kept: new Map() };
}

// Which way a label moved: up (rose, or appeared for the first time), down, flat (steady), or nowhere (none).
function directionOf(label: QuarterTrend): 'up' | 'down' | 'flat' | null {
  if (label === 'rose' || label === 'first_time') return 'up';
  if (label === 'fell') return 'down';
  return label === 'steady' ? 'flat' : null;
}

// How much a row stands out, from its two labels: 5 moved the same way against both bases, 4 moved opposite ways, 3 moved against one base, 1 only steady, 0 nothing to say (never asked).
export function standoutScore(figure: Pick<QuarterSummaryFigure, 'vsPrevious' | 'vsLastYear'>): number {
  const a = directionOf(figure.vsPrevious);
  const b = directionOf(figure.vsLastYear);
  const moved = [a, b].filter((d) => d === 'up' || d === 'down');
  if (moved.length === 2) return a === b ? 5 : 4;
  if (moved.length === 1) return 3;
  return a === 'flat' || b === 'flat' ? 1 : 0;
}

// The rows the coworker is given, in the card's order: the most striking ones (at most QUARTER_SUMMARY_MAX_NOTES, ties in the card's order), and the key of each row to put an answer back on its row. A row with
// nothing to say (both labels none) is never asked.
export function quarterSummaryFacts(summary: FinanceQuarterSummary, language: 'vi' | 'en'): { facts: QuarterSummaryNoteFacts; keys: QuarterSummaryRow[] } {
  const order = new Map<string, number>(QUARTER_SUMMARY_ROWS.map((key, i) => [key, i]));
  const picked = summary.figures
    .map((figure, index) => ({ figure, index, score: standoutScore(figure) }))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score || x.index - y.index)
    .slice(0, QUARTER_SUMMARY_MAX_NOTES)
    .sort((x, y) => (order.get(x.figure.key) ?? 0) - (order.get(y.figure.key) ?? 0));
  return {
    keys: picked.map((r) => r.figure.key),
    facts: {
      language,
      entity: summary.kind,
      rows: picked.map((r) => ({ row: r.figure.key, vsPrevious: r.figure.vsPrevious, vsLastYear: r.figure.vsLastYear, overdue: r.figure.key === 'receivables' && summary.overdue.count > 0 })),
    },
  };
}

export async function explainQuarterSummary(
  ai: QuarterSummaryAi,
  orgId: string,
  userId: string,
  summary: FinanceQuarterSummary,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<QuarterSummaryExplanation> {
  const answer = (state: QuarterSummaryExplanation['ai'], notes: QuarterSummaryExplanation['notes'] = []): QuarterSummaryExplanation => ({ ai: state, notes });
  if (!ai.reader) return answer('off');
  const { facts, keys } = quarterSummaryFacts(summary, language);
  if (facts.rows.length === 0) return answer('quiet');
  // The row keys are part of the key: two quarters with the same facts text but other rows must not share sentences.
  const key = `${orgId}\n${language}\n${keys.join(',')}\n${quarterSummaryFactsText(facts)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < QUARTER_SUMMARY_KEEP_MS) return answer('used', hit.notes);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.quarterSummaryNotes(facts);
    if (result.kind === 'none') {
      console.error(`[finance-quarter-summary-ai] notes refused: ${result.code}`);
      return answer('failed');
    }
    const notes = result.notes.flatMap((n) => {
      const row = keys[n.row - 1];
      return row === undefined ? [] : [{ row, text: n.text }];
    });
    if (notes.length === 0) return answer('failed');
    if (ai.kept.size >= QUARTER_SUMMARY_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { notes, at: now() });
    return answer('used', notes);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-quarter-summary-ai] notes failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
