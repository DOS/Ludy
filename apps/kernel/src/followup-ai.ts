// SPDX-License-Identifier: AGPL-3.0-only
// The meetings coworker's wording of a follow-up email, on the API side (L3, #2590). meetings.followup.draft runs in the recorder's own transaction and gives the language
// and the sender's name; the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member, so the
// budgets and the kill switches stop it). The model is told none of the meeting (not the summary, a decision, an action item, a name or a date), and its text is refused when
// it holds a figure, a link or an address (packages/agent followup.ts).
//
// The wording is read, never written: nothing here stores a text or sends a mail, and it is not a command. The recorder reads it, edits it and sends it through
// meetings.followup.send, which checks every text the same way whatever its origin and rebuilds the facts from the published result. When the model is off, the AI budget is
// spent or a kill switch is on, the member's calls are too frequent, the call fails or its text is refused, the answer names the state (`ai`) with no words, and the dialog keeps
// the fixed words. A failure is named, never quoted: neither the org's name, the hint nor the model's answer is logged.
import { AiBudgetExhaustedError, type InboxReader } from '@crove/agent';
import { FOLLOWUP_CLOSING_MAX, FOLLOWUP_LEAD_MAX, followupClean, followupWordsProblem, type FollowupWording } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface FollowupAi {
  reader: Pick<InboxReader, 'followupWords'> | null;
  budget: DraftBudget;
}

export async function wordFollowup(ai: FollowupAi, orgId: string, userId: string, facts: { lang: 'vi' | 'en'; org: string }, hint: string | undefined): Promise<FollowupWording> {
  const answer = (state: FollowupWording['ai'], words: FollowupWording['words'] = null): FollowupWording => ({ ai: state, words });
  if (!ai.reader) return answer('off');
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.followupWords({ language: facts.lang, orgName: facts.org, ...(hint ? { hint } : {}) });
    if (result.kind === 'none') {
      console.error(`[followup-ai] wording refused: ${result.code}`);
      return answer('failed');
    }
    // The send command's own checks, run here too: what the dialog shows is never a text the send would refuse.
    const lead = followupClean(result.words.lead, false);
    const closing = followupClean(result.words.closing, false);
    if (followupWordsProblem(lead, FOLLOWUP_LEAD_MAX) !== null || followupWordsProblem(closing, FOLLOWUP_CLOSING_MAX) !== null) {
      console.error('[followup-ai] wording refused: SEND_CHECK');
      return answer('failed');
    }
    return answer('used', { lead, closing });
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[followup-ai] wording failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
