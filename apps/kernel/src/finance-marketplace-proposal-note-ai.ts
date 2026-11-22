// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's note on a pending marketplace settlement or payout proposal, on the API side (#4389, plan docs/plan/stock-and-marketplaces.md 8.6). The stored proposal is read in the caller's
// own context (finance.marketplace.proposal_facts: the Inbox's visibility, so another org or an entity outside the caller's scope is not found), code has already computed every figure in whole dong
// and chosen the Uncertain (#2520) points from a closed table, and the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the
// member). The model is told whole-dong figures, the kinds of classified lines and the entry's account codes, and no platform, party, order, buyer or date; it words them in at most three sentences
// and the text is checked as a whole (packages/agent marketplace-proposal-note.ts).
//
// The note is read, never written: nothing here posts, changes the proposal or approves anything, and it is not a command. With no model, no budget, calls too frequent, a failed call or a refused text,
// the answer names the state (`ai`) and carries the fixed template built in code from the same figures. The Uncertain list is the same whatever `ai` says. An answer is kept for a while by org,
// language and facts, so reopening the card does not pay for the same note twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, marketplaceProposalNoteFactsText, marketplaceProposalNoteHasNews, marketplaceProposalNoteTemplate, type InboxReader, type MarketplaceProposalNoteFacts } from '@ludy/agent';
import type { MarketplaceProposalNote } from '@ludy/kernel-contract';
import type { MarketplaceProposalFacts } from '@ludy/mod-finance';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface MarketplaceProposalNoteAi {
  reader: Pick<InboxReader, 'marketplaceProposalNote'> | null;
  budget: DraftBudget;
  // Texts by org, language and facts, with the time they were written; `text` null is a refusal, kept shorter so a set the checks always refuse does not pay again on every open.
  kept: Map<string, { text: string | null; at: number }>;
}

export const MARKETPLACE_PROPOSAL_NOTE_KEEP_MS = 30 * 60 * 1000;
export const MARKETPLACE_PROPOSAL_NOTE_REFUSED_KEEP_MS = 5 * 60 * 1000;
export const MARKETPLACE_PROPOSAL_NOTE_KEEP_MAX = 200;

export function marketplaceProposalNoteAi(reader: MarketplaceProposalNoteAi['reader'], budget: DraftBudget): MarketplaceProposalNoteAi {
  return { reader, budget, kept: new Map() };
}

export async function explainMarketplaceProposal(
  ai: MarketplaceProposalNoteAi,
  orgId: string,
  userId: string,
  proposal: MarketplaceProposalFacts,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<MarketplaceProposalNote> {
  const told: MarketplaceProposalNoteFacts = { language, kind: proposal.kind, figures: proposal.figures, lineKinds: proposal.lineKinds, accounts: proposal.accounts };
  const uncertain = proposal.uncertain.map((p) => ({ key: p.key, text: language === 'vi' ? p.vi : p.en }));
  const template = marketplaceProposalNoteTemplate(told);
  const answer = (state: MarketplaceProposalNote['ai'], text: string = template): MarketplaceProposalNote => ({ ai: state, kind: proposal.kind, note: text, uncertain });
  // Nothing above zero: nothing to word, and the template would be empty too.
  if (!marketplaceProposalNoteHasNews(told)) return answer('off', '');
  if (!ai.reader) return answer('off');
  const key = `${orgId}\n${language}\n${marketplaceProposalNoteFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < (hit.text === null ? MARKETPLACE_PROPOSAL_NOTE_REFUSED_KEEP_MS : MARKETPLACE_PROPOSAL_NOTE_KEEP_MS)) return hit.text === null ? answer('failed') : answer('used', hit.text);
  const remember = (text: string | null) => {
    if (ai.kept.size >= MARKETPLACE_PROPOSAL_NOTE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { text, at: now() });
  };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.marketplaceProposalNote(told);
    if (result.kind === 'none') {
      console.error(`[finance-marketplace-proposal-note-ai] note refused: ${result.code}`);
      remember(null);
      return answer('failed');
    }
    remember(result.text);
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-marketplace-proposal-note-ai] note failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
