// SPDX-License-Identifier: AGPL-3.0-only
// The data the quote PDF is made from (issue #2695, plan docs/plan/crm-quotes.md step Q3): the quote, the seller (the org's own record) and the buyer
// (the customer's record). Read only: members and viewers may read a quote, so they may read its document; nothing is written and no row is audited, as
// for `crm.quote.get`. The bytes are made from this by `renderQuotePdf`, in the HTTP route for the download and later by the mail template of Q2.
//
// `loadQuoteDocument(ctx, quoteId)` gives a `QuoteDocument`; `renderQuotePdf(document)` is a pure function of its input.
import { defineQuery } from '@crove/kernel-runtime';
import { vietnamToday, zQuoteRef } from '@crove/kernel-contract';
import { loadQuote, type Reader } from './quotes.ts';
import { QUOTE_LOGO_MAX_BYTES, QUOTE_LOGO_TYPES } from '@crove/kernel-contract';
import type { QuoteDocument, QuoteParty } from './pdf/quote-document.ts';

const ALL = ['owner', 'admin', 'member', 'viewer'] as const;

// Where the letterhead's logo is stored (#2814), for the HTTP route to read the bytes with: the document itself holds no file. Only a PNG or JPEG within the size the upload allows.
export interface QuoteLogoFile {
  storageKey: string;
  generation: string | null;
  sha256: string;
  contentType: string;
  sizeBytes: number;
}
// What `crm.quote.document` answers: the document and the logo's reference. The logo is live, for a draft and for a sent quote alike.
export type QuoteDocumentData = QuoteDocument & { logoFile: QuoteLogoFile | null };

async function logoFileOf(ctx: Reader): Promise<QuoteLogoFile | null> {
  const setting = await ctx.trx.selectFrom('crove_crm.quote_setting').select('logo_file_id').where('org_id', '=', ctx.orgId).executeTakeFirst();
  if (!setting?.logo_file_id) return null;
  const file = await ctx.trx
    .selectFrom('crove_kernel.file')
    .select(['storage_key', 'generation', 'sha256', 'content_type', 'size_bytes'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', setting.logo_file_id)
    .executeTakeFirst();
  if (!file || !(QUOTE_LOGO_TYPES as readonly string[]).includes(file.content_type) || Number(file.size_bytes) > QUOTE_LOGO_MAX_BYTES) return null;
  return { storageKey: file.storage_key, generation: file.generation, sha256: file.sha256, contentType: file.content_type, sizeBytes: Number(file.size_bytes) };
}

type Frozen = { sent: boolean; issuerEntityId: string | null; snapshot: QuoteDocument['seller'] | null };
type Org = { name: string; tax_code: string | null; address: string | null; contact_email: string | null };

// The one place the seller is decided. A quote that has been sent shows the seller frozen into it when it was sent (#2826: the issuing entity's name and tax code, the
// org's address, and the phone, email and bank note of the settings as they were), the same as the customer's public page, so a later change of the letterhead
// changes no quote that was sent. A draft is read live: the org's own record, with the contact email as the email when no letterhead email is set. A quote sent
// before the snapshot existed (no seller_name) reads the live letterhead as the customer's page does: the issuing legal entity's name and tax code, the org's address,
// and the phone, email and bank note of the quote settings (no fallback).
async function sellerOf(ctx: Reader, org: Org, frozen: Frozen): Promise<QuoteDocument['seller']> {
  if (frozen.sent && frozen.snapshot) return frozen.snapshot;
  const letterhead = await ctx.trx.selectFrom('crove_crm.quote_setting').select(['phone', 'email', 'bank_note']).where('org_id', '=', ctx.orgId).executeTakeFirst();
  if (!frozen.sent) {
    return { name: org.name, taxCode: org.tax_code, address: org.address, phone: letterhead?.phone ?? null, email: letterhead?.email ?? org.contact_email, bankNote: letterhead?.bank_note ?? null };
  }
  const issuer =
    frozen.issuerEntityId === null
      ? undefined
      : await ctx.trx.selectFrom('crove_kernel.legal_entity').select(['name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', frozen.issuerEntityId).executeTakeFirst();
  return { name: issuer?.name ?? org.name, taxCode: issuer?.tax_code ?? null, address: org.address, phone: letterhead?.phone ?? null, email: letterhead?.email ?? null, bankNote: letterhead?.bank_note ?? null };
}

// A draft is read live. A quote that has been sent is frozen at the moment of sending (Q2, #2694): the buyer is the snapshot taken then and the date is the
// day it was sent, so the file does not move when the customer's record changes; the seller is `sellerOf`.
export async function loadQuoteDocument(ctx: Reader, quoteId: string): Promise<QuoteDocumentData> {
  const quote = await loadQuote(ctx, quoteId);
  const row = await ctx.trx
    .selectFrom('crove_crm.quote')
    .select(['sent_at', 'issuer_entity_id', 'buyer_name', 'buyer_tax_code', 'buyer_address', 'buyer_email', 'seller_name', 'seller_tax_code', 'seller_address', 'seller_phone', 'seller_email', 'seller_bank_note'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', quoteId)
    .executeTakeFirstOrThrow();
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['name', 'tax_code', 'address', 'contact_email']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const sentAt = row.sent_at;
  const sent = sentAt !== null && row.buyer_name !== null;
  const snapshot =
    row.seller_name === null
      ? null
      : { name: row.seller_name, taxCode: row.seller_tax_code, address: row.seller_address, phone: row.seller_phone, email: row.seller_email, bankNote: row.seller_bank_note };
  const seller = await sellerOf(ctx, org, { sent, issuerEntityId: row.issuer_entity_id, snapshot });
  const logoFile = await logoFileOf(ctx);
  if (!sent) {
    const party = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['name', 'tax_code', 'address', 'phone', 'email'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', quote.partyId)
      .executeTakeFirstOrThrow();
    const buyer: QuoteParty = { name: party.name, taxCode: party.tax_code, address: party.address, phone: party.phone, email: party.email };
    return { quote, seller, buyer, issuedOn: vietnamToday(new Date(quote.createdAt)), logoFile };
  }
  // The snapshot holds what the customer's page shows (name, tax code, address) and the address the mail went to; it holds no phone.
  const buyer: QuoteParty = { name: row.buyer_name ?? quote.partyName, taxCode: row.buyer_tax_code, address: row.buyer_address, phone: null, email: row.buyer_email };
  return { quote, seller, buyer, issuedOn: vietnamToday(new Date(sentAt ?? quote.createdAt)), logoFile };
}

export const quoteDocument = defineQuery({
  name: 'crm.quote.document',
  input: zQuoteRef,
  access: ALL,
  handler: async (ctx, input): Promise<QuoteDocumentData> => loadQuoteDocument(ctx, input.quoteId),
});

export const quotePdfQueries = [quoteDocument];
