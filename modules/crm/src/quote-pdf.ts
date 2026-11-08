// SPDX-License-Identifier: AGPL-3.0-only
// The data the quote PDF is made from (issue #2695, plan docs/plan/crm-quotes.md step Q3): the quote, the seller (the org's own record) and the buyer
// (the customer's record). Read only: members and viewers may read a quote, so they may read its document; nothing is written and no row is audited, as
// for `crm.quote.get`. The bytes are made from this by `renderQuotePdf`, in the HTTP route for the download and later by the mail template of Q2.
//
// The seam for Q2 (#2694): `loadQuoteDocument(ctx, quoteId)` gives a `QuoteDocument`; a sent quote's buyer snapshot replaces `buyer` there, and
// `issuedOn` becomes the day it was sent. `renderQuotePdf(document)` is a pure function of its input.
import { defineQuery } from '@crove/kernel-runtime';
import { vietnamToday, zQuoteRef } from '@crove/kernel-contract';
import { loadQuote, type Reader } from './quotes.ts';
import type { QuoteDocument, QuoteParty } from './pdf/quote-document.ts';

const ALL = ['owner', 'admin', 'member', 'viewer'] as const;

export async function loadQuoteDocument(ctx: Reader, quoteId: string): Promise<QuoteDocument> {
  const quote = await loadQuote(ctx, quoteId);
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['name', 'tax_code', 'address', 'contact_email']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const party = await ctx.trx
    .selectFrom('crove_kernel.party')
    .select(['name', 'tax_code', 'address', 'phone', 'email'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', quote.partyId)
    .executeTakeFirstOrThrow();
  const seller: QuoteDocument['seller'] = { name: org.name, taxCode: org.tax_code, address: org.address, phone: null, email: org.contact_email, bankNote: null };
  const buyer: QuoteParty = { name: party.name, taxCode: party.tax_code, address: party.address, phone: party.phone, email: party.email };
  return { quote, seller, buyer, issuedOn: vietnamToday(new Date(quote.createdAt)) };
}

export const quoteDocument = defineQuery({
  name: 'crm.quote.document',
  input: zQuoteRef,
  access: ALL,
  handler: async (ctx, input): Promise<QuoteDocument> => loadQuoteDocument(ctx, input.quoteId),
});

export const quotePdfQueries = [quoteDocument];
