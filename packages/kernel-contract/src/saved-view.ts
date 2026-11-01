// SPDX-License-Identifier: AGPL-3.0-only
// Saved views of a list (CRM plan 4.3, step K3, #2227): a member names the filter and the sort of a list (the deals, later
// the contacts) and opens them again in one click. A view stores a small Filter AST, never SQL: `{ v: 1, all: [{ field,
// op, value }] }`, at most 8 conditions, all ANDed. The scope registry below says, per scope, which fields exist, which
// operators each takes and what value each operator carries, so the app and the server cannot disagree, and a stored
// view cannot name a field the server does not know. The server turns an AST into a `where` (saved-view-filter.ts in
// @crove/kernel), so a view only ever narrows what row-level security already lets the member read.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

export const FILTER_AST_VERSION = 1;
export const FILTER_MAX_CONDITIONS = 8;
export const SAVED_VIEW_NAME_MAX = 60;
// The views one member keeps per scope, counted by kernel.saved_view.save under a lock.
export const SAVED_VIEW_LIMIT = 30;
// A stored filter is a JSON object of at most this many characters (the table checks its stored size again).
export const SAVED_VIEW_FILTERS_MAX_CHARS = 3072;
// A scope is `<module>.<list>`.
export const SAVED_VIEW_SCOPE_PATTERN = /^[a-z]+\.[a-z_]+$/;

// What an operator's value looks like: none (the operator is the whole condition), or a schema.
const none = null;
const text = z.string().trim().min(1).max(100);
const ids = z.array(zId).min(1).max(20);
const days = z.number().int().min(1).max(3650);
// A decimal string, never a JS number: at most 16 integer digits and 2 decimals, as numeric(20,2).
const amount = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'decimal string');
const yesNo = z.boolean();

interface FieldSpec {
  /** The label of the field in Vietnamese, for the filter bar. */
  label: string;
  /** Operator name to its value schema (null: no value). */
  ops: Readonly<Record<string, z.ZodType | null>>;
}

// Deals (crm plan 4.3): the sixth field is the date a deal is expected to close, which "overdue" and "within next N days"
// read on open deals only.
const DEAL_FIELDS = {
  search: { label: 'Tìm kiếm', ops: { contains: text } },
  stage: { label: 'Giai đoạn', ops: { in: ids } },
  status: { label: 'Trạng thái', ops: { is: z.enum(['open', 'won', 'lost']) } },
  owner: { label: 'Người phụ trách', ops: { is: zId, is_me: none, is_empty: none } },
  party: { label: 'Liên hệ', ops: { is: zId } },
  amount: { label: 'Giá trị', ops: { gte: amount, lte: amount } },
  expected_close: { label: 'Dự kiến chốt', ops: { before: zLocalDate, after: zLocalDate, overdue: none, within_next_days: days, is_empty: none } },
  created: { label: 'Ngày tạo', ops: { within_last_days: days } },
} as const satisfies Record<string, FieldSpec>;

const PARTY_FIELDS = {
  search: { label: 'Tìm kiếm', ops: { contains: text } },
  kind: { label: 'Loại', ops: { is: z.enum(['organization', 'person']) } },
  has_email: { label: 'Có email', ops: { is: yesNo } },
  has_phone: { label: 'Có số điện thoại', ops: { is: yesNo } },
  has_tax_code: { label: 'Có mã số thuế', ops: { is: yesNo } },
  has_open_deal: { label: 'Có cơ hội đang mở', ops: { is: yesNo } },
  created: { label: 'Ngày tạo', ops: { within_last_days: days } },
} as const satisfies Record<string, FieldSpec>;

interface ScopeSpec {
  fields: Readonly<Record<string, FieldSpec>>;
  /** The fields a view may sort by. */
  sortable: readonly string[];
}

export const SAVED_VIEW_SCOPES = {
  'crm.deal': { fields: DEAL_FIELDS, sortable: ['created', 'name', 'amount', 'expected_close', 'updated'] },
  'crm.party': { fields: PARTY_FIELDS, sortable: ['created', 'name', 'updated'] },
} as const satisfies Record<string, ScopeSpec>;

export type SavedViewScope = keyof typeof SAVED_VIEW_SCOPES;
export const SAVED_VIEW_SCOPE_NAMES = Object.keys(SAVED_VIEW_SCOPES) as SavedViewScope[];
export const isSavedViewScope = (scope: string): scope is SavedViewScope => Object.hasOwn(SAVED_VIEW_SCOPES, scope);

// The shape alone: any field and operator as text. The HTTP contract uses it, so a stored view that names a field the
// server no longer knows still reads back; the commands check the registry (zFilterAst for a scope).
export const zFilterConditionShape = z.strictObject({
  field: z.string().min(1).max(40),
  op: z.string().min(1).max(40),
  value: z.unknown().optional(),
});
export const zFilterAstShape = z.strictObject({
  v: z.literal(FILTER_AST_VERSION),
  all: z.array(zFilterConditionShape).max(FILTER_MAX_CONDITIONS),
});
export interface FilterCondition {
  field: string;
  op: string;
  value?: unknown;
}
export interface FilterAst {
  v: typeof FILTER_AST_VERSION;
  all: FilterCondition[];
}

