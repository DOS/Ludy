// SPDX-License-Identifier: AGPL-3.0-only
// finance.quarter_summary (#5183): the quarter in plain words, the figures of one legal entity for one quarter that has ended, read only. Every figure comes from a read that already exists, so the card and the
// reports cannot disagree:
// - revenue, other income, costs and profit: the income statement's own lines (buildB02 with the TT133 map; finance.statements.period and finance.overview read a TT99 entity under the TT99 map since #5187, and this card keeps its own split below) for the quarter, the previous quarter and the same quarter
//   last year, in ONE statement (#365) with the balances below, so every column sees the same entries even in the query's READ COMMITTED transaction. B02 is the TT133 map (#5187): the class 5 to 8 balances
//   none of its lines reads (a TT99 entity's 641 and 521 above all) are added where they belong (domain/quarter-summary.ts) and the answer says so (`includesUnmapped`);
// - cash (B01 line 110), receivables (131) and payables (311): the balances at the quarter's last day and at the last day of the two bases, the overview's own shape;
// - the oldest overdue sales invoice: the reminders' loader (loadCustomers), as at the quarter's last day, bounded like the cash forecast's read;
// - VAT: the VAT screen's own read (loadVatReport) for a company; a household's tax: its 01/CNKD worksheet (finance.household.cnkd), with its own refusals as the state `not_required`;
// - stock value: the stock report's rows (stockReportRows) for the last month of the quarter and of the previous quarter, only when the entity keeps stock;
// - the period lock (finance.period.lock_state), shown whether or not it reaches the quarter.
// It runs in the member's own transaction: the entity is the caller's own (resolveLegalEntity), every journal read filters org and entity and the tables' le_scope policy applies. It writes nothing. A quarter still
// running is refused (QUARTER_NOT_ENDED). A basis that ends before the entity's first entry is not 0, it is not there: its figure is null and its label `none`.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  QUARTER_SUMMARY_DOCUMENTS_MAX,
  QUARTER_SUMMARY_PARTIES_MAX,
  QUARTER_SUMMARY_STEADY_PERCENT,
  zFinanceQuarterSummary,
  zFinanceQuarterSummaryInput,
  type FinanceQuarterSummary,
  type QuarterSummaryHouseholdTax,
  type QuarterSummaryVat,
} from '@ludy/kernel-contract';
import { money, sum } from '@ludy/l10n-vn';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { booksOnDate } from './domain/expense-variance.ts';
import { ledgerPeriod, type LedgerPeriod } from './domain/ledger-reports.ts';
import { canonical } from './domain/money.ts';
import { balanceColumn, basisThere, buildFigures, lockStateOf, overdueSummary, quarterEnded, resultColumn, type BalanceColumn, type ResultColumn } from './domain/quarter-summary.ts';
import { comparisonPlan } from './domain/statement-comparison.ts';
import { buildB01, buildB02, type B01Setup } from './domain/tt133-reports.ts';
import { b01For } from './domain/tt99-reports.ts';
import { booksRows } from './expense-variance.ts';
import { householdCnkd } from './household-return.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { loadCustomers } from './payment-reminders.ts';
import { databaseToday, periodLockState } from './period-lock.ts';
import { asEntries, balances, type BalanceRow } from './statements.ts';
import { stockReportRows } from './stock-report.ts';
import { loadVatReport } from './vat.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The accounts B01's cash (110), receivables (131) and payables (311) lines read; the balances query needs nothing else.
const BALANCE_PREFIXES = ['111', '112', '113', '131', '331'];

export const quarterNotEnded = () => new DomainError('QUARTER_NOT_ENDED', 422, 'Quý này chưa kết thúc; hãy chọn một quý đã qua để xem tóm tắt');

type Rows = Record<string, BalanceRow[]>;

interface Basis {
  period: LedgerPeriod;
}

