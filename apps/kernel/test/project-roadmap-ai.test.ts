// SPDX-License-Identifier: AGPL-3.0-only
// Unit checks for Vy omnichannel roadmap signal match adapter (#4492).
import { describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError } from '@ludy/agent';
import type { RoadmapAiSignalMatchSource } from '@ludy/mod-projects';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { prepareRoadmapSignalMatch, projectRoadmapAi } from '../src/project-roadmap-ai.ts';

function sourceFixture(overrides: Partial<RoadmapAiSignalMatchSource> = {}): RoadmapAiSignalMatchSource {
  return {
    boardId: '11111111-1111-4111-8111-111111111111',
    boardTitle: 'Lo trinh 2027',
    todayVn: '2026-11-23',
    sourceType: 'crm.deal',
    sourceId: '22222222-2222-4222-8222-222222222222',
    sourceIsRecorder: false,
    meetingDetail: null,
    sourceTitle: 'Goi Enterprise',
    sourceExcerpt: 'Khach de cap xuat hoa don XML hang loat',
    accountLabel: 'Cong ty Minh Anh',
    dealValue: '25000000.00',
    dealCurrency: 'VND',
    items: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Xuat hoa don XML hang loat',
        summary: null,
        stage: 'planned',
        tainted: false,
      },
    ],
    inspectedCount: 1,
    truncated: false,
    aiStopped: false,
    aiBudgetSpent: false,
    ...overrides,
  };
}

describe('projectRoadmapAi (#4492)', () => {
  const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('refunds DraftBudget ticket on AiBudgetExhaustedError so subsequent calls are not falsely rate-limited', async () => {
    let calls = 0;
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const ai = projectRoadmapAi(
      {
        roadmapSignalMatch: async () => {
          calls += 1;
          if (calls === 1) {
            throw new AiBudgetExhaustedError('org', '2026-12-01T00:00:00.000Z');
          }
          return {
            kind: 'ok',
            suggestions: [
              {
                roadmapItemId: '33333333-3333-4333-8333-333333333333',
                confidence: 'high',
                reason: 'Khach de cap xuat hoa don XML',
              },
            ],
            newIdeaDraft: null,
          };
        },
      },
      budget,
    );

    const first = await prepareRoadmapSignalMatch(ai, orgId, userId, sourceFixture(), 'vi');
    expect(first.ai).toBe('budget');
    expect(first.suggestions).toEqual([]);

    const second = await prepareRoadmapSignalMatch(ai, orgId, userId, sourceFixture(), 'vi');
    expect(second.ai).toBe('used');
    expect(second.suggestions).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('short-circuits on off, paused, budget-spent, and empty guards without invoking reader', async () => {
    let calls = 0;
    const reader = {
      roadmapSignalMatch: async () => {
        calls += 1;
        return { kind: 'none' as const, code: 'EMPTY' as const };
      },
    };
    const off = await prepareRoadmapSignalMatch(projectRoadmapAi(null, new DraftBudget()), orgId, userId, sourceFixture(), 'vi');
    expect(off.ai).toBe('off');

    const paused = await prepareRoadmapSignalMatch(projectRoadmapAi(reader, new DraftBudget()), orgId, userId, sourceFixture({ aiStopped: true }), 'vi');
    expect(paused.ai).toBe('paused');

    const spent = await prepareRoadmapSignalMatch(projectRoadmapAi(reader, new DraftBudget()), orgId, userId, sourceFixture({ aiBudgetSpent: true }), 'vi');
    expect(spent.ai).toBe('budget');

    const empty = await prepareRoadmapSignalMatch(
      projectRoadmapAi(reader, new DraftBudget()),
      orgId,
      userId,
      sourceFixture({ sourceTitle: '', sourceExcerpt: '' }),
      'vi',
    );
    expect(empty.ai).toBe('empty');

    expect(calls).toBe(0);
  });
});
