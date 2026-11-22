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
import { MARKETPLACE_PAYOUT_COMMAND, MARKETPLACE_SETTLEMENT_COMMAND, PAYROLL_PAYMENT_COMMAND, SUPPLIER_PAYMENT_SETTLE_COMMAND, VOUCHER_COMMAND } from '@ludy/kernel-contract';
import { VOUCHER_SOURCE } from './domain/cash-voucher.ts';
import { JOURNAL_VOUCHER_SOURCE } from './domain/journal-voucher.ts';
import { declaringPeriods, vatPeriod } from './domain/vat-return.ts';
import { buildMonthClose, lockCovers, monthBounds, monthOver, portalPeriods, vatMarkPeriod, type MonthBounds } from './domain/month-close.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday, periodLockedThrough } from './period-lock.ts';
import { reconcilePeriod } from './portal-list.ts';
import { latestRevision, reversedSource } from './source-entry.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const DATE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

// The org's filing period (an org that never set one files monthly, so null reads as month).
async function filingPeriod(ctx: QueryContext): Promise<VatFilingPeriod | null> {
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('vat_filing_period').where('org_id', '=', ctx.orgId).executeTakeFirst();
  return (org?.vat_filing_period as VatFilingPeriod | null | undefined) ?? null;
}

// Finance proposals still pending whose own date is in the month: the voucher's date (a cash or journal voucher), the invoice's issue date (a purchase or sale), else the day the
// proposal was made (Vietnam time). A proposal that needs no voucher date, such as a marketplace settlement, is dated by the day it was made. The date is compared as the text it is
// stored as (an ISO date sorts as text), so one impossible date in a payload ("2026-02-31") cannot raise an error and break the checklist: it is just a day that is in no month.
async function pendingProposals(ctx: QueryContext, entity: string, b: MonthBounds): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT pg_catalog.count(*)::text AS n
    FROM crove_kernel.proposal p
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        CASE WHEN p.payload->>'date' ~ ${DATE} THEN p.payload->>'date' END,
        CASE WHEN p.payload #>> '{invoice,issueDate}' ~ ${DATE} THEN p.payload #>> '{invoice,issueDate}' END,
        pg_catalog.to_char(p.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')
      ) AS dated
    ) d
    WHERE p.org_id = ${ctx.orgId}::uuid AND p.legal_entity_id = ${entity}::uuid AND p.status = 'pending' AND p.command LIKE 'finance.%'
      AND d.dated >= ${b.from} AND d.dated < ${b.next}`.execute(ctx.trx);
  return Number(rows[0]?.n ?? 0);
}

// Invoices of the tax portal's lists of the month's VAT period that match no voucher the books hold (the portal reconciliation's missing and different-amount outcomes, purchases and
// sales together), from the same reconciliation the Tax portal check screen shows. An invoice that is only a proposal in the Inbox is left out: that proposal is counted in the first item.
// For a quarterly filer in the last month of the quarter the quarter's lists are read when there are any, and the month's own only when there are none, so one invoice is never
// counted from two lists. Null when no list was imported and read for the period: there is then nothing to compare.
async function unmatchedInvoices(ctx: QueryContext, entity: string, month: string, kind: VatFilingPeriod | null): Promise<{ count: number; period: string } | null> {
  const lists = await ctx.trx
    .selectFrom('crove_finance.portal_invoice_list')
    .select(['period', 'direction'])
    .distinct()
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('period', 'in', portalPeriods(month, kind))
    .where('status', '=', 'done')
    .where('removed_at', 'is', null)
    .execute();
  const period = portalPeriods(month, kind).find((p) => lists.some((l) => l.period === p));
  if (period === undefined) return null;
  let count = 0;
  for (const list of lists.filter((l) => l.period === period)) {
    const { reconciliation } = await reconcilePeriod(ctx, period, entity, list.direction);
    count += reconciliation.summary.missing + reconciliation.summary.amountMismatch;
  }
  return { count, period };
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

// Marketplace settlements still to post and payouts still to record, whose settlement period ends in the month, in two month-filtered counts with the standing and posted rules of the Sàn
// screen's worklist and facts (finance.marketplace.worklist and .facts), with no cap: a settlement stands when it is not reversed and not itself a reversal; it is still to post when it
// has no posting voucher and has something to post (a line with sales, a refund or a net amount: a settlement of nothing posts nothing and is not one); its payout is still to record when
// its posting stands (it has vouchers and none is reversed) and no payout voucher names it. One that already has a pending proposal is left out, because that proposal is counted in the first item.
async function openMarketplace(ctx: QueryContext, entity: string, b: MonthBounds): Promise<number> {
  const standing = sql`s.org_id = ${ctx.orgId}::uuid AND s.legal_entity_id = ${entity}::uuid AND s.period_end >= ${b.from}::date AND s.period_end <= ${b.last}::date
    AND s.reversal_of IS NULL
    AND NOT EXISTS (SELECT 1 FROM crove_finance.channel_settlement r WHERE r.org_id = s.org_id AND r.legal_entity_id = s.legal_entity_id AND r.reversal_of = s.id)`;
  const pending = (command: string) =>
    sql`NOT EXISTS (SELECT 1 FROM crove_kernel.proposal p WHERE p.org_id = s.org_id AND p.command = ${command} AND p.status = 'pending' AND p.payload->>'settlementId' = s.id::text)`;
  const { rows } = await sql<{ to_post: string; to_record: string }>`
    SELECT
      pg_catalog.count(*) FILTER (
        WHERE NOT EXISTS (SELECT 1 FROM crove_finance.journal_voucher v WHERE v.org_id = s.org_id AND v.settlement_id = s.id)
          AND EXISTS (SELECT 1 FROM crove_finance.channel_settlement_line l WHERE l.org_id = s.org_id AND l.settlement_id = s.id AND (l.sales <> 0 OR l.refund <> 0 OR l.net <> 0))
          AND ${pending(MARKETPLACE_SETTLEMENT_COMMAND)}
      )::text AS to_post,
      pg_catalog.count(*) FILTER (
        WHERE EXISTS (SELECT 1 FROM crove_finance.journal_voucher v WHERE v.org_id = s.org_id AND v.settlement_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_voucher j WHERE j.org_id = s.org_id AND j.settlement_id = s.id AND ${reversedSource('j', JOURNAL_VOUCHER_SOURCE)})
          AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_voucher p WHERE p.org_id = s.org_id AND p.payout_settlement_id = s.id)
          AND ${pending(MARKETPLACE_PAYOUT_COMMAND)}
      )::text AS to_record
    FROM crove_finance.channel_settlement s
    WHERE ${standing}`.execute(ctx.trx);
  return Number(rows[0]?.to_post ?? 0) + Number(rows[0]?.to_record ?? 0);
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
