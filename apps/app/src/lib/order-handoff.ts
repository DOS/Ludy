// SPDX-License-Identifier: AGPL-3.0-only
// What the order screen sends to Kế toán (#2818, ADR-0050): the order's facts as `crm.salesOrders.handoff` read them, and which lines go on an invoice draft. Pure functions, so the
// rules are tested without a screen. A percent is a string and is only looked at for a non-zero digit, never turned into a number.
import type { SalesOrderHandoff } from '@ludy/kernel-contract';

// A discount the draft cannot take as it is (the draft holds a price after the discount).
export const hasDiscount = (percent: string): boolean => /[1-9]/.test(percent);

export interface InvoicePlan {
  // The goods lines that go on the draft, the ones left out for a discount, and the ones a draft holds already (#3477).
  open: number[];
  skipped: number[];
  claimed: number[];
  goods: number;
}

// `held`: the line numbers a draft of Kế toán holds already (draft or issued), from `einvoice.drafts.orderLines`. It is a hint for the screen; the server still refuses a line twice.
export function invoicePlan(lines: SalesOrderHandoff['lines'], held: ReadonlySet<number> = new Set()): InvoicePlan {
  const goods = lines.filter((l) => l.kind === 'item');
  const free = goods.filter((l) => !held.has(l.lineNo));
  return {
    open: free.filter((l) => !hasDiscount(l.discountPercent)).map((l) => l.lineNo),
    skipped: free.filter((l) => hasDiscount(l.discountPercent)).map((l) => l.lineNo),
    claimed: goods.filter((l) => held.has(l.lineNo)).map((l) => l.lineNo),
    goods: goods.length,
  };
}

// True when the order has goods lines, none is on a draft, and every one has a discount: nothing can be invoiced until the quote is revised.
export const allDiscounted = (plan: InvoicePlan): boolean => plan.goods > 0 && plan.claimed.length === 0 && plan.open.length === 0;

// True when some line is on a draft and no line is left to invoice: the button has nothing to name and is hidden (a discounted line left over is said in the note).
export const nothingLeft = (plan: InvoicePlan): boolean => plan.claimed.length > 0 && plan.open.length === 0;

// The input of `einvoice.drafts.fromOrder`: every open line is asked for by leaving `lineNos` out, unless some line was left out (a discount) or is on a draft already, then the rest are named.
export function invoiceInput(handoff: SalesOrderHandoff, held: ReadonlySet<number> = new Set()): { handoff: SalesOrderHandoff; lineNos?: number[] } | null {
  const plan = invoicePlan(handoff.lines, held);
  if (allDiscounted(plan) || nothingLeft(plan)) return null;
  return plan.skipped.length > 0 || plan.claimed.length > 0 ? { handoff, lineNos: plan.open } : { handoff };
}

// Which of an order's lines a draft holds and whether it is issued, as `einvoice.drafts.orderLines` answers (#3477); a line not in the map is "none".
export type LineInvoiceState = 'none' | 'draft' | 'issued';
export const lineStateOf = (held: ReadonlyMap<number, 'draft' | 'issued'> | undefined, lineNo: number): LineInvoiceState => held?.get(lineNo) ?? 'none';
