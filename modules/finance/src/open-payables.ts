// SPDX-License-Identifier: AGPL-3.0-only
// What the books hold on 331 for the cash forecast (#4391) and for the aging of payables (#5338): who the entity owes as of a day, the 331 lines that name no party, and the purchase invoices still in the books of those
// suppliers. Read only, in the caller's one transaction; moved out of cash-forecast.ts unchanged so both reads lay the same balances over the same invoices.
import { sql } from 'kysely';
import type { QueryContext } from '@ludy/kernel-runtime';
import { Decimal, PAYABLE_ACCOUNT } from '@ludy/l10n-vn';
import { canonical } from './domain/money.ts';
import type { PayableDocument } from './domain/cash-forecast.ts';

// Who the entity owes on 331 as of `today`: the credit minus the debit per supplier (a party and the parties marked as its duplicates are one), positive balances only, the largest first, at most `limit`.
// Lines that name no party are not here: see partylessPayables.
export async function payableParties(ctx: QueryContext, entity: string, today: string, limit: number): Promise<Array<{ partyId: string; balance: string }>> {
  const kept = sql<string>`coalesce(x.duplicate_of, x.id)`;
  const rows = await ctx.trx
    .selectFrom('ludy_finance.journal_line as l')
    .innerJoin('ludy_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .innerJoin('ludy_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'l.org_id').onRef('x.id', '=', 'l.party_id'))
    .select(kept.as('party_id'))
    .select(sql<string>`sum(l.credit - l.debit)`.as('balance'))
    .where('l.org_id', '=', ctx.orgId)
    .where('l.legal_entity_id', '=', entity)
    .where('l.account_code', 'like', `${PAYABLE_ACCOUNT}%`)
    .where('j.entry_date', '<=', today)
    .groupBy(kept)
    .having(sql<boolean>`sum(l.credit - l.debit) > 0`)
    .orderBy(sql`sum(l.credit - l.debit)`, 'desc')
    .orderBy(kept)
    .limit(limit)
    .execute();
  return rows.map((r) => ({ partyId: r.party_id, balance: r.balance }));
}

// The 331 lines that name no party (a manual journal), netted: credit minus debit, a decimal string that may be negative. A credit is a debt no invoice can cover (counted on day 0); a debit is a payment
// already made (the cash has left), so it lowers what is owed to the suppliers, the largest first (the books do not say which one it paid).
export async function partylessPayables(ctx: QueryContext, entity: string, today: string): Promise<string> {
  const row = await ctx.trx
    .selectFrom('ludy_finance.journal_line as l')
    .innerJoin('ludy_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .select(sql<string | null>`sum(l.credit - l.debit)`.as('balance'))
    .where('l.org_id', '=', ctx.orgId)
    .where('l.legal_entity_id', '=', entity)
    .where('l.account_code', 'like', `${PAYABLE_ACCOUNT}%`)
    .where('l.party_id', 'is', null)
    .where('j.entry_date', '<=', today)
    .executeTakeFirst();
  return canonical(new Decimal(row?.balance ?? '0'));
}

// The purchase invoices still in the books (not voided) of these suppliers, newest first, at most `limit`.
export async function purchaseDocuments(ctx: QueryContext, entity: string, asOf: string, partyIds: readonly string[], limit: number): Promise<Array<PayableDocument & { partyId: string }>> {
  if (partyIds.length === 0) return [];
  const kept = sql<string>`coalesce(x.duplicate_of, x.id)`;
  const rows = await ctx.trx
    .selectFrom('ludy_finance.purchase_document as d')
    .innerJoin('ludy_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'd.org_id').onRef('x.id', '=', 'd.party_id'))
    .leftJoin('ludy_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
    .select(kept.as('party_id'))
    .select(['d.id', 'd.invoice_series', 'd.invoice_number', 'd.invoice_date', 'd.due_date', 'd.total', 'd.currency'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.legal_entity_id', '=', entity)
    .where('d.direction', '=', 'purchase')
    .where('d.invoice_date', '<=', asOf)
    // Posted by the as-of day too, the boundary the 331 balance is read at.
    .where(sql<boolean>`exists (select 1 from ludy_finance.journal_entry e where e.org_id = d.org_id and e.source_type = 'finance.purchase_document' and e.source_id = d.id and e.entry_date <= ${asOf})`)
    .where('v.document_id', 'is', null)
    .where(sql<boolean>`coalesce(x.duplicate_of, x.id) IN (${sql.join(partyIds)})`)
    .orderBy('d.invoice_date', 'desc')
    .orderBy('d.id')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ partyId: r.party_id, id: r.id, series: r.invoice_series, number: r.invoice_number, date: r.invoice_date, dueDate: r.due_date, total: r.total, currency: r.currency }));
}

