// SPDX-License-Identifier: AGPL-3.0-only
// finance.aging (#5338): the aging of the receivables (131) or the payables (331) of ONE legal entity as of a day, read only, for the "Hỏi đáp sổ sách" cards. Nothing is posted, paid or stored, and no model is called. Every
// figure is decided by domain/aging.ts (pure, tested) from the open invoices the party balances are laid over, with the due dates the reminders and the cash forecast already use:
// - Receivables: the reminders' own loader (loadCustomers): the 131 balance of each customer laid over its sales invoices newest first (the oldest are taken as paid first), each due at the invoice date plus the
//   customer's own terms, else the org's. A balance no invoice covers has no date and is the `undated` figure; so is nothing else.
// - Payables: the forecast's loaders (open-payables.ts): the 331 balance of each supplier laid over its purchase invoices, each due on its due date when it has one, else the invoice date plus PAYABLE_TERMS_DAYS (said as an
//   estimate, `estimatedDueDates`). The 331 lines that name no party are netted as the forecast nets them: a credit no invoice covers is `undated`, a debit lowers the largest suppliers first. An approved supplier payment
//   is NOT taken out: aging is what the books hold, not a plan.
// - A balance on the other side (a customer paid ahead, an advance to a supplier) is the `advances` figure, never netted into a bucket.
//
// Cost (performance is on the review checklist): the forecast's aggregates on ludy_finance.journal_line by (org_id, legal_entity_id, account_code prefix, entry_date <= asOf), the same predicates, one more for the
// advances, then the invoices of the parties found. Bounded as the forecast is: at most CASH_FORECAST_PARTIES_MAX parties (the largest balances first) and CASH_FORECAST_DOCUMENTS_MAX invoices (newest first); one row more
// than a bound tells it was hit, and the answer is then `truncated`.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { CASH_FORECAST_DOCUMENTS_MAX, CASH_FORECAST_PARTIES_MAX, zId, zLocalDate } from '@ludy/kernel-contract';
import { defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { Decimal, PAYABLE_ACCOUNT, RECEIVABLE_ACCOUNT } from '@ludy/l10n-vn';
import { allocatePayable } from './domain/cash-forecast.ts';
import { buildAging, type AgingBucket, type AgingInvoice } from './domain/aging.ts';
import { canonical } from './domain/money.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { partylessPayables, payableParties, purchaseDocuments } from './open-payables.ts';
import { databaseToday } from './period-lock.ts';
import { loadCustomers } from './payment-reminders.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const zFinanceAgingInput = z.strictObject({
  side: z.enum(['receivable', 'payable']),
  // The day the aging is read at; never after today (a later day is today). Left out: today.
  asOf: zLocalDate.optional(),
  legalEntityId: zId.optional(),
});
type FinanceAgingInput = z.infer<typeof zFinanceAgingInput>;

export interface FinanceAging {
  side: 'receivable' | 'payable';
  asOf: string;
  legalEntityId: string;
  // Decimal strings, in the book currency.
  buckets: Record<AgingBucket, string>;
  // What no invoice dates: the balance no invoice covers (and, for payables, the 331 credit that names no party).
  undated: string;
  // What parties paid ahead (131) or were advanced (331), as its own figure, never netted into a bucket.
  advances: string;
  // The invoices past due: their total, the parties holding them, and the largest of those.
  overdue: { total: string; partyCount: number; parties: Array<{ name: string | null; amount: string }> };
  // Some due date is invoice date + the payables' standard terms, not the invoice's own.
  estimatedDueDates: boolean;
  // A bound of the read was hit: the figures are of the largest balances and the newest invoices.
  truncated: boolean;
}

// What parties hold on the other side of the account (the debit side of 331, the credit side of 131), as of a day: the sum of their balances in that direction. A party and the parties marked as its duplicates are one;
// lines that name no party are not here.
async function advanceTotal(ctx: QueryContext, entity: string, side: 'receivable' | 'payable', asOf: string): Promise<string> {
  const balance = side === 'receivable' ? sql`l.debit - l.credit` : sql`l.credit - l.debit`;
  const prefix = `${side === 'receivable' ? RECEIVABLE_ACCOUNT : PAYABLE_ACCOUNT}%`;
  const { rows } = await sql<{ total: string | null }>`
    SELECT sum(-t.balance) AS total FROM (
      SELECT sum(${balance}) AS balance
      FROM ludy_finance.journal_line l
      JOIN ludy_finance.journal_entry j ON j.org_id = l.org_id AND j.id = l.entry_id
      JOIN ludy_kernel.party x ON x.org_id = l.org_id AND x.id = l.party_id
      WHERE l.org_id = ${ctx.orgId}::uuid AND l.legal_entity_id = ${entity}::uuid AND l.account_code LIKE ${prefix} AND j.entry_date <= ${asOf}::date
      GROUP BY coalesce(x.duplicate_of, x.id)
      HAVING sum(${balance}) < 0) t`.execute(ctx.trx);
  return canonical(new Decimal(rows[0]?.total ?? '0'));
}

