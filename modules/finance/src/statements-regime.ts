// SPDX-License-Identifier: AGPL-3.0-only
// The chart an entity's statements are read under (#5187): the entity's books on the period's last day (the newest legal_entity_books row that starts on or before it, TT133 2026.1 when there is none; the same rule the database
// applies to every posting). `mixedCharts` says that some part the statement shows was booked under another chart: the period itself, or a comparison column, starts or ends under a chart other than the period's last day's. A chart can
// change only on the first day of a fiscal year, so a month never straddles a change; a quarter, a year and the columns can. The statement is then read with the period-end map from the raw balances (B02 reads account prefixes),
// and the answer says so; it is a note, not a refusal.
import type { QueryContext } from '@ludy/kernel-runtime';
import { booksOnDate, type BooksRow } from './domain/expense-variance.ts';
import type { StatementsRegime } from './domain/tt99-reports.ts';

export interface StatementsBooks {
  regime: StatementsRegime;
  mixedCharts: boolean;
}

/** The regime of a statement and whether it mixes charts. `spans` are the periods the statement shows (its own and the comparison columns'), each as its first and last day. Pure. */
export function statementsBooksOf(rows: readonly BooksRow[], to: string, spans: ReadonlyArray<{ from: string; to: string }>): StatementsBooks {
  const here = booksOnDate(rows, to);
  const key = (date: string) => {
    const books = booksOnDate(rows, date);
    return `${books.regime}@${books.version}`;
  };
  const mixed = spans.some((span) => key(span.from) !== key(to) || key(span.to) !== key(to));
  return { regime: here.regime, mixedCharts: mixed };
}

// The entity's books rows (a few at most). Read here and not through expense-variance.ts, which reads the statements' balances: statements.ts imports this file.
async function booksOf(ctx: QueryContext, legalEntityId: string): Promise<BooksRow[]> {
  const rows = await ctx.trx
    .selectFrom('ludy_finance.legal_entity_books')
    .select(['regime', 'chart_version', 'effective_from'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .execute();
  return rows.map((r) => ({ regime: r.regime, chartVersion: r.chart_version, effectiveFrom: String(r.effective_from).slice(0, 10) }));
}

export async function statementsBooks(ctx: QueryContext, legalEntityId: string, to: string, spans: ReadonlyArray<{ from: string; to: string }>): Promise<StatementsBooks> {
  return statementsBooksOf(await booksOf(ctx, legalEntityId), to, spans);
}
