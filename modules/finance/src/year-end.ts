// SPDX-License-Identifier: AGPL-3.0-only
// finance.year_end: the year-end checklist of the Kế toán screen (#5283), read only. For one legal entity and one calendar year it finds, by a read of the books each, what a person still
// has to do before the year can be closed and its returns filed: the 131, 331, 3387 and 141 balances to look at, the asset months not depreciated, the stock count, the closing entry, the period
// lock, the company returns marked done on the tax calendar, the household's fourth-quarter return prepared, and the e-invoice series of the new year. Every read is scoped by org_id and by the
// entity (and the restrictive le_scope policy of each table applies on top), is a state or a count and never a list, and no amount leaves it. The due dates come from the tax calendar's rules
// (domain/year-end.ts). The coworker's note over the open items is asked of the model elsewhere (apps/kernel finance-year-end-ai.ts); nothing here writes or posts.
import { sql } from 'kysely';
import { zFinanceYearEndInput, type FinanceYearEndInput, type TaxObligation, type YearEnd } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { RETURN_OBLIGATION, buildYearEnd, openAssetMonths, yearLast, yearStart, type YearEndReads } from './domain/year-end.ts';
import { householdProfileView } from './household.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday, periodLockedThrough } from './period-lock.ts';
import { isClosed } from './year-closing.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The parties and accounts to look at at the year's last day: a 131 party with a credit balance (the customer paid more than was invoiced), a 331 party with a debit balance (an advance to a
// supplier), and a 3387 or 141 account with any balance (revenue received in advance, an advance to staff). Each is a legitimate state that a person decides on, so the item says "to look at"
// and never "wrong". Every entry and reversal through the day is summed, so a reversed one nets out, as the closing entry reads the result accounts.
async function balancesToReview(ctx: QueryContext, entity: string, year: number): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT pg_catalog.count(*)::text AS n FROM (
      SELECT l.account_code, l.party_id, pg_catalog.sum(l.debit) - pg_catalog.sum(l.credit) AS balance
      FROM ludy_finance.journal_line l
      JOIN ludy_finance.journal_entry j ON j.org_id = l.org_id AND j.id = l.entry_id
      WHERE l.org_id = ${ctx.orgId}::uuid AND l.legal_entity_id = ${entity}::uuid AND j.entry_date <= ${yearLast(year)}::date
        AND (l.account_code LIKE '131%' OR l.account_code LIKE '331%' OR l.account_code LIKE '3387%' OR l.account_code LIKE '141%')
      GROUP BY l.account_code, l.party_id
    ) x
    WHERE (x.account_code LIKE '131%' AND x.balance < 0) OR (x.account_code LIKE '331%' AND x.balance > 0) OR (x.account_code LIKE '3387%' AND x.balance <> 0) OR (x.account_code LIKE '141%' AND x.balance <> 0)`.execute(ctx.trx);
  return Number(rows[0]?.n ?? 0);
}

// The asset months of the year not depreciated, through the last month that has ended; null when the entity has no fixed asset or prepaid cost that starts by the year's end.
async function assetMonthsOpen(ctx: QueryContext, entity: string, year: number, today: string): Promise<number | null> {
  const assets = await ctx.trx
    .selectFrom('ludy_finance.fixed_asset')
    .select(['id', 'cost', 'months', sql<string>`pg_catalog.to_char(start_month, 'YYYY-MM-DD')`.as('start_month'), sql<string | null>`pg_catalog.to_char(ended_month, 'YYYY-MM-DD')`.as('ended_month')])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('start_month', '<=', yearLast(year))
    .execute();
  if (assets.length === 0) return null;
  const lines = await ctx.trx
    .selectFrom('ludy_finance.depreciation_line')
    .select(['asset_id', sql<string>`pg_catalog.to_char(month, 'YYYY-MM-DD')`.as('month')])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('month', '>=', yearStart(year))
    .where('month', '<=', yearLast(year))
    .execute();
  const posted = new Set(lines.map((l) => `${l.asset_id}|${l.month}`));
  return openAssetMonths(
    assets.map((a) => ({ id: a.id, cost: a.cost, startMonth: a.start_month, months: a.months, endedMonth: a.ended_month })),
    posted,
    year,
    today,
  );
}

// Whether the entity keeps stock (an active stock item) and has a confirmed count dated in December of the year (Law 88/2015/QH13 Art. 40 asks for a count at the end of the accounting year and fixes no window).
async function stockCount(ctx: QueryContext, entity: string, year: number): Promise<{ kept: boolean; counted: boolean }> {
  const { rows } = await sql<{ kept: boolean; counted: boolean }>`
    SELECT
      EXISTS (SELECT 1 FROM ludy_finance.stock_item i WHERE i.org_id = ${ctx.orgId}::uuid AND i.legal_entity_id = ${entity}::uuid AND i.active) AS kept,
      EXISTS (SELECT 1 FROM ludy_finance.stock_count c WHERE c.org_id = ${ctx.orgId}::uuid AND c.legal_entity_id = ${entity}::uuid AND c.status = 'confirmed'
        AND c.count_date >= ${`${year}-12-01`}::date AND c.count_date <= ${yearLast(year)}::date) AS counted`.execute(ctx.trx);
  return { kept: rows[0]?.kept === true, counted: rows[0]?.counted === true };
}

// The org's tax calendar (the obligations it turned on and the last month of its fiscal year) and which obligations are marked done for the year of this entity. An org that never saved its
// calendar has no obligation turned on, as the Overview's due list shows none for it either.
async function taxMarks(ctx: QueryContext, entity: string, year: number): Promise<YearEndReads['tax']> {
  const profile = await ctx.trx.selectFrom('ludy_kernel.tax_profile').select(['obligations', 'fiscal_year_end_month']).where('org_id', '=', ctx.orgId).executeTakeFirst();
  const obligations = (profile?.obligations ?? []) as TaxObligation[];
  const wanted = Object.values(RETURN_OBLIGATION) as TaxObligation[];
  const marks = await ctx.trx
    .selectFrom('ludy_kernel.tax_obligation_done')
    .select('obligation')
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('period', '=', String(year))
    .where('obligation', 'in', wanted)
    .execute();
  return { obligations, fiscalYearEndMonth: profile?.fiscal_year_end_month ?? 12, marked: new Set(marks.map((m) => m.obligation as TaxObligation)) };
}

// A household whose profile on the year's last day files the 01/CNKD by percentage, and whether an export of the fourth quarter's worksheet was recorded: the audit row names the entity, the
// book and the period. An export is evidence the worksheet was prepared, not that the return was filed: Ludy never files.
async function householdReturn(ctx: QueryContext, entity: string, year: number): Promise<YearEndReads['householdReturn']> {
  const view = await householdProfileView(ctx, entity, yearLast(year));
  if (view.profile?.pitMethod !== 'percentage') return { required: false, prepared: false };
  const { rows } = await sql<{ prepared: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM ludy_kernel.audit_event a
      WHERE a.org_id = ${ctx.orgId}::uuid AND a.command = 'finance.household.export' AND a.outcome = 'ok' AND a.actor_type <> 'agent'
        AND a.detail ->> 'legalEntityId' = ${entity} AND a.detail ->> 'book' = '01/CNKD' AND a.detail ->> 'period' = ${`${year}-Q4`}
    ) AS prepared`.execute(ctx.trx);
  return { required: true, prepared: rows[0]?.prepared === true };
}

