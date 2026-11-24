// SPDX-License-Identifier: AGPL-3.0-only
// Kernel orchestration for Ly's quarterly OKR check-in draft (hr.okr_checkin_draft, #4529 Stage 6D).
// Reads factual OKR metrics and caller-scoped Ludy Cong tac tasks inside the caller's transaction, then calls
// Ly outside any transaction via withAiScope, always supplying deterministicSummary for 100% AI-off parity.
import {
  AiBudgetExhaustedError,
  AiMeterMissingError,
  PayrollPromptLeakError,
  buildDeterministicOkrCheckinSummary,
  withAiScope,
  type AiMeter,
  type InboxReader,
} from '@ludy/agent';
import type { HrOkrDraftCheckinAsk, HrOkrDraftCheckinResult } from '@ludy/kernel-contract';
import { DomainError, type Actor, type Runtime } from '@ludy/kernel-runtime';
import type { HrOkrDraftSource } from '@ludy/mod-hr';
import type { DraftBudget } from './ai-draft-limit.ts';
import { memberMeter, type MeterOptions } from './ai-meter.ts';

export interface HrOkrAi {
  reader: Partial<Pick<InboxReader, 'hrOkrCheckinDraft'>> | null;
  budget: DraftBudget;
}

export interface HrOkrPorts {
  read: (input: { keyResultId: string }) => Promise<HrOkrDraftSource>;
  isAiStopped: () => Promise<boolean>;
  record: (input: {
    keyResultId: string;
    aiStatus: HrOkrDraftCheckinResult['status'];
    progressPct: string;
    completedLinkedTasks: number;
  }) => Promise<unknown>;
}

export function hrOkrAi(reader: HrOkrAi['reader'], budget: DraftBudget): HrOkrAi {
  return { reader, budget };
}

class HrOkrAiStoppedError extends Error {
  constructor() {
    super('AI kill switch is active');
    this.name = 'HrOkrAiStoppedError';
  }
}

export async function draftOkrCheckinSummary(
  ai: HrOkrAi,
  ports: HrOkrPorts,
  runtime: Pick<Runtime, 'execute' | 'query'>,
  orgId: string,
  actor: Actor,
  input: HrOkrDraftCheckinAsk,
  meter: AiMeter | 'runtime' = 'runtime',
  meterOptions?: MeterOptions,
): Promise<HrOkrDraftCheckinResult> {
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên đã đăng nhập mới tạo được nháp check-in OKR');
  }

  const lang = input.lang ?? 'vi';
  const source = await ports.read({ keyResultId: input.keyResultId });
  const { facts } = source;
  const deterministicSummary = buildDeterministicOkrCheckinSummary(facts, lang);

  const finish = async (
    status: HrOkrDraftCheckinResult['status'],
    draftNote: string | null,
  ): Promise<HrOkrDraftCheckinResult> => {
    await ports
      .record({
        keyResultId: facts.keyResultId,
        aiStatus: status,
        progressPct: facts.progressPct,
        completedLinkedTasks: facts.completedLinkedTasks,
      })
      .catch((error: unknown) => {
        console.error('[hr-okr-ai] draft audit write failed', error instanceof Error ? error.name : typeof error);
      });
    return {
      status,
      draftNote,
      deterministicSummary,
      progressPct: facts.progressPct,
      completedLinkedTasks: facts.completedLinkedTasks,
      totalLinkedTasks: facts.totalLinkedTasks,
    };
  };

  const reader = ai.reader;
  const ask = reader?.hrOkrCheckinDraft;
  if (!reader || !ask || source.aiStopped) {
    return finish('off', null);
  }
  if (source.aiBudgetSpent) {
    return finish('budget', null);
  }

  const hasAnyFacts =
    facts.currentValue !== '0' ||
    facts.totalLinkedTasks > 0 ||
    facts.lastCheckinNote !== null;
  if (!hasAnyFacts) {
    return finish('no_data', null);
  }

  const ticket = ai.budget.take(orgId, actor.userId);
  if (!ticket.allowed) {
    return finish('busy', null);
  }

  const baseMeter =
    meter === 'runtime' ? memberMeter(runtime as Runtime, actor, meterOptions ?? {}) : meter;

  const guardedMeter: AiMeter = {
    admit: async (call) => {
      try {
        if (await ports.isAiStopped()) {
          throw new HrOkrAiStoppedError();
        }
        const admitted = await baseMeter.admit(call);
        if (await ports.isAiStopped()) {
          throw new HrOkrAiStoppedError();
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
      ask.call(
        reader,
        {
          language: lang,
          quarter: facts.quarter,
          objectiveScope: facts.objectiveScope,
          objectiveTitle: facts.objectiveTitle,
          keyResultTitle: facts.keyResultTitle,
          metricType: facts.metricType,
          targetValue: facts.targetValue,
          currentValue: facts.currentValue,
          unit: facts.unit,
          progressPct: facts.progressPct,
          departmentName: facts.departmentName,
          lastCheckinNote: facts.lastCheckinNote,
          projectsAvailable: facts.projectsAvailable,
          projectAccessible: facts.projectAccessible,
          linkedProjectName: facts.linkedProjectName,
          completedLinkedTasks: facts.completedLinkedTasks,
          totalLinkedTasks: facts.totalLinkedTasks,
          linkedTaskTitles: facts.linkedTaskTitles,
        },
        {
          forbidden: facts.ownerName ? [facts.ownerName] : [],
        },
      ),
    );

    if (await ports.isAiStopped()) {
      throw new HrOkrAiStoppedError();
    }

    if (!out.ai.ok || out.draft === null) {
      if (out.ai.reason === 'budget') return finish('budget', null);
      if (out.ai.reason === 'rate_limited') return finish('busy', null);
      if (out.ai.reason === 'off') return finish('off', null);
      return finish('failed', null);
    }

    return finish('used', out.draft);
  } catch (error: unknown) {
    if (error instanceof HrOkrAiStoppedError) {
      return finish('off', null);
    }
    if (error instanceof PayrollPromptLeakError) {
      ticket.refund?.();
      return finish('failed', null);
    }
    if (error instanceof AiBudgetExhaustedError) {
      return finish('budget', null);
    }
    if (error instanceof AiMeterMissingError) {
      ticket.refund?.();
      throw error;
    }
    if (error instanceof DomainError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      throw error;
    }
    if (error instanceof DomainError && error.code === 'AI_BUDGET_EXHAUSTED') {
      return finish('budget', null);
    }
    if (error instanceof DomainError && (error.code === 'RATE_LIMITED' || error.status === 429)) {
      return finish('busy', null);
    }
    console.error('[hr-okr-ai] draft failed', error instanceof Error ? error.name : typeof error);
    return finish('failed', null);
  } finally {
    ticket.release();
  }
}
