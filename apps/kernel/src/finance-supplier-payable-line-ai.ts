// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's one line above "Invoices to pay", on the API side (#3113 S4c, #3701). finance.supplier_payment.payable reads the list in the caller's own transaction, code sums the facts from it
// (supplierPayableFacts), and the model call then runs here, outside any transaction, through the AI budget meter (the request's AI scope names the org and the member). The model is told four facts
// (how many invoices wait, their total in dong, the oldest invoice date, how many are of a supplier whose bank account changed recently) and nothing else, and its text is refused when it states a number or
// date the facts do not hold, a link, advice, or says something was paid or sent (packages/agent supplier-payable-line.ts).
//
// The line is read, never written: nothing here asks for a payment or stores a text, and it is not a command. With nothing to say there is no call (`none`). When there is no model, the AI budget is spent, the
// member's calls are too frequent, the call fails or its text is refused, the answer names the state (`ai`) with no words and the screen shows the facts alone. An answer is kept for a while by its facts,
// so reopening the screen does not pay for the same line twice. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { Decimal } from '@crove/l10n-vn';
import { AiBudgetExhaustedError, supplierPayableLineFactsText, supplierPayableLineHasNews, type InboxReader, type SupplierPayableLineFacts } from '@crove/agent';
import type { SupplierPayableFacts, SupplierPayableLine, SupplierPayableList } from '@crove/kernel-contract';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface SupplierPayableLineAi {
  reader: Pick<InboxReader, 'supplierPayableLineSentence'> | null;
  budget: DraftBudget;
  // Sentences by org and facts, with the time they were written; `text` null is a refusal, kept shorter so a fact set the check always refuses does not pay again on every open.
  kept: Map<string, { text: string | null; at: number }>;
}

export const SUPPLIER_PAYABLE_LINE_KEEP_MS = 30 * 60 * 1000;
export const SUPPLIER_PAYABLE_LINE_REFUSED_KEEP_MS = 5 * 60 * 1000;
export const SUPPLIER_PAYABLE_LINE_KEEP_MAX = 200;

export function supplierPayableLineAi(reader: SupplierPayableLineAi['reader'], budget: DraftBudget): SupplierPayableLineAi {
  return { reader, budget, kept: new Map() };
}

/** The facts of the list, by code. Null when there is no line to give: nothing waits, the list was cut short (a total or an oldest date would not be the books' own) or an invoice is not in dong.
 * The invoice suggested first is the one with the oldest invoice date among those a person can ask for now (the supplier has one active account); ties go to the lower id, so the answer is stable. */
export function supplierPayableFacts(list: SupplierPayableList): SupplierPayableFacts | null {
  const items = list.items;
  if (items.length === 0 || list.more || items.some((i) => i.currency !== 'VND')) return null;
  const older = (a: (typeof items)[number], b: (typeof items)[number]) => a.invoiceDate < b.invoiceDate || (a.invoiceDate === b.invoiceDate && a.purchaseDocumentId < b.purchaseDocumentId);
  const oldest = items.reduce((best, i) => (older(i, best) ? i : best));
  const askable = items.filter((i) => i.account === 'ready');
  const first = askable.length === 0 ? null : askable.reduce((best, i) => (older(i, best) ? i : best));
  return {
    invoices: items.length,
    total: items.reduce((sum, i) => sum.plus(i.amount), new Decimal(0)).toFixed(0),
    oldestDate: oldest.invoiceDate,
    onChangedAccount: items.filter((i) => i.accountChangedOn !== null).length,
    suggestedPurchaseDocumentId: first?.purchaseDocumentId ?? null,
  };
}

// The facts the sentence is written from: the four numbers, nothing else (not the suggested invoice, which is shown by code).
export function supplierPayableLineFacts(facts: SupplierPayableFacts, language: 'vi' | 'en'): SupplierPayableLineFacts {
  return { language, invoices: facts.invoices, total: facts.total, oldestDate: facts.oldestDate, onChangedAccount: facts.onChangedAccount };
}

export async function explainSupplierPayableLine(
  ai: SupplierPayableLineAi,
  orgId: string,
  userId: string,
  list: SupplierPayableList,
  language: 'vi' | 'en',
  now: () => number = Date.now,
): Promise<SupplierPayableLine> {
  const facts = supplierPayableFacts(list);
  const answer = (state: SupplierPayableLine['ai'], text: string | null = null): SupplierPayableLine => ({ facts, ai: state, text });
  if (facts === null) return answer('none');
  const told = supplierPayableLineFacts(facts, language);
  if (!supplierPayableLineHasNews(told)) return answer('none');
  if (!ai.reader) return answer('off');
  const key = `${orgId}\n${language}\n${supplierPayableLineFactsText(told)}`;
  const hit = ai.kept.get(key);
  if (hit && now() - hit.at < (hit.text === null ? SUPPLIER_PAYABLE_LINE_REFUSED_KEEP_MS : SUPPLIER_PAYABLE_LINE_KEEP_MS)) return hit.text === null ? answer('failed') : answer('used', hit.text);
  const remember = (k: string, text: string | null) => {
    if (ai.kept.size >= SUPPLIER_PAYABLE_LINE_KEEP_MAX) ai.kept.delete(ai.kept.keys().next().value as string);
    ai.kept.set(k, { text, at: now() });
  };
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.supplierPayableLineSentence(told);
    if (result.kind === 'none') {
      console.error(`[finance-supplier-payable-line-ai] sentence refused: ${result.code}`);
      remember(key, null);
      return answer('failed');
    }
    remember(key, result.text);
    return answer('used', result.text);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[finance-supplier-payable-line-ai] sentence failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}
