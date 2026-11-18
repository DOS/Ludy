// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker's one line above "Invoices to pay" (#3113 S4c): what the model is told, and the checks that refuse its text. The sentence is tainted: any number or date the facts do not hold, a number set
// against the wrong thing, a link, advice, a claim that something was paid, approved or sent, or a text that is not one short sentence is no line (never repaired).
import { describe, expect, it } from 'vitest';
import {
  checkSupplierPayableLineSentence,
  supplierPayableLineFactsText,
  supplierPayableLineHasNews,
  supplierPayableLineInstructions,
  supplierPayableLinePrompt,
  type SupplierPayableLineFacts,
} from '../src/index.ts';

const VI: SupplierPayableLineFacts = { language: 'vi', invoices: 3, total: '12500000', oldestDate: '2026-10-03', onChangedAccount: 1 };
const EN: SupplierPayableLineFacts = { ...VI, language: 'en' };
const check = (facts: SupplierPayableLineFacts, sentence: string) => checkSupplierPayableLineSentence(facts, { sentence });
const refused = (facts: SupplierPayableLineFacts, sentence: string, code: string) => expect(check(facts, sentence)).toEqual({ kind: 'none', code });

describe('the facts the model is told', () => {
  it('are four lines, the amount and the date as the language writes them, and nothing else', () => {
    expect(supplierPayableLineFactsText(VI)).toBe(
      [
        'Received invoices waiting to be asked for payment: 3',
        'Their total: 12.500.000 đồng',
        'Oldest invoice date: 03/10/2026',
        'Of them, invoices of a supplier whose bank account changed recently: 1',
      ].join('\n'),
    );
    expect(supplierPayableLineFactsText(EN)).toContain('Their total: 12,500,000 dong');
    expect(supplierPayableLinePrompt(VI)).toBe(`${supplierPayableLineFactsText(VI)}\n\nWrite the sentence on what is waiting.`);
    expect(supplierPayableLineInstructions('vi')).toContain('Vietnamese');
  });

  it('say there is news only when an invoice waits', () => {
    expect(supplierPayableLineHasNews({ invoices: 0 })).toBe(false);
    expect(supplierPayableLineHasNews({ invoices: 1 })).toBe(true);
  });
});

describe('a sentence that states the facts as given', () => {
  it.each([
    [VI, 'Có 3 hóa đơn cần chi, tổng 12.500.000 đồng, cũ nhất ngày 03/10/2026.'],
    [VI, 'Hiện có 3 hóa đơn, trong đó 1 của nhà cung cấp đã đổi tài khoản ngân hàng.'],
    [VI, 'Có 3 hóa đơn chờ chi, tổng 12.500.000 đồng, cũ nhất ngày 03/10/2026, trong đó 1 hóa đơn của nhà cung cấp vừa đổi tài khoản ngân hàng.'],
    [EN, '3 invoices, total 12,500,000 dong, oldest 03/10/2026, 1 invoice of a supplier whose bank account changed.'],
    [EN, '3 received invoices are waiting, 12,500,000 dong in total, the oldest dated 03/10/2026.'],
    [EN, 'Of the 3 invoices waiting to be paid, 1 is of a supplier whose bank account changed.'],
  ])('is kept: %#', (facts, sentence) => {
    expect(check(facts, sentence)).toEqual({ kind: 'sentence', text: sentence });
  });
});

describe('a sentence that is refused, not repaired', () => {
  it('has no text, or more than one sentence, or is too long', () => {
    refused(VI, '', 'EMPTY');
    expect(checkSupplierPayableLineSentence(VI, null)).toEqual({ kind: 'none', code: 'EMPTY' });
    refused(VI, 'Có 3 hóa đơn. Tổng 12.500.000 đồng.', 'TOO_LONG');
    refused(VI, `Có 3 hóa đơn ${'rất '.repeat(80)}đang chờ.`, 'TOO_LONG');
  });

  it('states a number, an amount or a date the facts do not hold', () => {
    refused(VI, 'Có 4 hóa đơn cần chi.', 'FIGURES');
    refused(VI, 'Tổng 12.500.001 đồng của 3 hóa đơn.', 'FIGURES');
    refused(VI, 'Tổng khoảng 12,5 triệu đồng của 3 hóa đơn.', 'FIGURES');
    refused(VI, 'Có ba hóa đơn cần chi.', 'FIGURES');
    refused(EN, 'Three invoices are waiting.', 'FIGURES');
    refused(EN, 'The oldest invoice is 12,500k.', 'FIGURES');
    refused(VI, 'Có 3 hóa đơn, cũ nhất ngày 04/10/2026.', 'FIGURES');
  });

  it('sets a number against the wrong thing', () => {
    refused(VI, 'Có 12.500.000 hóa đơn, tổng 3 đồng.', 'BINDING');
    refused(VI, 'Có 1 hóa đơn cần chi, tổng 12.500.000 đồng.', 'BINDING');
    refused(VI, 'Có 3 hóa đơn của nhà cung cấp đổi tài khoản.', 'BINDING');
    refused(EN, 'Total 3 across 12,500,000 invoices.', 'BINDING');
    refused(EN, 'The newest invoice is dated 03/10/2026.', 'BINDING');
    // Safe over lively: a count next to the changed-account words that is not the changed-account number is refused, and the screen shows the facts alone.
    refused(EN, '1 of the 3 invoices is of a supplier whose bank account changed.', 'BINDING');
    refused(EN, 'There are 3 invoices, dated 03/10/2026.', 'BINDING');
  });

  it('carries a link, advice, a claim that something was done or a script of another alphabet', () => {
    refused(VI, 'Có 3 hóa đơn, xem https://example.com để chi.', 'LINK');
    refused(VI, 'Có 3 hóa đơn, nên chi hóa đơn cũ nhất trước.', 'ADVICE');
    refused(EN, 'You should pay the oldest of the 3 invoices first.', 'ADVICE');
    refused(VI, 'Đã chi 3 hóa đơn.', 'CLAIM');
    refused(EN, 'The 3 invoices were paid.', 'CLAIM');
    refused(EN, 'A payment request was sent for 3 invoices.', 'CLAIM');
    refused(EN, 'The 3 invoices are approved.', 'CLAIM');
    refused(EN, '3 invoices, total 12,500,000 dong, payment is made.', 'CLAIM');
    refused(EN, '3 invoices, total 12,500,000 dong, all overdue.', 'CLAIM');
    refused(EN, '3 invoices, payment pending approval.', 'CLAIM');
    refused(VI, 'Có 3 hóa đơn đã quá hạn.', 'CLAIM');
    refused(VI, 'Có 3 hóa đơn, mình ѕẽ chi hôm nay.', 'SCRIPT');
  });

  it('allows "waiting to be paid" and "changed", which are facts, not claims', () => {
    expect(check(EN, 'Waiting to be paid: 3 invoices, 12,500,000 dong in total.').kind).toBe('sentence');
    expect(check(VI, 'Có 3 hóa đơn chờ chi, tổng 12.500.000 đồng.').kind).toBe('sentence');
  });
});
