// SPDX-License-Identifier: AGPL-3.0-only
// finance.cash_forecast (#4391): the 30/60/90-day cash-flow forecast of ONE legal entity, read only. The books as of day 0 are read here, in the caller's one transaction; every figure is decided by
// domain/cash-forecast.ts (pure, tested), and nothing is posted, paid or stored. Booked cash (111 + 112), the open sales invoices (the reminders' own loader, loadCustomers), the 331 balance laid over the
// open purchase invoices, the approved supplier payments and the tax due dates (markers, no amount) are what it reads; payroll, insurance, tax payments and recurring costs are not in it, and the answer says so.
//
// Cost (performance is on the review checklist): four aggregate reads on crove_finance.journal_line by (org_id, legal_entity_id, account_code prefix, entry_date <= day 0), the same predicates the overview and the
// customers list already run, then the invoices of the parties found. The reads are bounded: at most CASH_FORECAST_PARTIES_MAX customers and as many suppliers (the largest balances first), CASH_FORECAST_DOCUMENTS_MAX
// purchase invoices (newest first) and CASH_FORECAST_PAYMENTS_MAX approved payments; the sales invoices are all those of the customers read (loadCustomers has no row limit on them, so they are bounded by the customer bound).
// Beyond a bound the forecast is partial and says so (`truncated`). An invoice dated after day 0 is not laid under the balance of day 0.
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
import { Decimal, PAYABLE_ACCOUNT, type DecimalValue } from '@ludy/l10n-vn';
import { buildCashForecast, allocatePayable, type ApprovedPayment } from './domain/cash-forecast.ts';
import { addDays, type SaleInvoice } from './domain/payment-reminder.ts';
import { canonical } from './domain/money.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';
import { bookCurrency, loadCustomers } from './payment-reminders.ts';
import { balances } from './statements.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const CASH_PREFIXES = ['111', '112'];

// The booked cash of the entity up to and including `today`, by the rule of B01 line 110 (the overview's cash card): the summed balance of EACH account of 111 and 112 (an account is read as a whole,
// whatever the party or the reversal), counted only when it is a debit balance. So an account overdrawn on its own (a credit balance of 112) adds nothing here, as it adds nothing to the card, and
// the opening cash equals `finance.overview`'s cash figure for the same day (a DB test pins that).
async function openingCash(ctx: QueryContext, entity: string, today: string): Promise<string> {
  const rows = await balances(ctx, entity, null, today, false)
    .where((eb) => eb.or(CASH_PREFIXES.map((prefix) => eb('l.account_code', 'like', `${prefix}%`))))
    .execute();
  const net = new Map<string, DecimalValue>();
  for (const r of rows) net.set(r.account_code, (net.get(r.account_code) ?? new Decimal(0)).plus(r.debit ?? '0').minus(r.credit ?? '0'));
  return canonical([...net.values()].reduce((total, v) => (v.greaterThan(0) ? total.plus(v) : total), new Decimal(0)));
}

interface PayableParty {
  partyId: string;
  balance: string;
}

