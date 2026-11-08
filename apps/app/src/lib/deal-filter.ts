// SPDX-License-Identifier: AGPL-3.0-only
// The filter bar of the Deals screen as a Filter AST of the `crm.deal` scope (CRM K3, #2227), and back. The bar edits the
// conditions it has a control for (search, stage, status, owner, expected close, amount range); any other condition of a
// saved view (a contact, created within N days, several stages) stays in `rest`, shown as a chip the person can remove, so
// opening a view and saving it again never drops a condition the bar cannot draw. No browser or API imports, so it is
// unit tested.
import { SAVED_VIEW_SCOPES, type FilterAst, type FilterCondition, type SavedViewSort } from '@crove/kernel-contract';
import { normalizeAmount } from './vouchers.ts';

export type DealStatusFilter = '' | 'open' | 'won' | 'lost';
// '' any, 'me' the asker, 'none' nobody, or a member's user id.
export type DealOwnerFilter = string;
export type DealCloseFilter = '' | 'overdue' | 'soon' | 'empty';

export interface DealFilterState {
  search: string;
  stage: string;
  status: DealStatusFilter;
  owner: DealOwnerFilter;
  close: DealCloseFilter;
  amountMin: string;
  amountMax: string;
  // Conditions the bar has no control for, kept as stored.
  rest: FilterCondition[];
}

export const EMPTY_DEAL_FILTER: DealFilterState = { search: '', stage: '', status: '', owner: '', close: '', amountMin: '', amountMax: '', rest: [] };

// "Due soon" is the next week.
export const DEAL_SOON_DAYS = 7;
// A decimal string the registry takes: at most 16 integer digits and two decimals.
const AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;
export const isAmount = (value: string): boolean => AMOUNT.test(value.trim());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function dealFilterToAst(state: DealFilterState): FilterAst {
  const all: FilterCondition[] = [];
  const search = state.search.trim();
  if (search) all.push({ field: 'search', op: 'contains', value: search });
  if (state.stage) all.push({ field: 'stage', op: 'in', value: [state.stage] });
  if (state.status) all.push({ field: 'status', op: 'is', value: state.status });
  if (state.owner === 'me') all.push({ field: 'owner', op: 'is_me' });
  else if (state.owner === 'none') all.push({ field: 'owner', op: 'is_empty' });
  else if (UUID.test(state.owner)) all.push({ field: 'owner', op: 'is', value: state.owner });
  if (state.close === 'overdue') all.push({ field: 'expected_close', op: 'overdue' });
  else if (state.close === 'soon') all.push({ field: 'expected_close', op: 'within_next_days', value: DEAL_SOON_DAYS });
  else if (state.close === 'empty') all.push({ field: 'expected_close', op: 'is_empty' });
  // "1.000.000" and "1 000 000" are read as 1000000, as the deal form reads an amount.
  const min = normalizeAmount(state.amountMin);
  const max = normalizeAmount(state.amountMax);
  if (isAmount(min)) all.push({ field: 'amount', op: 'gte', value: min });
  if (isAmount(max)) all.push({ field: 'amount', op: 'lte', value: max });
  return { v: 1, all: [...all, ...state.rest] };
}

export function astToDealFilter(ast: FilterAst): DealFilterState {
  const state: DealFilterState = { ...EMPTY_DEAL_FILTER, rest: [] };
  for (const c of ast.all) {
    const only = c.op === 'in' && Array.isArray(c.value) && c.value.length === 1 && typeof c.value[0] === 'string' ? (c.value[0] as string) : null;
    if (c.field === 'search' && c.op === 'contains' && typeof c.value === 'string' && state.search === '') state.search = c.value;
    else if (c.field === 'stage' && only !== null && state.stage === '') state.stage = only;
    else if (c.field === 'status' && c.op === 'is' && (c.value === 'open' || c.value === 'won' || c.value === 'lost') && state.status === '') state.status = c.value;
    else if (c.field === 'owner' && state.owner === '' && c.op === 'is_me') state.owner = 'me';
    else if (c.field === 'owner' && state.owner === '' && c.op === 'is_empty') state.owner = 'none';
    else if (c.field === 'owner' && state.owner === '' && c.op === 'is' && typeof c.value === 'string') state.owner = c.value;
    else if (c.field === 'expected_close' && state.close === '' && c.op === 'overdue') state.close = 'overdue';
    else if (c.field === 'expected_close' && state.close === '' && c.op === 'within_next_days' && c.value === DEAL_SOON_DAYS) state.close = 'soon';
    else if (c.field === 'expected_close' && state.close === '' && c.op === 'is_empty') state.close = 'empty';
    else if (c.field === 'amount' && c.op === 'gte' && typeof c.value === 'string' && state.amountMin === '') state.amountMin = c.value;
    else if (c.field === 'amount' && c.op === 'lte' && typeof c.value === 'string' && state.amountMax === '') state.amountMax = c.value;
    else state.rest.push(c);
  }
  return state;
}

// The sorts the Deals screen offers, as `field:dir` option values; the empty value is the list's own order (newest first).
export const DEAL_SORT_OPTIONS = SAVED_VIEW_SCOPES['crm.deal'].sortable.flatMap((field) => [`${field}:asc`, `${field}:desc`]);

export function dealSortValue(sort: SavedViewSort | null | undefined): string {
  return sort ? `${sort.field}:${sort.dir}` : '';
}

export function dealSortOfValue(value: string): SavedViewSort | null {
  const [field, dir] = value.split(':');
  return field && (dir === 'asc' || dir === 'desc') && DEAL_SORT_OPTIONS.includes(value) ? { field, dir } : null;
}

// What a condition the bar cannot draw says, for its chip: the field's label from the registry and the operator's value.
export function dealConditionLabel(c: FilterCondition): string {
  const spec = (SAVED_VIEW_SCOPES['crm.deal'].fields as Record<string, { label: string }>)[c.field];
  return `${spec?.label ?? c.field}: ${c.op}${c.value === undefined ? '' : ` ${String(c.value)}`}`;
}
