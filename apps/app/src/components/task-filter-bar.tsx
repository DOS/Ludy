// SPDX-License-Identifier: AGPL-3.0-only
// Filter and sort bar for Tasks and Project boards (scope 'kernel.task', issue #2610).
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { SavedViewSort } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ludy/ui/components/popover';
import { TASK_STATUSES } from '../lib/agents.ts';
import {
  EMPTY_TASK_FILTER,
  TASK_SORT_OPTIONS,
  selectTaskAssignee,
  selectTaskDue,
  selectTaskStatus,
  selectTaskTainted,
  taskFilterCount,
  taskConditionLabel,
  taskFilterToAst,
  taskSortOfValue,
  taskSortValue,
  type TaskFilterState,
} from '../lib/task-filter.ts';

export interface TaskFilterPosition {
  id: string;
  label: string;
}

type SortKey =
  | 'sort.due_asc'
  | 'sort.due_desc'
  | 'sort.created_asc'
  | 'sort.created_desc'
  | 'sort.updated_asc'
  | 'sort.updated_desc'
  | 'sort.title_asc'
  | 'sort.title_desc';

const SORT_LABELS: Record<string, SortKey> = {
  'due:asc': 'sort.due_asc',
  'due:desc': 'sort.due_desc',
  'created:asc': 'sort.created_asc',
  'created:desc': 'sort.created_desc',
  'updated:asc': 'sort.updated_asc',
  'updated:desc': 'sort.updated_desc',
  'title:asc': 'sort.title_asc',
  'title:desc': 'sort.title_desc',
};

