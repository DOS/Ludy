// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for kernel OKR check-in draft orchestration and AI-off parity (#4529 Stage 6D).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, AiMeterMissingError, InboxReader, metered, type AiMeter } from '@ludy/agent';
import type { HrOkrDraftReadResult } from '@ludy/kernel-contract';
import { DomainError, type Actor, type Runtime } from '@ludy/kernel-runtime';
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates AiMeterMissingError and admit-time DomainError while refunding DraftBudget pre-flight', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    const ports: HrOkrPorts = {
      read: async () => ({ facts: sampleFacts(), aiStopped: false, aiBudgetSpent: false }),
      isAiStopped: async () => false,
      record: async () => undefined,
    };

    await expect(
      draftOkrCheckinSummary(
        hrOkrAi({ hrOkrCheckinDraft: async () => { throw new AiMeterMissingError('hr.okr_checkin_draft'); } }, budget),
        ports,
        FAKE_RUNTIME,
        ORG_ID,
        ACTOR,
        { keyResultId: KR_ID },
        okMeter,
      ),
    ).rejects.toBeInstanceOf(AiMeterMissingError);

    const reader = new InboxReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        hrOkrCheckinDraft: async () => {
          const res = await metered('hr.okr_checkin_draft', async () => ({
            output: { draft: 'Trong quý 2026-Q4, P1 đã đạt 3/4 công việc (75%) cho dự án Vận hành Q4.' },
            usage: { inputTokens: 15, outputTokens: 10 },
          }));
          return { output: res.output, usage: res.usage };
        },
      },
    );

    await expect(
      draftOkrCheckinSummary(
        hrOkrAi(reader, budget),
        ports,
        FAKE_RUNTIME,
        ORG_ID,
        ACTOR,
        { keyResultId: KR_ID },
        {
          admit: async () => {
            throw new DomainError('FORBIDDEN', 403, 'denied');
          },
          record: async () => {},
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Ticket refunded: immediate retry succeeds instead of hitting DraftBudget rate limit.
    const followUp = await draftOkrCheckinSummary(
      hrOkrAi(reader, budget),
      ports,
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID },
      okMeter,
    );
    expect(followUp.status).toBe('used');
    expect(followUp.draftNote).toContain('P1');
  });

  it('refunds DraftBudget on mid-admit kill switch or pre-flight leak, distinguishes budget vs busy, and logs non-PII audit failures', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    const modelSpy = vi.fn();
    let stopped = false;

    const reader = new InboxReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        hrOkrCheckinDraft: async () => {
          const res = await metered('hr.okr_checkin_draft', async () => {
            modelSpy();
            return {
              output: { draft: 'Trong quý 2026-Q4, P1 đã đạt 3/4 công việc (75%) cho dự án Vận hành Q4.' },
              usage: { inputTokens: 15, outputTokens: 10 },
            };
          });
          return { output: res.output, usage: res.usage };
        },
      },
    );

    const killed = await draftOkrCheckinSummary(
      hrOkrAi(reader, budget),
      {
        read: async () => ({ facts: sampleFacts(), aiStopped: false, aiBudgetSpent: false }),
        isAiStopped: async () => stopped,
        record: async () => undefined,
      },
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID },
      {
        admit: async () => {
          stopped = true;
        },
        record: async () => {},
      },
    );
    expect(killed.status).toBe('off');
    expect(modelSpy).not.toHaveBeenCalled();

    // Ticket refunded: pre-flight PayrollPromptLeakError (forbidden name leaked in structured quarter field) also refunds.
    stopped = false;
    const leaked = await draftOkrCheckinSummary(
      hrOkrAi(reader, budget),
      {
        read: async () => ({
          facts: sampleFacts({ linkedProjectName: 'Vận hành', quarter: 'Nguyễn Văn A' }),
          aiStopped: false,
          aiBudgetSpent: false,
        }),
        isAiStopped: async () => false,
        record: async () => undefined,
      },
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID },
      okMeter,
    );
    expect(leaked.status).toBe('failed');
    expect(modelSpy).not.toHaveBeenCalled();

    // Ticket refunded: admit-time AiBudgetExhaustedError returns budget (not busy) and refunds DraftBudget.
    const budgetExceeded = await draftOkrCheckinSummary(
      hrOkrAi(reader, budget),
      {
        read: async () => ({ facts: sampleFacts(), aiStopped: false, aiBudgetSpent: false }),
        isAiStopped: async () => false,
        record: async () => undefined,
      },
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID },
      {
        admit: async () => {
          throw new AiBudgetExhaustedError('module', '2026-12-01T00:00:00Z');
        },
        record: async () => {},
      },
    );
    expect(budgetExceeded.status).toBe('budget');

    // First real call succeeds and consumes the single DraftBudget slot.
    const firstOk = await draftOkrCheckinSummary(
      hrOkrAi(reader, budget),
      {
        read: async () => ({ facts: sampleFacts(), aiStopped: false, aiBudgetSpent: false }),
        isAiStopped: async () => false,
        record: async () => undefined,
      },
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID },
      okMeter,
    );
    expect(firstOk.status).toBe('used');
    expect(modelSpy).toHaveBeenCalledTimes(1);

    // Second immediate call hits DraftBudget -> busy (not budget), and failing audit logs non-PII error name only.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const busy = await draftOkrCheckinSummary(
      hrOkrAi(reader, budget),
      {
        read: async () => ({ facts: sampleFacts(), aiStopped: false, aiBudgetSpent: false }),
        isAiStopped: async () => false,
        record: async () => {
          throw new TypeError('audit failed for Nguyễn Văn A');
        },
      },
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      { keyResultId: KR_ID },
      okMeter,
    );
    expect(busy.status).toBe('busy');
    expect(errSpy).toHaveBeenCalledWith('[hr-okr-ai] draft audit write failed', 'TypeError');
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('Nguyễn Văn A');
  });
});
