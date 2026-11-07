// SPDX-License-Identifier: AGPL-3.0-only
// A quote and the e-invoice draft made from it add up the same (#2693, docs/plan/crm-quotes.md 4.4): computeDraft and the shared line-totals rule of
// @crove/l10n-vn give the same amount, VAT and totals on a table of cases (rounding half up at .5, exempt VAT, a rate written without the sign).
import { computeLineTotals, sumLineTotals } from '@crove/l10n-vn';
import { describe, expect, it } from 'vitest';
import { computeDraft } from '../src/domain/einvoice-draft.ts';

const CASES = [
  { quantity: '2', unitPrice: '1500000', vatRate: '10%' },
  { quantity: '3', unitPrice: '333.5', vatRate: '10%' },
  { quantity: '1', unitPrice: '25', vatRate: '10%' },
  { quantity: '1.5', unitPrice: '100001', vatRate: 'KCT' },
  { quantity: '7', unitPrice: '99.99', vatRate: '5' },
  { quantity: '0.333333', unitPrice: '3000', vatRate: '8%' },
  { quantity: '1', unitPrice: '5000', vatRate: 'KKKNT' },
  { quantity: '1', unitPrice: '1001.5', vatRate: '0%' },
];

describe('computeDraft and computeLineTotals', () => {
  it('compute each line the same way', () => {
    const draft = computeDraft(CASES.map((c) => ({ description: 'Hàng', unit: null, ...c })));
    CASES.forEach((c, i) => {
      const shared = computeLineTotals(c);
      expect(draft.lines[i], JSON.stringify(c)).toMatchObject({ amount: shared.amount, vatAmount: shared.vatAmount, vatRate: shared.vatRate });
    });
  });

  it('keep the amounts the e-invoice draft always had, pinned as literals', () => {
    const draft = computeDraft([
      { description: 'a', unit: null, quantity: '3', unitPrice: '333.5', vatRate: '10%' },
      { description: 'b', unit: null, quantity: '1', unitPrice: '25', vatRate: '10%' },
      { description: 'c', unit: null, quantity: '1.5', unitPrice: '100001', vatRate: 'KCT' },
    ]);
    expect(draft.lines.map((l) => [l.amount, l.vatAmount])).toEqual([['1001', '100'], ['25', '3'], ['150002', '0']]);
    expect([draft.subtotal, draft.vatAmount, draft.total]).toEqual(['151028', '103', '151131']);
  });

  it('give a quote the total of the invoice made from it', () => {
    const draft = computeDraft(CASES.map((c) => ({ description: 'Hàng', unit: null, ...c })));
    const quote = sumLineTotals(CASES.map((c) => computeLineTotals(c)));
    expect({ subtotal: draft.subtotal, vatAmount: draft.vatAmount, total: draft.total }).toEqual(quote);
  });
});
