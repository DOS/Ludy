// SPDX-License-Identifier: AGPL-3.0-only
// The quote inputs (#2693): a VAT rate fits the column once normalized, and a save names a deal or a versioned quote.
import { describe, expect, it } from 'vitest';
import { QUOTE_VAT_RATE_MAX, zQuoteLineInput, zQuoteSave, zQuoteSettingSet } from '../src/crm-quotes.ts';

const line = (vatRate: string) => ({ kind: 'item', description: 'x', quantity: '1', unitPrice: '1', vatRate });

describe('quote inputs', () => {
  it('stops a VAT rate one short of the column, since normalizing may add the percent sign', () => {
    expect(zQuoteLineInput.safeParse(line('1'.repeat(QUOTE_VAT_RATE_MAX - 1))).success).toBe(true);
    expect(zQuoteLineInput.safeParse(line('1'.repeat(QUOTE_VAT_RATE_MAX))).success).toBe(false);
    expect(zQuoteSettingSet.safeParse({ validDays: 14, defaultVat: '1'.repeat(QUOTE_VAT_RATE_MAX), defaultTerms: null }).success).toBe(false);
  });

  it('needs a deal to create and a version to save', () => {
    expect(zQuoteSave.safeParse({ dealId: crypto.randomUUID(), lines: [] }).success).toBe(true);
    expect(zQuoteSave.safeParse({ lines: [] }).success).toBe(false);
    expect(zQuoteSave.safeParse({ quoteId: crypto.randomUUID(), lines: [] }).success).toBe(false);
    expect(zQuoteSave.safeParse({ quoteId: crypto.randomUUID(), version: 1, lines: [] }).success).toBe(true);
  });
});
