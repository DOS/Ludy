// SPDX-License-Identifier: AGPL-3.0-only
// What the order screen sends to Kế toán (#2818, ADR-0050): the order's facts as `crm.salesOrders.handoff` read them, and which lines go on an invoice draft. Pure functions, so the
// rules are tested without a screen. A percent is a string and is only looked at for a non-zero digit, never turned into a number.
import type { SalesOrderHandoff } from '@crove/kernel-contract';

// A discount the draft cannot take as it is (the draft holds a price after the discount).
export const hasDiscount = (percent: string): boolean => /[1-9]/.test(percent);

export interface InvoicePlan {
  // The goods lines that go on the draft, and the ones left out for a discount.
  open: number[];
  skipped: number[];
  goods: number;
}

export function invoicePlan(lines: SalesOrderHandoff['lines']): InvoicePlan {
  const goods = lines.filter((l) => l.kind === 'item');
  return {
    open: goods.filter((l) => !hasDiscount(l.discountPercent)).map((l) => l.lineNo),
    skipped: goods.filter((l) => hasDiscount(l.discountPercent)).map((l) => l.lineNo),
    goods: goods.length,
  };
}

// True when the order has goods lines and every one has a discount: nothing can be invoiced until the quote is revised.
export const allDiscounted = (plan: InvoicePlan): boolean => plan.goods > 0 && plan.open.length === 0;

// The input of `einvoice.drafts.fromOrder`: every open line is asked for by leaving `lineNos` out, unless some line was left out, then the rest are named.
export function invoiceInput(handoff: SalesOrderHandoff): { handoff: SalesOrderHandoff; lineNos?: number[] } | null {
  const plan = invoicePlan(handoff.lines);
  if (allDiscounted(plan)) return null;
  return plan.skipped.length > 0 ? { handoff, lineNos: plan.open } : { handoff };
}
