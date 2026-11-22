// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's one sentence on an open bank line the matcher could not settle, on the API side (#4219, Tingee S4c). finance.bank.line_voucher runs in the caller's own transaction and the
// deterministic matcher lists the candidates (this file never recomputes or reorders them); the model call then runs here, outside any transaction, through the AI budget meter under finance.bank_match_explain
// (the request's AI scope names the org and the member). The model is told the direction, date, amount and the NUMBER of candidates, no name, description or account, and its text is refused when it states a
// figure the facts do not hold, picks a candidate or says something was matched, posted or paid (packages/agent bank-candidates-line.ts).
//
// The sentence is read, never written: it picks nothing, changes no ranking and makes no voucher, and it is not a command; a person chooses and a person approves the voucher. A line that is not open, has one
// candidate that stands out, none at all, or an amount with fractions of a dong answers `none` with no call. When there is no model, the AI budget is spent, the member's calls are too frequent, the call fails
// or its text is refused, the answer names the state (`ai`) with no words and the screen shows the line as it is. An answer is kept for a while by its facts. A failure is named, never quoted.
import { Decimal } from '@ludy/l10n-vn';
import { AiBudgetExhaustedError, bankCandidatesLineFactsText, type BankCandidatesLineFacts, type InboxReader } from '@ludy/agent';
import type { BankCandidatesLine, BankLineVoucher } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface BankCandidatesLineAi {
  reader: Pick<InboxReader, 'bankCandidatesLineSentence'> | null;
  budget: DraftBudget;
  // Sentences by org and facts, with the time they were written; `text` null is a refusal, kept shorter so a fact set the check always refuses does not pay again on every open.
  kept: Map<string, { text: string | null; at: number }>;
}

export const BANK_CANDIDATES_LINE_KEEP_MS = 30 * 60 * 1000;
export const BANK_CANDIDATES_LINE_REFUSED_KEEP_MS = 5 * 60 * 1000;
export const BANK_CANDIDATES_LINE_KEEP_MAX = 200;

export function bankCandidatesLineAi(reader: BankCandidatesLineAi['reader'], budget: DraftBudget): BankCandidatesLineAi {
  return { reader, budget, kept: new Map() };
}

// The look list on the screen comes from finance.bank.match_groups (withBalances=false), while this RPC rereads the line with finance.bank.line_voucher (withBalances=true), so the server's candidate count may differ
// from the screen's: when it does and nothing is open to choice, the answer is `none` with no model call.
/** The facts of the line, by code, or null when the matcher left nothing open to choice: the line is not open, it has no candidate, it has exactly one and that one is the suggestion, or its amount has
 * fractions of a dong (the amount is written whole). The candidates are counted as the matcher listed them. */
export function bankCandidatesLineFacts(read: BankLineVoucher, language: 'vi' | 'en'): BankCandidatesLineFacts | null {
  if (read.line.state.status !== 'open') return null;
  const candidates = read.candidates.length;
  if (candidates === 0 || (candidates === 1 && read.suggested !== null)) return null;
  const amount = new Decimal(read.line.amount);
  if (amount.isZero() || !amount.isInteger()) return null;
  return { language, direction: amount.isNegative() ? 'out' : 'in', date: read.line.date, amount: amount.abs().toFixed(0), candidates };
}

export async function explainBankCandidatesLine(
  ai: BankCandidatesLineAi,
  orgId: string,
  userId: string,
  read: BankLineVoucher,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<BankCandidatesLine> {
  const answer = (state: BankCandidatesLine['ai'], text: string | null = null): BankCandidatesLine => ({ ai: state, text });
  const told = bankCandidatesLineFacts(read, language);
  if (told === null) return answer('none');
  if (!ai.reader) return answer('off');
  const key = `${orgId}\n${language}\n${bankCandidatesLineFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < (hit.text === null ? BANK_CANDIDATES_LINE_REFUSED_KEEP_MS : BANK_CANDIDATES_LINE_KEEP_MS)) return hit.text === null ? answer('failed') : answer('used', hit.text);
  const remember = (k: string, text: string | null) => {
    if (ai.kept.size >= BANK_CANDIDATES_LINE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(k, { text, at: now() });
  };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.bankCandidatesLineSentence(told);
    if (result.kind === 'none') {
      console.error(`[finance-bank-candidates-line-ai] sentence refused: ${result.code}`);
      remember(key, null);
      return answer('failed');
    }
    remember(key, result.text);
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-bank-candidates-line-ai] sentence failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
