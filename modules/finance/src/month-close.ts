// SPDX-License-Identifier: AGPL-3.0-only
// finance.month_close: the month-close checklist of the Kế toán screen, read only. For one legal entity and one calendar month it counts, by a read of the books each, what a
// person still has to do before the month can be locked: pending proposals dated in the month, tax-portal invoices that match no voucher, bank statement lines not booked, marketplace
// settlements and payouts not recorded, the stock close not run, the VAT return not marked as filed, the period lock not covering the month. Every read is scoped by org_id and by the
// entity (and the restrictive le_scope policy of each table applies on top), is a count and never a list, and reads no amount. The coworker's note over the open items is asked of the
// model elsewhere (apps/kernel finance-month-close-ai.ts); nothing here writes or posts.
import { sql } from 'kysely';
import { zFinanceMonthCloseInput, type FinanceMonthCloseInput, type MonthClose, type VatFilingPeriod } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { MARKETPLACE_PAYOUT_COMMAND, PAYROLL_PAYMENT_COMMAND, SUPPLIER_PAYMENT_SETTLE_COMMAND, VOUCHER_COMMAND } from '@ludy/kernel-contract';
import { VOUCHER_SOURCE } from './domain/cash-voucher.ts';
import { declaringPeriods, vatPeriod } from './domain/vat-return.ts';
import { buildMonthClose, lockCovers, monthBounds, monthOver, portalPeriods, vatMarkPeriod, type MonthBounds } from './domain/month-close.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { marketplaceWorklist } from './marketplace-worklist.ts';
import { databaseToday, periodLockedThrough } from './period-lock.ts';
import { reconcilePeriod } from './portal-list.ts';
import { latestRevision } from './source-entry.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const DATE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

// The org's filing period (an org that never set one files monthly, so null reads as month).
async function filingPeriod(ctx: QueryContext): Promise<VatFilingPeriod | null> {
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('vat_filing_period').where('org_id', '=', ctx.orgId).executeTakeFirst();
  return (org?.vat_filing_period as VatFilingPeriod | null | undefined) ?? null;
}

