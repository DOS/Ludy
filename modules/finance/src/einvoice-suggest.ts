// SPDX-License-Identifier: AGPL-3.0-only
// What the finance coworker may see when it proposes the lines of a sales e-invoice draft (#2505, plan einvoice-issue.md section 9):
// - finance.einvoice_draft.suggest_source (owners, admins, members; read only): the customers of the org whose names share a word with the text a person typed (the most such matches
//   first, at most SUGGEST_PARTIES_MAX; the names only go to the model, the rest of the record is for the code that fills the form), with the VAT rates of the earlier drafts to each of them,
//   and the org's own earlier rates. No credential, no bank account, no provider data, no amount: the model is shown the text and the names. The model is asked outside any transaction, by the API.
// Nothing is written here and nothing is issued.
import { sql } from 'kysely';
import { zEInvoiceSuggestInput } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';

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
    const orgRatesRows = await sql<{ vat_rate: string; n: number }>`
      SELECT l.vat_rate, count(*)::int AS n
      FROM crove_finance.einvoice_draft_line l
      WHERE l.org_id = ${ctx.orgId}
      GROUP BY l.vat_rate`.execute(ctx.trx);
    const orgRates = orgRatesRows.rows.map((r) => ({ vatRate: r.vat_rate, n: r.n }));
    if (words.length === 0) return { parties: [], orgRates };
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
    return { parties, orgRates };
  },
});
