// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for notes.my_work project lookup bounds (#2593).
import { describe, expect, it } from 'vitest';
import { PROJECT_TASK_MAP_LIMIT, zProjectTaskProjectsInput } from '@crove/kernel-contract';
import type { Lookup, QueryContext } from '@crove/kernel-runtime';
import { myWork } from '../src/todos.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-000000000003';
const P1 = '10000000-0000-4000-8000-000000000001';
const taskId = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('notes.my_work (#2593)', () => {
  it('caps taskIds sent to projects.task_projects at PROJECT_TASK_MAP_LIMIT', async () => {
    const chain = {
      select: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      execute: async () => [],
      executeTakeFirstOrThrow: async () => ({ n: '1' }),
      executeTakeFirst: async () => undefined,
    };

    const totalTasks = PROJECT_TASK_MAP_LIMIT + 15;
    const listedTasks = Array.from({ length: totalTasks }, (_, i) => ({
      id: taskId(i + 1),
      title: `Task ${i + 1}`,
      status: 'todo',
      assigneePositionId: null,
      due: null,
      tainted: false,
    }));

    let capturedInput: unknown;
    const ctx = {
      orgId: ORG,
      role: 'owner',
      actor: { type: 'user', userId: USER, sessionId: SESSION },
      trx: { selectFrom: () => chain },
      query: async (name: string, input: unknown): Promise<Lookup<unknown>> => {
        if (name === 'kernel.task.list') {
          return { status: 'ok', value: { tasks: listedTasks } };
        }
        if (name === 'projects.task_projects') {
          capturedInput = input;
          const parsed = zProjectTaskProjectsInput.parse(input);
          return {
            status: 'ok',
            value: parsed.taskIds.length > 0 ? [{ taskId: parsed.taskIds[0], project: { id: P1, name: 'Thuế Q4' } }] : [],
          };
        }
        return { status: 'not_installed', module: name.split('.')[0] ?? name };
      },
    } as unknown as QueryContext;

    const result = await myWork.handler(ctx, { timeZone: 'Asia/Ho_Chi_Minh' });
    const parsedInput = zProjectTaskProjectsInput.parse(capturedInput);

    expect(parsedInput.taskIds).toHaveLength(PROJECT_TASK_MAP_LIMIT);
    expect(parsedInput.taskIds[0]).toBe(taskId(1));
    expect(parsedInput.taskIds[PROJECT_TASK_MAP_LIMIT - 1]).toBe(taskId(PROJECT_TASK_MAP_LIMIT));
    expect(result.tasks).toHaveLength(totalTasks);
    expect(result.tasks[0]?.project).toEqual({ id: P1, name: 'Thuế Q4' });
    expect(result.tasks[totalTasks - 1]?.project).toBeNull();
  });
});
