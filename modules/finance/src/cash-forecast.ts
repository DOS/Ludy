// SPDX-License-Identifier: AGPL-3.0-only
// finance.cash_forecast (#4391): the 30/60/90-day cash-flow forecast of ONE legal entity, read only. The books as of day 0 are read here, in the caller's one transaction; every figure is decided by
// domain/cash-forecast.ts (pure, tested), and nothing is posted, paid or stored. Booked cash (111 + 112), the open sales invoices (the reminders' own loader, loadCustomers), the 331 balance laid over the
// open purchase invoices, the approved supplier payments and the tax due dates (markers, no amount) are what it reads; payroll, insurance, tax payments and recurring costs are not in it, and the answer says so.
//
// Cost (performance is on the review checklist): four aggregate reads on crove_finance.journal_line by (org_id, legal_entity_id, account_code prefix, entry_date <= day 0), the same predicates the overview and the
// customers list already run, then the invoices of the parties found. Every read is bounded: at most CASH_FORECAST_PARTIES_MAX customers and as many suppliers (the largest balances first), CASH_FORECAST_DOCUMENTS_MAX
// purchase invoices (newest first) and CASH_FORECAST_PAYMENTS_MAX approved payments. Beyond a bound the forecast is partial and says so (`truncated`); it never reads without a limit.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  CASH_FORECAST_DAYS,
  CASH_FORECAST_DOCUMENTS_MAX,
  CASH_FORECAST_PARTIES_MAX,
  CASH_FORECAST_PAYMENTS_MAX,
  VIETNAM_TIME_ZONE,
  zFinanceCashForecastInput,
  type CashForecast,
  type CashForecastTaxMarker,
  type FinanceCashForecastInput,
} from '@ludy/kernel-contract';
import type { VatFilingPeriod } from '@ludy/kernel-contract';
import { taxDuesOf } from '@ludy/kernel';
import { defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { Decimal, PAYABLE_ACCOUNT } from '@ludy/l10n-vn';
import { buildCashForecast, allocatePayable, type ApprovedPayment } from './domain/cash-forecast.ts';
import { addDays, type SaleInvoice } from './domain/payment-reminder.ts';
import { canonical } from './domain/money.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';
import { bookCurrency, loadCustomers } from './payment-reminders.ts';
import { balances } from './statements.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const CASH_PREFIXES = ['111', '112'];

// The booked 111 + 112 of the entity up to and including `today`: the same summed balances finance.overview reads, so it equals B01's cash line 110.
async function openingCash(ctx: QueryContext, entity: string, today: string): Promise<string> {
  const rows = await balances(ctx, entity, null, today, false)
    .where((eb) => eb.or(CASH_PREFIXES.map((prefix) => eb('l.account_code', 'like', `${prefix}%`))))
    .execute();
  return canonical(rows.reduce((total, r) => total.plus(r.debit ?? '0').minus(r.credit ?? '0'), new Decimal(0)));
}

interface PayableParty {
  // null: lines of 331 that name no party (a manual journal): nothing to lay them over, so all of it is "no invoice covers".
  partyId: string | null;
  balance: string;
}

// Who the entity owes on 331 as of `today`: the credit minus the debit per supplier (a party and the parties marked as its duplicates are one), positive balances only, the largest first, at most `limit`.
async function payableParties(ctx: QueryContext, entity: string, today: string, limit: number): Promise<PayableParty[]> {
  const kept = sql<string | null>`coalesce(x.duplicate_of, x.id)`;
  const rows = await ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .leftJoin('crove_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'l.org_id').onRef('x.id', '=', 'l.party_id'))
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

// The purchase invoices still in the books (not voided) of these suppliers, newest first, at most `limit`.
async function purchaseDocuments(ctx: QueryContext, entity: string, partyIds: readonly string[], limit: number): Promise<Array<SaleInvoice & { partyId: string }>> {
  if (partyIds.length === 0) return [];
  const kept = sql<string>`coalesce(x.duplicate_of, x.id)`;
  const rows = await ctx.trx
    .selectFrom('crove_finance.purchase_document as d')
    .innerJoin('crove_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'd.org_id').onRef('x.id', '=', 'd.party_id'))
    .leftJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
    .select(kept.as('party_id'))
    .select(['d.id', 'd.invoice_series', 'd.invoice_number', 'd.invoice_date', 'd.total', 'd.currency'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.legal_entity_id', '=', entity)
    .where('d.direction', '=', 'purchase')
    .where('v.document_id', 'is', null)
    .where(sql<boolean>`coalesce(x.duplicate_of, x.id) IN (${sql.join(partyIds)})`)
    .orderBy('d.invoice_date', 'desc')
    .orderBy('d.id')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ partyId: r.party_id, id: r.id, series: r.invoice_series, number: r.invoice_number, date: r.invoice_date, total: r.total, currency: r.currency }));
}

// The approved supplier payments of the entity (#3113), in the book currency (a payment in another currency cannot be added to the books' cash, and its invoice stays in the 331 pool), by the
// supplier they are made to, with the first day their bank file may go: the end of the 24-hour hold of a new account, else today.
async function approvedPayments(ctx: QueryContext, entity: string, today: string, currency: string, limit: number): Promise<Array<ApprovedPayment & { partyId: string }>> {
  const kept = sql<string>`coalesce(x.duplicate_of, x.id)`;
  const rows = await ctx.trx
    .selectFrom('crove_finance.supplier_payment as p')
    .innerJoin('crove_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'p.org_id').onRef('x.id', '=', 'p.party_id'))
    .select(kept.as('party_id'))
    .select(['p.purchase_document_id', 'p.amount'])
    .select(sql<string | null>`pg_catalog.to_char(p.payable_after AT TIME ZONE ${VIETNAM_TIME_ZONE}::text, 'YYYY-MM-DD')`.as('payable_on'))
    .where('p.org_id', '=', ctx.orgId)
    .where('p.legal_entity_id', '=', entity)
    .where('p.status', '=', 'approved')
    .where('p.currency', '=', currency)
    .orderBy('p.approved_at')
    .orderBy('p.id')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ partyId: r.party_id, documentId: r.purchase_document_id, amount: r.amount, payableOn: r.payable_on !== null && r.payable_on > today ? r.payable_on : today }));
}

// The tax due dates of the horizon as markers with no amount; none when the org has not set its VAT filing period (no calendar then).
async function taxMarkers(ctx: QueryContext, today: string): Promise<CashForecastTaxMarker[]> {
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('vat_filing_period').where('org_id', '=', ctx.orgId).executeTakeFirst();
  const kind = (org?.vat_filing_period as VatFilingPeriod | null | undefined) ?? null;
  if (kind === null) return [];
  const last = addDays(today, CASH_FORECAST_DAYS);
  return (await taxDuesOf(ctx, kind, today))
    .filter((d) => d.dueDate >= today && d.dueDate <= last)
    .map((d) => ({ obligation: d.obligation, period: String(d.period), dueDate: d.dueDate }));
}

export async function financeCashForecast(ctx: QueryContext, input: FinanceCashForecastInput): Promise<CashForecast> {
  const entity = await resolveLegalEntity(ctx, input.legalEntityId);
  const today = input.asOf ?? (await databaseToday(ctx.trx));
  const currency = await bookCurrency(ctx);
  let truncated = false;

  const opening = await openingCash(ctx, entity, today);
  const any = await ctx.trx.selectFrom('crove_finance.journal_entry').select('id').where('org_id', '=', ctx.orgId).where('legal_entity_id', '=', entity).limit(1).executeTakeFirst();

  // Receipts: the customers' open invoices, dated by their terms. One read more than the bound tells whether the bound was hit.
  const customers = await loadCustomers(ctx, entity, today, undefined, { customers: CASH_FORECAST_PARTIES_MAX + 1, entriesTo: today });
  if (customers.length > CASH_FORECAST_PARTIES_MAX) truncated = true;
  const owed = customers.slice(0, CASH_FORECAST_PARTIES_MAX);
  const receivables = owed.flatMap((c) => c.receivable.open.map((i) => ({ dueDate: i.dueDate, amountDue: i.amountDue })));
  const unlinkedReceivables = owed.reduce((total, c) => total.plus(c.receivable.other), new Decimal(0));

  // Payments: the 331 balance of each supplier laid over its purchase invoices, the approved payments taken out first.
  const found = await payableParties(ctx, entity, today, CASH_FORECAST_PARTIES_MAX + 1);
  if (found.length > CASH_FORECAST_PARTIES_MAX) truncated = true;
  const suppliers = found.slice(0, CASH_FORECAST_PARTIES_MAX);
  const supplierIds = suppliers.flatMap((s) => (s.partyId === null ? [] : [s.partyId]));
  const documents = await purchaseDocuments(ctx, entity, supplierIds, CASH_FORECAST_DOCUMENTS_MAX + 1);
  if (documents.length > CASH_FORECAST_DOCUMENTS_MAX) truncated = true;
  const approved = await approvedPayments(ctx, entity, today, currency, CASH_FORECAST_PAYMENTS_MAX + 1);
  if (approved.length > CASH_FORECAST_PAYMENTS_MAX) truncated = true;
  const payables: Array<{ dueDate: string; amountDue: string }> = [];
  const counted: ApprovedPayment[] = [];
  let unlinkedPayables = new Decimal(0);
  for (const supplier of suppliers) {
    if (supplier.partyId === null) {
      unlinkedPayables = unlinkedPayables.plus(supplier.balance);
      continue;
    }
    const mine = documents.filter((d) => d.partyId === supplier.partyId);
    const pool = allocatePayable(mine, supplier.balance, approved.slice(0, CASH_FORECAST_PAYMENTS_MAX).filter((a) => a.partyId === supplier.partyId), today);
    payables.push(...pool.open.map((i) => ({ dueDate: i.dueDate, amountDue: i.amountDue })));
    unlinkedPayables = unlinkedPayables.plus(pool.unlinked);
    counted.push(...pool.approved);
  }

  return buildCashForecast({
    legalEntityId: entity,
    today,
    openingCash: opening,
    empty: any === undefined,
    receivables,
    unlinkedReceivables: unlinkedReceivables.toFixed(),
    payables,
    unlinkedPayables: unlinkedPayables.toFixed(),
    approvedPayments: counted,
    taxMarkers: await taxMarkers(ctx, today),
    truncated,
  });
}

export const financeCashForecastQuery = defineQuery({
  name: 'finance.cash_forecast',
  input: zFinanceCashForecastInput,
  access: ALL,
  handler: (ctx, input): Promise<CashForecast> => financeCashForecast(ctx, input),
});
