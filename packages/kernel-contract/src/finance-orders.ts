// SPDX-License-Identifier: AGPL-3.0-only
// The Kế toán side of the quote hand-off (issue #2818, ADR-0050 points 3 and 4): an e-invoice draft from the lines of a sales order, and the stock move of a delivered order line.
// Both take the facts Engage's `crm.sales_order.handoff` returned (`SalesOrderHandoff`, carried by the browser) and re-check all of them; finance reads no CRM table and writes none.
// No agent holds either command.
import { z } from 'zod';
import { EINVOICE_DRAFT_MAX_LINES } from './einvoice.ts';
import { zSalesOrderHandoff } from './crm-sales-orders.ts';
import { zId, zLocalDate } from './schemas.ts';

// The source kind a draft line or a document line made from a CRM sales order carries.
export const ORDER_SOURCE_KIND = 'crm.sales_order';

// `lineNos` names the lines to invoice (whole lines only); left out, every open line: the item lines not already on a draft.
export const zEInvoiceDraftFromOrder = z.strictObject({
  handoff: zSalesOrderHandoff,
  lineNos: z.array(z.number().int().min(1)).min(1).max(EINVOICE_DRAFT_MAX_LINES).optional(),
});
export type EInvoiceDraftFromOrder = z.infer<typeof zEInvoiceDraftFromOrder>;

export const ORDER_STOCK_ACTIONS = ['deliver', 'return'] as const;
// `date` is the delivery date for a delivery (not in the future), the day the goods came back for a return. A retry of either is safe: the same line, the same answer.
export const zStockMoveFromOrderLine = z.strictObject({
  handoff: zSalesOrderHandoff,
  lineNo: z.number().int().min(1),
  date: zLocalDate,
  action: z.enum(ORDER_STOCK_ACTIONS).default('deliver'),
});
export type StockMoveFromOrderLine = z.input<typeof zStockMoveFromOrderLine>;

// moved / returned: this call wrote the move (or its reversal); already_moved / already_returned: an earlier call did, nothing is written; service: a text line moves no stock.
export const ORDER_STOCK_STATUSES = ['moved', 'already_moved', 'returned', 'already_returned', 'service'] as const;
export const zStockMoveFromOrderLineResult = z.strictObject({ status: z.enum(ORDER_STOCK_STATUSES), moveId: zId.nullable() });
export type StockMoveFromOrderLineResult = z.infer<typeof zStockMoveFromOrderLineResult>;

// The state of each order line on the e-invoice drafts of Kế toán (#3477, ADR-0050): the order screen's per-line label and the reason a drafted order is not cancelled from there.
// `draft`: a draft that has not become an invoice holds the line (draft, submitting, pending, rejected, failed); `issued`: the draft is issued. A line no draft names is not listed (the
// screen reads it as "none"). Asked by order ids, never listed: it cannot walk the drafts or reconcile every order with every draft (ADR-0050 "Left out").
export const ORDER_LINE_INVOICE_ORDERS_MAX = 50;
export const ORDER_LINE_INVOICE_STATES = ['draft', 'issued'] as const;
export type OrderLineInvoiceState = (typeof ORDER_LINE_INVOICE_STATES)[number];
export const zOrderLineInvoiceStatesInput = z.strictObject({ orderIds: z.array(zId).min(1).max(ORDER_LINE_INVOICE_ORDERS_MAX) });
export const zOrderLineInvoiceStates = z.strictObject({
  orders: z.array(
    z.strictObject({
      orderId: zId,
      lines: z.array(z.strictObject({ lineNo: z.number().int().min(1), state: z.enum(ORDER_LINE_INVOICE_STATES) })),
    }),
  ),
});
export type OrderLineInvoiceStates = z.infer<typeof zOrderLineInvoiceStates>;
