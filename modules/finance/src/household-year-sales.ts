// SPDX-License-Identifier: AGPL-3.0-only
// The revenue entries of one legal entity over a range of days, for the household's yearly rule (#3710 slice 3): one row per journal entry that touched account 511 (and its sub-accounts, the TT133 ones and the
// org's own), with the entry's net amount (credit less debit) and its date. A dedicated statement and not the ledger view: the view loads every account's lines of the period and refuses above 50 000 lines,
// which a busy shop passes within a year, while this reads only the revenue lines and has no such cap. The match of the account is the book's own: 511, any code that starts with it, and the org's
// sub-accounts whose root is 511 (the same notion as `accountLedgerOf(..., '511')`).
import { sql } from 'kysely';
import type { QueryContext } from '@ludy/kernel-runtime';
import { money, toMoney } from '@ludy/l10n-vn';

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

export interface SalesEntry {
  entryId: string;
  date: string;
  amount: string;
}

export interface SalesTotals {
  quarter: string;
  before: string;
}

// Canonical decimal money string from a SQL numeric::text result (strips trailing zeros, never '-0').
export function normalizeSalesTotal(raw: string | null | undefined): string {
  const value = money(raw);
  return value.isZero() ? '0' : toMoney(value);
}

function salesLines(ctx: Ctx, entity: string) {
  return ctx.trx
    .selectFrom('ludy_finance.journal_line as l')
    .innerJoin('ludy_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .where('l.org_id', '=', ctx.orgId)
    .where('l.legal_entity_id', '=', entity)
    .where('j.legal_entity_id', '=', entity)
    .where((eb) =>
      eb.or([
        eb('l.account_code', 'like', '511%'),
        eb('l.account_code', 'in', eb.selectFrom('ludy_finance.org_account').select('code').where('org_id', '=', ctx.orgId).where('root_code', '=', '511')),
      ]),
    );
}

// `from` and `to` are days (inclusive); with `before` instead of `to` the range stops the day before it.
export async function salesEntriesOf(ctx: Ctx, entity: string, range: { from: string; to: string } | { from: string; before: string }): Promise<SalesEntry[]> {
  let query = salesLines(ctx, entity)
    .select(['j.id', 'j.entry_date'])
    .select(sql<string>`SUM(l.credit - l.debit)::text`.as('amount'))
    .where('j.entry_date', '>=', range.from);
  query = 'to' in range ? query.where('j.entry_date', '<=', range.to) : query.where('j.entry_date', '<', range.before);
  const rows = await query.groupBy(['j.id', 'j.entry_date']).orderBy('j.entry_date').orderBy('j.id').execute();
  return rows.map((r) => ({ entryId: r.id, date: r.entry_date, amount: r.amount }));
}

// One-statement revenue sums for 01/CNKD (#3216): net movement (credit less debit) of account 511 and its sub-accounts over [from, to] (the return quarter) and [yearStart, from) (earlier in the year).
// Reads one PostgreSQL snapshot with no LEDGER_LINE_LIMIT cap and returns two scalars rather than per-entry or per-line rows.
export async function salesTotalsOf(ctx: Ctx, entity: string, range: { yearStart: string; from: string; to: string }): Promise<SalesTotals> {
  const scanFrom = range.yearStart < range.from ? range.yearStart : range.from;
  const row = await salesLines(ctx, entity)
    .select([
      sql<string>`COALESCE(SUM(l.credit - l.debit) FILTER (WHERE j.entry_date >= ${range.from}::date), 0)::text`.as('quarter'),
      sql<string>`COALESCE(SUM(l.credit - l.debit) FILTER (WHERE j.entry_date >= ${range.yearStart}::date AND j.entry_date < ${range.from}::date), 0)::text`.as('before'),
    ])
    .where('j.entry_date', '>=', scanFrom)
    .where('j.entry_date', '<=', range.to)
    .executeTakeFirst();
  return {
    quarter: normalizeSalesTotal(row?.quarter),
    before: normalizeSalesTotal(row?.before),
  };
}

// With one trade the year's revenue is put on it whole, which is wrong when an earlier profile of the year named another trade: the sales before the book's first day were made under that one. True when a profile
// in force during the year before `from` (the one in force on 1 January, which may start that day, and any later one) names other trades than `trades`; the yearly figures then wait for the accountant (#3710 slice 3 review).
export async function tradesDifferEarlierInYear(ctx: Ctx, entity: string, year: string, from: string, trades: readonly string[]): Promise<boolean> {
  const jan1 = `${year}-01-01`;
  if (from <= jan1) return false;
  const rows = await ctx.trx
    .selectFrom('ludy_finance.household_profile')
    .select(['effective_from', 'trades'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('effective_from', '<', from)
    .orderBy('effective_from', 'desc')
    .execute();
  const key = (list: readonly string[]) => [...list].sort().join(',');
  // The profile in force on 1 January is the latest one effective on or before it (a profile that starts on 1 January replaces the one before); the later ones in the year are those after it.
  const inYear = rows.filter((r) => r.effective_from > jan1);
  const onJan1 = rows.find((r) => r.effective_from <= jan1);
  return [...inYear, ...(onJan1 ? [onJan1] : [])].some((r) => key(r.trades) !== key(trades));
}
