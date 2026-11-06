// SPDX-License-Identifier: AGPL-3.0-only
// The filter bar of the contacts screen as a Filter AST of the `crm.party` scope (CRM K4, #2228), and back. The bar edits
// the conditions it has a control for (search, kind, has an email, a phone, a tax code); any other condition of a saved
// view (created within N days, has an open deal) stays in `rest`, shown as a chip the person can remove, so opening a view
// and saving it again never drops a condition the bar cannot draw. No browser or API imports, so it is unit tested.
import { SAVED_VIEW_SCOPES, type FilterAst, type FilterCondition, type SavedViewSort } from '@crove/kernel-contract';

export type Tri = '' | 'yes' | 'no';
export type ContactKind = '' | 'organization' | 'person';

export interface ContactFilterState {
  search: string;
  kind: ContactKind;
  email: Tri;
  phone: Tri;
  taxCode: Tri;
  // Conditions the bar has no control for, kept as stored.
  rest: FilterCondition[];
}

export const EMPTY_CONTACT_FILTER: ContactFilterState = { search: '', kind: '', email: '', phone: '', taxCode: '', rest: [] };

const FLAGS = { has_email: 'email', has_phone: 'phone', has_tax_code: 'taxCode' } as const;

export function contactFilterToAst(state: ContactFilterState): FilterAst {
  const all: FilterCondition[] = [];
  const search = state.search.trim();
  if (search) all.push({ field: 'search', op: 'contains', value: search });
  if (state.kind) all.push({ field: 'kind', op: 'is', value: state.kind });
  for (const [field, key] of Object.entries(FLAGS)) {
    const value = state[key as 'email' | 'phone' | 'taxCode'];
    if (value) all.push({ field, op: 'is', value: value === 'yes' });
  }
  return { v: 1, all: [...all, ...state.rest] };
}

export function astToContactFilter(ast: FilterAst): ContactFilterState {
  const state: ContactFilterState = { ...EMPTY_CONTACT_FILTER, rest: [] };
  for (const c of ast.all) {
    if (c.field === 'search' && c.op === 'contains' && typeof c.value === 'string' && state.search === '') state.search = c.value;
    else if (c.field === 'kind' && c.op === 'is' && (c.value === 'organization' || c.value === 'person') && state.kind === '') state.kind = c.value;
    else if (c.field in FLAGS && c.op === 'is' && typeof c.value === 'boolean') {
      const key = FLAGS[c.field as keyof typeof FLAGS];
      if (state[key] === '') state[key] = c.value ? 'yes' : 'no';
      else state.rest.push(c);
    } else state.rest.push(c);
  }
  return state;
}

// The sorts the contacts screen offers, as `field:dir` option values; the empty value is the list's own order (by name).
export const CONTACT_SORT_OPTIONS = SAVED_VIEW_SCOPES['crm.party'].sortable.flatMap((field) => [`${field}:asc`, `${field}:desc`]);

export function sortValue(sort: SavedViewSort | null | undefined): string {
  return sort ? `${sort.field}:${sort.dir}` : '';
}

export function sortOfValue(value: string): SavedViewSort | null {
  const [field, dir] = value.split(':');
  return field && (dir === 'asc' || dir === 'desc') && CONTACT_SORT_OPTIONS.includes(value) ? { field, dir } : null;
}

// What a condition the bar cannot draw says, for its chip: the field's label from the registry and the operator's value.
export function conditionLabel(c: FilterCondition): string {
  const spec = (SAVED_VIEW_SCOPES['crm.party'].fields as Record<string, { label: string }>)[c.field];
  return `${spec?.label ?? c.field}: ${c.op}${c.value === undefined ? '' : ` ${String(c.value)}`}`;
}
