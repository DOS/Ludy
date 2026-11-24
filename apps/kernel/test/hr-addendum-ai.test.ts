// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for kernel addendum AI orchestration (#4528 Stage 6C, #4613):
// error propagation (AiMeterMissingError, DomainError, HrAddendumAiStoppedError),
// DraftBudget pre-flight refunds, rate_limited vs budget_exhausted distinction, and audit log resilience.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiBudgetExhaustedError,
  AiMeterMissingError,
  InboxReader,
  metered,
  type AiMeter,
} from '@ludy/agent';
import { DomainError, type Actor, type Runtime } from '@ludy/kernel-runtime';
import type { HrAddendumCheckSource } from '@ludy/mod-hr';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { checkAddendumDraft, hrAddendumAi, type HrAddendumPorts } from '../src/hr-addendum-ai.ts';

const ORG_ID = '00000000-0000-7000-8000-000000000301';
const EMP_ID = '00000000-0000-7000-8000-000000000302';
const EMPLOYMENT_ID = '00000000-0000-7000-8000-000000000303';
const USER_ID = '00000000-0000-7000-8000-000000000304';
const ACTOR: Extract<Actor, { type: 'user' }> = { type: 'user', userId: USER_ID, aal: 'aal1' };
const FAKE_RUNTIME = {} as Pick<Runtime, 'execute' | 'query'>;
const READER_CONFIG = { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 };

function sampleSource(over: Partial<HrAddendumCheckSource> = {}): HrAddendumCheckSource {
  return {
    employeeId: EMP_ID,
    employmentId: EMPLOYMENT_ID,
    contractType: 'indefinite',
    employmentEffectiveFrom: '2026-01-15',
    currentTitle: 'Chuyên viên',
    currentBaseWage: '15000000',
    addendumNumber: 'PL-2026-01',
    effectiveOn: '2026-12-01',
    changeSummary: 'Điều chỉnh mức lương cơ bản theo thỏa thuận hai bên.',
    previousPayRate: '15000000',
    newPayRate: '18000000',
    previousTitle: 'Chuyên viên',
    newTitle: 'Trưởng nhóm',
    forbiddenTerms: ['Nguyễn Văn An'],
    ...over,
  };
}

function makePorts(over: Partial<HrAddendumPorts> = {}, sourceOver: Partial<HrAddendumCheckSource> = {}): HrAddendumPorts {
  return {
    read: async () => sampleSource(sourceOver),
    isAiStopped: async () => false,
    record: async () => ({ ok: true }),
    ...over,
  };
}

const okMeter: AiMeter = {
  admit: async () => {},
  record: async () => {},
};

const askInput = {
  employeeId: EMP_ID,
  employmentId: EMPLOYMENT_ID,
  language: 'vi' as const,
};

