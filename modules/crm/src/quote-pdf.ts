// SPDX-License-Identifier: AGPL-3.0-only
// The data the quote PDF is made from (issue #2695, plan docs/plan/crm-quotes.md step Q3): the quote, the seller (the org's own record) and the buyer
// (the customer's record). Read only: members and viewers may read a quote, so they may read its document; nothing is written and no row is audited, as
// for `crm.quote.get`. The bytes are made from this by `renderQuotePdf`, in the HTTP route for the download and later by the mail template of Q2.
//
// `loadQuoteDocument(ctx, quoteId)` gives a `QuoteDocument`; `renderQuotePdf(document)` is a pure function of its input.
import { defineQuery } from '@crove/kernel-runtime';
import { vietnamToday, zQuoteRef } from '@crove/kernel-contract';
import { loadQuote, type Reader } from './quotes.ts';
import type { QuoteDocument, QuoteParty } from './pdf/quote-document.ts';

const ALL = ['owner', 'admin', 'member', 'viewer'] as const;

// A draft is read live (the org's own record and the customer's record as they are now). A quote that has been sent is frozen at the moment of sending (Q2,
// #2694): the buyer is the snapshot taken then, the date is the day it was sent, and the seller is the letterhead the public page shows (the issuing legal
// entity's name and tax code, the org's address, and the phone, email and bank note of the quote settings), so the file says what the customer's page says.
export async function loadQuoteDocument(ctx: Reader, quoteId: string): Promise<QuoteDocument> {
  const quote = await loadQuote(ctx, quoteId);
  const frozen = await ctx.trx
    .selectFrom('crove_crm.quote')
    .select(['sent_at', 'issuer_entity_id', 'buyer_name', 'buyer_tax_code', 'buyer_address', 'buyer_email'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', quoteId)
    .executeTakeFirstOrThrow();
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['name', 'tax_code', 'address', 'contact_email']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const letterhead = await ctx.trx.selectFrom('crove_crm.quote_setting').select(['phone', 'email', 'bank_note']).where('org_id', '=', ctx.orgId).executeTakeFirst();
  const sent = frozen.sent_at !== null && frozen.buyer_name !== null;
  if (!sent) {
    const party = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['name', 'tax_code', 'address', 'phone', 'email'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', quote.partyId)
      .executeTakeFirstOrThrow();
    const seller: QuoteDocument['seller'] = {
      name: org.name,
      taxCode: org.tax_code,
      address: org.address,
      phone: letterhead?.phone ?? null,
      email: letterhead?.email ?? org.contact_email,
      bankNote: letterhead?.bank_note ?? null,
    };
    const buyer: QuoteParty = { name: party.name, taxCode: party.tax_code, address: party.address, phone: party.phone, email: party.email };
    return { quote, seller, buyer, issuedOn: vietnamToday(new Date(quote.createdAt)) };
  }
  const issuer =
    frozen.issuer_entity_id === null
      ? undefined
      : await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', frozen.issuer_entity_id).executeTakeFirst();
  const seller: QuoteDocument['seller'] = {
    name: issuer?.name ?? org.name,
    taxCode: issuer?.tax_code ?? null,
    address: org.address,
    phone: letterhead?.phone ?? null,
    email: letterhead?.email ?? null,
    bankNote: letterhead?.bank_note ?? null,
  };
  // The snapshot holds what the customer's page shows (name, tax code, address) and the address the mail went to; it holds no phone.
  const buyer: QuoteParty = { name: frozen.buyer_name ?? quote.partyName, taxCode: frozen.buyer_tax_code, address: frozen.buyer_address, phone: null, email: frozen.buyer_email };
  return { quote, seller, buyer, issuedOn: vietnamToday(new Date(frozen.sent_at ?? quote.createdAt)) };
}

export const quoteDocument = defineQuery({
  name: 'crm.quote.document',
  input: zQuoteRef,
  access: ALL,
  handler: async (ctx, input): Promise<QuoteDocument> => loadQuoteDocument(ctx, input.quoteId),
});

export const quotePdfQueries = [quoteDocument];