// Who the entity owes on 331 as of `today`: the credit minus the debit per supplier (a party and the parties marked as its duplicates are one), positive balances only, the largest first, at most `limit`.
// Lines that name no party are not here: see partylessPayables.
async function payableParties(ctx: QueryContext, entity: string, today: string, limit: number): Promise<PayableParty[]> {
  const kept = sql<string>`coalesce(x.duplicate_of, x.id)`;
  const rows = await ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .innerJoin('crove_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'l.org_id').onRef('x.id', '=', 'l.party_id'))
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
async function partylessPayables(ctx: QueryContext, entity: string, today: string): Promise<string> {
  const row = await ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
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
async function purchaseDocuments(ctx: QueryContext, entity: string, asOf: string, partyIds: readonly string[], limit: number): Promise<Array<SaleInvoice & { partyId: string }>> {
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
    .where('d.invoice_date', '<=', asOf)
    // Posted by the as-of day too, the boundary the 331 balance is read at.
    .where(sql<boolean>`exists (select 1 from crove_finance.journal_entry e where e.org_id = d.org_id and e.source_type = 'finance.purchase_document' and e.source_id = d.id and e.entry_date <= ${asOf})`)
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

// The tax due dates of the horizon as markers with no amount: the tax calendar's own window (the next 30 days, so fewer than the 90 days), of this entity; none when the org has not set its VAT filing period.
async function taxMarkers(ctx: QueryContext, entity: string, today: string): Promise<CashForecastTaxMarker[]> {
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('vat_filing_period').where('org_id', '=', ctx.orgId).executeTakeFirst();
  const kind = (org?.vat_filing_period as VatFilingPeriod | null | undefined) ?? null;
  if (kind === null) return [];
  const last = addDays(today, CASH_FORECAST_DAYS);
  return (await taxDuesOf(ctx, kind, today))
    // Of this entity (an obligation every other entity has marked done is not its marker), within the horizon.
    .filter((d) => d.dueDate >= today && d.dueDate <= last && d.openEntities.some((e) => e.id === entity))
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
  const seen = { documents: 0 };
  const customers = await loadCustomers(ctx, entity, today, undefined, { customers: CASH_FORECAST_PARTIES_MAX + 1, documents: CASH_FORECAST_DOCUMENTS_MAX, entriesTo: today, seen });
  if (customers.length > CASH_FORECAST_PARTIES_MAX || seen.documents > CASH_FORECAST_DOCUMENTS_MAX) truncated = true;
  const owed = customers.slice(0, CASH_FORECAST_PARTIES_MAX);
  const receivables = owed.flatMap((c) => c.receivable.open.map((i) => ({ dueDate: i.dueDate, amountDue: i.amountDue })));
  const unlinkedReceivables = owed.reduce((total, c) => total.plus(c.receivable.other), new Decimal(0));

  // Payments: the 331 balance of each supplier laid over its purchase invoices, the approved payments taken out first.
  const found = await payableParties(ctx, entity, today, CASH_FORECAST_PARTIES_MAX + 1);
  if (found.length > CASH_FORECAST_PARTIES_MAX) truncated = true;
  // A payment that names no supplier lowers what is owed, the largest supplier first; a debt that names none is counted on day 0 with the rest no invoice covers.
  const partyless = new Decimal(await partylessPayables(ctx, entity, today));
  let unnamedPaid = partyless.isNegative() ? partyless.negated() : new Decimal(0);
  const suppliers = found.slice(0, CASH_FORECAST_PARTIES_MAX).map((supplier) => {
    const take = Decimal.min(unnamedPaid, supplier.balance);
    unnamedPaid = unnamedPaid.minus(take);
    return { partyId: supplier.partyId, balance: new Decimal(supplier.balance).minus(take).toFixed() };
  });
  const supplierIds = suppliers.map((s) => s.partyId);
  const probed = await purchaseDocuments(ctx, entity, today, supplierIds, CASH_FORECAST_DOCUMENTS_MAX + 1);
  if (probed.length > CASH_FORECAST_DOCUMENTS_MAX) truncated = true;
  const documents = probed.slice(0, CASH_FORECAST_DOCUMENTS_MAX);
  const approved = await approvedPayments(ctx, entity, today, currency, CASH_FORECAST_PAYMENTS_MAX + 1);
  if (approved.length > CASH_FORECAST_PAYMENTS_MAX) truncated = true;
  const payables: Array<{ dueDate: string; amountDue: string }> = [];
  const counted: ApprovedPayment[] = [];
  let unlinkedPayables = partyless.greaterThan(0) ? partyless : new Decimal(0);
  for (const supplier of suppliers) {
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
    taxMarkers: await taxMarkers(ctx, entity, today),
    truncated,
  });
}

export const financeCashForecastQuery = defineQuery({
  name: 'finance.cash_forecast',
  input: zFinanceCashForecastInput,
  access: ALL,
  handler: (ctx, input): Promise<CashForecast> => financeCashForecast(ctx, input),
});
