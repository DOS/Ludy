// SPDX-License-Identifier: AGPL-3.0-only
// Which open bank lines are clean, and why the others need a look (#2385): the rule is pure, so each way out of the clean
// group is shown on its own, and two lines naming one invoice are shown to leave it together.
import { describe, expect, it } from 'vitest';
import { classifyLine, invoiceKey, sharedInvoices, type LineFacts } from '../src/domain/bank-groups.ts';

const invoice = { series: 'C26TAA', number: '123' };
const clean = (over: Partial<LineFacts> = {}): LineFacts => ({
  suggested: { reason: 'tax_code' },
  candidates: 1,
  flaggedAtImport: false,
  exactInvoices: [invoice],
  balanceCovers: true,
  ...over,
});

describe('classifyLine', () => {
  it('is clean with one exact candidate and no warning, by tax code or by invoice number', () => {
    expect(classifyLine(clean())).toEqual({ group: 'clean', why: null, invoice });
    expect(classifyLine(clean({ suggested: { reason: 'invoice' } }))).toEqual({ group: 'clean', why: null, invoice });
    // A party a person taught by hand (#2402) is as clear as a tax code, and still needs its exact invoice.
    expect(classifyLine(clean({ suggested: { reason: 'learned' } }))).toEqual({ group: 'clean', why: null, invoice });
    expect(classifyLine(clean({ suggested: { reason: 'learned' }, exactInvoices: [] }))).toEqual({ group: 'look', why: 'no_invoice' });
  });

  it('needs a look when two parties could be meant: no suggestion, or another party at a weaker reason', () => {
    expect(classifyLine(clean({ suggested: null, candidates: 2 }))).toEqual({ group: 'look', why: 'several' });
    expect(classifyLine(clean({ candidates: 2 }))).toEqual({ group: 'look', why: 'several' });
  });

  it('needs a look when only the name or the open balance points at the party', () => {
    expect(classifyLine(clean({ suggested: { reason: 'name' } }))).toEqual({ group: 'look', why: 'weak' });
    expect(classifyLine(clean({ suggested: { reason: 'balance' } }))).toEqual({ group: 'look', why: 'weak' });
  });

  it('needs a look when no open invoice of the party equals the amount: a partial payment or a fee in it', () => {
    expect(classifyLine(clean({ exactInvoices: [] }))).toEqual({ group: 'look', why: 'no_invoice' });
    // The invoice is already settled: the party's open balance no longer covers the amount.
    expect(classifyLine(clean({ balanceCovers: false }))).toEqual({ group: 'look', why: 'no_invoice' });
  });

  it('needs a look when the party has two open invoices of the amount: which one is paid is for a person to say', () => {
    expect(classifyLine(clean({ exactInvoices: [invoice, { series: 'C26TAA', number: '124' }] }))).toEqual({ group: 'look', why: 'several' });
  });

  it('needs a look when the line was flagged at import, whatever else is true of it', () => {
    expect(classifyLine(clean({ flaggedAtImport: true }))).toEqual({ group: 'look', why: 'duplicate' });
  });
});

describe('sharedInvoices', () => {
  it('names the lines that settle the same invoice: both leave the clean group', () => {
    const one = invoiceKey('party-a', invoice);
    const other = invoiceKey('party-a', { series: 'C26TAA', number: '124' });
    const elsewhere = invoiceKey('party-b', invoice);
    const shared = sharedInvoices([
      ['line-1', one],
      ['line-2', one],
      ['line-3', other],
      ['line-4', elsewhere],
    ]);
    expect([...shared].sort()).toEqual(['line-1', 'line-2']);
    expect(sharedInvoices([])).toEqual(new Set());
  });
});
