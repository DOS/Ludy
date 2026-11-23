// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError } from '@ludy/agent';
import type { ProjectWeeklyStatusSource } from '@ludy/mod-projects';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { prepareProjectWeeklyStatus, projectWeeklyStatusAi } from '../src/project-weekly-status-ai.ts';

function sourceFixture(overrides: Partial<ProjectWeeklyStatusSource> = {}): ProjectWeeklyStatusSource {
  return {
    project: { id: '11111111-1111-4111-8111-111111111111', name: 'Mùa cao điểm', status: 'active' },
    window: { from: '2026-11-10', to: '2026-11-16', nextFrom: '2026-11-17', nextTo: '2026-11-23', timeZone: 'Asia/Ho_Chi_Minh' },
    counts: { totalVisible: 4, doneThisWeek: 1, overdue: 1, waiting: 1, dueNextWeek: 1 },
    tasks: {
      doneThisWeek: [{ id: '22222222-2222-4222-8222-222222222221', title: 'Chốt báo giá', tainted: false, status: 'done', due: '2026-11-12T03:00:00.000Z', commentCount: 1, latestComment: 'Khách đã duyệt.' }],
      overdue: [{ id: '22222222-2222-4222-8222-222222222222', title: 'Ký hợp đồng', tainted: false, status: 'in_progress', due: '2026-11-09T03:00:00.000Z', commentCount: 0, latestComment: null }],
      waiting: [{ id: '22222222-2222-4222-8222-222222222223', title: 'Chờ nghiệm thu', tainted: false, status: 'waiting', due: null, commentCount: 0, latestComment: null }],
      dueNextWeek: [{ id: '22222222-2222-4222-8222-222222222224', title: 'Xuất hóa đơn', tainted: false, status: 'todo', due: '2026-11-18T03:00:00.000Z', commentCount: 0, latestComment: null }],
    },
    hiddenByEntityCount: 2,
    truncated: false,
    aiAllowed: true,
    aiStopped: false,
    aiBudgetSpent: false,
    ...overrides,
  };
}

describe('projectWeeklyStatusAi (#2597)', () => {
  const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns Vy sentences when allowed and passes every guard, preserving exact deterministic facts', async () => {
    const ai = projectWeeklyStatusAi(
      {
        projectWeeklyStatus: async (facts) => {
          expect(facts.language).toBe('vi');
          expect(facts.counts.doneThisWeek).toBe(1);
          expect(facts.tasks.overdue[0]?.dueDay).toBe('2026-11-09');
          return {
            kind: 'summary',
            sentences: [
              'Tuần này dự án hoàn thành 1 việc là Chốt báo giá.',
              'Hiện có 1 việc quá hạn từ 9/11 là Ký hợp đồng.',
              'Ngoài ra còn 1 việc đang chờ và 1 việc đến hạn tuần tới.',
            ],
          };
        },
      },
      new DraftBudget(),
    );

    const out = await prepareProjectWeeklyStatus(ai, orgId, userId, sourceFixture(), 'vi');
    expect(out.ai).toBe('used');
    expect(out.sentences).toHaveLength(3);
    expect(out.counts).toEqual({ totalVisible: 4, doneThisWeek: 1, overdue: 1, waiting: 1, dueNextWeek: 1 });
    expect(out.hiddenByEntityCount).toBe(2);
  });

  it('keeps deterministic counts when AI is off, kill-switched, budget-spent, viewer-forbidden or empty without calling reader', async () => {
    let calls = 0;
    const reader = {
      projectWeeklyStatus: async () => {
        calls += 1;
        return { kind: 'none' as const, code: 'EMPTY' as const };
      },
    };

    const off = await prepareProjectWeeklyStatus(projectWeeklyStatusAi(null, new DraftBudget()), orgId, userId, sourceFixture());
    expect(off.ai).toBe('off');
    expect(off.sentences).toEqual([]);
    expect(off.counts.overdue).toBe(1);

    const paused = await prepareProjectWeeklyStatus(projectWeeklyStatusAi(reader, new DraftBudget()), orgId, userId, sourceFixture({ aiStopped: true }));
    expect(paused.ai).toBe('paused');
    expect(paused.counts.doneThisWeek).toBe(1);

    const forbidden = await prepareProjectWeeklyStatus(projectWeeklyStatusAi(reader, new DraftBudget()), orgId, userId, sourceFixture({ aiAllowed: false }));
    expect(forbidden.ai).toBe('forbidden');
    expect(forbidden.counts.waiting).toBe(1);

    const budget = await prepareProjectWeeklyStatus(projectWeeklyStatusAi(reader, new DraftBudget()), orgId, userId, sourceFixture({ aiBudgetSpent: true }));
    expect(budget.ai).toBe('budget');
    expect(budget.counts.dueNextWeek).toBe(1);

    const empty = await prepareProjectWeeklyStatus(
      projectWeeklyStatusAi(reader, new DraftBudget()),
      orgId,
      userId,
      sourceFixture({
        counts: { totalVisible: 0, doneThisWeek: 0, overdue: 0, waiting: 0, dueNextWeek: 0 },
        tasks: { doneThisWeek: [], overdue: [], waiting: [], dueNextWeek: [] },
      }),
    );
    expect(empty.ai).toBe('empty');
    expect(calls).toBe(0);
  });

  it('maps refused output, AiBudgetExhaustedError, transient errors and per-member rate limits cleanly', async () => {
    const refusedAi = projectWeeklyStatusAi(
      {
        projectWeeklyStatus: async () => ({ kind: 'none', code: 'AI_OUTPUT_UNSAFE', badNumbers: ['99'] }),
      },
      new DraftBudget(),
    );
    const refused = await prepareProjectWeeklyStatus(refusedAi, orgId, userId, sourceFixture());
    expect(refused.ai).toBe('refused');
    expect(refused.sentences).toEqual([]);
    expect(refused.counts.overdue).toBe(1);

    const exhaustedAi = projectWeeklyStatusAi(
      {
        projectWeeklyStatus: async () => {
          throw new AiBudgetExhaustedError('org', '2026-12-01T00:00:00.000Z');
        },
      },
      new DraftBudget(),
    );
    const exhausted = await prepareProjectWeeklyStatus(exhaustedAi, orgId, userId, sourceFixture());
    expect(exhausted.ai).toBe('budget');
    expect(exhausted.sentences).toEqual([]);

    const brokenAi = projectWeeklyStatusAi(
      {
        projectWeeklyStatus: async () => {
          throw new Error('upstream timeout');
        },
      },
      new DraftBudget(),
    );
    const failed = await prepareProjectWeeklyStatus(brokenAi, orgId, userId, sourceFixture());
    expect(failed.ai).toBe('failed');
    expect(failed.sentences).toEqual([]);

    const tinyBudget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const busyAi = projectWeeklyStatusAi(
      {
        projectWeeklyStatus: async () => ({
          kind: 'summary',
          sentences: ['Hoàn thành 1 việc.', 'Quá hạn 1 việc.', 'Tuần tới 1 việc.'],
        }),
      },
      tinyBudget,
    );
    const first = await prepareProjectWeeklyStatus(busyAi, orgId, userId, sourceFixture());
    expect(first.ai).toBe('used');
    const second = await prepareProjectWeeklyStatus(busyAi, orgId, userId, sourceFixture());
    expect(second.ai).toBe('busy');
    expect(second.sentences).toEqual([]);
  });
});
