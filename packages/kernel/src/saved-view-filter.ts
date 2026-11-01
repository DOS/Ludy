// SPDX-License-Identifier: AGPL-3.0-only
// The Filter AST of a saved view turned into a SQL condition (CRM plan 4.3, step K3, #2227). The AST says what to match;
// this file says how, once per kind of condition, and the module that owns a list (crm for the deals) says which column
// or expression each field of its scope means. So the kernel never names a table of a module, a stored view is checked
// against the registry in @crove/kernel-contract before anything runs (an unknown field or operator is a 422), and every
// value reaches the database as a bound parameter, never as SQL text.
//
// A view only narrows: the condition is ANDed into the query the caller already runs under row-level security, so it
// can never show a row the member could not read without it.
import { sql, type Expression, type SqlBool } from 'kysely';
import {
  SAVED_VIEW_SCOPES,
  filterIssues,
  isSavedViewScope,
  normalizeFilter,
  sortIssues,
  type FilterAst,
  type SavedViewSort,
} from '@crove/kernel-contract';
import { DomainError } from '@crove/kernel-runtime';

// What a condition may need beyond its own value: who is asking ("is me"), today in Vietnam ("overdue", "within the next
// N days") and the clock ("within the last N days"). The caller passes ctx.now and vietnamToday(ctx.now), so one run
// reads one clock.
export interface FilterContext {
  me: string | null;
  today: string;
  now: Date;
}

// One field of a scope: the condition for an operator and its value (already checked and normalized).
export type FieldCondition = (op: string, value: unknown, ctx: FilterContext) => Expression<SqlBool>;

const DAY_MS = 86_400_000;
const never = sql<boolean>`false`;

// Turns the AST of a view of `scope` into one condition: every field of the AST needs an entry in `fields`. The view's
// conditions are ANDed; no condition matches every row. Throws a 422 when the AST names something the registry does not
// know, so a stored view that went stale is refused rather than guessed at.
export function filterCondition(scope: string, ast: FilterAst, fields: Readonly<Record<string, FieldCondition>>, ctx: FilterContext): Expression<SqlBool> {
  if (!isSavedViewScope(scope)) throw new DomainError('VALIDATION', 422, 'Chế độ xem không hợp lệ', { issues: [{ path: 'scope', code: 'unknown_scope' }] });
  const issues = filterIssues(scope, ast);
  if (issues.length > 0) throw new DomainError('VALIDATION', 422, 'Bộ lọc không hợp lệ', { issues });
  const parts = normalizeFilter(scope, ast).all.map((c) => {
    const field = Object.hasOwn(fields, c.field) ? fields[c.field] : undefined;
    if (!field) throw new Error(`saved view filter: scope ${scope} has no condition for field ${c.field}`);
    return sql<boolean>`(${field(c.op, c.value, ctx)})`;
  });
  return parts.length === 0 ? sql<boolean>`true` : sql<boolean>`(${sql.join(parts, sql` AND `)})`;
}

// The ORDER BY terms of a view's sort: the sort field's expression and direction (rows without a value last), then the
// id, so paging is stable. `sortable` maps each sort field of the scope to its expression. No sort: the scope's default.
export function sortTerms(
  scope: string,
  sort: SavedViewSort | null | undefined,
  sortable: Readonly<Record<string, Expression<unknown>>>,
  id: Expression<unknown>,
  fallback: SavedViewSort,
): Expression<unknown>[] {
  const issues = sortIssues(scope, sort);
  if (issues.length > 0) throw new DomainError('VALIDATION', 422, 'Cách sắp xếp không hợp lệ', { issues });
  const by = sort ?? fallback;
  const expr = Object.hasOwn(sortable, by.field) ? sortable[by.field] : undefined;
  if (!expr) throw new Error(`saved view sort: scope ${scope} has no expression for field ${by.field}`);
  return [sql`${expr} ${sql.raw(by.dir === 'desc' ? 'DESC' : 'ASC')} NULLS LAST`, sql`${id} ASC`];
}

// The fields a scope sorts by, for a caller that checks it maps every one.
export const sortableFields = (scope: keyof typeof SAVED_VIEW_SCOPES): readonly string[] => SAVED_VIEW_SCOPES[scope].sortable;

// ---- Conditions, one per kind of field. Each takes the expression the field means in the caller's query. ----

