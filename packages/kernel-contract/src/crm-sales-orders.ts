// SPDX-License-Identifier: AGPL-3.0-only
// CRM sales orders (issue #2696, ADR-0050, plan docs/plan/crm-quotes.md sections 4.7 and 6, step Q4): a person records that a customer accepted a quote, which makes one
// frozen sales order; the order is handed to Kế toán as facts (`SalesOrderHandoff`) that a person turns into an e-invoice draft with Kế toán's own command. Every amount and
// quantity is a decimal string, never a number. No agent holds a command of this file.
import { z } from 'zod';
import { QUOTE_DESCRIPTION_MAX, QUOTE_LINE_KINDS, QUOTE_UNIT_MAX, zQuoteLine } from './crm-quotes.ts';
import { zId } from './schemas.ts';

// The sets are the product's: the CHECK constraints of crove_crm.sales_order say the same (packages/db/test/check-unions.db.test.ts compares them).
export const SALES_ORDER_STATUSES = ['confirmed', 'cancelled'] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];
// How the customer's yes arrived: a record of it, not a proof (ADR-0050 point 1).
export const QUOTE_ACCEPTED_VIA = ['chat', 'email', 'phone', 'in_person', 'other'] as const;
export type QuoteAcceptedVia = (typeof QUOTE_ACCEPTED_VIA)[number];
export const SALES_ORDER_PAGE_SIZE = 50;
export const SALES_ORDER_REASON_MAX = 200;

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

// A person records the acceptance of a sent quote: the version the caller read (a second person's change in between is refused), the day the customer said yes (today in
// Vietnam's calendar by default, never in the future) and how it arrived. The client's idempotency key replays the same order after a lost answer.
export const zQuoteAccept = z.strictObject({
  quoteId: zId,
  version: z.number().int().min(1),
  acceptedOn: zDate.optional(),
  acceptedVia: z.enum(QUOTE_ACCEPTED_VIA).optional(),
});
export type QuoteAccept = z.infer<typeof zQuoteAccept>;
export const zQuoteDecline = z.strictObject({
  quoteId: zId,
  version: z.number().int().min(1),
  reason: z.string().trim().max(SALES_ORDER_REASON_MAX).nullable().optional(),
});
export type QuoteDecline = z.infer<typeof zQuoteDecline>;
export const zQuoteDecided = z.strictObject({ quoteId: z.string(), status: z.enum(['accepted', 'declined']), orderId: z.string().nullable(), orderNumber: z.string().nullable() });
export type QuoteDecided = z.infer<typeof zQuoteDecided>;

export const zSalesOrderRef = z.strictObject({ orderId: zId });
export const zSalesOrderCancel = z.strictObject({ orderId: zId, version: z.number().int().min(1), reason: z.string().trim().min(1).max(SALES_ORDER_REASON_MAX) });
export const zSalesOrderListQuery = z.strictObject({
  dealId: zId.optional(),
  partyId: zId.optional(),
  status: z.enum(SALES_ORDER_STATUSES).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.strictObject({ createdAt: z.iso.datetime(), id: zId }).optional(),
});

// An order without its lines, for lists and the deal's tab. The invoiced and delivered state of its lines is read from Kế toán and is not part of it (ADR-0050 point 2).
export const zSalesOrderSummary = z.strictObject({
  id: z.string(),
  number: z.string(),
  quoteId: z.string(),
  quoteNumber: z.string().nullable(),
  dealId: z.string(),
  dealTitle: z.string(),
  partyId: z.string(),
  buyerName: z.string(),
  orderDate: z.string(),
  status: z.enum(SALES_ORDER_STATUSES),
  subtotal: z.string(),
  vatAmount: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  version: z.number().int(),
  confirmedAt: z.string(),
  cancelledAt: z.string().nullable(),
});
export type SalesOrderSummary = z.infer<typeof zSalesOrderSummary>;

export const zSalesOrderBuyer = z.strictObject({
  kind: z.enum(['business', 'consumer']),
  name: z.string(),
  taxCode: z.string().nullable(),
  address: z.string().nullable(),
  email: z.string().nullable(),
});
export type SalesOrderBuyer = z.infer<typeof zSalesOrderBuyer>;

export const zSalesOrder = zSalesOrderSummary.extend({
  issuerEntityId: z.string(),
  currency: z.literal('VND'),
  buyer: zSalesOrderBuyer,
  acceptedVia: z.enum(QUOTE_ACCEPTED_VIA).nullable(),
  cancelReason: z.string().nullable(),
  lines: z.array(zQuoteLine),
});
export type SalesOrder = z.infer<typeof zSalesOrder>;
export const zSalesOrderPage = z.strictObject({ items: z.array(zSalesOrderSummary), next: z.strictObject({ createdAt: z.string(), id: z.string() }).nullable() });
export type SalesOrderPage = z.infer<typeof zSalesOrderPage>;

// What Kế toán takes to make an e-invoice draft (ADR-0050 point 3, plan 6.1): everything it needs and nothing it fills itself (the series, the template, the payment
// method). Read by `crm.sales_order.handoff` (R0, refuses a cancelled order) and carried by the browser to Kế toán's own command, which re-checks all of it.
export const zSalesOrderHandoffLine = z.strictObject({
  lineNo: z.number().int(),
  kind: z.enum(QUOTE_LINE_KINDS),
  stockItemId: zId.nullable(),
  description: z.string().max(QUOTE_DESCRIPTION_MAX),
  unit: z.string().max(QUOTE_UNIT_MAX).nullable(),
  quantity: z.string().nullable(),
  unitPrice: z.string().nullable(),
  discountPercent: z.string(),
  // What the percent came to on the line, rounded half up (plan 4.4), so Kế toán can take either form of a discount.
  discountAmount: z.string(),
  amount: z.string(),
  vatRate: z.string().nullable(),
  vatAmount: z.string(),
});
export const zSalesOrderHandoff = z.strictObject({
  orderId: zId,
  orderNumber: z.string(),
  orderDate: z.string(),
  legalEntityId: zId,
  currency: z.literal('VND'),
  buyer: zSalesOrderBuyer,
  lines: z.array(zSalesOrderHandoffLine),
  subtotal: z.string(),
  vatAmount: z.string(),
  total: z.string(),
});
export type SalesOrderHandoff = z.infer<typeof zSalesOrderHandoff>;
export type SalesOrderHandoffLine = z.infer<typeof zSalesOrderHandoffLine>;
