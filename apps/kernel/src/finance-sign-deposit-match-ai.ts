// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's one sentence on why a money-in bank statement line may match an executed eSign
// VietQR deposit request (#4723). Runs outside DB transactions on non-PII facts only (date, amount, CK-* token,
// signer-notice flag), metered under finance.bank_match_explain.
import {
  AiBudgetExhaustedError,
  signDepositMatchFactsText,
  type InboxReader,
  type SignDepositMatchFacts,
} from '@ludy/agent';
import type { BankSignDepositCandidate, BankSignDepositExplanation } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface SignDepositMatchAi {
  reader: Pick<InboxReader, 'signDepositMatchSentence'> | null;
  budget: DraftBudget;
  kept: Map<string, { text: string; at: number }>;
}

export const SIGN_DEPOSIT_MATCH_KEEP_MS = 30 * 60 * 1000;
export const SIGN_DEPOSIT_MATCH_KEEP_MAX = 200;

export function signDepositMatchAi(
  reader: SignDepositMatchAi['reader'],
  budget: DraftBudget,
): SignDepositMatchAi {
  return { reader, budget, kept: new Map() };
}

export function signDepositMatchFacts(
  candidate: BankSignDepositCandidate,
  date: string,
  language: 'vi' | 'en',
): SignDepositMatchFacts {
  return {
    date,
    amount: candidate.amount,
    memoToken: candidate.memoToken,
    hasSignerNotice: candidate.signerNoticeAt !== null,
    language,
  };
}

export async function explainSignDepositMatch(
  ai: SignDepositMatchAi,
  orgId: string,
  userId: string,
  candidate: BankSignDepositCandidate | null,
  date: string,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<BankSignDepositExplanation> {
  const answer = (state: BankSignDepositExplanation['ai'], text: string | null = null): BankSignDepositExplanation => ({ ai: state, text });
  if (!candidate) return answer('none');
  if (!ai.reader) return answer('off');

  const facts = signDepositMatchFacts(candidate, date, language);
  const key = `${orgId}\n${language}\n${signDepositMatchFactsText(facts)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < SIGN_DEPOSIT_MATCH_KEEP_MS) return answer('used', hit.text);

  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');

  try {
    const result = await ai.reader.signDepositMatchSentence(facts);
    if (result.kind === 'none') {
      console.error(`[finance-sign-deposit-match-ai] sentence refused: ${result.code}`);
      return answer('failed');
    }
    if (ai.kept.size >= SIGN_DEPOSIT_MATCH_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text: result.text, at: now() });
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-sign-deposit-match-ai] sentence failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
