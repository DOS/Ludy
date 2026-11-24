// SPDX-License-Identifier: AGPL-3.0-only
// API orchestrator unit tests for prepareProjectTriageAssist (#4493, ADR-0058, ADR-0041 §8):
// covers conversation auto_draft opt-out, ticket refund on AiBudgetExhaustedError, and guard states.
import { describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError } from '@ludy/agent';
import type { ProjectTriageAssistSource } from '@ludy/mod-projects';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { prepareProjectTriageAssist, projectTriageAi } from '../src/project-triage-ai.ts';

const ITEM_1 = '00000000-0000-4000-8000-000000000401';
const PROJECT_1 = '00000000-0000-4000-8000-000000000011';
const SEAT_1 = '00000000-0000-4000-8000-000000000101';
const CYCLE_1 = '00000000-0000-4000-8000-000000000201';

const baseSource = (
  over: Partial<ProjectTriageAssistSource> = {},
  itemOver: Partial<ProjectTriageAssistSource['item']> = {},
): ProjectTriageAssistSource => ({
  item: {
    id: ITEM_1,
    projectId: PROJECT_1,
    projectName: 'Kế hoạch Q4',
    sourceType: 'manual',
    sourceId: null,
    status: 'pending',
    priority: 'medium',
    title: 'Tối ưu báo cáo tuần',
    description: 'Kiểm tra câu lệnh lọc theo tuần.',
    tainted: false,
    ...itemOver,
  },
  candidates: {
    seats: [{ positionId: SEAT_1, label: 'Kỹ sư chính (Lan)' }],
    cycles: [{ cycleId: CYCLE_1, label: '#1 Tuần 1', status: 'active' }],
    tasks: [],
  },
  todayVn: '2026-11-23',
  aiStopped: false,
  aiBudgetSpent: false,
  ...over,
});

describe('prepareProjectTriageAssist (#4493)', () => {
  it('short-circuits conversation items when conversationAutoDraft is false with zero model calls and zero DraftBudget spend', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const spyAssist = vi.fn(async () => ({
      kind: 'ok' as const,
      proposal: {
        recommendedPriority: 'high' as const,
        suggestedAssigneePositionId: SEAT_1,
        suggestedAssigneeLabel: 'Kỹ sư chính (Lan)',
        suggestedCycleId: CYCLE_1,
        suggestedCycleLabel: '#1 Tuần 1',
        duplicateTaskId: null,
        duplicateTaskTitle: null,
        reason: 'Nên giao Kỹ sư chính xử lý.',
      },
    }));

    const offConv = await prepareProjectTriageAssist(
      projectTriageAi({ projectTriageAssist: spyAssist }, budget),
      'org-1',
      'user-1',
      baseSource({}, { sourceType: 'kernel.conversation', sourceId: '00000000-0000-4000-8000-000000000901', tainted: true }),
      'vi',
      { conversationAutoDraft: false },
    );
    expect(offConv).toEqual({ ai: 'off', proposal: null });
    expect(spyAssist).not.toHaveBeenCalled();

    // DraftBudget still has its 1-per-minute quota untouched, and non-conversation sources ignore conversationAutoDraft.
    const manualUsed = await prepareProjectTriageAssist(
      projectTriageAi({ projectTriageAssist: spyAssist }, budget),
      'org-1',
      'user-1',
      baseSource({}, { sourceType: 'manual', tainted: false }),
      'vi',
      { conversationAutoDraft: false },
    );
    expect(manualUsed.ai).toBe('used');
    expect(spyAssist).toHaveBeenCalledTimes(1);
  });

  it('refunds DraftBudget ticket when AiBudgetExhaustedError is thrown and handles all guard states', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });

    // 1. Model throws AiBudgetExhaustedError -> returns budget AND refunds DraftBudget ticket.
    const exhausted = await prepareProjectTriageAssist(
      projectTriageAi(
        {
          projectTriageAssist: async () => {
            throw new AiBudgetExhaustedError('org', null);
          },
        },
        budget,
      ),
      'org-2',
      'user-2',
      baseSource(),
      'vi',
    );
    expect(exhausted).toEqual({ ai: 'budget', proposal: null });

    // Ticket was refunded cleanly, so a subsequent immediate call passes DraftBudget and succeeds.
    const recovered = await prepareProjectTriageAssist(
      projectTriageAi(
        {
          projectTriageAssist: async () => ({
            kind: 'ok' as const,
            proposal: {
              recommendedPriority: 'urgent' as const,
              suggestedAssigneePositionId: null,
              suggestedAssigneeLabel: null,
              suggestedCycleId: null,
              suggestedCycleLabel: null,
              duplicateTaskId: null,
              duplicateTaskTitle: null,
              reason: 'Ưu tiên gấp.',
            },
          }),
        },
        budget,
      ),
      'org-2',
      'user-2',
      baseSource(),
      'vi',
    );
    expect(recovered.ai).toBe('used');

    // Guard states: off, paused, budget, refused, empty, failed.
    const unusedBudget = new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 10 });
    expect((await prepareProjectTriageAssist(projectTriageAi(null, unusedBudget), 'o', 'u', baseSource())).ai).toBe('off');
    expect(
      (await prepareProjectTriageAssist(projectTriageAi({ projectTriageAssist: async () => ({ kind: 'none', code: 'EMPTY' }) }, unusedBudget), 'o', 'u', baseSource({ aiStopped: true }))).ai,
    ).toBe('paused');
    expect(
      (await prepareProjectTriageAssist(projectTriageAi({ projectTriageAssist: async () => ({ kind: 'none', code: 'EMPTY' }) }, unusedBudget), 'o', 'u', baseSource({ aiBudgetSpent: true }))).ai,
    ).toBe('budget');
    expect(
      (await prepareProjectTriageAssist(projectTriageAi({ projectTriageAssist: async () => ({ kind: 'none', code: 'AI_OUTPUT_UNSAFE' }) }, unusedBudget), 'o', 'u', baseSource())).ai,
    ).toBe('refused');
    expect(
      (await prepareProjectTriageAssist(projectTriageAi({ projectTriageAssist: async () => ({ kind: 'none', code: 'EMPTY' }) }, unusedBudget), 'o', 'u', baseSource())).ai,
    ).toBe('empty');
    expect(
      (
        await prepareProjectTriageAssist(
          projectTriageAi({ projectTriageAssist: async () => { throw new Error('upstream down'); } }, unusedBudget),
          'o',
          'u',
          baseSource(),
        )
      ).ai,
    ).toBe('failed');
  });
});
