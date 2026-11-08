// SPDX-License-Identifier: AGPL-3.0-only
// The sales order inputs and the hand-off schema (#2696, ADR-0050): an accept names a quote and the version the caller read, a date is a day, how the yes arrived is one of
// five, a cancellation needs a reason, a delivery names a line (and a day, if given) and nothing else, and the hand-off carries decimal strings only.
import { describe, expect, it } from 'vitest';
import { QUOTE_ACCEPTED_VIA, SALES_ORDER_REASON_MAX, zQuoteAccept, zQuoteDecline, zSalesOrderCancel, zSalesOrderDeliver, zSalesOrderHandoff, zSalesOrderListQuery, zSalesOrderUndeliver } from '../src/crm-sales-orders.ts';

const id = () => crypto.randomUUID();

describe('quote acceptance inputs', () => {
  it('needs the quote and the version the caller read', () => {
    expect(zQuoteAccept.safeParse({ quoteId: id(), version: 2 }).success).toBe(true);
    expect(zQuoteAccept.safeParse({ quoteId: id() }).success).toBe(false);
    expect(zQuoteAccept.safeParse({ quoteId: id(), version: 0 }).success).toBe(false);
    expect(zQuoteDecline.safeParse({ quoteId: id() }).success).toBe(false);
  });

  it('takes a day and one of five ways the yes arrived, nothing else', () => {
    expect(zQuoteAccept.safeParse({ quoteId: id(), version: 1, acceptedOn: '2026-11-08', acceptedVia: 'phone' }).success).toBe(true);
    expect(zQuoteAccept.safeParse({ quoteId: id(), version: 1, acceptedOn: '08/11/2026' }).success).toBe(false);
    expect(zQuoteAccept.safeParse({ quoteId: id(), version: 1, acceptedVia: 'carrier pigeon' }).success).toBe(false);
    expect(zQuoteAccept.safeParse({ quoteId: id(), version: 1, total: '1' }).success).toBe(false);
    expect(QUOTE_ACCEPTED_VIA).toEqual(['chat', 'email', 'phone', 'in_person', 'other']);
  });

  it('keeps a decline reason and a cancel reason within their column', () => {
    expect(zQuoteDecline.safeParse({ quoteId: id(), version: 1, reason: 'x'.repeat(SALES_ORDER_REASON_MAX) }).success).toBe(true);
    expect(zQuoteDecline.safeParse({ quoteId: id(), version: 1, reason: 'x'.repeat(SALES_ORDER_REASON_MAX + 1) }).success).toBe(false);
    expect(zSalesOrderCancel.safeParse({ orderId: id(), version: 1, reason: 'Khách đổi ý' }).success).toBe(true);
    expect(zSalesOrderCancel.safeParse({ orderId: id(), version: 1, reason: '   ' }).success).toBe(false);
  });

  it('lists by deal, customer or status, and pages by cursor', () => {
    expect(zSalesOrderListQuery.safeParse({ status: 'confirmed', limit: 20, cursor: { createdAt: new Date().toISOString(), id: id() } }).success).toBe(true);
    expect(zSalesOrderListQuery.safeParse({ status: 'open' }).success).toBe(false);
  });
});

describe('the hand-off to Kế toán', () => {
  const line = { lineNo: 1, kind: 'item', stockItemId: null, description: 'x', unit: 'gói', quantity: '2', unitPrice: '1500000', discountPercent: '0', discountAmount: '0', amount: '3000000', vatRate: '10%', vatAmount: '300000' };
  const handoff = {
    orderId: id(),
    orderNumber: 'DH-2026-0001',
    orderDate: '2026-11-08',
    legalEntityId: id(),
    currency: 'VND',
    buyer: { kind: 'business', name: 'Công ty ABC', taxCode: '0312345678', address: null, email: null },
    lines: [line],
    subtotal: '3000000',
    vatAmount: '300000',
    total: '3300000',
  };

  it('accepts the shape of the plan and nothing the order does not carry', () => {
    expect(zSalesOrderHandoff.safeParse(handoff).success).toBe(true);
    expect(zSalesOrderHandoff.safeParse({ ...handoff, currency: 'USD' }).success).toBe(false);
    expect(zSalesOrderHandoff.safeParse({ ...handoff, series: 'C26TAA' }).success).toBe(false);
    expect(zSalesOrderHandoff.safeParse({ ...handoff, buyer: { ...handoff.buyer, kind: 'robot' } }).success).toBe(false);
  });

  it('holds money as strings: a number is refused', () => {
    expect(zSalesOrderHandoff.safeParse({ ...handoff, total: 3300000 }).success).toBe(false);
    expect(zSalesOrderHandoff.safeParse({ ...handoff, lines: [{ ...line, amount: 3000000 }] }).success).toBe(false);
  });
});

describe('delivery inputs (#2697)', () => {
  it('names an order and a line, with a day if the goods left on another one', () => {
    expect(zSalesOrderDeliver.safeParse({ orderId: id(), lineNo: 1 }).success).toBe(true);
    expect(zSalesOrderDeliver.safeParse({ orderId: id(), lineNo: 3, deliveredOn: '2026-11-08' }).success).toBe(true);
    expect(zSalesOrderDeliver.safeParse({ orderId: id() }).success).toBe(false);
    expect(zSalesOrderDeliver.safeParse({ orderId: id(), lineNo: 0 }).success).toBe(false);
    expect(zSalesOrderDeliver.safeParse({ orderId: id(), lineNo: 101 }).success).toBe(false);
    expect(zSalesOrderDeliver.safeParse({ orderId: id(), lineNo: 1.5 }).success).toBe(false);
    expect(zSalesOrderDeliver.safeParse({ orderId: id(), lineNo: 1, deliveredOn: '08/11/2026' }).success).toBe(false);
  });

  it('takes nothing a delivery does not carry: no quantity (whole lines only), no stock item', () => {
    expect(zSalesOrderDeliver.safeParse({ orderId: id(), lineNo: 1, quantity: '1' }).success).toBe(false);
    expect(zSalesOrderDeliver.safeParse({ orderId: id(), lineNo: 1, stockItemId: id() }).success).toBe(false);
    expect(zSalesOrderUndeliver.safeParse({ orderId: id(), lineNo: 1 }).success).toBe(true);
    expect(zSalesOrderUndeliver.safeParse({ orderId: id(), lineNo: 1, deliveredOn: '2026-11-08' }).success).toBe(false);
  });
});
