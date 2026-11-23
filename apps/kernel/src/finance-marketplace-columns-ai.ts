// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's first mapping for the columns of an unrecognised marketplace order report, on the API side (#4036, slice 1c of #3850). The masked sheet the worker recorded is read again here in the
// caller's own context, so the model is told what the file shows (header texts and the SHAPES of a few values, no buyer column), never what the caller says, and never a line or a value. The model call runs
// here, outside any transaction, through the AI budget meter (feature `finance.stock_columns`; the request's AI scope names the org and the member). It answers per column number; the answer is tainted and
// only a proposal (packages/agent marketplace-columns.ts drops a column not given, a column or a field answered twice, a field that is not on the list): the screen files a check of it on the real file, which
// decides, and a person confirms.
//
// The proposal is read, never written: nothing here changes a row, and it is not a command. With fewer than three columns to show there is no call (`none`). When there is no model, the AI budget is spent, the
// member's calls are too frequent, the call fails or every answer is dropped, the answer names the state (`ai`) with no assignment and the screen shows the manual pickers alone. An answer is kept for a while by
// its facts, so reopening the screen does not pay for the same proposal twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, marketplaceColumnsFactsText, marketplaceColumnsHaveNews, type InboxReader, type MarketplaceColumnFacts } from '@ludy/agent';
import type { MarketplaceColumnAssignment, MarketplaceColumnSheet, MarketplaceColumnsProposal } from '@ludy/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface MarketplaceColumnsAi {
  reader: Pick<InboxReader, 'marketplaceColumns'> | null;
  budget: DraftBudget;
  // Proposals by org, language and facts, with the time they were made; `assignments` null is a refusal, kept shorter so a sheet the checks always refuse does not pay again on every open.
  kept: Map<string, { assignments: readonly MarketplaceColumnAssignment[] | null; at: number }>;
}

export const MARKETPLACE_COLUMNS_KEEP_MS = 30 * 60 * 1000;
export const MARKETPLACE_COLUMNS_REFUSED_KEEP_MS = 5 * 60 * 1000;
export const MARKETPLACE_COLUMNS_KEEP_MAX = 200;

export function marketplaceColumnsAi(reader: MarketplaceColumnsAi['reader'], budget: DraftBudget): MarketplaceColumnsAi {
  return { reader, budget, kept: new Map() };
}

export async function proposeMarketplaceColumns(
  ai: MarketplaceColumnsAi,
  orgId: string,
  userId: string,
  sheet: MarketplaceColumnSheet | null,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<MarketplaceColumnsProposal> {
  const answer = (state: MarketplaceColumnsProposal['ai'], assignments: MarketplaceColumnsProposal['assignments'] = []): MarketplaceColumnsProposal => ({ ai: state, assignments });
  // The model is told the columns the code shows: a buyer column is an empty shell and is never given.
  const told: MarketplaceColumnFacts = { language, columns: sheet?.columns ?? [] };
  if (!sheet || !marketplaceColumnsHaveNews(told)) return answer('none');
  if (!ai.reader) return answer('off');
  const key = `${orgId}\n${language}\n${marketplaceColumnsFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < (hit.assignments === null ? MARKETPLACE_COLUMNS_REFUSED_KEEP_MS : MARKETPLACE_COLUMNS_KEEP_MS)) return hit.assignments === null ? answer('failed') : answer('used', [...hit.assignments]);
  const remember = (assignments: readonly MarketplaceColumnAssignment[] | null) => {
    if (ai.kept.size >= MARKETPLACE_COLUMNS_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { assignments, at: now() });
  };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.marketplaceColumns(told);
    if (result.kind === 'none') {
      console.error(`[finance-marketplace-columns-ai] proposal refused: ${result.code}`);
      remember(null);
      return answer('failed');
    }
    remember(result.assignments);
    return answer('used', result.assignments);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-marketplace-columns-ai] proposal failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