// Finance proposals still pending whose own date is in the month: the voucher's date (a cash or journal voucher), the invoice's issue date (a purchase or sale), else the day the
// proposal was made (Vietnam time). A proposal that needs no voucher date, such as a marketplace settlement, is dated by the day it was made.
async function pendingProposals(ctx: QueryContext, entity: string, b: MonthBounds): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT pg_catalog.count(*)::text AS n
    FROM crove_kernel.proposal p
    WHERE p.org_id = ${ctx.orgId}::uuid AND p.legal_entity_id = ${entity}::uuid AND p.status = 'pending' AND p.command LIKE 'finance.%'
      AND COALESCE(
        CASE WHEN p.payload->>'date' ~ ${DATE} THEN (p.payload->>'date')::date END,
        CASE WHEN p.payload #>> '{invoice,issueDate}' ~ ${DATE} THEN (p.payload #>> '{invoice,issueDate}')::date END,
        (p.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      ) >= ${b.from}::date
      AND COALESCE(
        CASE WHEN p.payload->>'date' ~ ${DATE} THEN (p.payload->>'date')::date END,
        CASE WHEN p.payload #>> '{invoice,issueDate}' ~ ${DATE} THEN (p.payload #>> '{invoice,issueDate}')::date END,
        (p.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      ) < ${b.next}::date`.execute(ctx.trx);
  return Number(rows[0]?.n ?? 0);
}

// Invoices of the tax portal's lists of the month's period that match no voucher the books hold (missing, a different amount, or only in the Inbox as a proposal), purchases and
// sales together, from the same reconciliation the Hóa đơn cổng thuế screen shows. Null when no list was imported and read for the period: there is then nothing to compare.
async function unmatchedInvoices(ctx: QueryContext, entity: string, month: string, kind: VatFilingPeriod | null): Promise<{ count: number; period: string } | null> {
  const periods = portalPeriods(month, kind);
  const lists = await ctx.trx
    .selectFrom('crove_finance.portal_invoice_list')
    .select(['period', 'direction'])
    .distinct()
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('period', 'in', periods)
    .where('status', '=', 'done')
    .where('removed_at', 'is', null)
    .execute();
  if (lists.length === 0) return null;
  let count = 0;
  for (const list of lists) {
    const { reconciliation } = await reconcilePeriod(ctx, list.period, entity, list.direction);
    count += reconciliation.summary.missing + reconciliation.summary.amountMismatch + reconciliation.summary.inInbox;
  }
  return { count, period: periods.find((p) => lists.some((l) => l.period === p)) ?? month };
}

// Bank statement lines dated in the month that no posted, unreversed bank voucher settles, no platform payout voucher names and no pending voucher proposal holds: the lines the bank
// screen shows as still to do (the rule of finance.bank.open_lines and bankLineStates, here for one month and with the payout vouchers counted).
async function unbookedBankLines(ctx: QueryContext, entity: string, b: MonthBounds): Promise<number> {
  const row = await ctx.trx
    .selectFrom('crove_finance.bank_line as l')
    .select(sql<string>`pg_catalog.count(*)`.as('n'))
    .where('l.org_id', '=', ctx.orgId)
    .where('l.legal_entity_id', '=', entity)
    .where('l.value_date', '>=', b.from)
    .where('l.value_date', '<', b.next)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('crove_finance.cash_voucher as v')
            .innerJoin('crove_finance.journal_entry as e', (join) =>
              join.onRef('e.org_id', '=', 'v.org_id').onRef('e.source_id', '=', 'v.id').on('e.source_type', '=', VOUCHER_SOURCE).on('e.reverses_entry_id', 'is', null).on(latestRevision('e')),
            )
            .select('v.id')
            .whereRef('v.org_id', '=', 'l.org_id')
            .whereRef('v.bank_line_id', '=', 'l.id')
            .where(({ not, exists, selectFrom }) =>
              not(exists(selectFrom('crove_finance.journal_entry as r').select('r.id').whereRef('r.org_id', '=', 'e.org_id').whereRef('r.reverses_entry_id', '=', 'e.id'))),
            ),
        ),
      ),
    )
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('crove_finance.journal_voucher as j').select('j.id').whereRef('j.org_id', '=', 'l.org_id').whereRef('j.payout_bank_line_id', '=', 'l.id'))))
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('crove_kernel.proposal as p')
            .select('p.id')
            .whereRef('p.org_id', '=', 'l.org_id')
            .where('p.command', 'in', [VOUCHER_COMMAND, PAYROLL_PAYMENT_COMMAND, MARKETPLACE_PAYOUT_COMMAND, SUPPLIER_PAYMENT_SETTLE_COMMAND])
            .where('p.status', '=', 'pending')
            .where(sql`p.payload->>'bankLineId'`, '=', sql`l.id::text`),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

// Settlements the Sàn screen still offers to post and payouts it still offers to record, whose settlement period ends in the month: the same worklist the screen reads, so the checklist
// never counts a settlement the screen would not offer (a settlement of zero net posts nothing and is not one).
async function openMarketplace(ctx: QueryContext, entity: string, b: MonthBounds): Promise<number> {
  const work = await marketplaceWorklist.handler(ctx, { legalEntityId: entity });
  const inMonth = (periodTo: string) => periodTo >= b.from && periodTo <= b.last;
  return work.settlements.filter((s) => inMonth(s.periodTo)).length + work.payouts.filter((p) => inMonth(p.periodTo)).length;
}

// Whether the stock close of the month still has to be run: the month is over, no stock close covers it (a close of this month or a later one: months close in order, so a later close
// covers it), and the entity has a stock move the close of this month would have to take in, dated from the month after the last closed month up to the end of this month. A month with
// no move of its own after the last closed one needs no close (as the close command itself says), so it is left out: null.
async function stockCloseOpen(ctx: QueryContext, entity: string, b: MonthBounds, today: string): Promise<boolean | null> {
  if (!monthOver(b, today)) return null;
  const closed = await ctx.trx.selectFrom('crove_finance.stock_period').select('id').where('org_id', '=', ctx.orgId).where('legal_entity_id', '=', entity).where('period_month', '>=', b.from).limit(1).executeTakeFirst();
  if (closed !== undefined) return false;
  const { rows } = await sql<{ pending: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM crove_finance.stock_move m
      WHERE m.org_id = ${ctx.orgId}::uuid AND m.legal_entity_id = ${entity}::uuid AND m.move_date < ${b.next}::date
        AND m.move_date >= COALESCE(
          (SELECT pg_catalog.max(p.period_month) + INTERVAL '1 month' FROM crove_finance.stock_period p WHERE p.org_id = ${ctx.orgId}::uuid AND p.legal_entity_id = ${entity}::uuid AND p.period_month < ${b.from}::date),
          DATE '0001-01-01')
    ) AS pending`.execute(ctx.trx);
  return rows[0]?.pending === true ? true : null;
}

// Whether the return of the VAT period is not marked as filed: the latest mark of the period (or of the quarter that holds a month, for a filer who changed period) is not a filed one.
async function vatMarkOpen(ctx: QueryContext, entity: string, period: string): Promise<boolean> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.vat_return_filed')
    .select(['period', 'status', 'source'])
    .distinctOn('period')
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('period', 'in', declaringPeriods(vatPeriod(period)))
    .orderBy('period')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return !rows.some((r) => r.status === 'filed' && r.source !== null);
}

export async function financeMonthClose(ctx: QueryContext, input: FinanceMonthCloseInput): Promise<MonthClose> {
  const entity = await resolveLegalEntity(ctx, input.legalEntityId);
  const b = monthBounds(input.month);
  const kind = await filingPeriod(ctx);
  const today = await databaseToday(ctx.trx);
  const markPeriod = vatMarkPeriod(b.month, kind);
  return buildMonthClose(entity, b, {
    proposals: await pendingProposals(ctx, entity, b),
    invoices: await unmatchedInvoices(ctx, entity, b.month, kind),
    bank: await unbookedBankLines(ctx, entity, b),
    marketplace: await openMarketplace(ctx, entity, b),
    stock: await stockCloseOpen(ctx, entity, b, today),
    vat: markPeriod === null ? null : { period: markPeriod, open: await vatMarkOpen(ctx, entity, markPeriod) },
    lock: !lockCovers(await periodLockedThrough(ctx, entity), b),
  });
}

export const financeMonthCloseQuery = defineQuery({
  name: 'finance.month_close',
  input: zFinanceMonthCloseInput,
  access: ALL,
  handler: (ctx, input): Promise<MonthClose> => financeMonthClose(ctx, input),
});
