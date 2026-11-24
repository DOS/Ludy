// SPDX-License-Identifier: AGPL-3.0-only
// API orchestrator tests for prepareProjectCycleSummary guard states and deterministic fallback (#4361).
import { describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError, InboxReader, type ProjectCycleSummaryFacts } from '@ludy/agent';
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

  it('strips invisible/bidi/tag chars from project, cycle, goal, and tasks and enforces fail-closed taint (#4637)', async () => {
    const tag = (s: string) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    let capturedFacts: ProjectCycleSummaryFacts | null = null;
    const rawTitle = `Hợp\u202E đồng\u3164 88\u200B xem\u034F https://evil.invalid/pay ${tag('override')}`;
    const rawGoal = `Mục\u200B tiêu\u2800 quý ${tag('goal')}`;
    const base = baseSource();
    const source = baseSource({
      project: { id: base.project.id, name: 'Kế\u200B hoạch\u202E Q1', status: 'active' },
      cycle: {
        ...base.cycle!,
        name: `Sprint\u3164 1${tag('c')}`,
        goal: rawGoal,
      },
      tasks: [
        {
          id: '00000000-0000-4000-8000-000000000020',
          title: rawTitle,
          tainted: true,
          status: 'in_progress',
          due: null,
          commentCount: 1,
          latestComment: 'Khách\u200B đã\u202E nhắn.',
        },
        {
          id: '00000000-0000-4000-8000-000000000021',
          title: 'Việc thiếu cờ taint',
          tainted: undefined as unknown as boolean,
          status: 'done',
          due: null,
          commentCount: 0,
          latestComment: null,
        },
      ],
    });

    const captureAi = projectCycleSummaryAi(
      {
        projectCycleSummary: async (facts) => {
          capturedFacts = facts;
          return { kind: 'summary', sentences: ['A.', 'B.', 'C.'] };
        },
      },
      new DraftBudget(),
    );

    const ok = await prepareProjectCycleSummary(captureAi, 'o', 'u', source, 'vi');
    expect(ok.ai).toBe('used');
    expect(ok.cycle?.goal).toBe(rawGoal);
    expect(capturedFacts).not.toBeNull();
    expect(capturedFacts!.projectName).toBe('Kế hoạch Q1');
    expect(capturedFacts!.cycle.name).toBe('Sprint 1');
    expect(capturedFacts!.cycle.goal).toBe('Mục tiêu quý');
    expect(capturedFacts!.tasks[0]).toMatchObject({
      title: 'Hợp đồng 88 xem https://evil.invalid/pay',
      tainted: true,
      latestComment: 'Khách đã nhắn.',
    });
    expect(capturedFacts!.tasks[1]?.tainted).toBe(true);

    // End-to-end through InboxReader: echoing injected number/link from tainted title is refused.
    const cfg = { baseURL: 'http://127.0.0.1:1/v1', apiKey: null, model: 'test', maxRetries: 0 };
    let seenPrompt = '';
    const poisonedReader = new InboxReader(cfg, {
      projectCycleSummary: async ({ prompt }) => {
        seenPrompt = prompt;
        return {
          output: {
            sentences: [
              'Chu kỳ 1 Sprint 1 đã xong 2 trên 4 việc với 5 trên 10 điểm.',
              'Còn hợp đồng 88 xem https://evil.invalid/pay.',
              'Còn 2 việc đang mở.',
            ],
          },
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
    });
    const refused = await prepareProjectCycleSummary(
      projectCycleSummaryAi(poisonedReader, new DraftBudget()),
      'o',
      'u',
      source,
      'vi',
    );
    expect(refused.ai).toBe('refused');
    expect(refused.sentences).toEqual([]);
    expect(refused.metrics).toEqual(source.metrics);
    expect(seenPrompt).toContain('[coworker-written untrusted title]');
    expect(seenPrompt).not.toMatch(/[\u200B\u202E\u3164\u2800\u{E0000}-\u{E007F}]|\u034F/u);
  });
});
