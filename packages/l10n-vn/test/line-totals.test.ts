// SPDX-License-Identifier: AGPL-3.0-only
// The one line-totals rule a quote and an e-invoice draft share (#2693, docs/plan/crm-quotes.md 4.4): half up to the whole dong, per line, with an optional
// discount, exempt and non-standard VAT rates, and totals that are the sums of the rounded lines.
import { describe, expect, it } from 'vitest';
import { computeLineTotals, normalizeVatRate, sumLineTotals } from '../src/index.ts';

export const LINE_CASES: { name: string; line: { quantity: string; unitPrice: string; discountPercent?: string; vatRate: string }; amount: string; vatAmount: string; vatRate: string }[] = [
  { name: 'a whole amount at 10%', line: { quantity: '2', unitPrice: '1500000', vatRate: '10%' }, amount: '3000000', vatAmount: '300000', vatRate: '10%' },
  { name: 'rounds .5 of the amount up', line: { quantity: '3', unitPrice: '333.5', vatRate: '10%' }, amount: '1001', vatAmount: '100', vatRate: '10%' },
  { name: 'rounds below .5 down', line: { quantity: '1', unitPrice: '100.49', vatRate: '10' }, amount: '100', vatAmount: '10', vatRate: '10%' },
  { name: 'rounds the VAT half up', line: { quantity: '1', unitPrice: '25', vatRate: '10%' }, amount: '25', vatAmount: '3', vatRate: '10%' },
  { name: 'applies a discount before the rounding', line: { quantity: '1', unitPrice: '1000000', discountPercent: '12.5', vatRate: '8%' }, amount: '875000', vatAmount: '70000', vatRate: '8%' },
  { name: 'a discount that lands on .5', line: { quantity: '1', unitPrice: '1001', discountPercent: '50', vatRate: '0%' }, amount: '501', vatAmount: '0', vatRate: '0%' },
  { name: 'a full discount is zero', line: { quantity: '4', unitPrice: '99', discountPercent: '100', vatRate: '10%' }, amount: '0', vatAmount: '0', vatRate: '10%' },
  { name: 'exempt (KCT) carries no VAT', line: { quantity: '1.5', unitPrice: '100001', vatRate: 'kct' }, amount: '150002', vatAmount: '0', vatRate: 'KCT' },
  { name: 'not declared (KKKNT) carries no VAT', line: { quantity: '1', unitPrice: '5000', vatRate: 'KKKNT' }, amount: '5000', vatAmount: '0', vatRate: 'KKKNT' },
  { name: 'five percent without the sign', line: { quantity: '7', unitPrice: '99.99', discountPercent: '0.5', vatRate: '5' }, amount: '696', vatAmount: '35', vatRate: '5%' },
  { name: 'six decimals of quantity', line: { quantity: '0.333333', unitPrice: '3000', vatRate: '10%' }, amount: '1000', vatAmount: '100', vatRate: '10%' },
];

describe('computeLineTotals', () => {
  for (const c of LINE_CASES) {
    it(c.name, () => {
      expect(computeLineTotals(c.line)).toEqual({ amount: c.amount, vatAmount: c.vatAmount, vatRate: c.vatRate });
    });
  }

  it('leaves a line that is not a decimal at zero for the caller to refuse', () => {
    expect(computeLineTotals({ quantity: 'abc', unitPrice: '1', vatRate: '10%' })).toEqual({ amount: '0', vatAmount: '0', vatRate: '10%' });
  });
});

describe('normalizeVatRate', () => {
  it('writes the rates of the set as an invoice does and refuses the rest', () => {
    expect(['0', '5%', ' 8 ', '10%', 'kct', 'KKKNT', 'KHAC:3.5%'].map(normalizeVatRate)).toEqual(['0%', '5%', '8%', '10%', 'KCT', 'KKKNT', 'KHAC:3.5%']);
    expect(['7%', '11', '100%', '', 'abc', 'KHAC'].map(normalizeVatRate)).toEqual([null, null, null, null, null, null]);
  });
});

describe('sumLineTotals', () => {
  it('is the sum of the rounded lines, so the document adds up as printed', () => {
    const lines = LINE_CASES.map((c) => computeLineTotals(c.line));
    const totals = sumLineTotals(lines);
    expect(totals.subtotal).toBe(String(LINE_CASES.reduce((a, c) => a + Number(c.amount), 0)));
    expect(totals.vatAmount).toBe(String(LINE_CASES.reduce((a, c) => a + Number(c.vatAmount), 0)));
    expect(Number(totals.total)).toBe(Number(totals.subtotal) + Number(totals.vatAmount));
    expect(sumLineTotals([])).toEqual({ subtotal: '0', vatAmount: '0', total: '0' });
  });
});
