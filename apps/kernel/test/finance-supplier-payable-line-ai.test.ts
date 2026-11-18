// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's one line above "Invoices to pay", on the API side (#3113 S4c): code sums the facts and picks the invoice to suggest first (the oldest invoice date among those a person can ask for), nothing
// waiting asks no model, the model is asked once with four facts, an answer is kept, and every state with no text (no model, a spent budget, too many calls, a failed or refused call) is named and never
// quoted. The facts always come back, so the screen never shows less than the books hold.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type SupplierPayableLineFacts, type SupplierPayableLineResult } from '@crove/agent';
import type { SupplierPayable, SupplierPayableList } from '@crove/kernel-contract';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import {
  SUPPLIER_PAYABLE_LINE_KEEP_MS,
  SUPPLIER_PAYABLE_LINE_REFUSED_KEEP_MS,
  explainSupplierPayableLine,
  supplierPayableFacts,
  supplierPayableLineAi,
  supplierPayableLineFacts,
} from '../src/finance-supplier-payable-line-ai.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, over: Partial<SupplierPayable> = {}): SupplierPayable => ({
  purchaseDocumentId: id(n),
  partyId: id(100 + n),
  partyName: `Supplier ${n}`,
  invoiceNumber: `INV-${n}`,
  invoiceDate: '2026-10-10',
  amount: '1000000',
  currency: 'VND',
  account: 'ready',
  accountChangedOn: null,
  ...over,
});
const LIST: SupplierPayableList = {
  items: [item(1, { invoiceDate: '2026-10-03', amount: '2500000.00', account: 'none' }), item(2, { invoiceDate: '2026-10-05', amount: '9000000' }), item(3, { invoiceDate: '2026-10-09', amount: '1000000', accountChangedOn: '2026-11-01' })],
  more: false,
};
const FACTS = supplierPayableFacts(LIST)!;
const SAID: SupplierPayableLineResult = { kind: 'sentence', text: 'Có 3 hóa đơn cần chi, tổng 12.500.000 đồng.' };

