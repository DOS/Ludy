// SPDX-License-Identifier: AGPL-3.0-only
// The filter bar of Tasks and Project boards as a Filter AST of the `kernel.task` scope (#2610), and back.
// No browser or API imports, so it is unit tested directly.
import type { useTranslations } from 'use-intl';
import { SAVED_VIEW_SCOPES, type FilterAst, type FilterCondition, type SavedViewSort } from '@ludy/kernel-contract';
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

/** How many filters are on, for the count on the filters button: each of status, assignee, due and tainted that is set, each condition kept as stored, and a sort. The search box is outside the popover and not counted. */
export function taskFilterCount(state: TaskFilterState, sort: SavedViewSort | null): number {
  return [state.status, state.assignee, state.due, state.tainted].filter((value) => value !== '').length + state.rest.length + (sort ? 1 : 0);
}

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
  const hasStatusIs = ast.all.some((c) => c.field === 'status' && c.op === 'is');
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
    } else if (c.field === 'status' && state.status === '' && (isStatus !== null || (!hasStatusIs && onlyStatus !== null))) {
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

function withoutRestCondition(rest: readonly FilterCondition[], field: string, op: string | null): FilterCondition[] {
  return op ? rest.filter((c) => !(c.field === field && c.op === op)) : [...rest];
}

export function selectTaskStatus(state: TaskFilterState, raw: string): TaskFilterState {
  const status = (TASK_STATUSES.find((s) => s === raw) ?? '') as '' | TaskStatus;
  return { ...state, status, rest: withoutRestCondition(state.rest, 'status', status ? 'is' : null) };
}

export function selectTaskAssignee(state: TaskFilterState, assignee: string): TaskFilterState {
  const op = assignee === 'me' ? 'is_me' : assignee === 'none' ? 'is_empty' : UUID.test(assignee) ? 'is' : null;
  return { ...state, assignee, rest: withoutRestCondition(state.rest, 'assignee', op) };
}

export function selectTaskDue(state: TaskFilterState, raw: string): TaskFilterState {
  const due = (['overdue', 'soon', 'empty'] as const).find((d) => d === raw) ?? ('' satisfies TaskDueFilter);
  const op = due === 'overdue' ? 'overdue' : due === 'soon' ? 'within_next_days' : due === 'empty' ? 'is_empty' : null;
  return { ...state, due, rest: withoutRestCondition(state.rest, 'due', op) };
}

export function selectTaskTainted(state: TaskFilterState, raw: string): TaskFilterState {
  const tainted = (['true', 'false'] as const).find((v) => v === raw) ?? ('' satisfies TaskTaintedFilter);
  return { ...state, tainted, rest: withoutRestCondition(state.rest, 'tainted', tainted ? 'is' : null) };
}

export function taskSortValue(sort: SavedViewSort | null | undefined): string {
  return sort ? `${sort.field}:${sort.dir}` : '';
}

export function taskSortOfValue(value: string): SavedViewSort | null {
  const [field, dir] = value.split(':');
  return field && (dir === 'asc' || dir === 'desc') && TASK_SORT_OPTIONS.includes(value) ? { field, dir } : null;
}

export type TaskFilterTranslator = ReturnType<typeof useTranslations<'tasks'>>;

function localizedStatus(value: unknown, t: TaskFilterTranslator): string {
  const s = String(value);
  return (TASK_STATUSES as readonly string[]).includes(s) ? t(`status.${s as TaskStatus}`) : s;
}

function localizedField(field: string, t: TaskFilterTranslator): string {
  if (field === 'search') return t('filters.search');
  if (field === 'status') return t('filters.status');
  if (field === 'assignee') return t('filters.assignee');
  if (field === 'due') return t('filters.due');
  if (field === 'tainted') return t('filters.tainted');
  if (field === 'created') return t('colCreated');
  return (SAVED_VIEW_SCOPES['kernel.task'].fields as Record<string, { label: string }>)[field]?.label ?? field;
}

export function taskConditionLabel(
  c: FilterCondition,
  t: TaskFilterTranslator,
  positions: readonly { id: string; label: string }[] = [],
): string {
  if (c.field === 'created' && c.op === 'within_last_days') {
    return t('filters.condCreatedWithinLastDays', { days: String(Number(c.value) || 0) });
  }
  if (c.field === 'due') {
    if (c.op === 'before') return t('filters.condDueBefore', { date: String(c.value ?? '') });
    if (c.op === 'after') return t('filters.condDueAfter', { date: String(c.value ?? '') });
    if (c.op === 'overdue') return `${t('filters.due')}: ${t('filters.dueOverdue')}`;
    if (c.op === 'within_next_days') return t('filters.condDueWithinNextDays', { days: String(Number(c.value) || 0) });
    if (c.op === 'is_empty') return `${t('filters.due')}: ${t('filters.dueEmpty')}`;
  }
  if (c.field === 'status' && (c.op === 'is' || c.op === 'in')) {
    const list = Array.isArray(c.value) ? c.value : [c.value];
    return t('filters.condStatusIn', { values: list.map((v) => localizedStatus(v, t)).join(', ') });
  }
  if (c.field === 'assignee') {
    if (c.op === 'is_me') return `${t('filters.assignee')}: ${t('filters.assigneeMe')}`;
    if (c.op === 'is_empty') return `${t('filters.assignee')}: ${t('filters.assigneeNone')}`;
    if (c.op === 'is') {
      const id = String(c.value ?? '');
      const label = positions.find((p) => p.id === id)?.label ?? id;
      return t('filters.condAssigneeIs', { value: label });
    }
  }
  if (c.field === 'tainted' && c.op === 'is' && typeof c.value === 'boolean') {
    return `${t('filters.tainted')}: ${c.value ? t('filters.taintedAi') : t('filters.taintedHuman')}`;
  }
  if (c.field === 'search' && c.op === 'contains') {
    return t('filters.condSearchContains', { value: String(c.value ?? '') });
  }
  const value = Array.isArray(c.value) ? c.value.map(String).join(', ') : c.value === undefined ? '' : String(c.value);
  return t('filters.condGeneric', { field: localizedField(c.field, t), value: value || c.op });
}