// The entity has an e-invoice connection, and a series whose symbol carries the next year (the symbol's second and third characters are the year's last two digits).
async function einvoiceSeries(ctx: QueryContext, entity: string, year: number): Promise<YearEndReads['einvoice']> {
  const connection = await ctx.trx.selectFrom('ludy_finance.einvoice_connection').select('id').where('org_id', '=', ctx.orgId).where('legal_entity_id', '=', entity).limit(1).executeTakeFirst();
  if (connection === undefined) return { connected: false, nextYearSeries: false };
  const next = String(year + 1).slice(2);
  const series = await ctx.trx
    .selectFrom('ludy_finance.einvoice_series')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where(sql<string>`pg_catalog.substr(symbol, 2, 2)`, '=', next)
    .limit(1)
    .executeTakeFirst();
  return { connected: true, nextYearSeries: series !== undefined };
}

export async function financeYearEnd(ctx: QueryContext, input: FinanceYearEndInput): Promise<YearEnd> {
  const entity = await resolveLegalEntity(ctx, input.legalEntityId);
  const today = await databaseToday(ctx.trx);
  const kind = await ctx.trx.selectFrom('ludy_kernel.legal_entity').select('kind').where('org_id', '=', ctx.orgId).where('id', '=', entity).executeTakeFirst();
  const household = kind?.kind === 'household';
  const stock = await stockCount(ctx, entity, input.year);
  return buildYearEnd(entity, input.year, today, {
    household,
    balances: await balancesToReview(ctx, entity, input.year),
    assetMonthsOpen: await assetMonthsOpen(ctx, entity, input.year, today),
    stockKept: stock.kept,
    stockCounted: stock.counted,
    closed: household ? false : await isClosed(ctx, input.year, entity),
    lockedThrough: await periodLockedThrough(ctx, entity),
    tax: household ? { obligations: [], fiscalYearEndMonth: 12, marked: new Set() } : await taxMarks(ctx, entity, input.year),
    householdReturn: household ? await householdReturn(ctx, entity, input.year) : { required: false, prepared: false },
    einvoice: await einvoiceSeries(ctx, entity, input.year),
  });
}

export const financeYearEndQuery = defineQuery({
  name: 'finance.year_end',
  input: zFinanceYearEndInput,
  access: ALL,
  handler: (ctx, input): Promise<YearEnd> => financeYearEnd(ctx, input),
});
