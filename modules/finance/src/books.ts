// SPDX-License-Identifier: AGPL-3.0-only
// The chart an entity keeps its books under on a date (issue #1403). The same rule the database applies to every journal
// line (ludy_finance.check_account_ref, 20261103020000 and 20270403010000), so the checks that come first in the app agree
// with the one that cannot be skipped.
import { sql } from 'kysely';
import type { QueryContext } from '@ludy/kernel-runtime';

// The entity and the date a posting's accounts are checked for: the books row in force on that date picks the chart.
export interface BooksScope {
  legalEntityId: string;
  date: string;
}

export interface BooksOn {
  regime: string;
  version: string;
}

// TT133 2026.1, the chart before the books rows existed and the one an entity without a row keeps.
export const TT133_BOOKS: BooksOn = { regime: 'tt133', version: '2026.1' };
export const isTt133Books = (books: BooksOn) => books.regime === TT133_BOOKS.regime && books.version === TT133_BOOKS.version;

// The chart an entity keeps its books under on a date: its books row in force (the newest that starts on or before the date), TT133 2026.1 when there is none (the only regime before the
// books rows existed).
export async function booksOn(ctx: Pick<QueryContext, 'trx' | 'orgId'>, legalEntityId: string, date: string): Promise<BooksOn> {
  const row = await ctx.trx
    .selectFrom('ludy_finance.legal_entity_books')
    .select(['regime', 'chart_version'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .where('effective_from', '<=', date)
    .orderBy('effective_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { regime: row.regime, version: row.chart_version } : TT133_BOOKS;
}

// Takes the entity's period_lock row FOR SHARE (ludy_finance.period_lock_share, 20270103030000) for the rest of the transaction. A books row is added
// under the same row FOR UPDATE (legal_entity_books_guard), so a switch of regime cannot commit between the moment a posting reads the books and the
// moment it commits: the switch waits for the posting, or the posting waits for the switch and then reads the new books. Every posting takes it first,
// with the entity already resolved, before the first read of the books. Commands only: a share lock is refused in a read-only transaction.
export async function lockBooks(ctx: Pick<QueryContext, 'trx'>, legalEntityId: string): Promise<void> {
  await sql`SELECT ludy_finance.period_lock_share(${legalEntityId}::uuid)`.execute(ctx.trx);
}

// The calendar day after a local date (yyyy-mm-dd), by the calendar and not the clock.
export function dayAfter(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// The name of a regime in a message to a person.
export function regimeLabel(regime: string): string {
  return regime === 'tt99' ? 'Thông tư 99' : regime === 'tt133' ? 'Thông tư 133' : regime;
}
