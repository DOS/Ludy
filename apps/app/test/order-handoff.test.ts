// SPDX-License-Identifier: AGPL-3.0-only
// Which lines of an order go on an invoice draft (#2818): a line with a discount is left out and named, the rest are asked for by number, and an order whose goods all have a discount asks for nothing.
import { describe, expect, it } from 'vitest';
import type { SalesOrderHandoff } from '@crove/kernel-contract';
import { allDiscounted, hasDiscount, invoiceInput, invoicePlan } from '../src/lib/order-handoff.ts';

const line = (lineNo: number, kind: 'item' | 'text', discountPercent: string): SalesOrderHandoff['lines'][number] => ({
  lineNo,
  kind,
  stockItemId: null,
  description: `Dòng ${lineNo}`,
  unit: kind === 'item' ? 'gói' : null,
  quantity: kind === 'item' ? '1' : null,
  unitPrice: kind === 'item' ? '1000000' : null,
  discountPercent,
  discountAmount: '0',
  amount: kind === 'item' ? '1000000' : '0',
  vatRate: kind === 'item' ? '10%' : null,
  vatAmount: '0',
});
const handoff = (lines: SalesOrderHandoff['lines']): SalesOrderHandoff => ({
  orderId: '00000000-0000-4000-8000-000000000020',
  orderNumber: 'DH-2026-0001',
  orderDate: '2026-11-08',
  legalEntityId: '00000000-0000-4000-8000-000000000030',
  currency: 'VND',
  buyer: { name: 'Khách', taxCode: null, address: null, email: null, partyId: null } as unknown as SalesOrderHandoff['buyer'],
  lines,
  subtotal: '0',
  vatAmount: '0',
  total: '0',
});

describe('the lines of an order that go on an invoice draft (#2818)', () => {
  it('reads a discount from the digits of its string, never as a number', () => {
    expect(hasDiscount('0')).toBe(false);
    expect(hasDiscount('0.00')).toBe(false);
    expect(hasDiscount('5')).toBe(true);
    expect(hasDiscount('0.5')).toBe(true);
    expect(hasDiscount('10.00')).toBe(true);
  });

  it('asks for every open line (no list) when none has a discount; a note line is not goods', () => {
    const h = handoff([line(1, 'item', '0'), line(2, 'text', '0'), line(3, 'item', '0.00')]);
    expect(invoicePlan(h.lines)).toEqual({ open: [1, 3], skipped: [], goods: 2 });
    expect(invoiceInput(h)).toEqual({ handoff: h });
  });

  it('leaves a discounted line out and names the rest', () => {
    const h = handoff([line(1, 'item', '0'), line(2, 'item', '10'), line(3, 'item', '0')]);
    expect(invoicePlan(h.lines)).toEqual({ open: [1, 3], skipped: [2], goods: 3 });
    expect(invoiceInput(h)).toEqual({ handoff: h, lineNos: [1, 3] });
  });

  it('asks for nothing when every goods line has a discount, and an order with no goods is left to the server', () => {
    const all = handoff([line(1, 'item', '5'), line(2, 'item', '10'), line(3, 'text', '0')]);
    expect(allDiscounted(invoicePlan(all.lines))).toBe(true);
    expect(invoiceInput(all)).toBeNull();
    const none = handoff([line(1, 'text', '0')]);
    expect(allDiscounted(invoicePlan(none.lines))).toBe(false);
    expect(invoiceInput(none)).toEqual({ handoff: none });
  });
});
