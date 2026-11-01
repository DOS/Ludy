// SPDX-License-Identifier: AGPL-3.0-only
// Saved views of the deals (CRM plan 4.3, step K3, #2227): what each field of the `crm.deal` scope means over the deal
// table, and how a view's sort and cursor read. The registry in @crove/kernel-contract says which fields, operators and
// values a view may hold; the kernel builds the SQL from helpers; this file maps each field to the deal's columns (alias
// d), its stage (alias s) and its party (alias p), as crm.deal.list joins them. A view only narrows the query the caller
// already runs under row-level security.
import { sql, type Expression, type SqlBool } from 'kysely';
import type { SavedViewSort } from '@crove/kernel-contract';
import {
  amountCompare,
  dateCompare,
  idIn,
  idIs,
  memberIs,
  textContains,
  valueIs,
  withinLastDays,
  type FieldCondition,
} from '@crove/kernel';
import { DomainError, type QueryContext } from '@crove/kernel-runtime';

// The list a view of no sort opens on: the newest first, as the list has always been.
export const DEAL_DEFAULT_SORT: SavedViewSort = { field: 'created', dir: 'desc' };

// A deal's own stage is open while it is neither Won nor Lost: "overdue" and "due within N days" mean open deals only.
const OPEN = sql<boolean>`s.kind = 'open'`;

// The condition of each field of the `crm.deal` scope. Search matches the deal's title and its contact's name, so a deal
// is found by the person or company it is with as well as by what it is called.
export function dealFields(): Record<string, FieldCondition> {
  return {
    search: textContains([sql`d.title`, sql`p.name`]),
    stage: idIn(sql`d.stage_id`),
    status: valueIs(sql`s.kind`),
    owner: memberIs(sql`d.owner_user_id`),
    party: idIs(sql`d.party_id`),
    amount: amountCompare(sql`d.amount`),
    expected_close: dateCompare(sql`d.expected_close`, OPEN),
    created: withinLastDays(sql`d.created_at`),
  };
}

interface SortColumn {
  column: Expression<unknown>;
  // How the last row's value is read back as text and compared again.
  type: 'text' | 'timestamptz' | 'numeric' | 'date';
  nullable: boolean;
}

export const DEAL_SORT: Record<string, SortColumn> = {
  created: { column: sql`d.created_at`, type: 'timestamptz', nullable: false },
  name: { column: sql`d.title`, type: 'text', nullable: false },
  amount: { column: sql`d.amount`, type: 'numeric', nullable: false },
  expected_close: { column: sql`d.expected_close`, type: 'date', nullable: true },
  updated: { column: sql`d.updated_at`, type: 'timestamptz', nullable: false },
};

export const dealSortColumns = (): Record<string, Expression<unknown>> => Object.fromEntries(Object.entries(DEAL_SORT).map(([field, c]) => [field, c.column]));

// Where the page after deal `afterId` starts, for the sort in use: past that deal's value, or equal to it with a later id,
// and, when the sort field may be empty (the expected close date, empty last), the deals with none. The value is read from
// that deal here, in this org and as this member reads it, so the client sends an id and nothing else; a deal that is gone
// is a stale cursor.
export async function dealsAfter(ctx: Pick<QueryContext, 'trx' | 'orgId'>, sort: SavedViewSort, afterId: string): Promise<Expression<SqlBool>> {
  const by = DEAL_SORT[sort.field];
  if (!by) throw new Error(`deal list: no column for sort field ${sort.field}`);
  const found = await sql<{ v: string | null }>`SELECT (${by.column})::text AS v FROM crove_crm.deal d WHERE d.org_id = ${ctx.orgId}::uuid AND d.id = ${afterId}::uuid`.execute(ctx.trx);
  const row = found.rows[0];
  if (!row) throw new DomainError('VALIDATION', 422, 'Con trỏ trang không còn hợp lệ', { issues: [{ path: 'after', code: 'bad_cursor' }] });
  // Empty values sort last, so after a deal with none come only the later deals with none.
  if (row.v === null) return sql<boolean>`(${by.column} IS NULL AND d.id > ${afterId}::uuid)`;
  const value = sql`${row.v}::${sql.raw(by.type)}`;
  const past = sort.dir === 'asc' ? sql`${by.column} > ${value}` : sql`${by.column} < ${value}`;
  const empty = by.nullable ? sql` OR ${by.column} IS NULL` : sql``;
  return sql<boolean>`(${past} OR (${by.column} = ${value} AND d.id > ${afterId}::uuid)${empty})`;
}
