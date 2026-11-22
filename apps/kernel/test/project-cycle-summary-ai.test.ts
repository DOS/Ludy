// SPDX-License-Identifier: AGPL-3.0-only
// API orchestrator tests for prepareProjectCycleSummary guard states and deterministic fallback (#4361).
import { describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError } from '@ludy/agent';
import type { ProjectCycleSummarySource } from '@ludy/mod-projects';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { prepareProjectCycleSummary, projectCycleSummaryAi } from '../src/project-cycle-summary-ai.ts';

const baseSource = (over: Partial<ProjectCycleSummarySource> = {}): ProjectCycleSummarySource => {
  const cycle = {
    id: '00000000-0000-4000-8000-000000000010',
    projectId: '00000000-0000-4000-8000-000000000001',
    number: 1,
    name: 'Sprint 1',
    goal: null,
    status: 'active' as const,
    startsOn: '2027-02-01',
    endsOn: '2027-02-14',
    startedAt: '2027-02-01T01:00:00.000Z',
    completedAt: null,
    createdAt: '2027-02-01T01:00:00.000Z',
    updatedAt: '2027-02-01T01:00:00.000Z',
    totalTasks: 4,
    openTasks: 2,
    doneTasks: 2,
    cancelledTasks: 0,
    totalPoints: 10,
    donePoints: 5,
  };
  return {
    project: { id: cycle.projectId, name: 'Kế hoạch Q1', status: 'active' },
    cycle,
    metrics: {
      projectId: cycle.projectId,
      selectedCycle: cycle,
      burndown: [],
      velocity: [],
      averageVelocityTasks: 0,
      averageVelocityPoints: 0,
      hiddenByEntityCount: 0,
    },
    tasks: [
      {
        id: '00000000-0000-4000-8000-000000000020',
        title: 'Chốt số liệu',
        tainted: false,
        status: 'in_progress',
        due: null,
        commentCount: 0,
        latestComment: null,
      },
    ],
    hiddenByEntityCount: 0,
    truncated: false,
    aiAllowed: true,
    aiStopped: false,
    aiBudgetSpent: false,
    ...over,
  };
};

describe('prepareProjectCycleSummary (#4361)', () => {
  it('handles off, paused, forbidden, budget, empty, busy, refused, failed, and used cleanly while keeping metrics', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    const src = baseSource();

    const off = await prepareProjectCycleSummary(projectCycleSummaryAi(null, budget), 'org-1', 'user-1', src);
    expect(off.ai).toBe('off');
    expect(off.sentences).toEqual([]);
    expect(off.metrics).toEqual(src.metrics);

    const dummyReader = {
      projectCycleSummary: async () => ({ kind: 'summary' as const, sentences: ['A.', 'B.', 'C.'] }),
    };

    expect((await prepareProjectCycleSummary(projectCycleSummaryAi(dummyReader, budget), 'o', 'u', baseSource({ aiStopped: true }))).ai).toBe('paused');
    expect((await prepareProjectCycleSummary(projectCycleSummaryAi(dummyReader, budget), 'o', 'u', baseSource({ aiAllowed: false }))).ai).toBe('forbidden');
    expect((await prepareProjectCycleSummary(projectCycleSummaryAi(dummyReader, budget), 'o', 'u', baseSource({ aiBudgetSpent: true }))).ai).toBe('budget');
    expect((await prepareProjectCycleSummary(projectCycleSummaryAi(dummyReader, budget), 'o', 'u', baseSource({ cycle: null }))).ai).toBe('empty');

    const refused = await prepareProjectCycleSummary(
      projectCycleSummaryAi({ projectCycleSummary: async () => ({ kind: 'none', code: 'AI_OUTPUT_UNSAFE', badNumbers: ['99'] }) }, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 10 })),
      'o',
      'u',
      src,
    );
    expect(refused.ai).toBe('refused');

    const threwBudget = await prepareProjectCycleSummary(
      projectCycleSummaryAi({ projectCycleSummary: async () => { throw new AiBudgetExhaustedError('org', null); } }, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 10 })),
      'o',
      'u',
      src,
    );
    expect(threwBudget.ai).toBe('budget');

    const failed = await prepareProjectCycleSummary(
      projectCycleSummaryAi({ projectCycleSummary: async () => { throw new Error('boom'); } }, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 10 })),
      'o',
      'u',
      src,
    );
    expect(failed.ai).toBe('failed');

    const used = await prepareProjectCycleSummary(
      projectCycleSummaryAi(dummyReader, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 10 })),
      'o',
      'u',
      src,
    );
    expect(used.ai).toBe('used');
    expect(used.sentences).toEqual(['A.', 'B.', 'C.']);
  });
});
