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
import { DomainError } from '@crove/kernel-runtime';

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
  // The column's value as text in a fixed form (UTC and microseconds for a time, ISO for a date), which is what a cursor
  // carries and what `value::<type>` reads back exactly, whatever the session's settings.
  text: Expression<unknown>;
  type: 'text' | 'timestamptz' | 'numeric' | 'date';
  nullable: boolean;
}

const TIME_TEXT = (column: string) => sql`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const DEAL_SORT: Record<string, SortColumn> = {
  created: { column: sql`d.created_at`, text: TIME_TEXT('d.created_at'), type: 'timestamptz', nullable: false },
  name: { column: sql`d.title`, text: sql`d.title`, type: 'text', nullable: false },
  amount: { column: sql`d.amount`, text: sql`d.amount::text`, type: 'numeric', nullable: false },
  expected_close: { column: sql`d.expected_close`, text: sql`to_char(d.expected_close, 'YYYY-MM-DD')`, type: 'date', nullable: true },
  updated: { column: sql`d.updated_at`, text: TIME_TEXT('d.updated_at'), type: 'timestamptz', nullable: false },
};

export const dealSortColumns = (): Record<string, Expression<unknown>> => Object.fromEntries(Object.entries(DEAL_SORT).map(([field, c]) => [field, c.column]));

// The sort field's text for the row a page ends on, to go into the cursor.
export function dealSortText(sort: SavedViewSort): Expression<string | null> {
  const by = Object.hasOwn(DEAL_SORT, sort.field) ? DEAL_SORT[sort.field] : undefined;
  if (!by) throw new Error(`deal list: no column for sort field ${sort.field}`);
  return by.text as Expression<string | null>;
}

// A cursor value as the server wrote it, and nothing else: a made-up value is a 422 here and never reaches a cast.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const validDay = (v: string): boolean => {
  if (!DAY.test(v)) return false;
  const at = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === v;
};
const VALID_VALUE: Record<SortColumn['type'], (v: string) => boolean> = {
  text: () => true,
  numeric: (v) => /^\d{1,18}(\.\d{1,2})?$/.test(v),
  date: validDay,
  timestamptz: (v) => {
    if (!TIME.test(v) || !validDay(v.slice(0, 10))) return false;
    const at = new Date(`${v.slice(0, 23)}Z`);
    return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 23) === v.slice(0, 23);
  },
};

const badCursor = () => new DomainError('VALIDATION', 422, 'Con trỏ trang không hợp lệ', { issues: [{ path: 'after', code: 'bad_cursor' }] });

// Where the page after `after` starts, for the sort in use: past the last deal's value, or equal to it with a later id,
// and, when the sort field may be empty (the expected close date, empty last), the deals with none. The value is the one
// the previous page ended on, so a deal edited or deleted since cannot make a page repeat or skip rows.
export function dealsAfter(sort: SavedViewSort, after: { id: string; value: string | null }): Expression<SqlBool> {
  const by = Object.hasOwn(DEAL_SORT, sort.field) ? DEAL_SORT[sort.field] : undefined;
  if (!by) throw new Error(`deal list: no column for sort field ${sort.field}`);
  // Empty values sort last, so after a deal with none come only the later deals with none.
  if (after.value === null) {
    if (!by.nullable) throw badCursor();
    return sql<boolean>`(${by.column} IS NULL AND d.id > ${after.id}::uuid)`;
  }
  if (!VALID_VALUE[by.type](after.value)) throw badCursor();
  const value = sql`${after.value}::${sql.raw(by.type)}`;
  const past = sort.dir === 'asc' ? sql`${by.column} > ${value}` : sql`${by.column} < ${value}`;
  const empty = by.nullable ? sql` OR ${by.column} IS NULL` : sql``;
  return sql<boolean>`(${past} OR (${by.column} = ${value} AND d.id > ${after.id}::uuid)${empty})`;
}
