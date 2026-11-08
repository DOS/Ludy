// SPDX-License-Identifier: AGPL-3.0-only
// What the finance coworker may see when it proposes the lines of a sales e-invoice draft (#2505, plan einvoice-issue.md section 9):
// - finance.einvoice_draft.suggest_source (owners, admins, members; read only): the customers of the org whose names share a word with the text a person typed (the most such matches
//   first, at most SUGGEST_PARTIES_MAX; the names only go to the model, the rest of the record is for the code that fills the form), with the VAT rates of the earlier drafts to each of them,
//   and the org's own earlier rates. No credential, no bank account, no provider data, no amount: the model is shown the text and the names. The model is asked outside any transaction, by the API.
// Nothing is written here and nothing is issued.
import { sql } from 'kysely';
import { zEInvoicePreviousInput, zEInvoiceSuggestInput, type EInvoicePrevious } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money, salesVatRatesOn } from '@crove/l10n-vn';
import { invoiceSourceText, type SourceLine } from './domain/einvoice-source.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The most customers the model is offered (packages/agent EINVOICE_DRAFT_PARTIES_MAX) and the most words of the text that look names up.
export const SUGGEST_PARTIES_MAX = 30;
const WORDS_MAX = 12;

export interface RateCount {
  vatRate: string;
  n: number;
}

export interface EInvoiceSuggestParty {
  id: string;
  kind: 'organization' | 'person';
  name: string;
  taxCode: string | null;
  address: string | null;
  email: string | null;
  // The VAT rates of the lines of the earlier drafts to this customer, with how many lines each.
  rates: RateCount[];
}

export interface EInvoiceSuggestSource {
  parties: EInvoiceSuggestParty[];
  // The same over every draft of the org.
  orgRates: RateCount[];
  // The lines of the issued invoice the person picked as part of the source (#2721), written as text for the model; null when none was picked.
  invoice: { text: string } | null;
}

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;
// A decimal read from the database (numeric keeps its scale: '200000.0000') as the API writes it ('200000').
const plain = (value: string): string => money(value).toFixed();

// The lines of an invoice to `buyerPartyId` that was issued, in the books of `entity` (the row policies of the draft tables also decide what the caller sees), or null. Another org's invoice, a draft
// that was not issued, another buyer's and another entity's are all the same answer: none.
async function issuedLines(ctx: Ctx, draftId: string, buyerPartyId: string, entity: string): Promise<SourceLine[] | null> {
  const draft = await ctx.trx
    .selectFrom('crove_finance.einvoice_draft')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', draftId)
    .where('state', '=', 'issued')
    .where('buyer_party_id', '=', buyerPartyId)
    .where('legal_entity_id', '=', entity)
    .executeTakeFirst();
  if (!draft) return null;
  const rows = await ctx.trx
    .selectFrom('crove_finance.einvoice_draft_line')
    .select(['description', 'unit', 'quantity', 'unit_price', 'vat_rate'])
    .where('org_id', '=', ctx.orgId)
    .where('draft_id', '=', draftId)
    .orderBy('line_no')
    .execute();
  return rows.map((r) => ({ description: r.description, unit: r.unit, quantity: plain(r.quantity), unitPrice: plain(r.unit_price), vatRate: r.vat_rate }));
}

/** The words of a text that may be part of a name: three letters or more, lower case, each once, at most WORDS_MAX. */
export function nameWords(text: string): string[] {
  const words = text.normalize('NFC').toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  return [...new Set(words)].slice(0, WORDS_MAX);
}

