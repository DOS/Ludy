// SPDX-License-Identifier: AGPL-3.0-only
// Contract checks for project task-map limits and schemas (#2593).
import { describe, expect, it } from 'vitest';
import {
  PROJECT_TASK_MAP_LIMIT,
  isRealCalendarDate,
  zProjectProposedTask,
  zProjectTaskProjectsInput,
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
