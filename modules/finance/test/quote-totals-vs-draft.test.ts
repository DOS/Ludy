// SPDX-License-Identifier: AGPL-3.0-only
// A quote's total equals the total of the sales e-invoice draft made from it (docs/plan/crm-quotes.md 4.4, exit criterion of step Q1): the shared line rule of
// @crove/l10n-vn `totalLines` against `computeDraft` of the finance module (which has no discount), on a table of cases. It lives in the finance module's tests because the two modules
// may not import each other and finance already depends on @crove/l10n-vn.
import { describe, expect, it } from 'vitest';
import { totalLines } from '@crove/l10n-vn';
import { computeDraft } from '../src/domain/einvoice-draft.ts';

interface Case {
  name: string;
  lines: Array<{ quantity: string; unitPrice: string; vatRate: string }>;
}

const CASES: Case[] = [
  { name: 'one plain line', lines: [{ quantity: '10', unitPrice: '120000', vatRate: '10%' }] },
  { name: 'half up at .5 on the amount', lines: [{ quantity: '1', unitPrice: '100.5', vatRate: '0%' }] },
  { name: 'half up at .5 on the VAT', lines: [{ quantity: '1', unitPrice: '105', vatRate: '10%' }] },
  { name: 'the same half twice, rounded line by line', lines: [{ quantity: '1', unitPrice: '100.5', vatRate: '10%' }, { quantity: '1', unitPrice: '100.5', vatRate: '10%' }] },
  { name: 'every rate', lines: ['0%', '5%', '8%', '10%', 'KCT', 'KKKNT'].map((vatRate) => ({ quantity: '3', unitPrice: '33333.33', vatRate })) },
  { name: 'a fractional quantity and a long price', lines: [{ quantity: '2.123456', unitPrice: '0.12345678', vatRate: '8%' }, { quantity: '1000000', unitPrice: '0.12345678', vatRate: '10%' }] },
  { name: 'the rate written without the percent sign', lines: [{ quantity: '7', unitPrice: '15000.5', vatRate: '10' }, { quantity: '2', unitPrice: '999', vatRate: '5' }] },
  { name: 'no lines', lines: [] },
];

describe('a quote total equals the e-invoice draft total (no discount)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const quote = totalLines(c.lines.map((l) => ({ ...l, discountPercent: '0' })));
      const draft = computeDraft(c.lines.map((l) => ({ description: 'x', unit: null, ...l })));
      expect(quote.subtotal).toBe(draft.subtotal);
      expect(quote.vatAmount).toBe(draft.vatAmount);
      expect(quote.total).toBe(draft.total);
      expect(quote.lines.map((l) => [l.amount, l.vatAmount, l.vatRate])).toEqual(draft.lines.map((l) => [l.amount, l.vatAmount, l.vatRate]));
    });
  }

  // A discount is the quote's own: the line's amount after it is what an invoice line with that net amount shows, so the same rule applies to it.
  it('a discounted line equals the draft line priced at the discounted amount', () => {
    const quote = totalLines([{ quantity: '3', unitPrice: '33333', discountPercent: '10', vatRate: '8%' }]);
    // 3 x 33333 x 0.9 = 89999.1, one line of quantity 1 at that net price (the amount rounds to the whole dong the same way).
    const draft = computeDraft([{ description: 'x', unit: null, quantity: '1', unitPrice: '89999.1', vatRate: '8%' }]);
    expect(quote.total).toBe(draft.total);
    expect(quote.lines[0]?.amount).toBe(draft.lines[0]?.amount);
  });
});