// The summed balances of every part in ONE statement: the quarter's results and balances, and those of the bases that are there (a basis that ends before the books begin is not read).
async function summaryRows(ctx: QueryContext, entity: string, period: LedgerPeriod, previous: Basis | null, lastYear: Basis | null): Promise<Rows> {
  const balancesTo = (to: string, part: string) =>
    balances(ctx, entity, null, to, false)
      .where((eb) => eb.or(BALANCE_PREFIXES.map((prefix) => eb('l.account_code', 'like', `${prefix}%`))))
      .select(sql.lit(part).as('part'));
  // Revenue, income and expense accounts (classes 5 to 8) are all B02 reads; the year-end closing entries are left out.
  const resultsIn = (from: string, to: string, part: string) =>
    balances(ctx, entity, from, to, true)
      .where(sql<boolean>`l.account_code ~ '^[5-8]'`)
      .select(sql.lit(part).as('part'));
  const parts = [balancesTo(period.to, 'bal_now'), resultsIn(period.from, period.to, 'res_now')];
  if (previous) parts.push(balancesTo(previous.period.to, 'bal_previous'), resultsIn(previous.period.from, previous.period.to, 'res_previous'));
  if (lastYear) parts.push(balancesTo(lastYear.period.to, 'bal_last_year'), resultsIn(lastYear.period.from, lastYear.period.to, 'res_last_year'));
  const [first, ...rest] = parts;
  if (!first) throw new Error('the quarter summary reads no part');
  let query = first;
  for (const part of rest) query = query.unionAll(part);
  const rows = await query.orderBy('part').orderBy('account_code').execute();
  const split: Rows = {};
  for (const { part, ...row } of rows) (split[part as string] ??= []).push(row as BalanceRow);
  return split;
}

function results(rows: Rows, name: string, period: LedgerPeriod, entity: string): ResultColumn {
  const report = buildB02(asEntries(rows[name] ?? [], period.from, entity), entity, period.from, period.to);
  return resultColumn(report.lines, report.unmapped);
}

// The balance sheet lines are read under the regime of the quarter's last day (#5204), so a TT99 entity's cash counts 113, money in transit.
function balancesAt(rows: Rows, name: string, period: LedgerPeriod, entity: string, setup: B01Setup): BalanceColumn {
  return balanceColumn(buildB01(asEntries(rows[name] ?? [], period.to, entity), entity, period.to, 'VND', setup).lines);
}

// The VAT working of the quarter, from the VAT screen's own read: the indicators [35] (VAT on sales) and [24] (VAT on purchases), their difference before any carry-forward, and whether the return is marked filed.
async function vatOf(ctx: QueryContext, entity: string, quarter: string): Promise<QuarterSummaryVat> {
  const report = await loadVatReport(ctx, quarter, entity);
  const indicator = (code: string) => money(report.indicators.find((i) => i.code === code)?.amount ?? '0');
  const output = indicator('35');
  const input = indicator('24');
  return { output: canonical(output), input: canonical(input), difference: canonical(output.minus(input)), filed: report.filed !== null };
}

// A household's tax for the quarter, from its 01/CNKD worksheet. A refusal of the worksheet (a group that files no quarterly return, the income method, a profile that changes inside the quarter, a rate not set, a window too large) is
// the state `not_required`, never an error of the card.
async function householdTaxOf(ctx: QueryContext, entity: string, period: LedgerPeriod): Promise<QuarterSummaryHouseholdTax> {
  const year = Number(period.from.slice(0, 4));
  const quarter = Number(period.period.slice(6)) as 1 | 2 | 3 | 4;
  try {
    const sheet = await householdCnkd.handler(ctx, { legalEntityId: entity, year, quarter });
    if (sheet.totals === null) return { state: 'held', tax: null, due: null, overpaid: null, commentary: sheet.commentary };
    return { state: 'ready', tax: sheet.totals.tax, due: sheet.due, overpaid: sheet.overpaid, commentary: sheet.commentary };
  } catch (error: unknown) {
    // Any refusal of the worksheet (its own HOUSEHOLD_ ones, or a ledger window too large for it) leaves the card with the state, never with an error.
    if (error instanceof DomainError) return { state: 'not_required', tax: null, due: null, overpaid: null, commentary: false };
    throw error;
  }
}

// The stock value (the sum of the items' closing values) at the last month of a quarter, and whether any of it is provisional (the month is not closed for the item's entity).
async function stockValueAt(ctx: QueryContext, entity: string, quarter: LedgerPeriod): Promise<{ value: string; provisional: boolean }> {
  const rows = await stockReportRows(ctx, quarter.to.slice(0, 7), entity);
  return { value: canonical(sum(rows.map((r) => r.closingValue))), provisional: rows.some((r) => !r.closed) };
}

