// SPDX-License-Identifier: AGPL-3.0-only
import { filterIssues } from '@crove/kernel-contract';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TASK_FILTER,
  TASK_SOON_DAYS,
  astToTaskFilter,
  taskConditionLabel,
  taskFilterToAst,
  taskSortOfValue,
  taskSortValue,
} from '../src/lib/task-filter.ts';
import { sameFilter } from '../src/lib/view-filter.ts';

const POS_1 = '0192a2b0-7c1e-7000-8000-0000000000a1';
const POS_2 = '0192a2b0-7c1e-7000-8000-0000000000b2';

describe('task filter (kernel.task, #2610)', () => {
  it('turns the bar into valid kernel.task AST conditions and nothing for an empty bar', () => {
    expect(taskFilterToAst(EMPTY_TASK_FILTER)).toEqual({ v: 1, all: [] });

    const ast = taskFilterToAst({
      search: ' khai thue ',
      status: 'in_progress',
      assignee: 'me',
      due: 'soon',
      tainted: 'true',
      rest: [],
    });
    expect(ast.all.map((c) => `${c.field}:${c.op}`)).toEqual([
      'search:contains',
      'status:is',
      'assignee:is_me',
      'due:within_next_days',
      'tainted:is',
    ]);
    expect(ast.all[0]).toEqual({ field: 'search', op: 'contains', value: 'khai thue' });
    expect(ast.all[3]).toEqual({ field: 'due', op: 'within_next_days', value: TASK_SOON_DAYS });
    expect(ast.all[4]).toEqual({ field: 'tainted', op: 'is', value: true });

    expect(filterIssues('kernel.task', ast)).toEqual([]);
    expect(
      filterIssues(
        'kernel.task',
        taskFilterToAst({ ...EMPTY_TASK_FILTER, assignee: POS_1, due: 'overdue', tainted: 'false' }),
      ),
    ).toEqual([]);
    expect(taskFilterToAst({ ...EMPTY_TASK_FILTER, assignee: 'none' }).all).toEqual([{ field: 'assignee', op: 'is_empty' }]);
    expect(taskFilterToAst({ ...EMPTY_TASK_FILTER, due: 'empty' }).all).toEqual([{ field: 'due', op: 'is_empty' }]);
    expect(taskFilterToAst({ ...EMPTY_TASK_FILTER, assignee: 'not-a-uuid' }).all).toEqual([]);
  });

  it('round-trips a stored view through astToTaskFilter while keeping extra conditions in rest', () => {
    const stored = {
      v: 1 as const,
      all: [
        { field: 'status', op: 'in', value: ['todo', 'waiting'] },
        { field: 'assignee', op: 'is_empty' },
        { field: 'due', op: 'before', value: '2026-12-31' },
        { field: 'created', op: 'within_last_days', value: 14 },
        { field: 'tainted', op: 'is', value: true },
      ],
    };
    const state = astToTaskFilter(stored);
    expect(state).toMatchObject({ status: '', assignee: 'none', due: '', tainted: 'true' });
    expect(state.rest.map((c) => `${c.field}:${c.op}`)).toEqual(['status:in', 'due:before', 'created:within_last_days']);
    expect(sameFilter(taskFilterToAst(state), stored)).toBe(true);

    // Single-status `in` restores onto the Status select, and 7-day due onto Soon.
    const single = astToTaskFilter({
      v: 1,
      all: [
        { field: 'status', op: 'in', value: ['done'] },
        { field: 'assignee', op: 'is', value: POS_2 },
        { field: 'due', op: 'within_next_days', value: TASK_SOON_DAYS },
      ],
    });
    expect(single).toMatchObject({ status: 'done', assignee: POS_2, due: 'soon', rest: [] });
    expect(astToTaskFilter({ v: 1, all: [{ field: 'due', op: 'within_next_days', value: 30 }] }).rest).toHaveLength(1);
    expect(taskConditionLabel({ field: 'created', op: 'within_last_days', value: 14 })).toContain('14');
  });

  it('reads and writes task sort options cleanly', () => {
    expect(taskSortValue(null)).toBe('');
    expect(taskSortValue({ field: 'due', dir: 'asc' })).toBe('due:asc');
    expect(taskSortOfValue('title:desc')).toEqual({ field: 'title', dir: 'desc' });
    expect(taskSortOfValue('updated:asc')).toEqual({ field: 'updated', dir: 'asc' });
    expect(taskSortOfValue('')).toBeNull();
    expect(taskSortOfValue('amount:desc')).toBeNull();
  });
});
