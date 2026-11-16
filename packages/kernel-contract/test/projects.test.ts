// SPDX-License-Identifier: AGPL-3.0-only
// Contract checks for project task-map limits and schemas (#2593).
import { describe, expect, it } from 'vitest';
import { contract } from '../src/contract.ts';
import {
  PROJECT_TASK_MAP_LIMIT,
  isRealCalendarDate,
  zProjectBoardInput,
  zProjectProposedTask,
  zProjectTaskProjectsInput,
  zProjectTaskReorder,
  zProjectTasksFromNoteConfirmInput,
} from '../src/projects.ts';

const taskId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('zProjectTaskProjectsInput (#2593)', () => {
  it('accepts up to PROJECT_TASK_MAP_LIMIT (500) task IDs and rejects one more', () => {
    expect(PROJECT_TASK_MAP_LIMIT).toBe(500);
    expect(
      zProjectTaskProjectsInput.safeParse({
        taskIds: Array.from({ length: PROJECT_TASK_MAP_LIMIT }, (_, i) => taskId(i + 1)),
      }).success,
    ).toBe(true);
    expect(
      zProjectTaskProjectsInput.safeParse({
        taskIds: Array.from({ length: PROJECT_TASK_MAP_LIMIT + 1 }, (_, i) => taskId(i + 1)),
      }).success,
    ).toBe(false);
  });
});

describe('zProjectProposedTask & confirm date check (#2598)', () => {
  it('accepts real calendar dates and rejects invalid dates like 2026-02-31', () => {
    expect(isRealCalendarDate('2026-11-20')).toBe(true);
    expect(isRealCalendarDate('2026-02-31')).toBe(false);
    expect(isRealCalendarDate('1999-01-01')).toBe(false);

    expect(
      zProjectProposedTask.safeParse({ title: 'Valid task', assigneePositionId: null, dueOn: '2026-11-20' }).success,
    ).toBe(true);
    expect(
      zProjectProposedTask.safeParse({ title: 'Valid null', assigneePositionId: null, dueOn: null }).success,
    ).toBe(true);
    expect(
      zProjectProposedTask.safeParse({ title: 'Bad date', assigneePositionId: null, dueOn: '2026-02-31' }).success,
    ).toBe(false);
    expect(
      zProjectTasksFromNoteConfirmInput.safeParse({
        noteId: taskId(1),
        projectId: taskId(2),
        confirmed: true,
        items: [{ title: 'Bad date', assigneePositionId: null, dueOn: '2026-02-31' }],
      }).success,
    ).toBe(false);
  });
});

describe('zProjectTaskReorder & zProjectBoardInput (#2610)', () => {
  it('validates reorder input and rejects moving a task next to itself', async () => {
    expect(
      zProjectTaskReorder.safeParse({
        projectId: taskId(1),
        taskId: taskId(2),
        place: 'before',
        anchorId: taskId(3),
      }).success,
    ).toBe(true);
    expect(
      zProjectTaskReorder.safeParse({
        projectId: taskId(1),
        taskId: taskId(2),
        place: 'after',
        anchorId: taskId(2),
      }).success,
    ).toBe(false);
    expect(
      zProjectTaskReorder.safeParse({
        projectId: taskId(1),
        taskId: taskId(2),
        place: 'top',
        anchorId: taskId(3),
      }).success,
    ).toBe(false);
    expect(
      await contract.projects.reorderTask['~orpc'].inputSchema?.['~standard'].validate({
        projectId: taskId(1),
        taskId: taskId(2),
        place: 'after',
        anchorId: taskId(2),
        idempotencyKey: taskId(9),
      }),
    ).toMatchObject({ issues: expect.any(Array) });
  });

  it('accepts optional saved-view filters and sort on board queries', () => {
    expect(
      zProjectBoardInput.safeParse({
        projectId: taskId(1),
        filters: { v: 1, all: [{ field: 'tainted', op: 'is', value: true }] },
        sort: { field: 'due', dir: 'asc' },
      }).success,
    ).toBe(true);
    expect(zProjectBoardInput.safeParse({ projectId: taskId(1), sort: null }).success).toBe(true);
  });
});
