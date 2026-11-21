// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's one line above the MISA export check, on the API side (#3848 slice B). The check is run again here in the caller's own context (misaCheck), code counts the findings per kind, and the
// model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The model is told those counts and the number of rows and nothing else,
// and its text is refused when it states a number the counts do not hold, sets a count against the wrong kind, has a link, or says something was fixed, imported or sent (packages/agent misa-check-line.ts).
//
// The line is read, never written: nothing here changes a voucher or stores a text, and it is not a command. With nothing flagged there is no call (`none`). When there is no model, the AI budget is spent, the
// member's calls are too frequent, the call fails or its text is refused, the answer names the state (`ai`) with no words and the screen shows the list alone. An answer is kept for a while by its counts, so
// reopening the check does not pay for the same line twice. A failure is named, never quoted: neither the counts nor the model's answer is logged.
import { AiBudgetExhaustedError, misaCheckLineFactsText, misaCheckLineHasNews, type InboxReader, type MisaCheckLineFacts } from '@ludy/agent';
import type { MisaCheck, MisaCheckCounts, MisaCheckLine } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface MisaCheckLineAi {
  reader: Pick<InboxReader, 'misaCheckLineSentence'> | null;
  budget: DraftBudget;
  // Sentences by org and counts, with the time they were written; `text` null is a refusal, kept shorter so a count set the check always refuses does not pay again on every open.
  kept: Map<string, { text: string | null; at: number }>;
}

export const MISA_CHECK_LINE_KEEP_MS = 30 * 60 * 1000;
export const MISA_CHECK_LINE_REFUSED_KEEP_MS = 5 * 60 * 1000;
export const MISA_CHECK_LINE_KEEP_MAX = 200;

export function misaCheckLineAi(reader: MisaCheckLineAi['reader'], budget: DraftBudget): MisaCheckLineAi {
  return { reader, budget, kept: new Map() };
}

/** The counts of a check, by code: the findings of each kind summed over the groups, and the rows. */
export function misaCheckCounts(check: MisaCheck): MisaCheckCounts {
  const of = (kind: MisaCheck['groups'][number]['kind']) => check.groups.filter((g) => g.kind === kind).reduce((sum, g) => sum + g.count, 0);
  return { rows: check.rows, codes: of('MISSING_CODE'), required: of('MISSING_REQUIRED'), vat: of('VAT_CODE'), accounts: of('ACCOUNT_NOT_IN_CHART'), tooLong: of('TOO_LONG') };
}

// The facts the sentence is written from: the counts and the language, nothing else.
export function misaCheckLineFacts(counts: MisaCheckCounts, language: 'vi' | 'en'): MisaCheckLineFacts {
  return { language, ...counts };
}

export async function explainMisaCheckLine(
  ai: MisaCheckLineAi,
  orgId: string,
  userId: string,
  check: MisaCheck,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<MisaCheckLine> {
  const counts = misaCheckCounts(check);
  const answer = (state: MisaCheckLine['ai'], text: string | null = null): MisaCheckLine => ({ counts, ai: state, text });
  const told = misaCheckLineFacts(counts, language);
  if (!misaCheckLineHasNews(told)) return answer('none');
  if (!ai.reader) return answer('off');
  const key = `${orgId}\n${language}\n${misaCheckLineFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < (hit.text === null ? MISA_CHECK_LINE_REFUSED_KEEP_MS : MISA_CHECK_LINE_KEEP_MS)) return hit.text === null ? answer('failed') : answer('used', hit.text);
  const remember = (k: string, text: string | null) => {
    if (ai.kept.size >= MISA_CHECK_LINE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(k, { text, at: now() });
  };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.misaCheckLineSentence(told);
    if (result.kind === 'none') {
      console.error(`[finance-misa-check-line-ai] sentence refused: ${result.code}`);
      remember(key, null);
      return answer('failed');
    }
    remember(key, result.text);
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-misa-check-line-ai] sentence failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