export async function financeQuarterSummary(ctx: QueryContext, input: { quarter: string; legalEntityId?: string | undefined }): Promise<FinanceQuarterSummary> {
  const entity = await resolveLegalEntity(ctx, input.legalEntityId);
  const today = await databaseToday(ctx.trx);
  const period = ledgerPeriod(input.quarter);
  // Only a quarter that has ended is summed: a quarter in progress against whole quarters would read as a drop.
  if (!quarterEnded(period.to, today)) throw quarterNotEnded();
  const plan = comparisonPlan(period);

  const first = await ctx.trx
    .selectFrom('ludy_finance.journal_entry')
    .select((eb) => eb.fn.min<string | null>('entry_date').as('first'))
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .executeTakeFirst();
  const booksStart = first?.first ? String(first.first).slice(0, 10) : null;
  const previousPeriod = plan.previous && basisThere(booksStart, plan.previous.to) ? plan.previous : null;
  const lastYearPeriod = plan.lastYear && basisThere(booksStart, plan.lastYear.to) ? plan.lastYear : null;
  const rows = await summaryRows(ctx, entity, period, previousPeriod && { period: previousPeriod }, lastYearPeriod && { period: lastYearPeriod });

  const entityRow = await ctx.trx.selectFrom('ludy_kernel.legal_entity').select('kind').where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirstOrThrow();
  const household = entityRow.kind === 'household';
  const books = booksOnDate(await booksRows(ctx, entity), period.to);

  const now = results(rows, 'res_now', period, entity);
  const previous = previousPeriod ? results(rows, 'res_previous', previousPeriod, entity) : null;
  const lastYear = lastYearPeriod ? results(rows, 'res_last_year', lastYearPeriod, entity) : null;

  // Stock only where it is kept: an entity with no item has no row, and its two reads of the moves are not made.
  const keepsStock = (await ctx.trx.selectFrom('ludy_finance.stock_item').select('id').where('org_id', '=', ctx.orgId).where('legal_entity_id', '=', entity).limit(1).executeTakeFirst()) !== undefined;
  const stockNow = keepsStock ? await stockValueAt(ctx, entity, period) : null;
  const stockBefore = keepsStock && previousPeriod ? await stockValueAt(ctx, entity, previousPeriod) : null;

  const figures = buildFigures({
    household,
    results: { now, previous, lastYear },
    balances: {
      now: balancesAt(rows, 'bal_now', period, entity, b01For(books.regime)),
      previous: previousPeriod ? balancesAt(rows, 'bal_previous', previousPeriod, entity, b01For(books.regime)) : null,
      lastYear: lastYearPeriod ? balancesAt(rows, 'bal_last_year', lastYearPeriod, entity, b01For(books.regime)) : null,
    },
    stock: stockNow ? { now: stockNow.value, previous: stockBefore ? stockBefore.value : null } : null,
  });

  // The overdue read as at the quarter's last day: the reminders' loader with its overdue invoices, bounded like the cash forecast's read (one customer more than the bound tells whether it was hit).
  const seen = { documents: 0 };
  const customers = await loadCustomers(ctx, entity, period.to, undefined, { customers: QUARTER_SUMMARY_PARTIES_MAX + 1, documents: QUARTER_SUMMARY_DOCUMENTS_MAX, entriesTo: period.to, seen });
  const truncated = customers.length > QUARTER_SUMMARY_PARTIES_MAX || seen.documents > QUARTER_SUMMARY_DOCUMENTS_MAX;
  const overdue = overdueSummary(customers.slice(0, QUARTER_SUMMARY_PARTIES_MAX).flatMap((c) => c.overdue));

  const lock = await periodLockState(ctx, entity);
  const answer: FinanceQuarterSummary = {
    quarter: period.period,
    from: period.from,
    to: period.to,
    legalEntityId: entity,
    kind: household ? 'household' : 'company',
    regime: books.regime,
    booksStart,
    partialBasis: (previousPeriod !== null && booksStart !== null && booksStart > previousPeriod.from) || (lastYearPeriod !== null && booksStart !== null && booksStart > lastYearPeriod.from),
    previousQuarter: plan.previous?.period ?? null,
    lastYearQuarter: plan.lastYear?.period ?? null,
    steadyPercent: QUARTER_SUMMARY_STEADY_PERCENT,
    empty: booksStart === null || booksStart > period.to,
    includesUnmapped: now.includesUnmapped || (previous?.includesUnmapped ?? false) || (lastYear?.includesUnmapped ?? false),
    figures,
    overdue: { ...overdue, truncated },
    vat: household ? null : await vatOf(ctx, entity, period.period),
    householdTax: household ? await householdTaxOf(ctx, entity, period) : null,
    // Provisional when either value is: the quarter's own or the previous quarter's one it is compared with.
    stockProvisional: stockNow ? stockNow.provisional || (stockBefore?.provisional ?? false) : null,
    lock: { state: lockStateOf(lock.lockedThrough, period.from, period.to), lockedThrough: lock.lockedThrough },
  };
  // The answer is held to the contract before it leaves.
  return zFinanceQuarterSummary.parse(answer);
}

export const financeQuarterSummaryQuery = defineQuery({
  name: 'finance.quarter_summary',
  input: zFinanceQuarterSummaryInput,
  access: ALL,
  handler: (ctx, input): Promise<FinanceQuarterSummary> => financeQuarterSummary(ctx, input),
});
