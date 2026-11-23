// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's notes under the Sàn table, on the API side (#3711 slice 7). The balance is loaded again here in the caller's own context, code takes the platforms whose fees still wait on their 331
// (the amount in whole dong, the age of the oldest fee, whether that is past one settlement cycle) and numbers them, and the model call then runs here, outside any transaction, through the AI budget meter
// (the request's AI scope names the org and the member). The model is told those numbers per row and the cycle length, and no platform name, party or entity (the display name of a platform is typed by the
// organization); it answers by row number, and the server maps a note back to its platform. A note is dropped on its own when it has a number that is not its row's, a platform name, a link, says something
// was done or promises a result (packages/agent marketplace-fee-note.ts).
//
// The notes are read, never written: nothing here posts, changes a figure or a flag, and it is not a command. With no platform waiting there is no call (`none`). When there is no model, the AI budget is
// spent, the member's calls are too frequent, the call fails or every note is dropped, the answer names the state (`ai`) with no notes and the screen shows the table alone. An answer is kept for a while by
// its facts, so reopening the screen does not pay for the same notes twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, marketplaceFeeNotesFactsText, marketplaceFeeNotesHaveNews, type InboxReader, type MarketplaceFeeNoteFacts } from '@ludy/agent';
import type { MarketplaceBalance, MarketplaceFeeNotes } from '@ludy/kernel-contract';
import { money } from '@ludy/l10n-vn';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface MarketplaceFeeNoteAi {
  reader: Pick<InboxReader, 'marketplaceFeeNotes'> | null;
  budget: DraftBudget;
  // Notes by org, language and facts, with the time they were written; `notes` null is a refusal, kept shorter so a set the checks always refuse does not pay again on every open.
  kept: Map<string, { notes: ReadonlyArray<{ row: number; text: string }> | null; at: number }>;
}

export const MARKETPLACE_FEE_NOTE_KEEP_MS = 30 * 60 * 1000;
export const MARKETPLACE_FEE_NOTE_REFUSED_KEEP_MS = 5 * 60 * 1000;
export const MARKETPLACE_FEE_NOTE_KEEP_MAX = 200;

export function marketplaceFeeNoteAi(reader: MarketplaceFeeNoteAi['reader'], budget: DraftBudget): MarketplaceFeeNoteAi {
  return { reader, budget, kept: new Map() };
}

// A platform row that has fees waiting: the facts the model is told, and who the row is (kept here, never told).
export interface FeeNoteRow {
  legalEntityId: string;
  platform: string;
  fees: string;
  ageDays: number;
  overdue: boolean;
}

/** The platforms whose fees still wait on 331, in the order of the balance: fees of at least half a dong (whole dong, as the model is told them) and an age. A row with no age has nothing to say about. */
export function feeNoteRows(balance: MarketplaceBalance): FeeNoteRow[] {
  return balance.rows
    .filter((r) => money(r.feesAwaitingInvoice).abs().gte('0.5') && r.feesAgeDays !== null)
    .map((r) => ({ legalEntityId: r.legalEntityId, platform: r.platform, fees: r.feesAwaitingInvoice, ageDays: r.feesAgeDays as number, overdue: r.feesOverdue }));
}

export async function explainMarketplaceFees(
  ai: MarketplaceFeeNoteAi,
  orgId: string,
  userId: string,
  balance: MarketplaceBalance,
  cycleDays: number,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<MarketplaceFeeNotes> {
  const rows = feeNoteRows(balance);
  const answer = (state: MarketplaceFeeNotes['ai'], notes: MarketplaceFeeNotes['notes'] = []): MarketplaceFeeNotes => ({ ai: state, notes });
  const told: MarketplaceFeeNoteFacts = { language, cycleDays, rows: rows.map((r) => ({ fees: r.fees, ageDays: r.ageDays, overdue: r.overdue })) };
  if (!marketplaceFeeNotesHaveNews(told)) return answer('none');
  if (!ai.reader) return answer('off');
  // A note is shown beside its platform, so a note kept for the same facts is mapped back through the rows of THIS balance.
  const place = (notes: ReadonlyArray<{ row: number; text: string }>): MarketplaceFeeNotes['notes'] =>
    notes.flatMap((n) => {
      const row = rows[n.row - 1];
      return row ? [{ legalEntityId: row.legalEntityId, platform: row.platform, text: n.text }] : [];
    });
  const key = `${orgId}\n${language}\n${marketplaceFeeNotesFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < (hit.notes === null ? MARKETPLACE_FEE_NOTE_REFUSED_KEEP_MS : MARKETPLACE_FEE_NOTE_KEEP_MS)) return hit.notes === null ? answer('failed') : answer('used', place(hit.notes));
  const remember = (notes: ReadonlyArray<{ row: number; text: string }> | null) => {
    if (ai.kept.size >= MARKETPLACE_FEE_NOTE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(key, { notes, at: now() });
  };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.marketplaceFeeNotes(told);
    if (result.kind === 'none') {
      console.error(`[finance-marketplace-fee-note-ai] notes refused: ${result.code}`);
      remember(null);
      return answer('failed');
    }
    remember(result.notes);
    return answer('used', place(result.notes));
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-marketplace-fee-note-ai] notes failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
