// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's possible reasons on the expense variance card, on the API side (#4392). finance.expense_variance runs in the member's own transaction and gives the flagged lines with their suppliers
// or vouchers; the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The facts are built from that read in code, never from
// the caller, and carry no figure at all: a fixed kind of expense, the direction, the kind of voucher and single, several or none (packages/agent expense-variance.ts), and no name of anyone. A note
// is dropped when it states a number, a date or a name it was not given, claims certainty or is not marked as a possibility.
//
// The notes are read, never written: nothing here stores a text or changes the books, and it is not a command. When there is no model, the AI budget is spent, the member's calls are too frequent, the call
// fails or every note is refused, the answer names the state (`ai`) with no notes and the card shows the same table without a sentence. An answer is kept for a while by its facts, so reopening the card does
// not pay for the same notes twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, expenseVarianceFactsText, type ExpenseVarianceNoteFacts, type InboxReader } from '@ludy/agent';
import { EXPENSE_VARIANCE_NOTE_LINES, type ExpenseVarianceExplanation, type FinanceExpenseVariance } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface ExpenseVarianceAi {
  reader: Pick<InboxReader, 'expenseVarianceNotes'> | null;
  budget: DraftBudget;
  // Notes by org and facts, with the time they were written.
  kept: Map<string, { notes: ExpenseVarianceExplanation['notes']; at: number }>;
}

export const EXPENSE_VARIANCE_KEEP_MS = 30 * 60 * 1000;
export const EXPENSE_VARIANCE_KEEP_MAX = 200;

export function expenseVarianceAi(reader: ExpenseVarianceAi['reader'], budget: DraftBudget): ExpenseVarianceAi {
  return { reader, budget, kept: new Map() };
}

// The kind of expense a line is, as the three-digit group the prompt labels. Under TT133 the chart has 6421 (selling expenses) and 6422 (administration), both under 642, so a 6421 line is the SELLING group
// (641's label), not 642's; under TT99 the line is already 641 or 642. Every other line is its own first three digits.
export function expenseVarianceGroup(code: string, regime: FinanceExpenseVariance['regime']): string {
  if (regime === 'tt133' && code === '6421') return '641';
  if (regime === 'tt133' && code === '6422') return '642';
  return code.slice(0, 3);
}

// The lines the coworker is given (the largest changes first, at most EXPENSE_VARIANCE_NOTE_LINES) as facts, and the account code of each row to put an answer back on its line. A voucher counts as one voucher in
// the month it is in and as none when it is only in the months it is compared with; a supplier is none, single or several by its vouchers of the month.
export function expenseVarianceFacts(variance: FinanceExpenseVariance, language: 'vi' | 'en'): { facts: ExpenseVarianceNoteFacts; codes: string[] } {
  const lines = variance.lines.slice(0, EXPENSE_VARIANCE_NOTE_LINES);
  return {
    codes: lines.map((l) => l.code),
    facts: {
      language,
      lines: lines.map((l) => ({
        group: expenseVarianceGroup(l.code, variance.regime),
        direction: l.direction,
        against: l.against,
        isNew: l.isNew,
        contributors: l.contributors.map((c) => ({
          kind: c.kind,
          sourceKind: c.sourceKind,
          vouchers: c.vouchers === 0 ? ('none' as const) : c.vouchers === 1 ? ('single' as const) : ('several' as const),
        })),
      })),
    },
  };
}

export async function explainExpenseVariance(
  ai: ExpenseVarianceAi,
  orgId: string,
  userId: string,
  variance: FinanceExpenseVariance,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<ExpenseVarianceExplanation> {
  const answer = (state: ExpenseVarianceExplanation['ai'], notes: ExpenseVarianceExplanation['notes'] = []): ExpenseVarianceExplanation => ({ ai: state, notes });
  if (!ai.reader) return answer('off');
  const { facts, codes } = expenseVarianceFacts(variance, language);
  if (facts.lines.length === 0) return answer('quiet');
  // The codes are part of the key: two months with the same facts but other lines must not share notes.
  const key = `${orgId}\n${language}\n${codes.join(',')}\n${expenseVarianceFactsText(facts)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < EXPENSE_VARIANCE_KEEP_MS) return answer('used', hit.notes);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.expenseVarianceNotes(facts);
    if (result.kind === 'none') {
      console.error(`[finance-expense-variance-ai] notes refused: ${result.code}`);
      return answer('failed');
    }
    const notes = result.notes.flatMap((n) => {
      const code = codes[n.row - 1];
      return code === undefined ? [] : [{ code, text: n.text }];
    });
    if (notes.length === 0) return answer('failed');
    if (ai.kept.size >= EXPENSE_VARIANCE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { notes, at: now() });
    return answer('used', notes);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-expense-variance-ai] notes failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
