// SPDX-License-Identifier: AGPL-3.0-only
// finance.overview (#2631): the Tổng quan of the Kế toán app, read only. Cash (111 and 112), receivables (131), payables (331) and the profit before tax of a
// period, each against the period of the same length right before, the results of the last six months and the period's costs by account group. The figures
// are the statements' own lines (domain/overview.ts builds them with buildB01 and buildB02), read from the same summed balances finance.statements.period
// reads, in ONE statement (#365) so every card and chart sees the same entries even in the query's READ COMMITTED transaction.
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { zFinanceOverviewInput, type FinanceOverview } from '@crove/kernel-contract';
import { defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';
import { buildOverview, overviewMonths, overviewPeriods } from './domain/overview.ts';
import { asEntries, balances, type BalanceRow } from './statements.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The accounts B01's cash, receivables and payables lines read; the balances query needs nothing else.
const BALANCE_PREFIXES = ['111', '112', '131', '331'];

type Rows = Record<string, BalanceRow[]>;

async function overviewRows(ctx: QueryContext, entity: string, periods: ReturnType<typeof overviewPeriods>, months: ReturnType<typeof overviewMonths>): Promise<Rows> {
  const balancesTo = (to: string, part: string) =>
    balances(ctx, entity, null, to, false)
      .where((eb) => eb.or(BALANCE_PREFIXES.map((prefix) => eb('l.account_code', 'like', `${prefix}%`))))
      .select(sql.lit(part).as('part'));
  // Revenue, income and expense accounts (classes 5 to 8) are all B02 reads; the year-end closing entries are left out.
  const resultsIn = (from: string, to: string, part: string) =>
    balances(ctx, entity, from, to, true)
      .where(sql<boolean>`l.account_code ~ '^[5-8]'`)
      .select(sql.lit(part).as('part'));
  const parts = [
    balancesTo(periods.to, 'bal_now'),
    balancesTo(periods.previousTo, 'bal_before'),
    resultsIn(periods.from, periods.to, 'res_now'),
    resultsIn(periods.previousFrom, periods.previousTo, 'res_before'),
    ...months.map((m, i) => resultsIn(m.from, m.to, `month_${i}`)),
  ];
  const [first, ...rest] = parts;
  if (!first) throw new Error('the overview reads no part');
  let query = first;
  for (const part of rest) query = query.unionAll(part);
  const rows = await query.orderBy('part').orderBy('account_code').execute();
  const split: Rows = {};
  for (const { part, ...row } of rows) (split[part as string] ??= []).push(row as BalanceRow);
  return split;
}

async function financeOverview(ctx: QueryContext, input: { range: FinanceOverview['range']; asOf?: string | undefined; legalEntityId?: string | undefined }): Promise<FinanceOverview> {
  const entity = await resolveLegalEntity(ctx, input.legalEntityId);
  const today = input.asOf ?? (await databaseToday(ctx.trx));
  const periods = overviewPeriods(input.range, today);
  const months = overviewMonths(periods.to);
  const rows = await overviewRows(ctx, entity, periods, months);
  const any = await ctx.trx.selectFrom('crove_finance.journal_entry').select('id').where('org_id', '=', ctx.orgId).where('legal_entity_id', '=', entity).limit(1).executeTakeFirst();
  return buildOverview({
    range: input.range,
    periods,
    legalEntityId: entity,
    balancesNow: asEntries(rows.bal_now ?? [], periods.to, entity),
    balancesBefore: asEntries(rows.bal_before ?? [], periods.previousTo, entity),
    resultsNow: asEntries(rows.res_now ?? [], periods.from, entity),
    resultsBefore: asEntries(rows.res_before ?? [], periods.previousFrom, entity),
    monthly: months.map((m, i) => ({ ...m, entries: asEntries(rows[`month_${i}`] ?? [], m.from, entity) })),
    empty: any === undefined,
  });
}

export const financeOverviewQuery = defineQuery({
  name: 'finance.overview',
  input: zFinanceOverviewInput,
  access: ALL,
  handler: (ctx, input): Promise<FinanceOverview> => financeOverview(ctx, input),
});
