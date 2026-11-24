// SPDX-License-Identifier: AGPL-3.0-only
// Kernel bridge for Ly's contract addendum completeness check (hr.addendum_check, #4528 Stage 6C):
// always runs deterministic statutory validation first; optional metered Ly review degrades cleanly on kill-switch/budget/outage.
import {
  AiBudgetExhaustedError,
  AiMeterMissingError,
  PayrollPromptLeakError,
  evaluateAddendumCompleteness,
  withAiScope,
  type AiMeter,
  type InboxReader,
} from '@ludy/agent';
import type {
  HrAddendumAiState,
  HrAddendumCheckAsk,
  HrAddendumCheckAudit,
  HrAddendumCheckResult,
} from '@ludy/kernel-contract';
import { DomainError, type Actor, type Runtime } from '@ludy/kernel-runtime';
import type { HrAddendumCheckSource } from '@ludy/mod-hr';
import type { DraftBudget } from './ai-draft-limit.ts';
import { memberMeter, type MeterOptions } from './ai-meter.ts';

export interface HrAddendumAi {
  reader: Partial<Pick<InboxReader, 'hrAddendumCheck'>> | null;
  budget: DraftBudget;
}

export interface HrAddendumPorts {
  read: (input: HrAddendumCheckAsk) => Promise<HrAddendumCheckSource>;
  isAiStopped: () => Promise<boolean>;
  record: (input: HrAddendumCheckAudit) => Promise<{ ok: true }>;
}

export class HrAddendumAiStoppedError extends Error {
  constructor() {
    super('HR addendum AI is stopped by kill switch');
    this.name = 'HrAddendumAiStoppedError';
  }
}

export function hrAddendumAi(reader: HrAddendumAi['reader'], budget: DraftBudget): HrAddendumAi {
  return { reader, budget };
}

type UserActor = Extract<Actor, { type: 'user' }>;

export async function checkAddendumDraft(
  ai: HrAddendumAi,
  ports: HrAddendumPorts,
  runtime: Pick<Runtime, 'query' | 'execute'>,
  orgId: string,
  actor: UserActor,
  input: HrAddendumCheckAsk,
  meter: AiMeter | 'runtime' = 'runtime',
  meterOptions?: MeterOptions,
): Promise<HrAddendumCheckResult> {
  const source = await ports.read(input);
  const language = input.language ?? 'vi';
  const evalOut = evaluateAddendumCompleteness({
    language,
    addendumNumber: source.addendumNumber,
    effectiveOn: source.effectiveOn,
    changeSummary: source.changeSummary,
    previousPayRate: source.previousPayRate,
    newPayRate: source.newPayRate,
    previousTitle: source.previousTitle,
    newTitle: source.newTitle,
  });

  const finish = async (
    reason: HrAddendumAiState['reason'],
    lyNote: string | null,
    ok = true,
  ): Promise<HrAddendumCheckResult> => {
    await ports
      .record({
        employeeId: source.employeeId,
        employmentId: source.employmentId,
        readyToIssue: evalOut.readyToIssue,
        findingsCount: evalOut.findings.length,
        aiReason: reason,
      })
      .catch((error: unknown) => {
        console.error('[hr-addendum-ai] check audit write failed', error instanceof Error ? error.name : typeof error);
      });
    return {
      employeeId: source.employeeId,
      employmentId: source.employmentId,
      readyToIssue: evalOut.readyToIssue,
      findings: evalOut.findings,
      lyNote,
      ai: { ok, reason },
    };
  };

  if (input.withAi === false) {
    return finish('skipped', null, true);
  }

  const reader = ai.reader;
  const check = reader?.hrAddendumCheck;
  if (!reader || !check) {
    return finish('ai_off', null, false);
  }
  if (await ports.isAiStopped()) {
    return finish('kill_switch', null, false);
  }

  const ticket = ai.budget.take(orgId, actor.userId);
  if (!ticket.allowed) {
    return finish('rate_limited', null, false);
  }

  const baseMeter =
    meter === 'runtime' ? memberMeter(runtime as Runtime, actor, meterOptions ?? {}) : meter;
  const guardedMeter: AiMeter = {
    admit: async (call) => {
      try {
        if (await ports.isAiStopped()) {
          throw new HrAddendumAiStoppedError();
        }
        const admitted = await baseMeter.admit(call);
        if (await ports.isAiStopped()) {
          throw new HrAddendumAiStoppedError();
        }
        return admitted;
      } catch (error: unknown) {
        ticket.refund?.();
        throw error;
      }
    },
    record: (call, usage) => baseMeter.record(call, usage),
  };

  try {
    const out = await withAiScope({ orgId, meter: guardedMeter }, () =>
      check.call(
        reader,
        {
          language,
          contractType: source.contractType,
          employmentEffectiveFrom: source.employmentEffectiveFrom,
          addendumNumber: source.addendumNumber,
          effectiveOn: source.effectiveOn,
          changeSummary: source.changeSummary,
          previousPayRate: source.previousPayRate,
          newPayRate: source.newPayRate,
          previousTitle: source.previousTitle,
          newTitle: source.newTitle,
        },
        { forbidden: source.forbiddenTerms },
      ),
    );
    if (await ports.isAiStopped()) {
      throw new HrAddendumAiStoppedError();
    }
    if (out.reason !== 'ok') {
      return finish(out.reason, null, false);
    }
    return finish('ok', out.lyNote, true);
  } catch (error: unknown) {
    if (error instanceof HrAddendumAiStoppedError) {
      return finish('kill_switch', null, false);
    }
    if (error instanceof PayrollPromptLeakError) {
      ticket.refund?.();
      return finish('leak_refused', null, false);
    }
    if (error instanceof AiBudgetExhaustedError) {
      return finish('budget_exhausted', null, false);
    }
    if (error instanceof AiMeterMissingError) {
      ticket.refund?.();
      throw error;
    }
    if (error instanceof DomainError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      throw error;
    }
    if (error instanceof DomainError && error.code === 'AI_BUDGET_EXHAUSTED') {
      return finish('budget_exhausted', null, false);
    }
    if (error instanceof DomainError && (error.code === 'RATE_LIMITED' || error.status === 429)) {
      return finish('rate_limited', null, false);
    }
    console.error('[hr-addendum-ai] check failed', error instanceof Error ? error.name : typeof error);
    return finish('unavailable', null, false);
  } finally {
    ticket.release();
  }
}
