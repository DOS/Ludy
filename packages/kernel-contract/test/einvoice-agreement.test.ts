// SPDX-License-Identifier: AGPL-3.0-only
// The rule for the buyer's signed agreement before an invoice is adjusted or replaced (#5266, Circular 91 Art. 10(1)(b)): every buyer kind, the fail-safe for an individual with a tax code, and the
// platform-sale attestation.
import { describe, expect, it } from 'vitest';
import { AGREEMENT_BASES, BUYER_KINDS, agreementRequirement, zEInvoiceStartCorrection } from '../src/index.ts';

const base = { buyerKind: 'business', buyerHasTaxCode: true, buyerIsBusiness: null, platformSale: false } as const;

describe('agreementRequirement', () => {
  it('requires the agreement of a business buyer, whatever else is said about the buyer', () => {
    expect(agreementRequirement(base)).toEqual({ needed: true, basis: 'business_buyer' });
    expect(agreementRequirement({ ...base, buyerIsBusiness: false })).toEqual({ needed: true, basis: 'business_buyer' });
  });

  it('needs none for an individual with no tax code, nor for a consumer', () => {
    expect(agreementRequirement({ ...base, buyerKind: 'individual', buyerHasTaxCode: false })).toEqual({ needed: false, basis: 'individual_no_tax_code' });
    expect(agreementRequirement({ ...base, buyerKind: 'individual', buyerHasTaxCode: false, buyerIsBusiness: true })).toEqual({ needed: false, basis: 'individual_no_tax_code' });
    expect(agreementRequirement({ ...base, buyerKind: 'consumer', buyerHasTaxCode: false })).toEqual({ needed: false, basis: 'consumer' });
  });

  it('fails safe for an individual with a tax code: asked unless the person says the buyer is not a business', () => {
    expect(agreementRequirement({ ...base, buyerKind: 'individual' })).toEqual({ needed: true, basis: 'individual_tax_code_unconfirmed' });
    expect(agreementRequirement({ ...base, buyerKind: 'individual', buyerIsBusiness: true })).toEqual({ needed: true, basis: 'individual_confirmed_business' });
    expect(agreementRequirement({ ...base, buyerKind: 'individual', buyerIsBusiness: false })).toEqual({ needed: false, basis: 'individual_not_business' });
  });

  it('waives the agreement for an attested platform sale, for every buyer kind, and says so', () => {
    for (const buyerKind of BUYER_KINDS) {
      expect(agreementRequirement({ ...base, buyerKind, platformSale: true })).toEqual({ needed: false, basis: 'platform_sale_attested' });
    }
  });

  it('only ever names a basis from the list', () => {
    const seen = new Set<string>();
    for (const buyerKind of BUYER_KINDS) {
      for (const buyerHasTaxCode of [true, false]) {
        for (const buyerIsBusiness of [true, false, null]) {
          for (const platformSale of [true, false]) seen.add(agreementRequirement({ buyerKind, buyerHasTaxCode, buyerIsBusiness, platformSale }).basis);
        }
      }
    }
    expect([...seen].sort()).toEqual([...AGREEMENT_BASES].sort());
  });
});

describe('the start of a correction', () => {
  const start = { originalDraftId: '00000000-0000-4000-8000-0000000000a1', kind: 'adjustment', reasonCode: '1', rateNature: 'no_amount_change', rateBasis: 'original' };

  it('treats no answer as unanswered and no attestation as none', () => {
    expect(zEInvoiceStartCorrection.parse(start)).toMatchObject({ agreementFileId: null, buyerIsBusiness: null, platformSale: false });
  });

  it('takes the two answers of the person and refuses anything that is not a boolean', () => {
    expect(zEInvoiceStartCorrection.parse({ ...start, buyerIsBusiness: false, platformSale: true })).toMatchObject({ buyerIsBusiness: false, platformSale: true });
    expect(zEInvoiceStartCorrection.safeParse({ ...start, buyerIsBusiness: 'no' }).success).toBe(false);
    expect(zEInvoiceStartCorrection.safeParse({ ...start, platformSale: 'yes' }).success).toBe(false);
  });
});
