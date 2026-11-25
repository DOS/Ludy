// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for kernel probation summary AI orchestration (#4448 Stage 5B).
import { describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, metered, type AiMeter } from '@ludy/agent';
import type { HrProbationPreviewResult } from '@ludy/kernel-contract';
import type { Actor, Runtime } from '@ludy/kernel-runtime';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { draftProbationSummary, hrProbationAi, type HrProbationPorts } from '../src/hr-probation-ai.ts';

const ORG_ID = '00000000-0000-7000-8000-000000000101';
const EMP_ID = '00000000-0000-7000-8000-000000000102';
const USER_ID = '00000000-0000-7000-8000-000000000103';
const ACTOR: Actor = { type: 'user', userId: USER_ID, aal: 'aal1' };
const FAKE_RUNTIME = {} as Pick<Runtime, 'execute' | 'query'>;

function samplePreview(over: Partial<HrProbationPreviewResult> = {}): HrProbationPreviewResult {
  return {
    employeeId: EMP_ID,
    employeeName: 'Nguyễn Văn A',
    linkedUserId: USER_ID,
    departmentName: 'Kỹ thuật',
    jobTitle: 'Kỹ sư phần mềm',
    probationEndOn: '2026-10-31',
    periodStart: '2026-09-01',
    periodEnd: '2026-10-31',
    projectsAvailable: true,
    completedTasksCount: 3,
    completedTasks: [
      {
        taskId: '00000000-0000-7000-8000-000000000201',
        title: 'Hoàn thiện API bảng lương',
        projectId: '00000000-0000-7000-8000-000000000301',
        projectName: 'Ludy HR',
        completedAt: '2026-10-15T10:00:00.000Z',
      },
    ],
    attendance: {
      monthCount: 2,
      annualLeaveDays: '1',
      personalPaidLeaveDays: '0',
      unpaidLeaveDays: '0',
      sicknessBhxhDays: '0',
      maternityBhxhDays: '0',
      overtimeHours: '2',
      overtimeRequestsCount: 1,
    },
    ...over,
  };
}

const okMeter: AiMeter = {
  admit: async () => {},
  record: async () => {},
};

