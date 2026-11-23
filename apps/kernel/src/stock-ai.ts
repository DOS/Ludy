// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on stock, on the API side (#2514): which item a goods line is about, and the wording of a reorder message to a supplier. finance.stock.suggest_source and
// finance.stock.reorder_source run in the member's own transaction and say what the model may see (a line's description and unit, an item's code, name and unit, and the names and
// quantities of a reorder: no amount, party or document number); the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names
// the org and the member).
//
// Both are read, never written: nothing here assigns a line, teaches a name, stores a text or sends a mail, and neither is a command. A suggestion is a hint a person confirms by
// assigning the line (finance.stock.assign checks the line and the item again and teaches the name); the reorder text is a draft the person edits and sends from their own mail. When
// the model is off, the AI budget is spent, the member's calls are too frequent, the call fails or its answer is refused (packages/agent stock.ts: an item that was not offered, a reason
// with a link or a figure the line and the item do not hold, a message with a figure, link or address it was not given), the answer names the state (`ai`) and gives no suggestion; the
// reorder draft then holds the fixed template, so the screen works as it does with AI off. A suggestion is kept for a while by its content, so reopening the screen does not pay for
// the same answer twice. A failure is named, never quoted: neither the lines, the names nor the model's answer is logged.
import { AiBudgetExhaustedError, type InboxReader } from '@ludy/agent';
import type { MarketplaceSuggested, StockAiState, StockReorderDraft, StockSuggested } from '@ludy/kernel-contract';
import { sha256Hex } from '@ludy/kernel-runtime';
import type { MarketplaceSuggestSource, ReorderSource, SuggestSource } from '@ludy/mod-finance';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface StockAi {
  // Either method may be missing: each use checks its own, so one that is there works without the other.
  reader: Partial<Pick<InboxReader, 'stockMatch' | 'reorderText'>> | null;
  budget: DraftBudget;
  // Suggestions by content (org, language, the lines and the items offered), with the time they were written. The invoice lines' and the marketplace lines' are kept apart: they are keyed differently.
  kept: Map<string, { suggestions: StockSuggested['suggestions']; at: number }>;
  keptMarketplace: Map<string, { suggestions: MarketplaceSuggested['suggestions']; at: number }>;
}

export const STOCK_KEEP_MS = 30 * 60 * 1000;
// "No suggestion" is kept only briefly (as the Inbox's is): the lines are asked again soon, in case an answer was only dropped by the checks.
export const STOCK_KEEP_NONE_MS = 2 * 60 * 1000;
export const STOCK_KEEP_MAX = 200;

export function stockAi(reader: StockAi['reader'], budget: DraftBudget): StockAi {
  return { reader, budget, kept: new Map(), keptMarketplace: new Map() };
}

// What the model is shown, as one key: the same lines against the same items give the same answer to reuse.
function suggestKey(orgId: string, language: 'vi' | 'en', source: SuggestSource): string {
  const lines = source.lines.map((l) => `${l.documentId}:${l.lineNo}:${l.description}:${l.unit ?? ''}`).join('\n');
  const items = source.items.map((i) => `${i.id}:${i.code}:${i.name}:${i.unit}`).join('\n');
  return sha256Hex(`${orgId}\n${language}\n${lines}\n--\n${items}`);
}