async function partyNames(ctx: QueryContext, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.trx.selectFrom('ludy_kernel.party').select(['id', 'name']).where('org_id', '=', ctx.orgId).where(sql<boolean>`id = ANY(${sql.val([...ids])}::uuid[])`).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function financeAging(ctx: QueryContext, input: FinanceAgingInput): Promise<FinanceAging> {
  const entity = await resolveLegalEntity(ctx, input.legalEntityId);
  const today = await databaseToday(ctx.trx);
  const asOf = input.asOf !== undefined && input.asOf < today ? input.asOf : today;
  let truncated = false;
  let estimated = false;
  let undated = new Decimal(0);
  const invoices: AgingInvoice[] = [];

  if (input.side === 'receivable') {
    // One row more than a bound tells whether the bound was hit.
    const seen = { documents: 0 };
    const customers = await loadCustomers(ctx, entity, asOf, undefined, { customers: CASH_FORECAST_PARTIES_MAX + 1, documents: CASH_FORECAST_DOCUMENTS_MAX, entriesTo: asOf, seen });
    if (customers.length > CASH_FORECAST_PARTIES_MAX || seen.documents > CASH_FORECAST_DOCUMENTS_MAX) truncated = true;
    for (const customer of customers.slice(0, CASH_FORECAST_PARTIES_MAX)) {
      invoices.push(...customer.receivable.open.map((i) => ({ partyId: customer.partyId, partyName: customer.name, amountDue: i.amountDue, daysOverdue: i.daysOverdue })));
      undated = undated.plus(customer.receivable.other);
    }
  } else {
    const found = await payableParties(ctx, entity, asOf, CASH_FORECAST_PARTIES_MAX + 1);
    if (found.length > CASH_FORECAST_PARTIES_MAX) truncated = true;
    // A payment that names no supplier lowers what is owed, the largest supplier first; a debt that names none is undated with the rest no invoice covers (the forecast's own rule).
    const partyless = new Decimal(await partylessPayables(ctx, entity, asOf));
    let unnamedPaid = partyless.isNegative() ? partyless.negated() : new Decimal(0);
    if (partyless.greaterThan(0)) undated = undated.plus(partyless);
    const suppliers = found.slice(0, CASH_FORECAST_PARTIES_MAX).map((supplier) => {
      const take = Decimal.min(unnamedPaid, supplier.balance);
      unnamedPaid = unnamedPaid.minus(take);
      return { partyId: supplier.partyId, balance: new Decimal(supplier.balance).minus(take).toFixed() };
    });
    const probed = await purchaseDocuments(ctx, entity, asOf, suppliers.map((s) => s.partyId), CASH_FORECAST_DOCUMENTS_MAX + 1);
    if (probed.length > CASH_FORECAST_DOCUMENTS_MAX) truncated = true;
    const documents = probed.slice(0, CASH_FORECAST_DOCUMENTS_MAX);
    const names = await partyNames(ctx, suppliers.map((s) => s.partyId));
    for (const supplier of suppliers) {
      const pool = allocatePayable(documents.filter((d) => d.partyId === supplier.partyId), supplier.balance, [], asOf);
      for (const open of pool.open) {
        invoices.push({ partyId: supplier.partyId, partyName: names.get(supplier.partyId) ?? null, amountDue: open.amountDue, daysOverdue: open.daysOverdue });
        if (open.dueDateEstimated) estimated = true;
      }
      undated = undated.plus(pool.unlinked);
    }
  }

  const aging = buildAging(invoices);
  return {
    side: input.side,
    asOf,
    legalEntityId: entity,
    buckets: aging.buckets,
    undated: canonical(undated),
    advances: await advanceTotal(ctx, entity, input.side, asOf),
    overdue: aging.overdue,
    estimatedDueDates: estimated,
    truncated,
  };
}

export const financeAgingQuery = defineQuery({
  name: 'finance.aging',
  input: zFinanceAgingInput,
  access: ALL,
  handler: (ctx, input) => financeAging(ctx, input),
});