describe('draftProbationSummary kernel orchestration (#4448)', () => {
  it('returns status used with draft note and records audit status', async () => {
    const record = vi.fn(async () => undefined);
    const ports: HrProbationPorts = {
      read: async () => ({ preview: samplePreview(), aiStopped: false, aiBudgetSpent: false }),
      isAiStopped: async () => false,
      record,
    };
    const ai = hrProbationAi(
      {
        hrProbationSummary: async (_input, opts) => {
          expect(opts?.forbidden).toEqual(['Nguyễn Văn A']);
          return { summary: 'P1 hoàn thành 3 công việc trong kỳ 2026-09-01 đến 2026-10-31.', ai: { ok: true, reason: 'ok' } };
        },
      },
      new DraftBudget(),
    );

    const out = await draftProbationSummary(ai, ports, FAKE_RUNTIME, ORG_ID, ACTOR, { employeeId: EMP_ID }, okMeter);
    expect(out).toMatchObject({
      status: 'used',
      draftNote: 'P1 hoàn thành 3 công việc trong kỳ 2026-09-01 đến 2026-10-31.',
      preview: { completedTasksCount: 3 },
    });
    expect(record).toHaveBeenCalledWith({
      employeeId: EMP_ID,
      aiStatus: 'used',
      completedTasksCount: 3,
    });
  });

  it('degrades deterministically for off, kill switch mid-flight, budget, busy, and no_data', async () => {
    const basePorts = (over: Partial<HrProbationPorts> = {}): HrProbationPorts => ({
      read: async () => ({ preview: samplePreview(), aiStopped: false, aiBudgetSpent: false }),
      isAiStopped: async () => false,
      record: async () => undefined,
      ...over,
    });

    const offOut = await draftProbationSummary(
      hrProbationAi(null, new DraftBudget()),
      basePorts(),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { employeeId: EMP_ID },
      okMeter,
    );
    expect(offOut).toMatchObject({ status: 'off', draftNote: null, preview: { completedTasksCount: 3 } });

    const killOut = await draftProbationSummary(
      hrProbationAi(
        {
          hrProbationSummary: async () => ({ summary: 'Should be discarded', ai: { ok: true, reason: 'ok' } }),
        },
        new DraftBudget(),
      ),
      basePorts({ isAiStopped: async () => true }),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { employeeId: EMP_ID },
      okMeter,
    );
    expect(killOut).toMatchObject({ status: 'off', draftNote: null });

    const budgetOut = await draftProbationSummary(
      hrProbationAi(
        {
          hrProbationSummary: async () => {
            await metered('hr.probation_summary', async () => ({
              usage: { inputTokens: 1, outputTokens: 1 },
            }));
            return { summary: 'P1', ai: { ok: true, reason: 'ok' } };
          },
        },
        new DraftBudget(),
      ),
      basePorts(),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { employeeId: EMP_ID },
      {
        admit: async () => {
          throw new AiBudgetExhaustedError('module', '100');
        },
        record: async () => {},
      },
    );
    expect(budgetOut).toMatchObject({ status: 'budget', draftNote: null });

    const busyBudget = new DraftBudget();
    const held = busyBudget.take(ORG_ID, USER_ID);
    const busyOut = await draftProbationSummary(
      hrProbationAi({ hrProbationSummary: vi.fn() }, busyBudget),
      basePorts(),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { employeeId: EMP_ID },
      okMeter,
    );
    if (held.allowed) held.release();
    expect(busyOut).toMatchObject({ status: 'busy', draftNote: null });

    const noDataOut = await draftProbationSummary(
      hrProbationAi({ hrProbationSummary: vi.fn() }, new DraftBudget()),
      basePorts({
        read: async () => ({
          preview: samplePreview({
            completedTasksCount: 0,
            completedTasks: [],
            attendance: {
              monthCount: 0,
              annualLeaveDays: '0',
              personalPaidLeaveDays: '0',
              unpaidLeaveDays: '0',
              sicknessBhxhDays: '0',
              maternityBhxhDays: '0',
              overtimeHours: '0',
              overtimeRequestsCount: 0,
            },
          }),
          aiStopped: false,
          aiBudgetSpent: false,
        }),
      }),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { employeeId: EMP_ID },
      okMeter,
    );
    expect(noDataOut).toMatchObject({ status: 'no_data', draftNote: null });
  });

  it('forwards runtime meterOptions price when charging monthly HR budget', async () => {
    const query = vi.fn(async () => ({}));
    const execute = vi.fn(async (name: string) => {
      if (name === 'kernel.ai.budget.reserve_member') {
        return { allowed: true, reservationId: '00000000-0000-7000-8000-000000000101' };
      }
      return {};
    });
    const runtimeStub: Pick<Runtime, 'execute' | 'query'> = { query, execute } as unknown as Pick<Runtime, 'execute' | 'query'>;
    const ports: HrProbationPorts = {
      read: async () => ({ preview: samplePreview(), aiStopped: false, aiBudgetSpent: false }),
      isAiStopped: async () => false,
      record: async () => undefined,
    };
    const ai = hrProbationAi(
      {
        hrProbationSummary: async () => {
          await metered('hr.probation_summary', async () => ({
            usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
          }));
          return { summary: 'P1 hoàn thành 3 công việc.', ai: { ok: true, reason: 'ok' } };
        },
      },
      new DraftBudget(),
    );

    const out = await draftProbationSummary(
      ai,
      ports,
      runtimeStub,
      ORG_ID,
      ACTOR,
      { employeeId: EMP_ID },
      'runtime',
      { price: { inputPerMTok: '2', outputPerMTok: '6' } },
    );

    expect(out.status).toBe('used');
    expect(execute).toHaveBeenCalledWith(
      'kernel.ai.budget.reserve_member',
      { module: 'hr', agentId: null, feature: 'hr.probation_summary', projectedCost: '0' },
      { actor: ACTOR, orgId: ORG_ID },
    );
    expect(execute).toHaveBeenCalledWith(
      'kernel.ai.usage.record_member',
      expect.objectContaining({
        feature: 'hr.probation_summary',
        module: 'hr',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cost: '5.000000',
        reservationId: '00000000-0000-7000-8000-000000000101',
      }),
      { actor: ACTOR, orgId: ORG_ID },
    );
  });
});