function setup(answer: ((facts: SupplierPayableLineFacts) => Promise<SupplierPayableLineResult>) | null, budget = new DraftBudget()) {
  const asked: SupplierPayableLineFacts[] = [];
  const ai = supplierPayableLineAi(answer ? { supplierPayableLineSentence: async (facts) => (asked.push(facts), answer(facts)) } : null, budget);
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('supplierPayableFacts', () => {
  it('sums the facts by code and suggests the oldest invoice among those a person can ask for', () => {
    // The oldest invoice (3 Oct) is of a supplier with no account, so it cannot be asked for: the suggestion is the next one.
    expect(FACTS).toEqual({ invoices: 3, total: '12500000', oldestDate: '2026-10-03', onChangedAccount: 1, suggestedPurchaseDocumentId: id(2) });
  });

  it('breaks a tie of dates by the lower id, and suggests none when no invoice can be asked for', () => {
    const tie: SupplierPayableList = { items: [item(7), item(5), item(6)], more: false };
    expect(supplierPayableFacts(tie)?.suggestedPurchaseDocumentId).toBe(id(5));
    const none: SupplierPayableList = { items: [item(1, { account: 'none' }), item(2, { account: 'many' })], more: false };
    expect(supplierPayableFacts(none)?.suggestedPurchaseDocumentId).toBeNull();
  });

  it('has no facts when nothing waits, the list was cut short or an invoice is not in dong', () => {
    expect(supplierPayableFacts({ items: [], more: false })).toBeNull();
    expect(supplierPayableFacts({ ...LIST, more: true })).toBeNull();
    expect(supplierPayableFacts({ items: [item(1), item(2, { currency: 'USD' })], more: false })).toBeNull();
  });

  it('tells the model only the four facts and the language', () => {
    expect(Object.keys(supplierPayableLineFacts(FACTS, 'en')).sort()).toEqual(['invoices', 'language', 'oldestDate', 'onChangedAccount', 'total']);
  });
});

describe('explainSupplierPayableLine', () => {
  it('asks the model once with the four facts and answers the facts with its sentence', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainSupplierPayableLine(ai, ORG, USER, LIST, 'vi')).toEqual({ facts: FACTS, ai: 'used', text: SAID.text });
    expect(asked).toEqual([{ language: 'vi', invoices: 3, total: '12500000', oldestDate: '2026-10-03', onChangedAccount: 1 }]);
  });

  it('makes no call when nothing waits, and says off with no call when the deployment has no model; the facts come back', async () => {
    const { ai, asked } = setup(async () => SAID);
    expect(await explainSupplierPayableLine(ai, ORG, USER, { items: [], more: false }, 'vi')).toEqual({ facts: null, ai: 'none', text: null });
    expect(await explainSupplierPayableLine(ai, ORG, USER, { ...LIST, more: true }, 'vi')).toEqual({ facts: null, ai: 'none', text: null });
    expect(asked).toEqual([]);
    expect(await explainSupplierPayableLine(setup(null).ai, ORG, USER, LIST, 'vi')).toEqual({ facts: FACTS, ai: 'off', text: null });
  });

  it('keeps an answer by its facts for a while, so reopening the screen does not pay twice', async () => {
    const { ai, asked } = setup(async () => SAID);
    const now = 1_000;
    await explainSupplierPayableLine(ai, ORG, USER, LIST, 'vi', () => now);
    await explainSupplierPayableLine(ai, ORG, USER, LIST, 'vi', () => now + 1000);
    expect(asked).toHaveLength(1);
    await explainSupplierPayableLine(ai, ORG, USER, LIST, 'vi', () => now + SUPPLIER_PAYABLE_LINE_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    // Other facts, another language or another org are asked again.
    await explainSupplierPayableLine(ai, ORG, USER, { items: [item(1)], more: false }, 'vi', () => now + SUPPLIER_PAYABLE_LINE_KEEP_MS + 2);
    await explainSupplierPayableLine(ai, ORG, USER, LIST, 'en', () => now + SUPPLIER_PAYABLE_LINE_KEEP_MS + 3);
    await explainSupplierPayableLine(ai, '33333333-3333-4333-8333-333333333333', USER, LIST, 'vi', () => now + SUPPLIER_PAYABLE_LINE_KEEP_MS + 4);
    expect(asked).toHaveLength(5);
  });

  it('keeps a refusal for a shorter while, and never keeps a transport failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ai, asked } = setup(async () => ({ kind: 'none', code: 'BINDING' }));
    const now = 1_000;
    expect(await explainSupplierPayableLine(ai, ORG, USER, LIST, 'vi', () => now)).toEqual({ facts: FACTS, ai: 'failed', text: null });
    expect(await explainSupplierPayableLine(ai, ORG, USER, LIST, 'vi', () => now + 1000)).toEqual({ facts: FACTS, ai: 'failed', text: null });
    expect(asked).toHaveLength(1);
    await explainSupplierPayableLine(ai, ORG, USER, LIST, 'vi', () => now + SUPPLIER_PAYABLE_LINE_REFUSED_KEEP_MS + 1);
    expect(asked).toHaveLength(2);
    expect(SUPPLIER_PAYABLE_LINE_REFUSED_KEEP_MS).toBeLessThan(SUPPLIER_PAYABLE_LINE_KEEP_MS);
    const failing = setup(async () => {
      throw new Error('upstream down');
    });
    await explainSupplierPayableLine(failing.ai, ORG, USER, LIST, 'vi', () => now);
    await explainSupplierPayableLine(failing.ai, ORG, USER, LIST, 'vi', () => now + 1000);
    expect(failing.asked).toHaveLength(2);
  });

  it('names a refused text, a failed call and a spent budget, with no text and no quote of either', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await explainSupplierPayableLine(setup(async () => ({ kind: 'none', code: 'CLAIM' })).ai, ORG, USER, LIST, 'vi')).toEqual({ facts: FACTS, ai: 'failed', text: null });
    const failed = setup(async () => {
      throw new Error('upstream said: 12.500.000 for Supplier 2');
    });
    expect(await explainSupplierPayableLine(failed.ai, ORG, USER, LIST, 'vi')).toEqual({ facts: FACTS, ai: 'failed', text: null });
    const spent = setup(async () => {
      throw new AiBudgetExhaustedError('module', null);
    });
    expect(await explainSupplierPayableLine(spent.ai, ORG, USER, LIST, 'vi')).toEqual({ facts: FACTS, ai: 'budget', text: null });
    expect(JSON.stringify(error.mock.calls)).not.toContain('Supplier 2');
    expect(JSON.stringify(error.mock.calls)).not.toContain('12.500.000');
  });

  it('says busy, with no call, when the member asks too often', async () => {
    const { ai, asked } = setup(async () => SAID, new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 60 }));
    await explainSupplierPayableLine(ai, ORG, USER, LIST, 'vi');
    const other: SupplierPayableList = { items: [item(1)], more: false };
    expect(await explainSupplierPayableLine(ai, ORG, USER, other, 'vi')).toMatchObject({ ai: 'busy', text: null });
    expect(asked).toHaveLength(1);
  });
});