// The one flow both kinds of line share: the model is asked once with each line's text and the items offered, an answer names an item by its number in that list (so an item that was not offered cannot
// come out), and the result is kept by content. `line` gives the model's text for a line and `suggest` builds the suggestion a line and an item make.
async function askMatch<L, S extends { reason: string }>(
  ai: StockAi,
  orgId: string,
  userId: string,
  lines: readonly L[],
  items: readonly { id: string; code: string; name: string; unit: string }[],
  language: 'vi' | 'en',
  shape: { text: (line: L) => { description: string; unit: string | null }; suggest: (line: L, itemId: string, reason: string) => S },
  cache: { map: Map<string, { suggestions: S[]; at: number }>; key: string },
  now: () => number,
): Promise<{ ai: StockAiState; suggestions: S[] }> {
  const match = ai.reader?.stockMatch;
  if (!match) return { ai: 'off', suggestions: [] };
  if (lines.length === 0 || items.length === 0) return { ai: 'quiet', suggestions: [] };
  const hit = cache.map.get(cache.key);
  if (hit && now() - hit.at < (hit.suggestions.length === 0 ? STOCK_KEEP_NONE_MS : STOCK_KEEP_MS)) return { ai: 'used', suggestions: hit.suggestions };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return { ai: 'busy', suggestions: [] };
  try {
    const answers = await match(
      lines.map((l) => shape.text(l)),
      items.map((i) => ({ code: i.code, name: i.name, unit: i.unit })),
      language,
    );
    const suggestions = answers.flatMap((a, i) => {
      const line = lines[i];
      const item = a === null ? undefined : items[a.itemIndex];
      return a !== null && line !== undefined && item ? [shape.suggest(line, item.id, a.reason)] : [];
    });
    if (cache.map.size >= STOCK_KEEP_MAX) cache.map.delete(cache.map.keys().next().value as string);
    cache.map.set(cache.key, { suggestions, at: now() });
    return { ai: 'used', suggestions };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return { ai: 'budget', suggestions: [] };
    console.error('[stock-ai] match failed', error instanceof Error ? error.name : typeof error);
    return { ai: 'failed', suggestions: [] };
  } finally {
    ticket.release();
  }
}

export async function suggestItems(ai: StockAi, orgId: string, userId: string, source: SuggestSource, language: 'vi' | 'en', now: () => number = Date.now): Promise<StockSuggested> {
  return askMatch(
    ai,
    orgId,
    userId,
    source.lines,
    source.items,
    language,
    { text: (l) => ({ description: l.description, unit: l.unit }), suggest: (l, itemId, reason) => ({ documentId: l.documentId, lineNo: l.lineNo, itemId, reason }) },
    { map: ai.kept, key: suggestKey(orgId, language, source) },
    now,
  );
}

// The same coworker for the unassigned marketplace order lines (#2686): the model sees each line's product name and SKU text as one string and the entity's items, nothing else of the order
// (finance.marketplace.suggest_source reads only those). A suggestion only fills the item picker; the person's `assign` writes.
export async function suggestMarketplaceItems(
  ai: StockAi,
  orgId: string,
  userId: string,
  source: MarketplaceSuggestSource,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<MarketplaceSuggested> {
  const lines = source.lines.map((l) => `${l.lineId}:${l.text}`).join('\n');
  const items = source.items.map((i) => `${i.id}:${i.code}:${i.name}:${i.unit}`).join('\n');
  return askMatch(
    ai,
    orgId,
    userId,
    source.lines,
    source.items,
    language,
    { text: (l) => ({ description: l.text, unit: null }), suggest: (l, itemId, reason) => ({ lineId: l.lineId, itemId, reason }) },
    { map: ai.keptMarketplace, key: sha256Hex(`${orgId}\n${language}\n${lines}\n--\n${items}`) },
    now,
  );
}

export async function draftReorder(ai: StockAi, orgId: string, userId: string, source: ReorderSource, language: 'vi' | 'en', hint: string | undefined): Promise<StockReorderDraft> {
  const answer = (state: StockReorderDraft['ai'], text: string = source.template): StockReorderDraft => ({ ai: state, supplier: source.supplier, text });
  const word = ai.reader?.reorderText;
  if (!word) return answer('off');
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await word({
      language,
      orgName: source.orgName,
      // A supplier that is not named is greeted by the same plain word as the template's.
      supplierName: source.supplier?.name ?? (language === 'vi' ? 'nhà cung cấp' : 'Supplier'),
      items: source.items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
      ...(hint ? { hint } : {}),
    });
    if (result.kind === 'none') {
      console.error(`[stock-ai] reorder refused: ${result.code}`);
      return answer('failed');
    }
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[stock-ai] reorder failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
