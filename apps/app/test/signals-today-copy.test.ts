// SPDX-License-Identifier: AGPL-3.0-only
// The words of the cross-app flag of Home (Vy plan C4, slice V4, #2967): each title key `kernel.signals.deal_without_invoice` returns
// (packages/kernel/src/signals.ts) has its text in both languages, built from the params it sends, and none of them names an AI coworker.
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';

const TITLES: Array<{ key: string; params: Record<string, string | number> }> = [
  { key: 'signals.wonDealNoInvoice', params: { days: 9 } },
  { key: 'signals.wonDealNoInvoiceMore', params: { count: 4 } },
  { key: 'signals.overdueReceivableOpenDeal', params: { days: 12 } },
  { key: 'signals.overdueReceivableOpenDealMore', params: { count: 4 } },
  { key: 'signals.supplierBankChanged', params: { days: 3, count: 2 } },
  { key: 'signals.supplierBankChangedMore', params: { count: 5 } },
  { key: 'signals.supplierBankChangedUnchecked', params: { count: 3 } },
  { key: 'signals.supplierBankChangedPartial', params: {} },
  { key: 'signals.conversationUnanswered', params: { hours: 26 } },
  { key: 'signals.conversationUnansweredMore', params: { count: 4 } },
];

type Say = (key: string, values?: Record<string, string | number>) => string;
const sayIn = (lang: 'en' | 'vi'): Say => translatorFor(lang) as unknown as Say;

describe('the cross-app flag of Home, in words', () => {
  it('has a text in both languages for every title the rule returns, with every param in it and no coworker name', () => {
    for (const lang of ['en', 'vi'] as const) {
      const say = sayIn(lang);
      for (const title of TITLES) {
        const text = say(`today.items.${title.key}`, title.params);
        expect(text, `${lang} ${title.key}`).not.toContain('today.items');
        for (const [name, value] of Object.entries(title.params)) expect(text, `${lang} ${title.key} ${name}`).toContain(String(value));
        expect(text, `${lang} ${title.key}`).not.toMatch(/\b(Vy|Ly|Dy|Uy)\b/);
      }
    }
  });

  it('says days and counts with the right plural', () => {
    expect(sayIn('en')('today.items.signals.wonDealNoInvoice', { days: 1 })).toContain('1 day ago');
    expect(sayIn('en')('today.items.signals.wonDealNoInvoice', { days: 9 })).toContain('9 days ago');
    expect(sayIn('en')('today.items.signals.wonDealNoInvoiceMore', { count: 1 })).toContain('1 more deal ');
    expect(sayIn('vi')('today.items.signals.wonDealNoInvoice', { days: 9 })).toContain('9 ngày');
  });
});
