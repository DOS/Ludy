// SPDX-License-Identifier: AGPL-3.0-only
// What the sweep makes of a Home item (ADR-0051 decision 4, issue #3024): ids, a severity, an amount, the day it falls due and a day count, and nothing a person typed.
import { describe, expect, it } from 'vitest';
import { DEAL_WITHOUT_INVOICE_READ, RECEIVABLE_WITH_OPEN_DEAL_READ, SUPPLIER_BANK_CHANGED_READ } from '@crove/kernel';
import type { TodayItem } from '@crove/kernel-contract';
import { wakeEvent } from '../src/mcp-wake-body.ts';
import { wakeItemOf } from '../src/mcp-wake-sweep.ts';

const ID = '0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10';
const base = { kind: 'flag', app: 'crm', href: '/deals' } as const;

describe('a Home item as a wake-up item', () => {
  it('maps the three rules to their key, entity id, severity, amount, Vietnam due day and day count', () => {
    const won: TodayItem = { ...base, id: `signal:won-deal-no-invoice:${ID}`, title: { key: 'signals.wonDealNoInvoice', params: { days: 7 } }, amount: '12500000', dueAt: '2026-11-19T00:00:00+07:00', severity: 'warn' };
    expect(wakeItemOf(DEAL_WITHOUT_INVOICE_READ, won)).toEqual({ rule: DEAL_WITHOUT_INVOICE_READ, key: `deal_without_invoice:${ID}`, severity: 'warn', deal_id: ID, amount: '12500000', currency: 'VND', due_on: '2026-11-19', days: 7 });
    const receivable: TodayItem = { ...base, id: `signal:overdue-receivable-open-deal:${ID}`, title: { key: 'x', params: { days: 31 } }, amount: '4000000.50' };
    expect(wakeItemOf(RECEIVABLE_WITH_OPEN_DEAL_READ, receivable)).toEqual({ rule: RECEIVABLE_WITH_OPEN_DEAL_READ, key: `receivable_with_open_deal:${ID}`, severity: 'warn', party_id: ID, amount: '4000000.50', currency: 'VND', days: 31 });
    // A currency other than VND is kept, so a receiver never reads a dollar amount as dong.
    const usd: TodayItem = { ...base, id: `signal:won-deal-no-invoice:${ID}`, title: { key: 'x' }, amount: '1200', currency: 'USD' };
    expect(wakeItemOf(DEAL_WITHOUT_INVOICE_READ, usd)).toMatchObject({ amount: '1200', currency: 'USD' });
    const bank: TodayItem = { kind: 'flag', app: 'finance', href: '/inbox', id: `signal:supplier-bank-changed:${ID}`, title: { key: 'x', params: { days: 2, count: 3 } }, severity: 'block' };
    expect(wakeItemOf(SUPPLIER_BANK_CHANGED_READ, bank)).toEqual({ rule: SUPPLIER_BANK_CHANGED_READ, key: `supplier_bank_changed:${ID}`, severity: 'block', party_id: ID, days: 2 });
  });

  it('leaves out the grouped items that name no record, an id of another rule, and an amount that is not a plain decimal; every item it makes fits a body', () => {
    for (const id of ['signal:won-deal-no-invoice:more', 'signal:supplier-bank-changed:partial', 'signal:supplier-bank-changed:unchecked', `signal:overdue-receivable-open-deal:${ID}`, 'other']) {
      expect(wakeItemOf(DEAL_WITHOUT_INVOICE_READ, { ...base, id, title: { key: 'x' } }), id).toBeNull();
    }
    const odd = wakeItemOf(DEAL_WITHOUT_INVOICE_READ, { ...base, id: `signal:won-deal-no-invoice:${ID}`, title: { key: 'x', params: { days: -3 } }, amount: '012.5', dueAt: 'not a date' });
    expect(odd).toEqual({ rule: DEAL_WITHOUT_INVOICE_READ, key: `deal_without_invoice:${ID}`, severity: 'warn', deal_id: ID });
    const event = { id: ID, type: 'signal.fired', created_at: '2026-11-12T03:00:00.000Z', org: ID, grant: ID, data: { items: [odd] } };
    expect(() => wakeEvent(event)).not.toThrow();
  });
});
