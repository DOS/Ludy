// SPDX-License-Identifier: AGPL-3.0-only
// Contract checks for project task-map limits and schemas (#2593).
import { describe, expect, it } from 'vitest';
import { PROJECT_TASK_MAP_LIMIT, zProjectTaskProjectsInput } from '../src/projects.ts';

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
