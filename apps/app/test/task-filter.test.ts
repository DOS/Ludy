// SPDX-License-Identifier: AGPL-3.0-only
import { filterIssues } from '@crove/kernel-contract';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider, createTranslator } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { TaskFilterBar } from '../src/components/task-filter-bar.tsx';
import { catalog } from '../src/i18n/runtime.ts';
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

    // Preserve single-item `status:in` in `rest` when `status:is` is also present so round-tripping never duplicates `status:is`.
    const bothStatusOps = astToTaskFilter({
      v: 1,
      all: [
        { field: 'status', op: 'in', value: ['todo'] },
        { field: 'status', op: 'is', value: 'waiting' },
      ],
    });
    expect(bothStatusOps.status).toBe('waiting');
    expect(bothStatusOps.rest).toEqual([{ field: 'status', op: 'in', value: ['todo'] }]);
    expect(filterIssues('kernel.task', taskFilterToAst(bothStatusOps))).toEqual([]);

    const enMessages = catalog('en');
    const viCatalog = catalog('vi');
    const tEn = createTranslator({ locale: 'en', messages: enMessages, namespace: 'tasks' });
    const tVi = createTranslator({ locale: 'vi', messages: viCatalog, namespace: 'tasks' });
    const positions = [{ id: POS_1, label: 'Kế toán trưởng' }];

    expect(taskConditionLabel({ field: 'created', op: 'within_last_days', value: 14 }, tEn, positions)).toBe(
      'Created in the last 14 days',
    );
    expect(taskConditionLabel({ field: 'created', op: 'within_last_days', value: 14 }, tVi, positions)).toBe(
      'Tạo trong 14 ngày gần đây',
    );
    expect(taskConditionLabel({ field: 'due', op: 'before', value: '2026-12-31' }, tEn, positions)).toBe(
      'Due before 2026-12-31',
    );
    expect(taskConditionLabel({ field: 'due', op: 'before', value: '2026-12-31' }, tVi, positions)).toBe(
      'Hạn trước 2026-12-31',
    );
    expect(taskConditionLabel({ field: 'due', op: 'after', value: '2026-01-01' }, tEn, positions)).toBe(
      'Due after 2026-01-01',
    );
    expect(taskConditionLabel({ field: 'due', op: 'within_next_days', value: 30 }, tEn, positions)).toBe(
      'Due in the next 30 days',
    );
    expect(taskConditionLabel({ field: 'status', op: 'in', value: ['todo', 'waiting'] }, tVi, positions)).toBe(
      'Trạng thái: Cần làm, Đang chờ',
    );
    expect(taskConditionLabel({ field: 'assignee', op: 'is', value: POS_1 }, tEn, positions)).toBe(
      'Assignee: Kế toán trưởng',
    );
    expect(taskConditionLabel({ field: 'tainted', op: 'is', value: true }, tEn, positions)).toBe(
      'Content trust: Unverified external content',
    );
    expect(taskConditionLabel({ field: 'tainted', op: 'is', value: false }, tVi, positions)).toBe(
      'Nguồn nội dung: Không phải nội dung bên ngoài',
    );

    const htmlEn = renderToStaticMarkup(
      createElement(IntlProvider, {
        locale: 'en',
        timeZone: 'Asia/Ho_Chi_Minh',
        messages: enMessages,
        children: createElement(TaskFilterBar, {
          bar: {
            ...EMPTY_TASK_FILTER,
            rest: [
              { field: 'created', op: 'within_last_days', value: 14 },
              { field: 'due', op: 'before', value: '2026-12-31' },
            ],
          },
          setBar: () => undefined,
          sort: null,
          setSort: () => undefined,
          positions,
        }),
      }),
    );
    expect(htmlEn).toContain('Unverified external content');
    expect(htmlEn).toContain('Not tainted');
    expect(htmlEn).toContain('Created in the last 14 days');
    expect(htmlEn).toContain('aria-label="Remove filter Created in the last 14 days"');
    expect(htmlEn).not.toContain('within_last_days');
    expect(htmlEn).not.toContain('AI proposed');
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
