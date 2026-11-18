// SPDX-License-Identifier: AGPL-3.0-only
// The revenue entries of one legal entity over a range of days, for the household's yearly rule (#3710 slice 3): one row per journal entry that touched account 511 (and its sub-accounts, the TT133 ones and the
// org's own), with the entry's net amount (credit less debit) and its date. A dedicated statement and not the ledger view: the view loads every account's lines of the period and refuses above 50 000 lines,
// which a busy shop passes within a year, while this reads only the revenue lines and has no such cap. The match of the account is the book's own: 511, any code that starts with it, and the org's
// sub-accounts whose root is 511 (the same notion as `accountLedgerOf(..., '511')`).
import { sql } from 'kysely';
import type { QueryContext } from '@crove/kernel-runtime';

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

export interface SalesEntry {
  entryId: string;
  date: string;
  amount: string;
}

// `from` and `to` are days (inclusive); with `before` instead of `to` the range stops the day before it.
export async function salesEntriesOf(ctx: Ctx, entity: string, range: { from: string; to: string } | { from: string; before: string }): Promise<SalesEntry[]> {
  let query = ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .select(['j.id', 'j.entry_date'])
    .select(sql<string>`SUM(l.credit - l.debit)::text`.as('amount'))
    .where('l.org_id', '=', ctx.orgId)
    .where('j.legal_entity_id', '=', entity)
    .where('j.entry_date', '>=', range.from)
    .where((eb) =>
      eb.or([
        eb('l.account_code', 'like', '511%'),
        eb('l.account_code', 'in', eb.selectFrom('crove_finance.org_account').select('code').where('org_id', '=', ctx.orgId).where('root_code', '=', '511')),
      ]),
    );
  query = 'to' in range ? query.where('j.entry_date', '<=', range.to) : query.where('j.entry_date', '<', range.before);
  const rows = await query.groupBy(['j.id', 'j.entry_date']).orderBy('j.entry_date').orderBy('j.id').execute();
  return rows.map((r) => ({ entryId: r.id, date: r.entry_date, amount: r.amount }));
}
