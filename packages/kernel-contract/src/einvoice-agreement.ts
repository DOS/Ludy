// SPDX-License-Identifier: AGPL-3.0-only
// When an adjusting or replacing e-invoice needs the buyer's signed written agreement first (#5266; plan einvoice-issue.md section 3d, row B). One rule for the finance command and for the
// screen, so they cannot drift.
//
// Circular 91/2026/TT-BTC Art. 10(1)(b): before an invoice is adjusted or replaced for a core error, a buyer that is an economic organization, another organization, a business household or a sole
// trader ("tổ chức kinh tế, tổ chức khác, hộ kinh doanh, cá nhân kinh doanh") and the seller make a written agreement naming the error; for an individual buyer the seller only notifies the buyer
// or posts a notice on its website.
//
// Fail safe: a buyer entered as an individual who has a tax code may be a business household or a sole trader (they carry a personal tax code), and the invoice does not say which. Unless the
// person confirms that the buyer is not a business, the agreement is required. An individual with no tax code, and a consumer who gave nothing, are the individual of the text.
//
// Two exemptions in the same paragraph:
// - Sellers that send the summary tables of Decree 254 Art. 16(3)(a)(a.1) and (a.2): NOT APPLICABLE here. They are sellers on non-coded invoices; Ludy issues coded invoices one by one
//   (Decree 254 Art. 12(1)), so the exemption reaches no invoice made here and the rule has no input for it.
// - Goods sold on an e-commerce or other digital platform ("hoạt động mua bán hàng hóa trên nền tảng thương mại điện tử, nền tảng số khác"): the person says so (`platformSale`), because the
//   invoice does not carry where the sale was made. It is a person's attestation, recorded in the audit as a code, never inferred.
import type { BuyerKind } from './einvoice.ts';

export const AGREEMENT_BASES = [
  'platform_sale_attested',
  'business_buyer',
  'individual_confirmed_business',
  'individual_tax_code_unconfirmed',
  'individual_not_business',
  'individual_no_tax_code',
  'consumer',
] as const;
export type AgreementBasis = (typeof AGREEMENT_BASES)[number];

export interface AgreementRuleInput {
  buyerKind: BuyerKind;
  // The original invoice has a tax code for the buyer.
  buyerHasTaxCode: boolean;
  // What the person answered for an individual buyer with a tax code: true = a business household or sole trader, false = not a business, null = no answer (treated as unclear).
  buyerIsBusiness: boolean | null;
  // The person attests that the goods were sold on an e-commerce or other digital platform.
  platformSale: boolean;
}

export interface AgreementRequirement {
  needed: boolean;
  // A code naming why, for the audit and the screen; never a buyer detail.
  basis: AgreementBasis;
}

export function agreementRequirement(input: AgreementRuleInput): AgreementRequirement {
  if (input.platformSale) return { needed: false, basis: 'platform_sale_attested' };
  if (input.buyerKind === 'business') return { needed: true, basis: 'business_buyer' };
  if (input.buyerKind === 'individual') {
    if (!input.buyerHasTaxCode) return { needed: false, basis: 'individual_no_tax_code' };
    if (input.buyerIsBusiness === false) return { needed: false, basis: 'individual_not_business' };
    return { needed: true, basis: input.buyerIsBusiness === true ? 'individual_confirmed_business' : 'individual_tax_code_unconfirmed' };
  }
  return { needed: false, basis: 'consumer' };
}
