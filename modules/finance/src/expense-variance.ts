// SPDX-License-Identifier: AGPL-3.0-only
// finance.expense_variance (#4392): the expense lines of one legal entity that moved most in an ended month, against the month before and against the average of the three months before it, with the
// suppliers or vouchers behind each. Read only, in the member's own transaction: the entity is the caller's own (resolveLegalEntity), every journal read filters org and entity and the tables' le_scope policy
// applies, so another entity's postings are never summed. The rules (which accounts, the line level per regime, the thresholds, the flags) are pure functions in domain/expense-variance.ts.
// Two statements: ONE for the four months' net amounts per account (the overview's balances() shape, so every column sees the same entries in a READ COMMITTED transaction), and ONE, only when a line is
// flagged, for the top suppliers or vouchers of the flagged lines, ranked and limited in the database (at most EXPENSE_VARIANCE_CONTRIBUTORS per line, at most EXPENSE_VARIANCE_MAX_LINES lines).
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  EXPENSE_VARIANCE_CONTRIBUTORS,
  EXPENSE_VARIANCE_MIN_AMOUNT,
  EXPENSE_VARIANCE_MIN_PERCENT,
  zFinanceExpenseVarianceInput,
  type ExpenseVarianceContributor,
  type ExpenseVarianceLine,
  type FinanceExpenseVariance,
} from '@ludy/kernel-contract';
import { Decimal, type DecimalValue } from '@ludy/l10n-vn';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { CLOSING_ACCOUNT } from './domain/tt133-reports.ts';
import { averageOf, basisMonths, buildExpenseVariance, monthBounds, sourceKindOf, type BooksRow, type MonthAmounts, type VarianceLine } from './domain/expense-variance.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';
import { balances } from './statements.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// Class 6 and the class 8 expense accounts (domain isExpenseAccount), as a database pattern.
const EXPENSE_PATTERN = '^(6[0-9]|811|821)';

export const monthNotEnded = () => new DomainError('MONTH_NOT_ENDED', 422, 'Tháng này chưa kết thúc; hãy chọn một tháng đã qua để so sánh chi phí');

