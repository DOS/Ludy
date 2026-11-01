// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkInvoice, lineContribution, money, roundInvoiceToDong, sum, type InvoiceLine, type ParsedInvoice } from '../src/index.ts';

// Rounding a VND invoice with amounts below one dong (#2235, owner decision #1308 option 2).
const parsed = JSON.parse(readFileSync(new URL('./fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;

const line = (lineNo: number, amount: string, nature: InvoiceLine['nature'] = 'goods'): InvoiceLine => ({
  lineNo,
  nature,
  code: null,
  description: `Line ${lineNo}`,
  unit: null,
  quantity: null,
  unitPrice: null,
  amount,
  vatRate: '10%',
});

// An invoice of the given lines, subtotal and VAT; the total is the sum unless given.
function build(lines: InvoiceLine[], subtotal: string, vatTotal = '0', total?: string): ParsedInvoice {
  return {
    ...structuredClone(parsed),
    lines,
    subtotal,
    vatTotal,
    total: total ?? money(subtotal).plus(money(vatTotal)).toFixed(),
    taxBreakdown: [{ rate: '10%', taxableAmount: subtotal, vatAmount: vatTotal }],
  };
}

const amounts = (invoice: ParsedInvoice) => invoice.lines.map((l) => l.amount);
const scale = (invoice: ParsedInvoice) => checkInvoice(invoice, '2026-10-13').filter((c) => c.id === 'amount_scale');

describe('roundInvoiceToDong', () => {
  it('rounds 10.4 + 20.4 + 30.4 with a total of 61 to 10 + 20 + 31, the difference on the largest line', () => {
    const result = roundInvoiceToDong(build([line(1, '10.4'), line(2, '20.4'), line(3, '30.4')], '61'));
    expect(amounts(result.invoice)).toEqual(['10', '20', '31']);
    expect(result.invoice.subtotal).toBe('61');
    expect(result.applied).toEqual({ firstFraction: '10.4', difference: '1', lineNo: 3 });
    expect(result.refused).toBeNull();
    expect(sum(result.invoice.lines.map(lineContribution)).toFixed()).toBe('61');
  });

  it('reads a subtotal that itself has a fraction the same way', () => {
    const result = roundInvoiceToDong(build([line(1, '10.4'), line(2, '20.4'), line(3, '30.4')], '61.2'));
    expect(amounts(result.invoice)).toEqual(['10', '20', '31']);
    expect(result.invoice.subtotal).toBe('61');
    expect(result.invoice.total).toBe('61');
  });

  it('rounds half up, so a half dong goes up', () => {
    const result = roundInvoiceToDong(build([line(1, '1000000.5'), line(2, '1800000')], '2800001'));
    expect(amounts(result.invoice)).toEqual(['1000001', '1800000']);
    expect(result.applied).toMatchObject({ difference: '0', lineNo: null });
  });

  it('puts a negative difference on the largest line too, and the first of equal lines', () => {
    const result = roundInvoiceToDong(build([line(1, '10.5'), line(2, '10.5')], '20'));
    expect(amounts(result.invoice)).toEqual(['9', '11']);
    expect(result.applied).toEqual({ firstFraction: '10.5', difference: '-2', lineNo: 1 });
    const tie = roundInvoiceToDong(build([line(1, '10.6'), line(2, '10.6')], '21'));
    expect(amounts(tie.invoice)).toEqual(['10', '11']);
    expect(tie.applied).toMatchObject({ difference: '-1', lineNo: 1 });
  });

  it('leaves VAT exactly as the invoice has it, and rounds the VAT table base only', () => {
    const invoice = build([line(1, '100000.4'), line(2, '200000.4')], '300001', '30000');
    const result = roundInvoiceToDong(invoice);
    expect(result.invoice.vatTotal).toBe('30000');
    expect(result.invoice.total).toBe('330001');
    expect(result.invoice.taxBreakdown).toEqual([{ rate: '10%', taxableAmount: '300001', vatAmount: '30000' }]);
    expect(amounts(result.invoice)).toEqual(['100000', '200001']);
  });

  it('never moves the difference onto a discount, a promotion or a note', () => {
    const invoice = build([line(1, '100.4'), line(2, '50.4', 'discount'), line(3, '0', 'note')], '50');
    const result = roundInvoiceToDong(invoice);
    expect(amounts(result.invoice)).toEqual(['100', '50', '0']);
    expect(result.applied).toEqual({ firstFraction: '100.4', difference: '0', lineNo: null });
    expect(roundInvoiceToDong(build([line(1, '50.4', 'discount')], '-49')).refused).toBe('50.4');
  });

  it('refuses an invoice whose VAT has a fraction of a dong', () => {
    expect(roundInvoiceToDong(build([line(1, '100000')], '100000', '10000.5')).refused).toBe('10000.5');
    const table = build([line(1, '100000')], '100000', '10000');
    table.taxBreakdown = [{ rate: '10%', taxableAmount: '100000', vatAmount: '10000.25' }];
    expect(roundInvoiceToDong(table).refused).toBe('10000.25');
  });

  it('refuses a difference above 1 dong per line and keeps the invoice as it was', () => {
    const invoice = build([line(1, '10.4'), line(2, '20.4')], '65');
    const result = roundInvoiceToDong(invoice);
    expect(result.refused).toBe('10.4');
    expect(result.applied).toBeNull();
    expect(result.invoice).toBe(invoice);
    // The same invoice with a difference of exactly 2 dong over 2 lines is absorbed.
    expect(roundInvoiceToDong(build([line(1, '10.4'), line(2, '20.4')], '32')).applied).toMatchObject({ difference: '2', lineNo: 2 });
  });

  it('refuses a total that is not the rounded subtotal plus the VAT', () => {
    expect(roundInvoiceToDong(build([line(1, '100.4')], '100', '10', '112')).refused).toBe('100.4');
  });

  it('refuses a difference that has no goods line to carry it, or that would make the line negative', () => {
    expect(roundInvoiceToDong(build([line(1, '10.4', 'promotion')], '1')).refused).toBe('10.4');
    expect(roundInvoiceToDong(build([line(1, '0.4'), line(2, '0.4')], '-1')).refused).toBe('0.4');
  });

  it('does nothing for a whole-dong invoice or a foreign-currency one', () => {
    const whole = build([line(1, '10'), line(2, '20.0000')], '30');
    expect(roundInvoiceToDong(whole)).toEqual({ invoice: whole, applied: null, refused: null });
    const usd = { ...build([line(1, '10.45')], '10.45'), currency: 'USD' };
    expect(roundInvoiceToDong(usd)).toEqual({ invoice: usd, applied: null, refused: null });
  });

  it('does not change the invoice it is given', () => {
    const invoice = build([line(1, '10.4'), line(2, '20.4'), line(3, '30.4')], '61');
    const before = structuredClone(invoice);
    roundInvoiceToDong(invoice);
    expect(invoice).toEqual(before);
  });
});

describe('amount_scale check with rounding', () => {
  it('warns, naming the amount, the dong and the line, and passes the sum and total checks', () => {
    const invoice = build([line(1, '10.4'), line(2, '20.4'), line(3, '30.4')], '61');
    expect(scale(invoice)).toEqual([
      {
        id: 'amount_scale',
        status: 'warn',
        code: 'amount_scale.rounded',
        params: { amount: '10.4', difference: '1', line: '3' },
        message: expect.stringContaining('dồn chênh lệch 1 đồng vào dòng 3'),
      },
    ]);
    const checks = checkInvoice(invoice, '2026-10-13');
    expect(checks.find((c) => c.id === 'lines_sum')?.status).toBe('pass');
    expect(checks.find((c) => c.id === 'total')?.status).toBe('pass');
    expect(checks.filter((c) => c.status === 'fail').map((c) => c.id)).not.toContain('amount_scale');
  });

  it('warns without a line when the rounded lines already add up', () => {
    expect(scale(build([line(1, '10.4'), line(2, '20.6')], '31'))).toMatchObject([{ status: 'warn', code: 'amount_scale.rounded_even', params: { amount: '10.4' } }]);
  });

  it('stays blocking for what cannot be rounded: VAT with a fraction, or a difference above the limit', () => {
    expect(scale(build([line(1, '100000')], '100000', '10000.5'))).toMatchObject([{ status: 'fail', code: 'amount_scale.fraction', params: { amount: '10000.5' } }]);
    expect(scale(build([line(1, '10.4'), line(2, '20.4')], '65'))).toMatchObject([{ status: 'fail', code: 'amount_scale.fraction' }]);
  });

  it('keeps the sum check on the lines as they are when the invoice cannot be rounded', () => {
    const checks = checkInvoice(build([line(1, '10.4'), line(2, '20.4')], '65'), '2026-10-13');
    expect(checks.find((c) => c.id === 'lines_sum')?.status).toBe('fail');
  });

  it('adds no check for a whole-dong invoice', () => {
    expect(scale(build([line(1, '10'), line(2, '20')], '30'))).toEqual([]);
  });
});