export const einvoiceDraftSuggestSource = defineQuery({
  name: 'finance.einvoice_draft.suggest_source',
  input: zEInvoiceSuggestInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<EInvoiceSuggestSource> => {
    const words = nameWords(input.text);
    let invoice: EInvoiceSuggestSource['invoice'] = null;
    if (input.invoiceDraftId !== undefined && input.buyerPartyId !== undefined) {
      const entity = await resolveLegalEntity(ctx, input.legalEntityId);
      const lines = await issuedLines(ctx, input.invoiceDraftId, input.buyerPartyId, entity);
      if (lines === null) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy hóa đơn này');
      invoice = { text: invoiceSourceText(lines, salesVatRatesOn(input.date)) };
    }
    const orgRatesRows = await sql<{ vat_rate: string; n: number }>`
      SELECT l.vat_rate, count(*)::int AS n
      FROM crove_finance.einvoice_draft_line l
      WHERE l.org_id = ${ctx.orgId}
      GROUP BY l.vat_rate`.execute(ctx.trx);
    const orgRates = orgRatesRows.rows.map((r) => ({ vatRate: r.vat_rate, n: r.n }));
    if (words.length === 0) return { parties: [], orgRates, invoice };
    // The score of a customer is the number of the text's words its name holds; the best come first, and a customer none of them fits is not offered.
    const score = sql.join(words.map((word) => sql`(pg_catalog.strpos(pg_catalog.lower(normalize(p.name, NFC)), ${word}) > 0)::int`), sql` + `);
    const partyRows = await sql<{ id: string; kind: 'organization' | 'person'; name: string; tax_code: string | null; address: string | null; email: string | null }>`
      SELECT p.id, p.kind, p.name, p.tax_code, p.address, p.email
      FROM crove_kernel.party p
      WHERE p.org_id = ${ctx.orgId} AND p.duplicate_of IS NULL AND (${score}) > 0
      ORDER BY (${score}) DESC, p.name, p.id
      LIMIT ${SUGGEST_PARTIES_MAX}`.execute(ctx.trx);
    const ids = partyRows.rows.map((p) => p.id);
    const rateRows =
      ids.length === 0
        ? []
        : (
            await sql<{ party_id: string; vat_rate: string; n: number }>`
              SELECT d.buyer_party_id AS party_id, l.vat_rate, count(*)::int AS n
              FROM crove_finance.einvoice_draft d
              JOIN crove_finance.einvoice_draft_line l ON l.org_id = d.org_id AND l.draft_id = d.id
              WHERE d.org_id = ${ctx.orgId} AND d.buyer_party_id IN (${sql.join(ids)})
              GROUP BY d.buyer_party_id, l.vat_rate`.execute(ctx.trx)
          ).rows;
    const parties = partyRows.rows.map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      taxCode: p.tax_code,
      address: p.address,
      email: p.email,
      rates: rateRows.filter((r) => r.party_id === p.id).map((r) => ({ vatRate: r.vat_rate, n: r.n })),
    }));
    return { parties, orgRates, invoice };
  },
});

// The previous issued invoice to a customer, to copy with no model (#2721). The newest by the day it was issued; the buyer and the lines as that invoice held them, each line marked with whether its VAT
// rate is still allowed on the date of the new invoice. Read only; the caller's own row policies decide which entities' invoices it sees.
export const einvoicePreviousInvoice = defineQuery({
  name: 'finance.einvoice_draft.previous_invoice',
  input: zEInvoicePreviousInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<EInvoicePrevious> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const draft = await ctx.trx
      .selectFrom('crove_finance.einvoice_draft')
      .select(['id', 'invoice_date', 'issued_number', 'buyer_kind', 'buyer_party_id', 'buyer_tax_code', 'buyer_name', 'buyer_address', 'buyer_email'])
      .where('org_id', '=', ctx.orgId)
      .where('buyer_party_id', '=', input.buyerPartyId)
      .where('legal_entity_id', '=', entity)
      .where('state', '=', 'issued')
      .orderBy('issued_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!draft) return { invoice: null };
    const rows = await ctx.trx
      .selectFrom('crove_finance.einvoice_draft_line')
      .select(['description', 'unit', 'quantity', 'unit_price', 'vat_rate'])
      .where('org_id', '=', ctx.orgId)
      .where('draft_id', '=', draft.id)
      .orderBy('line_no')
      .execute();
    // The buyer's details are the party record's as they are now (a tax code or an address added since is not lost); the invoice's own where the record has none.
    const party = (
      await sql<{ name: string | null; tax_code: string | null; address: string | null; email: string | null }>`
        SELECT p.name, p.tax_code, p.address, p.email FROM crove_kernel.party p WHERE p.org_id = ${ctx.orgId} AND p.id = ${input.buyerPartyId}`.execute(ctx.trx)
    ).rows[0];
    const pick = (fresh: string | null | undefined, held: string | null): string | null => (fresh && fresh.trim() !== '' ? fresh : held);
    const allowed = salesVatRatesOn(input.date);
    const date = typeof draft.invoice_date === 'string' ? draft.invoice_date : new Date(draft.invoice_date).toISOString().slice(0, 10);
    return {
      invoice: {
        draftId: draft.id,
        date,
        number: draft.issued_number,
        buyer: {
          kind: draft.buyer_kind,
          partyId: draft.buyer_party_id,
          taxCode: pick(party?.tax_code, draft.buyer_tax_code),
          name: pick(party?.name, draft.buyer_name),
          address: pick(party?.address, draft.buyer_address),
          email: pick(party?.email, draft.buyer_email),
        },
        lines: rows.map((r) => ({ description: r.description, unit: r.unit, quantity: plain(r.quantity), unitPrice: plain(r.unit_price), vatRate: r.vat_rate, vatAllowed: allowed.includes(r.vat_rate) })),
      },
    };
  },
});
