// SPDX-License-Identifier: AGPL-3.0-only
// The filter bar of Tasks and Project boards as a Filter AST of the `kernel.task` scope (#2610), and back.
// No browser or API imports, so it is unit tested directly.
import { SAVED_VIEW_SCOPES, type FilterAst, type FilterCondition, type SavedViewSort } from '@crove/kernel-contract';
import { TASK_STATUSES, type TaskStatus } from './agents.ts';

// '' any, 'me' caller's positions (or unassigned for owners), 'none' unassigned, or a position UUID.
export type TaskAssigneeFilter = string;
export type TaskDueFilter = '' | 'overdue' | 'soon' | 'empty';
export type TaskTaintedFilter = '' | 'true' | 'false';

export interface TaskFilterState {
  search: string;
  status: '' | TaskStatus;
  assignee: TaskAssigneeFilter;
  due: TaskDueFilter;
  tainted: TaskTaintedFilter;
  // Conditions the bar has no direct control for (multi-status `in`, due `before`/`after`, `created`), kept as stored.
  rest: FilterCondition[];
}

export const EMPTY_TASK_FILTER: TaskFilterState = {
  search: '',
  status: '',
  assignee: '',
  due: '',
  tainted: '',
  rest: [],
};

// "Due soon" matches the next week window.
export const TASK_SOON_DAYS = 7;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function taskFilterToAst(state: TaskFilterState): FilterAst {
  const all: FilterCondition[] = [];
  const search = state.search.trim();
  if (search) all.push({ field: 'search', op: 'contains', value: search });
  if (state.status) all.push({ field: 'status', op: 'is', value: state.status });
  if (state.assignee === 'me') all.push({ field: 'assignee', op: 'is_me' });
  else if (state.assignee === 'none') all.push({ field: 'assignee', op: 'is_empty' });
  else if (UUID.test(state.assignee)) all.push({ field: 'assignee', op: 'is', value: state.assignee });
  if (state.due === 'overdue') all.push({ field: 'due', op: 'overdue' });
  else if (state.due === 'soon') all.push({ field: 'due', op: 'within_next_days', value: TASK_SOON_DAYS });
  else if (state.due === 'empty') all.push({ field: 'due', op: 'is_empty' });
  if (state.tainted === 'true' || state.tainted === 'false') {
    all.push({ field: 'tainted', op: 'is', value: state.tainted === 'true' });
  }
  return { v: 1, all: [...all, ...state.rest] };
}

export function astToTaskFilter(ast: FilterAst): TaskFilterState {
  const state: TaskFilterState = { ...EMPTY_TASK_FILTER, rest: [] };
  for (const c of ast.all) {
    const onlyStatus =
      c.op === 'in' &&
      Array.isArray(c.value) &&
      c.value.length === 1 &&
      typeof c.value[0] === 'string' &&
      (TASK_STATUSES as readonly string[]).includes(c.value[0])
        ? (c.value[0] as TaskStatus)
        : null;
    const isStatus =
      c.op === 'is' && typeof c.value === 'string' && (TASK_STATUSES as readonly string[]).includes(c.value)
        ? (c.value as TaskStatus)
        : null;
    if (c.field === 'search' && c.op === 'contains' && typeof c.value === 'string' && state.search === '') {
      state.search = c.value;
    } else if (c.field === 'status' && state.status === '' && (isStatus !== null || onlyStatus !== null)) {
      state.status = isStatus ?? onlyStatus ?? '';
    } else if (c.field === 'assignee' && state.assignee === '' && c.op === 'is_me') {
      state.assignee = 'me';
    } else if (c.field === 'assignee' && state.assignee === '' && c.op === 'is_empty') {
      state.assignee = 'none';
    } else if (c.field === 'assignee' && state.assignee === '' && c.op === 'is' && typeof c.value === 'string') {
      state.assignee = c.value;
    } else if (c.field === 'due' && state.due === '' && c.op === 'overdue') {
      state.due = 'overdue';
    } else if (c.field === 'due' && state.due === '' && c.op === 'within_next_days' && c.value === TASK_SOON_DAYS) {
      state.due = 'soon';
    } else if (c.field === 'due' && state.due === '' && c.op === 'is_empty') {
      state.due = 'empty';
    } else if (c.field === 'tainted' && state.tainted === '' && c.op === 'is' && typeof c.value === 'boolean') {
      state.tainted = c.value ? 'true' : 'false';
    } else {
      state.rest.push(c);
    }
  }
  return state;
}

export const TASK_SORT_OPTIONS = SAVED_VIEW_SCOPES['kernel.task'].sortable.flatMap((field) => [`${field}:asc`, `${field}:desc`]);

export function taskSortValue(sort: SavedViewSort | null | undefined): string {
  return sort ? `${sort.field}:${sort.dir}` : '';
}

export function taskSortOfValue(value: string): SavedViewSort | null {
  const [field, dir] = value.split(':');
  return field && (dir === 'asc' || dir === 'desc') && TASK_SORT_OPTIONS.includes(value) ? { field, dir } : null;
}

export function taskConditionLabel(c: FilterCondition): string {
  const spec = (SAVED_VIEW_SCOPES['kernel.task'].fields as Record<string, { label: string }>)[c.field];
  return `${spec?.label ?? c.field}: ${c.op}${c.value === undefined ? '' : ` ${Array.isArray(c.value) ? c.value.join(', ') : String(c.value)}`}`;
}
