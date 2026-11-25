// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's one sentence explaining a matched signed-contract VietQR deposit (#4723),
// built strictly from non-PII facts (date, VND amount, CK-<CODE> memo token, signer-notice boolean).
import { statedFiguresProblem } from './overview.ts';
import { payrollMatchAmountText } from './payroll-match.ts';
import { sentenceClaimsDone, sentenceCount } from './supplier-payable-line.ts';

export const SIGN_DEPOSIT_MATCH_SENTENCE_MAX = 240;

export interface SignDepositMatchFacts {
  date: string;
  amount: string;
  memoToken: string;
  hasSignerNotice: boolean;
  language: 'vi' | 'en';
}

export type SignDepositMatchResult =
  | { kind: 'sentence'; text: string }
  | { kind: 'none'; code: 'REFUSED' };

export function signDepositMatchFactsText(facts: SignDepositMatchFacts): string {
  const dong = facts.language === 'en' ? 'VND' : 'đồng';
  return [
    `Date: ${facts.date}`,
    `Amount: ${payrollMatchAmountText(facts.amount, facts.language)} ${dong}`,
    `Transfer memo token: ${facts.memoToken}`,
    `Signer already reported transfer: ${facts.hasSignerNotice ? 'yes' : 'no'}`,
  ].join('\n');
}

export function signDepositMatchInstructions(language: 'vi' | 'en'): string {
  const lang =
    language === 'en'
      ? 'Write in plain English, at most one short sentence (under 240 characters).'
      : 'Viết bằng tiếng Việt có dấu đầy đủ, ngắn gọn trong đúng một câu (dưới 240 ký tự).';
  return [
    'You are the Ludy Accounting coworker explaining why a money-in bank statement line may match a completed eSign VietQR deposit request.',
    lang,
    'ONLY state the exact date, amount, CK-* transfer memo token, and whether a signer transfer notice exists.',
    'Use the present tense only (never write past markers like "đã", "was", or "has been").',
    'NEVER claim the payment or voucher is already recorded, approved, matched, or paid; a person still confirms the receipt voucher.',
    'Do not include any URL, email address, phone number, person name, company name, or extra numbers.',
  ].join('\n');
}

export function signDepositMatchPrompt(facts: SignDepositMatchFacts): string {
  return `${signDepositMatchFactsText(facts)}\n\nExplain why this bank line fits the deposit request in one sentence.`;
}

const PAID_OR_POSTED_RE =
  /\b(?:already paid|already recorded|already posted|already approved|already matched|auto[- ]?posted|da ghi so|da hach toan|da duyet|da khop)\b/i;

export function checkSignDepositMatchSentence(
  facts: SignDepositMatchFacts,
  output: { sentence?: string } | null | undefined,
): SignDepositMatchResult {
  const text = (output?.sentence ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (
    !text ||
    Array.from(text).length > SIGN_DEPOSIT_MATCH_SENTENCE_MAX ||
    sentenceCount(text) !== 1 ||
    sentenceClaimsDone(text)
  ) {
    return { kind: 'none', code: 'REFUSED' };
  }
  const normalizedToken = facts.memoToken.trim().toUpperCase();
  if (!text.toUpperCase().includes(normalizedToken)) {
    return { kind: 'none', code: 'REFUSED' };
  }
  const strippedForPaidCheck = text.normalize('NFD').replace(/\p{M}+/gu, '');
  if (PAID_OR_POSTED_RE.test(strippedForPaidCheck)) {
    return { kind: 'none', code: 'REFUSED' };
  }
  if (statedFiguresProblem(text, [signDepositMatchFactsText(facts)])) {
    return { kind: 'none', code: 'REFUSED' };
  }
  return { kind: 'sentence', text };
}
