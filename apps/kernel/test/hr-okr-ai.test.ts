// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for kernel OKR check-in draft orchestration and AI-off parity (#4529 Stage 6D).
import { describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, metered, type AiMeter } from '@ludy/agent';
import type { HrOkrDraftReadResult } from '@ludy/kernel-contract';
import type { Actor, Runtime } from '@ludy/kernel-runtime';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { draftOkrCheckinSummary, hrOkrAi, type HrOkrPorts } from '../src/hr-okr-ai.ts';

const ORG_ID = '00000000-0000-7000-8000-000000000201';
const KR_ID = '00000000-0000-7000-8000-000000000202';
const OBJ_ID = '00000000-0000-7000-8000-000000000203';
const EMP_ID = '00000000-0000-7000-8000-000000000204';
const USER_ID = '00000000-0000-7000-8000-000000000205';
const ACTOR: Actor = { type: 'user', userId: USER_ID, aal: 'aal1' };
const FAKE_RUNTIME = {} as Pick<Runtime, 'execute' | 'query'>;

function sampleFacts(over: Partial<HrOkrDraftReadResult> = {}): HrOkrDraftReadResult {
  return {
    keyResultId: KR_ID,
    objectiveId: OBJ_ID,
    quarter: '2026-Q4',
    objectiveScope: 'individual',
    objectiveTitle: 'Tối ưu giao hàng nội thành',
    keyResultTitle: 'Hoàn thành 4 bước tự động hóa đơn hàng',
    metricType: 'project_tasks',
    targetValue: '4',
    currentValue: '3',
    unit: 'công việc',
    progressPct: '75',
    ownerEmployeeId: EMP_ID,
    ownerName: 'Nguyễn Văn A',
    departmentName: 'Vận hành',
    lastCheckinNote: null,
    lastCheckinAt: null,
    projectsAvailable: true,
    projectAccessible: true,
    linkedProjectName: 'Vận hành Q4',
    completedLinkedTasks: 3,
    totalLinkedTasks: 4,
    linkedTaskTitles: [
      { title: 'Kết nối đơn vị vận chuyển', completed: true },
      { title: 'Kiểm thử luồng đối soát', completed: false },
    ],
    ...over,
  };
}

const okMeter: AiMeter = {
  admit: async () => {},
  record: async () => {},
};

describe('draftOkrCheckinSummary kernel orchestration (#4529)', () => {
  it('returns status used with pseudonymized forbidden ownerName and deterministic fallback', async () => {
    const record = vi.fn(async () => undefined);
    const ports: HrOkrPorts = {
      read: async () => ({ facts: sampleFacts(), aiStopped: false, aiBudgetSpent: false }),
      isAiStopped: async () => false,
      record,
    };
    const ai = hrOkrAi(
      {
        hrOkrCheckinDraft: async (_input, opts) => {
          expect(opts?.forbidden).toEqual(['Nguyễn Văn A']);
          return {
            draft: 'Trong quý 2026-Q4, P1 đã đạt 3/4 công việc (75%) cho dự án Vận hành Q4.',
            ai: { ok: true, reason: 'ok' },
          };
        },
      },
      new DraftBudget(),
    );

    const out = await draftOkrCheckinSummary(ai, ports, FAKE_RUNTIME, ORG_ID, ACTOR, { keyResultId: KR_ID }, okMeter);
    expect(out.status).toBe('used');
    expect(out.draftNote).toContain('75%');
    expect(out.deterministicSummary).toContain('2026-Q4');
    expect(out.deterministicSummary).toContain('3/4');
    expect(record).toHaveBeenCalledWith({
      keyResultId: KR_ID,
      aiStatus: 'used',
      progressPct: '75',
      completedLinkedTasks: 3,
    });
  });

  it('preserves full deterministicSummary when AI is off, kill-switched, budgeted, busy, or no_data', async () => {
    const basePorts = (over: Partial<HrOkrPorts> = {}): HrOkrPorts => ({
      read: async () => ({ facts: sampleFacts(), aiStopped: false, aiBudgetSpent: false }),
      isAiStopped: async () => false,
      record: async () => undefined,
      ...over,
    });

    const offOut = await draftOkrCheckinSummary(
      hrOkrAi(null, new DraftBudget()),
      basePorts(),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID, lang: 'en' },
      okMeter,
    );
    expect(offOut).toMatchObject({
      status: 'off',
      draftNote: null,
      progressPct: '75',
      completedLinkedTasks: 3,
      totalLinkedTasks: 4,
    });
    expect(offOut.deterministicSummary).toContain('2026-Q4');
    expect(offOut.deterministicSummary).toContain('75%');

    const killOut = await draftOkrCheckinSummary(
      hrOkrAi({ hrOkrCheckinDraft: async () => ({ draft: 'should not send', ai: { ok: true, reason: 'ok' } }) }, new DraftBudget()),
      basePorts({ isAiStopped: async () => true }),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID },
      {
        admit: async () => {},
        record: async () => {},
      },
    );
    expect(killOut.status).toBe('off');
    expect(killOut.draftNote).toBeNull();
    expect(killOut.deterministicSummary).toContain('2026-Q4');

    const budgetOut = await draftOkrCheckinSummary(
      hrOkrAi(
        {
          hrOkrCheckinDraft: async () =>
            metered('hr.okr_checkin_draft', async () => {
              throw new AiBudgetExhaustedError('module', null);
            }),
        },
        new DraftBudget(),
      ),
      basePorts(),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID },
      {
        admit: async () => {
          throw new AiBudgetExhaustedError('module', null);
        },
        record: async () => {},
      },
    );
    expect(budgetOut.status).toBe('budget');
    expect(budgetOut.draftNote).toBeNull();

    const noDataOut = await draftOkrCheckinSummary(
      hrOkrAi({ hrOkrCheckinDraft: async () => ({ draft: 'unused', ai: { ok: true, reason: 'ok' } }) }, new DraftBudget()),
      basePorts({
        read: async () => ({
          facts: sampleFacts({
            currentValue: '0',
            progressPct: '0',
            totalLinkedTasks: 0,
            completedLinkedTasks: 0,
            linkedTaskTitles: [],
          }),
          aiStopped: false,
          aiBudgetSpent: false,
        }),
      }),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID },
      okMeter,
    );
    expect(noDataOut.status).toBe('no_data');
    expect(noDataOut.draftNote).toBeNull();
    expect(noDataOut.deterministicSummary).toContain('0/4');
  });
});