export const zSavedViewSortShape = z.strictObject({ field: z.string().min(1).max(40), dir: z.enum(['asc', 'desc']) });
export interface SavedViewSort {
  field: string;
  dir: 'asc' | 'desc';
}

// A problem with a view's filter or sort: where, and a fixed code a person can be told about.
export interface FilterIssue {
  path: string;
  code: 'unknown_scope' | 'unknown_field' | 'unknown_op' | 'bad_value' | 'unexpected_value' | 'duplicate' | 'unknown_sort_field';
}

// The registry check: every condition names a field of the scope and an operator of that field, carries the value the
// operator takes (and none when it takes none), and a (field, operator) pair appears once. Returns the problems found.
export function filterIssues(scope: string, ast: FilterAst): FilterIssue[] {
  if (!isSavedViewScope(scope)) return [{ path: 'scope', code: 'unknown_scope' }];
  const fields: Readonly<Record<string, FieldSpec>> = SAVED_VIEW_SCOPES[scope].fields;
  const issues: FilterIssue[] = [];
  const seen = new Set<string>();
  ast.all.forEach((condition, i) => {
    const path = `filters.all.${i}`;
    const field = Object.hasOwn(fields, condition.field) ? fields[condition.field] : undefined;
    if (!field) {
      issues.push({ path: `${path}.field`, code: 'unknown_field' });
      return;
    }
    const schema = Object.hasOwn(field.ops, condition.op) ? field.ops[condition.op] : undefined;
    if (schema === undefined) {
      issues.push({ path: `${path}.op`, code: 'unknown_op' });
      return;
    }
    if (schema === null) {
      if (condition.value !== undefined) issues.push({ path: `${path}.value`, code: 'unexpected_value' });
    } else if (!schema.safeParse(condition.value).success) {
      issues.push({ path: `${path}.value`, code: 'bad_value' });
    }
    const key = `${condition.field}:${condition.op}`;
    if (seen.has(key)) issues.push({ path, code: 'duplicate' });
    seen.add(key);
  });
  return issues;
}

export function sortIssues(scope: string, sort: SavedViewSort | null | undefined): FilterIssue[] {
  if (sort === null || sort === undefined) return [];
  if (!isSavedViewScope(scope)) return [{ path: 'scope', code: 'unknown_scope' }];
  const sortable: readonly string[] = SAVED_VIEW_SCOPES[scope].sortable;
  return sortable.includes(sort.field) ? [] : [{ path: 'sort.field', code: 'unknown_sort_field' }];
}

// The AST as stored: values trimmed as their schema trims them, nothing but the fields set.
export function normalizeFilter(scope: SavedViewScope, ast: FilterAst): FilterAst {
  const fields: Readonly<Record<string, FieldSpec>> = SAVED_VIEW_SCOPES[scope].fields;
  return {
    v: FILTER_AST_VERSION,
    all: ast.all.map((c) => {
      const schema = fields[c.field]?.ops[c.op];
      const value = schema ? schema.parse(c.value) : undefined;
      return value === undefined ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value };
    }),
  };
}

// The name of a view: NFC, so a name typed with combining marks matches the same name typed precomposed.
export const zSavedViewName = z
  .string()
  .transform((s) => s.normalize('NFC').trim())
  .pipe(z.string().min(1).max(SAVED_VIEW_NAME_MAX));

const zScope = z.string().regex(SAVED_VIEW_SCOPE_PATTERN).max(40);

// Create a view, or replace the filter and sort of one (viewId); the name and sharing change through rename and
// set_shared.
export const zSavedViewSaveShape = z.union([
  z.strictObject({
    scope: zScope,
    name: z.string().max(200),
    filters: zFilterAstShape,
    sort: zSavedViewSortShape.nullable().optional(),
    shared: z.boolean(),
  }),
  z.strictObject({ viewId: zId, filters: zFilterAstShape, sort: zSavedViewSortShape.nullable().optional() }),
]);
export type SavedViewSaveInput = z.infer<typeof zSavedViewSaveShape>;

// What the command accepts: the shape above, the name as stored, and a filter and sort the registry knows (422 otherwise).
export const zSavedViewSave = zSavedViewSaveShape.superRefine((input, ctx) => {
  const asAst = input.filters as FilterAst;
  // A replacement names no scope: the command checks it against the stored view's.
  if ('scope' in input) {
    for (const issue of [...filterIssues(input.scope, asAst), ...sortIssues(input.scope, input.sort)]) {
      ctx.addIssue({ code: 'custom', path: issue.path.split('.'), message: issue.code });
    }
    if (zSavedViewName.safeParse(input.name).success === false) ctx.addIssue({ code: 'custom', path: ['name'], message: 'bad_name' });
  }
});

export const zSavedViewRename = z.strictObject({ viewId: zId, name: z.string().max(200) });
export const zSavedViewSetShared = z.strictObject({ viewId: zId, shared: z.boolean() });
export const zSavedViewDelete = z.strictObject({ viewId: zId });
export const zSavedViewList = z.strictObject({ scope: zScope });

export const zSavedView = z.object({
  id: zId,
  scope: z.string(),
  name: z.string(),
  filters: zFilterAstShape,
  sort: zSavedViewSortShape.nullable(),
  shared: z.boolean(),
  ownerId: zId,
  mine: z.boolean(),
  canChange: z.boolean(),
  updatedAt: z.string(),
});
export type SavedView = z.infer<typeof zSavedView>;
