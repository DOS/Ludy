// SPDX-License-Identifier: AGPL-3.0-only
// The accounting coworker's notes on the AMIS preview, on the API side (#3904, S5 of #3854). The preview is run again here in the caller's own context (misaAmisPreview), code takes the SET of blocker kinds on its
// list, and the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The model is told the language and those kinds with their
// fixed meaning and nothing else (no count, voucher, item code or party), and each note it writes is dropped when it is for a kind that is not on the list, has a number, a link, says something was done or
// promises a result (packages/agent misa-amis-blocker-notes.ts).
//
// The notes are read, never written: nothing here changes a voucher, a blocker or what is sent, and it is not a command. With no blocker there is no call (`none`). When there is no model, the AI budget is spent,
// the member's calls are too frequent, the call fails or every note is dropped, the answer names the state (`ai`) with no notes and the screen shows the list alone. An answer is kept for a while by its kinds, so
// reopening the preview does not pay for the same notes twice. A failure is named, never quoted: neither the kinds nor the model's answer is logged.
import { AiBudgetExhaustedError, MISA_AMIS_BLOCKER_KINDS, misaAmisBlockerNotesFactsText, misaAmisBlockerNotesHaveNews, type InboxReader, type MisaAmisBlockerKind, type MisaAmisBlockerNotesFacts, type MisaAmisNotesProduct } from '@crove/agent';
import type { MisaAmisBlockerNotes, MisaAmisPreview } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface MisaAmisBlockerNotesAi {
  reader: Pick<InboxReader, 'misaAmisBlockerNotes'> | null;
  budget: DraftBudget;
  // Notes by org, language and kinds, with the time they were written; `notes` null is a refusal, kept shorter so a set the checks always refuse does not pay again on every open.
  kept: Map<string, { notes: MisaAmisBlockerNotes['notes'] | null; at: number }>;
}

export const MISA_AMIS_BLOCKER_NOTES_KEEP_MS = 30 * 60 * 1000;
export const MISA_AMIS_BLOCKER_NOTES_REFUSED_KEEP_MS = 5 * 60 * 1000;
export const MISA_AMIS_BLOCKER_NOTES_KEEP_MAX = 200;

export function misaAmisBlockerNotesAi(reader: MisaAmisBlockerNotesAi['reader'], budget: DraftBudget): MisaAmisBlockerNotesAi {
  return { reader, budget, kept: new Map() };
}

/** The kinds of blocker on the list of a preview, each once, in the order the agent names them. */
export function misaAmisBlockerKinds(preview: MisaAmisPreview): MisaAmisBlockerKind[] {
  const present = new Set<string>(preview.items.flatMap((item) => item.blockers.map((b) => b.code)));
  return MISA_AMIS_BLOCKER_KINDS.filter((kind) => present.has(kind));
}

export async function explainMisaAmisBlockers(
  ai: MisaAmisBlockerNotesAi,
  orgId: string,
  userId: string,
  preview: MisaAmisPreview,
  language: 'vi' | 'en',
  // The MISA product of the connection the preview is for (its wording differs where the fix does); absent when the ask names no connection, which reads as AMIS as before.
  product: MisaAmisNotesProduct = 'amis',
  now: () => number = Date.now,
): Promise<MisaAmisBlockerNotes> {
  const answer = (state: MisaAmisBlockerNotes['ai'], notes: MisaAmisBlockerNotes['notes'] = []): MisaAmisBlockerNotes => ({ ai: state, notes });
  const told: MisaAmisBlockerNotesFacts = { language, product, kinds: misaAmisBlockerKinds(preview) };
  if (!misaAmisBlockerNotesHaveNews(told)) return answer('none');
  if (!ai.reader) return answer('off');
  const key = `${orgId}\n${language}\n${product}\n${misaAmisBlockerNotesFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < (hit.notes === null ? MISA_AMIS_BLOCKER_NOTES_REFUSED_KEEP_MS : MISA_AMIS_BLOCKER_NOTES_KEEP_MS)) return hit.notes === null ? answer('failed') : answer('used', hit.notes);
  const remember = (notes: MisaAmisBlockerNotes['notes'] | null) => {
    if (ai.kept.size >= MISA_AMIS_BLOCKER_NOTES_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { notes, at: now() });
  };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.misaAmisBlockerNotes(told);
    if (result.kind === 'none') {
      console.error(`[finance-misa-amis-blocker-notes-ai] notes refused: ${result.code}`);
      remember(null);
      return answer('failed');
    }
    const notes = result.notes.map((n) => ({ code: n.kind, text: n.text }));
    remember(notes);
    return answer('used', notes);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-misa-amis-blocker-notes-ai] notes failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
