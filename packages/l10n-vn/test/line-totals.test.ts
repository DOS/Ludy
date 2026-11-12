// SPDX-License-Identifier: AGPL-3.0-only
// The line amounts and totals a quote and a sales e-invoice draft share (docs/plan/crm-quotes.md 4.4).
import { describe, expect, it } from 'vitest';
import { LINE_VAT_RATES, lineAmounts, normalizeLineVatRate, totalLines } from '../src/index.ts';

describe('normalizeLineVatRate', () => {
  it('writes an allowed rate as an invoice does, whatever the spelling', () => {
    expect(normalizeLineVatRate('10')).toBe('10%');
    expect(normalizeLineVatRate(' 8 % ')).toBe('8%');
    expect(normalizeLineVatRate('0%')).toBe('0%');
    expect(normalizeLineVatRate('kct')).toBe('KCT');
    expect(normalizeLineVatRate('KKKNT')).toBe('KKKNT');
  });
  it('refuses a rate that is not allowed', () => {
    for (const bad of ['7', '7%', '101', 'KHAC:5%', '', 'abc', '-5']) expect(normalizeLineVatRate(bad), bad).toBeNull();
  });
  it('lists the six rates', () => {
    expect([...LINE_VAT_RATES]).toEqual(['0%', '5%', '8%', '10%', 'KCT', 'KKKNT']);
  });
});

describe('lineAmounts', () => {
  const cases: Array<[string, { quantity: string; unitPrice: string; discountPercent?: string; vatRate: string }, { amount: string; vatAmount: string }]> = [
    ['a plain line', { quantity: '10', unitPrice: '120000', vatRate: '10%' }, { amount: '1200000', vatAmount: '120000' }],
    ['half up at .5 on the amount', { quantity: '1', unitPrice: '100.5', vatRate: '0%' }, { amount: '101', vatAmount: '0' }],
    ['just under .5 rounds down', { quantity: '1', unitPrice: '100.4999', vatRate: '0%' }, { amount: '100', vatAmount: '0' }],
    ['half up at .5 on the VAT', { quantity: '1', unitPrice: '105', vatRate: '10%' }, { amount: '105', vatAmount: '11' }],
    ['a discount is taken before rounding', { quantity: '3', unitPrice: '33333', discountPercent: '10', vatRate: '8%' }, { amount: '89999', vatAmount: '7200' }],
    ['a discount of 100 percent', { quantity: '2', unitPrice: '500', discountPercent: '100', vatRate: '10%' }, { amount: '0', vatAmount: '0' }],
    ['a fractional quantity', { quantity: '2.5', unitPrice: '40000', vatRate: '5%' }, { amount: '100000', vatAmount: '5000' }],
    ['an exempt line has no VAT', { quantity: '4', unitPrice: '25000', vatRate: 'KCT' }, { amount: '100000', vatAmount: '0' }],
    ['a line not declared has no VAT', { quantity: '4', unitPrice: '25000', vatRate: 'KKKNT' }, { amount: '100000', vatAmount: '0' }],
    ['a price with eight decimals', { quantity: '1000000', unitPrice: '0.12345678', vatRate: '10%' }, { amount: '123457', vatAmount: '12346' }],
  ];
  for (const [name, line, want] of cases) {
    it(name, () => {
      const got = lineAmounts(line);
      expect({ amount: got.amount, vatAmount: got.vatAmount }).toEqual(want);
    });
  }
  it('throws for a rate that is not allowed, which the caller checks first', () => {
    expect(() => lineAmounts({ quantity: '1', unitPrice: '1', vatRate: '7%' })).toThrow();
  });
});

describe('totalLines', () => {
  it('sums the rounded lines, so the document adds up as printed', () => {
    const totals = totalLines([
      { quantity: '1', unitPrice: '100.5', vatRate: '10%' },
      { quantity: '1', unitPrice: '100.5', vatRate: '10%' },
    ]);
    expect(totals.lines.map((l) => [l.amount, l.vatAmount])).toEqual([
      ['101', '10'],
      ['101', '10'],
    ]);
    expect(totals.subtotal).toBe('202');
    expect(totals.vatAmount).toBe('20');
    expect(totals.total).toBe('222');
  });
  it('is zero for no lines', () => {
    expect(totalLines([])).toEqual({ lines: [], subtotal: '0', vatAmount: '0', total: '0' });
  });
  it('keeps what else a line carries', () => {
    const [line] = totalLines([{ quantity: '1', unitPrice: '10', vatRate: '10', note: 'x' }]).lines;
    expect(line?.note).toBe('x');
    expect(line?.vatRate).toBe('10%');
  });
});