async function booksRows(ctx: QueryContext, entity: string): Promise<BooksRow[]> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.legal_entity_books')
    .select(['regime', 'chart_version', 'effective_from'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .execute();
  return rows.map((r) => ({ regime: r.regime, chartVersion: r.chart_version, effectiveFrom: String(r.effective_from).slice(0, 10) }));
}

// The net amount (debit minus credit) of every expense account in each of the months, in ONE statement.
async function monthlyAmounts(ctx: QueryContext, entity: string, months: readonly string[]): Promise<MonthAmounts[]> {
  const parts = months.map((month) => {
    const { from, to } = monthBounds(month);
    return balances(ctx, entity, from, to, true)
      .where(sql<boolean>`l.account_code ~ ${EXPENSE_PATTERN}`)
      .select(sql.lit(month).as('part'));
  });
  const [first, ...rest] = parts;
  if (!first) throw new Error('the variance reads no month');
  let query = first;
  for (const part of rest) query = query.unionAll(part);
  const rows = await query.orderBy('part').orderBy('account_code').execute();
  const byMonth = new Map<string, Map<string, DecimalValue>>(months.map((m) => [m, new Map()]));
  for (const row of rows) {
    const sums = byMonth.get(row.part as string);
    if (!sums) continue;
    sums.set(row.account_code, (sums.get(row.account_code) ?? new Decimal(0)).plus(row.debit ?? '0').minus(row.credit ?? '0'));
  }
  return months.map((month) => ({ month, rows: [...(byMonth.get(month) ?? new Map<string, DecimalValue>())].map(([accountCode, net]) => ({ accountCode, net: net.toFixed() })) }));
}

interface ContributorRow {
  line_code: string;
  party_id: string | null;
  entry_id: string | null;
  entry_date: string | null;
  source_type: string | null;
  description: string | null;
  m_net: string | null;
  p_net: string | null;
  a_sum: string | null;
  vouchers: string | number;
  // Every voucher of the line in the month, whatever the contributors shown.
  line_vouchers: string | number;
}

// The suppliers (by party) or vouchers (no party) behind the flagged lines: per line the top ones by their own change in the line's direction, measured against the basis that flagged the line.
// Ranked and limited in SQL (row_number per line), so the answer is bounded whatever the month holds.
async function contributorRows(ctx: QueryContext, entity: string, month: string, lines: readonly VarianceLine[], regime: 'tt133' | 'tt99'): Promise<ContributorRow[]> {
  if (lines.length === 0) return [];
  const { previous, average } = basisMonths(month);
  const mFrom = monthBounds(month).from;
  const mTo = monthBounds(month).to;
  const pFrom = monthBounds(previous).from;
  const windowFrom = monthBounds(average[0] ?? previous).from;
  const picked = sql.join(lines.map((l) => sql`(${l.code}::text, ${l.against}::text, ${l.direction === 'up' ? 1 : -1}::int)`));
  const { rows } = await sql<ContributorRow>`
    WITH picked (line_code, against, dir) AS (VALUES ${picked}),
    src AS (
      SELECT
        CASE WHEN ${regime}::text = 'tt133' AND l.account_code ~ '^64[0-9][0-9]' THEN pg_catalog.left(l.account_code, 4) ELSE pg_catalog.left(l.account_code, 3) END AS line_code,
        l.party_id, j.id AS entry_id, j.entry_date, j.source_type, j.description, (l.debit - l.credit) AS net
      FROM crove_finance.journal_line l
      JOIN crove_finance.journal_entry j ON j.org_id = l.org_id AND j.id = l.entry_id
      WHERE l.org_id = ${ctx.orgId} AND l.legal_entity_id = ${entity}
        AND j.entry_date >= ${windowFrom}::date AND j.entry_date <= ${mTo}::date
        AND l.account_code ~ ${EXPENSE_PATTERN}
        AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_line c WHERE c.org_id = j.org_id AND c.entry_id = j.id AND c.account_code LIKE ${`${CLOSING_ACCOUNT}%`})
    ),
    agg AS (
      SELECT s.line_code, s.party_id, CASE WHEN s.party_id IS NULL THEN s.entry_id END AS entry_id,
        pg_catalog.min(s.entry_date) AS entry_date,
        (pg_catalog.array_agg(s.source_type ORDER BY pg_catalog.abs(s.net) DESC))[1] AS source_type,
        (pg_catalog.array_agg(s.description ORDER BY pg_catalog.abs(s.net) DESC))[1] AS description,
        pg_catalog.sum(s.net) FILTER (WHERE s.entry_date >= ${mFrom}::date) AS m_net,
        pg_catalog.sum(s.net) FILTER (WHERE s.entry_date >= ${pFrom}::date AND s.entry_date < ${mFrom}::date) AS p_net,
        pg_catalog.sum(s.net) FILTER (WHERE s.entry_date < ${mFrom}::date) AS a_sum,
        pg_catalog.count(DISTINCT s.entry_id) FILTER (WHERE s.entry_date >= ${mFrom}::date) AS vouchers
      FROM src s
      WHERE s.line_code IN (SELECT line_code FROM picked)
      GROUP BY s.line_code, s.party_id, CASE WHEN s.party_id IS NULL THEN s.entry_id END
    ),
    ranked AS (
      SELECT a.*,
        (CASE WHEN p.against = 'previous' THEN COALESCE(a.m_net, 0) - COALESCE(a.p_net, 0)
              ELSE COALESCE(a.m_net, 0) - COALESCE(a.a_sum, 0) / 3 END) * p.dir AS moved
      FROM agg a JOIN picked p ON p.line_code = a.line_code
    ),
    top AS (
      SELECT r.*, pg_catalog.row_number() OVER (PARTITION BY r.line_code ORDER BY r.moved DESC, r.party_id, r.entry_id) AS rk
      FROM ranked r WHERE r.moved > 0
    ),
    totals AS (
      SELECT s.line_code, pg_catalog.count(DISTINCT s.entry_id) FILTER (WHERE s.entry_date >= ${mFrom}::date) AS line_vouchers
      FROM src s WHERE s.line_code IN (SELECT line_code FROM picked) GROUP BY s.line_code
    )
    SELECT p.line_code, t.party_id, t.entry_id, pg_catalog.to_char(t.entry_date, 'YYYY-MM-DD') AS entry_date, t.source_type, t.description, t.m_net, t.p_net, t.a_sum, t.vouchers,
      COALESCE(tt.line_vouchers, 0) AS line_vouchers
    FROM picked p
    LEFT JOIN top t ON t.line_code = p.line_code AND t.rk <= ${EXPENSE_VARIANCE_CONTRIBUTORS}
    LEFT JOIN totals tt ON tt.line_code = p.line_code
    ORDER BY p.line_code, t.rk`.execute(ctx.trx);
  return rows;
}

async function accountNames(ctx: QueryContext, regime: string, version: string, codes: readonly string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows =
    regime === 'tt99'
      ? await ctx.trx.selectFrom('crove_finance.chart_account').select(['code', 'name']).where('regime', '=', 'tt99').where('version', '=', version).where('code', 'in', [...codes]).execute()
      : await ctx.trx.selectFrom('crove_finance.account').select(['code', 'name']).where('code', 'in', [...codes]).execute();
  return new Map(rows.map((r) => [r.code, r.name]));
}

const text = (value: DecimalValue): string => (value.isZero() ? '0' : value.toFixed());

export async function financeExpenseVariance(ctx: QueryContext, input: { month: string; legalEntityId?: string | undefined }): Promise<FinanceExpenseVariance> {
  const entity = await resolveLegalEntity(ctx, input.legalEntityId);
  const today = await databaseToday(ctx.trx);
  // A month in progress against whole months would flag false drops: only an ended month is compared.
  if (input.month >= today.slice(0, 7)) throw monthNotEnded();
  const basis = basisMonths(input.month);
  const months = [...basis.average, input.month];
  const books = await booksRows(ctx, entity);
  const amounts = await monthlyAmounts(ctx, entity, months);
  const result = buildExpenseVariance(input.month, amounts, books);
  const window = { from: monthBounds(basis.average[0] ?? basis.previous).from, to: monthBounds(input.month).to };
  const any = await ctx.trx
    .selectFrom('crove_finance.journal_entry')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .where('entry_date', '>=', window.from)
    .where('entry_date', '<=', window.to)
    .limit(1)
    .executeTakeFirst();

  const contributorsFound = await contributorRows(ctx, entity, input.month, result.lines, result.regime);
  const partyIds = [...new Set(contributorsFound.flatMap((r) => (r.party_id ? [r.party_id] : [])))];
  const parties = new Map<string, { name: string; kind: string }>();
  if (partyIds.length > 0) {
    for (const p of await ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name', 'kind']).where('org_id', '=', ctx.orgId).where('id', 'in', partyIds).execute()) parties.set(p.id, { name: p.name, kind: p.kind });
  }
  const names = await accountNames(ctx, result.regime, result.chartVersion, result.lines.map((l) => l.code));

  const contributorsOf = (line: VarianceLine): ExpenseVarianceContributor[] =>
    contributorsFound
      .filter((r) => r.line_code === line.code && (r.party_id !== null || r.entry_id !== null))
      .map((r): ExpenseVarianceContributor => {
        const amount = new Decimal(r.m_net ?? '0');
        // The basis that flagged the line: the month before, or the average of the three months (rounded half up to whole dong, like the line's own).
        const basisAmount = line.against === 'previous' ? new Decimal(r.p_net ?? '0') : averageOf([new Decimal(r.a_sum ?? '0').dividedBy(3)]);
        const party = r.party_id ? parties.get(r.party_id) : undefined;
        return {
          kind: r.party_id ? 'supplier' : 'voucher',
          partyId: r.party_id,
          name: party?.name ?? null,
          partyKind: party?.kind ?? null,
          entryId: r.entry_id,
          entryDate: r.party_id ? null : r.entry_date,
          description: r.party_id ? null : r.description,
          sourceKind: sourceKindOf(r.source_type ?? ''),
          vouchers: Number(r.vouchers),
          amount: text(amount),
          basis: text(basisAmount),
          change: text(amount.minus(basisAmount)),
        };
      });
  const lines: ExpenseVarianceLine[] = result.lines.map((line) => ({
    ...line,
    name: names.get(line.code) ?? null,
    vouchers: Number(contributorsFound.find((r) => r.line_code === line.code)?.line_vouchers ?? 0),
    contributors: contributorsOf(line),
  }));
  return {
    month: input.month,
    legalEntityId: entity,
    regime: result.regime,
    chartVersion: result.chartVersion,
    thresholds: { amount: EXPENSE_VARIANCE_MIN_AMOUNT, percent: EXPENSE_VARIANCE_MIN_PERCENT },
    previousMonth: basis.previous,
    averageMonths: basis.average,
    missing: result.missing,
    empty: any === undefined,
    lines,
    moreFlagged: result.moreFlagged,
  };
}

export const financeExpenseVarianceQuery = defineQuery({
  name: 'finance.expense_variance',
  input: zFinanceExpenseVarianceInput,
  access: ALL,
  handler: (ctx, input): Promise<FinanceExpenseVariance> => financeExpenseVariance(ctx, input),
});