export function TaskFilterBar({
  idPrefix = 'task-filter',
  bar,
  setBar,
  sort,
  setSort,
  positions,
  popover = false,
}: {
  idPrefix?: string;
  bar: TaskFilterState;
  setBar: (next: TaskFilterState) => void;
  sort: SavedViewSort | null;
  setSort: (next: SavedViewSort | null) => void;
  positions: readonly TaskFilterPosition[];
  // The Tasks screen: the search box stays in view and the status, assignee, due, origin and sort controls sit in one popover behind a button that counts them.
  // Project boards keep every control in the row.
  popover?: boolean;
}) {
  const t = useTranslations('tasks');
  const filtered = taskFilterToAst(bar).all.length > 0;
  const count = taskFilterCount(bar, sort);
  const select = (id: string, label: string, value: string, onChange: (value: string) => void, options: ReactNode, testId?: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-subtle-foreground">
        {label}
      </Label>
      <NativeSelect id={id} size="sm" data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)}>
        {options}
      </NativeSelect>
    </div>
  );

  const searchField = (
    <div className="flex min-w-48 max-w-sm flex-1 flex-col gap-1">
      <Label htmlFor={`${idPrefix}-search`} className="text-xs text-subtle-foreground">
        {t('filters.search')}
      </Label>
      <Input
        id={`${idPrefix}-search`}
        type="search"
        data-testid="task-filter-search"
        placeholder={t('filters.searchPlaceholder')}
        maxLength={100}
        value={bar.search}
        onChange={(e) => setBar({ ...bar, search: e.target.value })}
      />
    </div>
  );
  const fields = (
    <>
      {select(
        `${idPrefix}-status`,
        t('filters.status'),
        bar.status,
        (status) => setBar(selectTaskStatus(bar, status)),
        <>
          <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
          {TASK_STATUSES.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {t(`status.${s}`)}
            </NativeSelectOption>
          ))}
        </>,
        'task-filter-status',
      )}
      {select(
        `${idPrefix}-assignee`,
        t('filters.assignee'),
        bar.assignee,
        (assignee) => setBar(selectTaskAssignee(bar, assignee)),
        <>
          <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
          <NativeSelectOption value="me">{t('filters.assigneeMe')}</NativeSelectOption>
          <NativeSelectOption value="none">{t('filters.assigneeNone')}</NativeSelectOption>
          {positions.map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.label}
            </NativeSelectOption>
          ))}
          {bar.assignee !== '' &&
            bar.assignee !== 'me' &&
            bar.assignee !== 'none' &&
            !positions.some((p) => p.id === bar.assignee) && (
              <NativeSelectOption value={bar.assignee}>{t('filters.removed')}</NativeSelectOption>
            )}
        </>,
        'task-filter-assignee',
      )}
      {select(
        `${idPrefix}-due`,
        t('filters.due'),
        bar.due,
        (due) => setBar(selectTaskDue(bar, due)),
        <>
          <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
          <NativeSelectOption value="overdue">{t('filters.dueOverdue')}</NativeSelectOption>
          <NativeSelectOption value="soon">{t('filters.dueSoon')}</NativeSelectOption>
          <NativeSelectOption value="empty">{t('filters.dueEmpty')}</NativeSelectOption>
        </>,
        'task-filter-due',
      )}
      {select(
        `${idPrefix}-tainted`,
        t('filters.tainted'),
        bar.tainted,
        (tainted) => setBar(selectTaskTainted(bar, tainted)),
        <>
          <NativeSelectOption value="">{t('filters.any')}</NativeSelectOption>
          <NativeSelectOption value="true">{t('filters.taintedAi')}</NativeSelectOption>
          <NativeSelectOption value="false">{t('filters.taintedHuman')}</NativeSelectOption>
        </>,
        'task-filter-tainted',
      )}
      {select(
        `${idPrefix}-sort`,
        t('filters.sort'),
        taskSortValue(sort),
        (value) => setSort(taskSortOfValue(value)),
        <>
          <NativeSelectOption value="">{t('sort.default')}</NativeSelectOption>
          {TASK_SORT_OPTIONS.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {t(SORT_LABELS[value] ?? 'sort.default')}
            </NativeSelectOption>
          ))}
        </>,
        'task-filter-sort',
      )}
    </>
  );
  // In the popover the button counts the sort too, so Clear is offered for it and puts the sort back; the search box is outside the popover and Clear leaves it.
  const clear = (popover ? count > 0 : filtered) ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="task-filter-clear"
      onClick={() => {
        setBar(popover ? { ...EMPTY_TASK_FILTER, search: bar.search } : EMPTY_TASK_FILTER);
        if (popover) setSort(null);
      }}
    >
      {t('filters.clear')}
    </Button>
  ) : null;

  return (
    <>
      {popover ? (
        <div className="mb-3 flex items-end gap-2" role="search" aria-label={t('filters.label')}>
          <div className="min-w-0 flex-1 sm:max-w-sm">{searchField}</div>
          <Popover>
            <PopoverTrigger
              data-testid="task-filter-button"
              aria-label={count > 0 ? t('filters.buttonCount', { count: String(count) }) : t('filters.button')}
              render={<Button type="button" variant="outline" className="shrink-0" />}
            >
              {t('filters.button')}
              {count > 0 && (
                <span data-testid="task-filter-count" className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
                  {count}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent data-testid="task-filter-popover">
              <PopoverTitle>{t('filters.button')}</PopoverTitle>
              <div className="mt-3 flex flex-col gap-3">
                {fields}
                {clear}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      ) : (
        <div className="mb-3 flex flex-wrap items-end gap-3" role="search" aria-label={t('filters.label')}>
          {searchField}
          {fields}
          {clear}
        </div>
      )}
      {bar.rest.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2" aria-label={t('filters.other')}>
          {bar.rest.map((c, i) => {
            const label = taskConditionLabel(c, t, positions);
            return (
              <li key={`${c.field}:${c.op}:${i}`} className="flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-muted-foreground">
                <span>{label}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('filters.remove', { condition: label })}
                  onClick={() => setBar({ ...bar, rest: bar.rest.filter((_, j) => j !== i) })}
                >
                  ×
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
