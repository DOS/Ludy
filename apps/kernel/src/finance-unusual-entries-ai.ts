// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's possible things to look at on the monthly review of unusual entries, on the API side (#5182). finance.unusual_entries.list runs in the member's own transaction and gives the ranked hits; the
// model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The facts are built from that read in code, never from the caller, and
// carry no figure, date, account code, voucher number or name at all: the rule that flagged each hit as a fixed phrase, the kind of voucher and one fixed detail (packages/agent unusual-entries.ts). A note is
// dropped when it states a number, a date or a name it was not given, says the entry is wrong, claims certainty, advises or is not marked as a possibility.
//
// The notes are read, never written: nothing here stores a text or changes the books, and it is not a command. When there is no model, the AI budget is spent, the member's calls are too frequent, the call
// fails or every note is refused, the answer names the state (`ai`) with no notes and the card shows the same list without a sentence. An answer is kept for a while by its facts, so reopening the card does
// not pay for the same notes twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, unusualEntriesFactsText, type InboxReader, type UnusualEntriesNoteFacts, type UnusualEntriesNoteHit } from '@ludy/agent';
import { UNUSUAL_NOTE_HITS, unusualEntryHitKey, type FinanceUnusualEntries, type UnusualEntriesExplanation } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface UnusualEntriesAi {
  reader: Pick<InboxReader, 'unusualEntriesNotes'> | null;
  budget: DraftBudget;
  // Notes by org and facts, with the time they were written.
  kept: Map<string, { notes: UnusualEntriesExplanation['notes']; at: number }>;
}

export const UNUSUAL_ENTRIES_KEEP_MS = 30 * 60 * 1000;
export const UNUSUAL_ENTRIES_KEEP_MAX = 200;

export function unusualEntriesAi(reader: UnusualEntriesAi['reader'], budget: DraftBudget): UnusualEntriesAi {
  return { reader, budget, kept: new Map() };
}

// The hits the coworker is given (the best ranked first, at most UNUSUAL_NOTE_HITS) as facts, and the key of each row to put an answer back on its hit. Only the closed labels cross: never an amount, a date, an
// account code, a number, a name or the memo.
export function unusualEntriesFacts(review: FinanceUnusualEntries, language: 'vi' | 'en'): { facts: UnusualEntriesNoteFacts; keys: string[] } {
  const hits = review.hits.slice(0, UNUSUAL_NOTE_HITS);
  return {
    keys: hits.map((h) => unusualEntryHitKey(h.rule, h.entryId)),
    facts: {
      language,
      hits: hits.map((h): UnusualEntriesNoteHit => ({
        rule: h.rule,
        sourceKind: h.sourceKind,
        ...(h.direction ? { direction: h.direction } : {}),
        ...(h.basis ? { basis: h.basis } : {}),
        ...(h.day ? { day: h.day } : {}),
        ...(h.control ? { control: h.control } : {}),
      })),
    },
  };
}

export async function explainUnusualEntries(
  ai: UnusualEntriesAi,
  orgId: string,
  userId: string,
  review: FinanceUnusualEntries,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<UnusualEntriesExplanation> {
  const answer = (state: UnusualEntriesExplanation['ai'], notes: UnusualEntriesExplanation['notes'] = []): UnusualEntriesExplanation => ({ ai: state, notes });
  if (!ai.reader) return answer('off');
  const { facts, keys } = unusualEntriesFacts(review, language);
  if (facts.hits.length === 0) return answer('quiet');
  // The keys are part of the cache key: two months with the same facts but other entries must not share notes.
  const key = `${orgId}\n${language}\n${keys.join(',')}\n${unusualEntriesFactsText(facts)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < UNUSUAL_ENTRIES_KEEP_MS) return answer('used', hit.notes);
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.unusualEntriesNotes(facts);
    if (result.kind === 'none') {
      console.error(`[finance-unusual-entries-ai] notes refused: ${result.code}`);
      return answer('failed');
    }
    const notes = result.notes.flatMap((n) => {
      const noteKey = keys[n.row - 1];
      return noteKey === undefined ? [] : [{ key: noteKey, text: n.text }];
    });
    if (notes.length === 0) return answer('failed');
    if (ai.kept.size >= UNUSUAL_ENTRIES_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { notes, at: now() });
    return answer('used', notes);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-unusual-entries-ai] notes failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