describe('checkAddendumDraft kernel AI orchestration (#4613)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates AiMeterMissingError and admit-time auth/not-found DomainError, refunding DraftBudget on admit reject', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });

    // Unmetered inner generator throws AiMeterMissingError -> propagates through reviewAddendumDraft -> checkAddendumDraft.
    await expect(
      checkAddendumDraft(
        hrAddendumAi(
          {
            hrAddendumCheck: async () => {
              throw new AiMeterMissingError('hr.addendum_check');
            },
          },
          budget,
        ),
        makePorts(),
        FAKE_RUNTIME,
        ORG_ID,
        ACTOR,
        askInput,
        okMeter,
      ),
    ).rejects.toBeInstanceOf(AiMeterMissingError);

    // Admit-time 403 DomainError propagates and refunds DraftBudget ticket.
    const realReader = new InboxReader(READER_CONFIG, {
      hrAddendumCheck: async ({ prompt }) => {
        expect(prompt).toContain('Subject alias: P1');
        const res = await metered('hr.addendum_check', async () => ({
          output: { note: 'P1 có đầy đủ ngày hiệu lực 2026-12-01 và điều chỉnh lương từ 15.000.000 lên 18.000.000.' },
          usage: { inputTokens: 20, outputTokens: 10 },
        }));
        return { output: res.output, usage: res.usage };
      },
    });

    await expect(
      checkAddendumDraft(
        hrAddendumAi(realReader, budget),
        makePorts(),
        FAKE_RUNTIME,
        ORG_ID,
        ACTOR,
        askInput,
        {
          admit: async () => {
            throw new DomainError('FORBIDDEN', 403, 'denied');
          },
          record: async () => {},
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Refunded: immediate follow-up with okMeter succeeds instead of hitting DraftBudget rate limit.
    const followUp = await checkAddendumDraft(
      hrAddendumAi(realReader, budget),
      makePorts(),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      askInput,
      okMeter,
    );
    expect(followUp.ai).toEqual({ ok: true, reason: 'ok' });
    expect(followUp.lyNote).toContain('P1');
  });

  it('refunds DraftBudget when kill switch engages during baseMeter.admit or PayrollPromptLeakError fires pre-flight', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    const providerSpy = vi.fn();
    let stopped = false;

    const reader = new InboxReader(READER_CONFIG, {
      hrAddendumCheck: async () => {
        const res = await metered('hr.addendum_check', async () => {
          providerSpy();
          return {
            output: { note: 'P1 có đầy đủ ngày hiệu lực 2026-12-01 và điều chỉnh lương từ 15.000.000 lên 18.000.000.' },
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        });
        return { output: res.output, usage: res.usage };
      },
    });

    // Mid-admit kill switch engages during baseMeter.admit -> HrAddendumAiStoppedError propagates through reviewAddendumDraft.
    const killed = await checkAddendumDraft(
      hrAddendumAi(reader, budget),
      makePorts({ isAiStopped: async () => stopped }),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      askInput,
      {
        admit: async () => {
          stopped = true;
        },
        record: async () => {},
      },
    );
    expect(killed.ai).toEqual({ ok: false, reason: 'kill_switch' });
    expect(killed.lyNote).toBeNull();
    expect(providerSpy).not.toHaveBeenCalled();

    // Ticket refunded: pre-flight PayrollPromptLeakError also refunds ticket and returns leak_refused.
    stopped = false;
    const leakedPrompt = await checkAddendumDraft(
      hrAddendumAi(reader, budget),
      makePorts({}, { contractType: 'Nguyễn Văn An' }),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      askInput,
      okMeter,
    );
    expect(leakedPrompt.ai).toEqual({ ok: false, reason: 'leak_refused' });
    expect(leakedPrompt.lyNote).toBeNull();
    expect(providerSpy).not.toHaveBeenCalled();

    // Ticket still available after both pre-flight rejections!
    const okRes = await checkAddendumDraft(
      hrAddendumAi(reader, budget),
      makePorts(),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      askInput,
      okMeter,
    );
    expect(okRes.ai).toEqual({ ok: true, reason: 'ok' });
    expect(providerSpy).toHaveBeenCalledTimes(1);
  });

  it('distinguishes in-memory DraftBudget rate_limited from AiBudgetExhaustedError budget_exhausted and logs audit failures', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 10 });
    const reader = new InboxReader(READER_CONFIG, {
      hrAddendumCheck: async () => {
        const res = await metered('hr.addendum_check', async () => ({
          output: { note: 'P1 có đầy đủ ngày hiệu lực 2026-12-01 và điều chỉnh lương từ 15.000.000 lên 18.000.000.' },
          usage: { inputTokens: 10, outputTokens: 5 },
        }));
        return { output: res.output, usage: res.usage };
      },
    });

    // Monthly AI budget exhaustion -> budget_exhausted (and refunds in-memory ticket).
    const overMonthlyBudget = await checkAddendumDraft(
      hrAddendumAi(reader, budget),
      makePorts(),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      askInput,
      {
        admit: async () => {
          throw new AiBudgetExhaustedError('module', '2026-12-01T00:00:00Z');
        },
        record: async () => {},
      },
    );
    expect(overMonthlyBudget.ai).toEqual({ ok: false, reason: 'budget_exhausted' });

    // Consume the single in-memory burst ticket, then assert the second call hits rate_limited (not budget_exhausted).
    const firstOk = await checkAddendumDraft(
      hrAddendumAi(reader, budget),
      makePorts(),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      askInput,
      okMeter,
    );
    expect(firstOk.ai).toEqual({ ok: true, reason: 'ok' });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rateLimited = await checkAddendumDraft(
      hrAddendumAi(reader, budget),
      makePorts({
        record: async () => {
          throw new Error('audit write failed for Nguyễn Văn An');
        },
      }),
      FAKE_RUNTIME,
      ORG_ID,
      ACTOR,
      askInput,
      okMeter,
    );
    expect(rateLimited.ai).toEqual({ ok: false, reason: 'rate_limited' });
    expect(rateLimited.readyToIssue).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('[hr-addendum-ai] check audit write failed', 'Error');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('Nguyễn Văn An');
  });
});
