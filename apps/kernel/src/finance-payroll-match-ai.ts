// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's one line on why a bank statement line may be a payroll payment, on the API side (#2532). finance.bank.payroll_match runs in the owner's or admin's own transaction and decides
// by the amount; the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The model is told the kind, the month,
// the amount and the line's date, and whether the description names the payment (a yes or no): no name, description, account or document text. Its text is refused when it states a number the facts do
// not hold (packages/agent payroll-match.ts), so what it writes can never state a fact the books do not hold.
//
// The line is read, never written: nothing here stores a text or changes the books, and it is not a command. When there is no model, the AI budget is spent, the member's calls are too frequent, the
// call fails or its text is refused, the answer names the state (`ai`) with no words and the screen shows the reason code alone. An answer is kept for a while by its facts, so reopening the screen does
// not pay for the same line twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, payrollMatchFactsText, type InboxReader, type PayrollMatchFacts } from '@crove/agent';
import type { BankPayrollCandidate, BankPayrollExplanation } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface PayrollMatchAi {
  reader: Pick<InboxReader, 'payrollMatchSentence'> | null;
  budget: DraftBudget;
  // Sentences by org and facts, with the time they were written.
  kept: Map<string, { text: string; at: number }>;
}

export const PAYROLL_MATCH_KEEP_MS = 30 * 60 * 1000;
export const PAYROLL_MATCH_KEEP_MAX = 200;

export function payrollMatchAi(reader: PayrollMatchAi['reader'], budget: DraftBudget): PayrollMatchAi {
  return { reader, budget, kept: new Map() };
}

// The facts the sentence is written from: the candidate and the line's date, nothing of the line's description but whether it names the payment.
export function payrollMatchFacts(candidate: BankPayrollCandidate, date: string, language: 'vi' | 'en'): PayrollMatchFacts {
  return { language, kind: candidate.kind, month: candidate.month, amount: candidate.amount, date, described: candidate.reason === 'amount_note' };
}

export async function explainPayrollMatch(
  ai: PayrollMatchAi,
  orgId: string,
  userId: string,
  candidate: BankPayrollCandidate | null,
  date: string,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<BankPayrollExplanation> {
  const answer = (state: BankPayrollExplanation['ai'], text: string | null = null): BankPayrollExplanation => ({ ai: state, text });
  if (!candidate) return answer('none');
  if (!ai.reader) return answer('off');
  const facts = payrollMatchFacts(candidate, date, language);
  const key = `${orgId}\n${language}\n${payrollMatchFactsText(facts)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < PAYROLL_MATCH_KEEP_MS) return answer('used', hit.text);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.payrollMatchSentence(facts);
    if (result.kind === 'none') {
      console.error(`[finance-payroll-match-ai] sentence refused: ${result.code}`);
      return answer('failed');
    }
    if (ai.kept.size >= PAYROLL_MATCH_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text: result.text, at: now() });
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-payroll-match-ai] sentence failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
