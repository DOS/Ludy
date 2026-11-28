// SPDX-License-Identifier: AGPL-3.0-only
// finance.party_ranking (#5338): the customers who bought the most, or the suppliers the business bought the most from, in a month, a quarter or a year, of ONE legal entity. Read only, for the "Hỏi đáp sổ sách" cards; no
// model, no write. It counts INVOICED DOCUMENTS, the table the customers list already counts sales from, not the ledger: the revenue and purchase lines (511, 156 and the like) carry no party, only the 131 and 331 lines
// do, and those are gross of VAT and carry the payments. A sale booked only by a journal voucher is therefore not ranked, and the card says it counts invoiced documents.
//
// The rule: a document of the side asked (sale or purchase) in the books (not voided: a replacement voids the original, an adjustment keeps it and carries the signed difference, so a decrease nets the party down), whose
// invoice date is in the period and whose entry was posted by the period's end, summed by its net of VAT (`subtotal`, book currency) for the kept party (a party and the parties marked as its duplicates are one). A party
// whose net is zero or less is not ranked. Largest first, ties by name then id.
//
// Cost: ONE grouped aggregate over purchase_document by (org_id, direction, invoice_date), the index purchase_document_direction_date_idx covers; the window functions give the total and the count of the same grouped
// set, and only the top rows are returned (ASK_RANKING_TOP). Nothing else is read.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { zId, zLedgerPeriod } from '@ludy/kernel-contract';
import { defineQuery } from '@ludy/kernel-runtime';
import { Decimal } from '@ludy/l10n-vn';
import { canonical } from './domain/money.ts';
import { ledgerPeriod } from './domain/ledger-reports.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The most parties the answer names.
const RANKING_TOP = 5;

const zFinancePartyRankingInput = z.strictObject({
  side: z.enum(['sales', 'purchases']),
  // YYYY-MM, YYYY-Qn or YYYY, as the ledger reports take it.
  period: zLedgerPeriod,
  legalEntityId: zId.optional(),
});

export interface FinancePartyRanking {
  side: 'sales' | 'purchases';
  period: string;
  from: string;
  to: string;
  // The net of every ranked party, and how many there are (the list holds the largest).
  total: string;
  partyCount: number;
  parties: Array<{ name: string; amount: string }>;
}

export const financePartyRankingQuery = defineQuery({
  name: 'finance.party_ranking',
  input: zFinancePartyRankingInput,
  access: ALL,
  handler: async (ctx, input): Promise<FinancePartyRanking> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const { from, to } = ledgerPeriod(input.period);
    const direction = input.side === 'sales' ? 'sale' : 'purchase';
    const { rows } = await sql<{ name: string; net: string; total: string; parties: string }>`
      WITH ranked AS (
        SELECT coalesce(x.duplicate_of, x.id) AS party_id, sum(d.subtotal) AS net
        FROM ludy_finance.purchase_document d
        JOIN ludy_kernel.party x ON x.org_id = d.org_id AND x.id = d.party_id
        LEFT JOIN ludy_finance.purchase_document_void v ON v.org_id = d.org_id AND v.document_id = d.id
        WHERE d.org_id = ${ctx.orgId}::uuid AND d.legal_entity_id = ${entity}::uuid AND d.direction = ${direction}
          AND v.document_id IS NULL
          AND d.invoice_date >= ${from}::date AND d.invoice_date <= ${to}::date
          AND EXISTS (SELECT 1 FROM ludy_finance.journal_entry e WHERE e.org_id = d.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = d.id AND e.entry_date <= ${to}::date)
        GROUP BY coalesce(x.duplicate_of, x.id)
        HAVING sum(d.subtotal) > 0)
      SELECT p.name, r.net, sum(r.net) OVER () AS total, count(*) OVER () AS parties
      FROM ranked r
      JOIN ludy_kernel.party p ON p.org_id = ${ctx.orgId}::uuid AND p.id = r.party_id
      ORDER BY r.net DESC, p.name, p.id
      LIMIT ${RANKING_TOP}`.execute(ctx.trx);
    return {
      side: input.side,
      period: input.period,
      from,
      to,
      total: canonical(new Decimal(rows[0]?.total ?? '0')),
      partyCount: Number(rows[0]?.parties ?? 0),
      parties: rows.map((r) => ({ name: r.name.slice(0, 300), amount: canonical(new Decimal(r.net)) })),
    };
  },
});