// LIKE wildcards in a search are matched as themselves.
const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Contains, ignoring case, Vietnamese marks, đ and punctuation (crove_kernel.search_fold, #673): "nguyen" finds "Nguyễn".
// A term with nothing left once folded (emoji, another script) matches the raw texts as typed, case aside. A folded term
// holds only a-z, 0-9 and single spaces, so it has no LIKE wildcard. Any of `texts` may match.
export function textContains(texts: ReadonlyArray<Expression<unknown>>): FieldCondition {
  return (_op, value) => {
    const search = String(value);
    const folded = sql.join(
      texts.map((t) => sql`crove_kernel.search_fold(${t}) LIKE '%' || crove_kernel.search_fold(${search}) || '%'`),
      sql` OR `,
    );
    const raw = sql.join(
      texts.map((t) => sql`${t} ILIKE ${likeTerm(search)}`),
      sql` OR `,
    );
    return sql<boolean>`(CASE WHEN crove_kernel.search_fold(${search}) = '' THEN (${raw}) ELSE (${folded}) END)`;
  };
}

// Is one of a list of ids (a stage), or is this id (a contact).
export const idIn = (column: Expression<unknown>): FieldCondition => (_op, value) => sql<boolean>`${column} = ANY (${value as string[]}::uuid[])`;
export const idIs = (column: Expression<unknown>): FieldCondition => (_op, value) => sql<boolean>`${column} = ${value as string}::uuid`;

// Is this value (a deal's status, a contact's kind), the value being one of the registry's fixed names.
export const valueIs = (column: Expression<unknown>): FieldCondition => (_op, value) => sql<boolean>`${column} = ${value as string}`;

// A member field: is that member, is the asker ("is me"; nobody when the asker is not a member), or has none.
export function memberIs(column: Expression<unknown>): FieldCondition {
  return (op, value, ctx) => {
    if (op === 'is') return sql<boolean>`${column} = ${value as string}::uuid`;
    if (op === 'is_me') return ctx.me === null ? never : sql<boolean>`${column} = ${ctx.me}::uuid`;
    return sql<boolean>`${column} IS NULL`;
  };
}

// An amount, a decimal string compared as numeric in SQL: at least (gte) or at most (lte). No JS number touches it.
export function amountCompare(column: Expression<unknown>): FieldCondition {
  return (op, value) => (op === 'gte' ? sql<boolean>`${column} >= ${value as string}::numeric` : sql<boolean>`${column} <= ${value as string}::numeric`);
}

// A calendar date that may be empty (an expected close date): strictly before or after a date, empty, and, on the rows
// `open` selects (deals not yet closed), overdue (before today in Vietnam) or due within the next N days (today to
// today + N, both days included). Closed deals are never overdue.
export function dateCompare(column: Expression<unknown>, open: Expression<SqlBool>): FieldCondition {
  return (op, value, ctx) => {
    switch (op) {
      case 'before':
        return sql<boolean>`${column} < ${value as string}::date`;
      case 'after':
        return sql<boolean>`${column} > ${value as string}::date`;
      case 'is_empty':
        return sql<boolean>`${column} IS NULL`;
      case 'overdue':
        return sql<boolean>`(${open} AND ${column} < ${ctx.today}::date)`;
      default:
        return sql<boolean>`(${open} AND ${column} BETWEEN ${ctx.today}::date AND ${ctx.today}::date + ${value as number}::integer)`;
    }
  };
}

// Created (or changed) within the last N days: the timestamp is at or after the clock minus N days.
export function withinLastDays(column: Expression<unknown>): FieldCondition {
  return (_op, value, ctx) => sql<boolean>`${column} >= ${new Date(ctx.now.getTime() - (value as number) * DAY_MS).toISOString()}::timestamptz`;
}

// A yes or no on a fact: `fact` is true for the rows that have it (an email, an open deal).
export const flagIs = (fact: Expression<SqlBool>): FieldCondition => (_op, value) => (value === true ? sql<boolean>`COALESCE(${fact}, false)` : sql<boolean>`NOT COALESCE(${fact}, false)`);

// A text column that holds something: not null and not blank.
export const hasText = (column: Expression<unknown>): Expression<SqlBool> => sql<boolean>`(${column} IS NOT NULL AND btrim(${column}) <> '')`;
