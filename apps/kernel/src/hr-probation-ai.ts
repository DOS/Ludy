// SPDX-License-Identifier: AGPL-3.0-only
// Kernel orchestration for Ly's probation evidence summary draft (hr.probation_summary, #4448 Stage 5B).
// Reads factual evidence in the caller's transaction, then calls Ly outside any transaction through the
// AI budget meter (withAiScope), degrading cleanly with 100% deterministic parity when AI is off/busy/budgeted.
import {
  AiBudgetExhaustedError,
  AiMeterMissingError,
  withAiScope,
  type AiMeter,
  type InboxReader,
} from '@ludy/agent';
import type { HrProbationDraftAsk, HrProbationDraftResult } from '@ludy/kernel-contract';
import { DomainError, type Actor, type Runtime } from '@ludy/kernel-runtime';
import type { HrProbationBriefSource } from '@ludy/mod-hr';
import type { DraftBudget } from './ai-draft-limit.ts';
import { memberMeter, type MeterOptions } from './ai-meter.ts';

export interface HrProbationAi {
  reader: Partial<Pick<InboxReader, 'hrProbationSummary'>> | null;
  budget: DraftBudget;
}

export interface HrProbationPorts {
  read: (input: { employeeId: string; periodStart?: string; periodEnd?: string }) => Promise<HrProbationBriefSource>;
  isAiStopped: () => Promise<boolean>;
  record: (input: {
    employeeId: string;
    aiStatus: HrProbationDraftResult['status'];
    completedTasksCount: number;
  }) => Promise<unknown>;
}

export function hrProbationAi(reader: HrProbationAi['reader'], budget: DraftBudget): HrProbationAi {
  return { reader, budget };
}

class HrProbationAiStoppedError extends Error {
  constructor() {
    super('AI kill switch is active');
    this.name = 'HrProbationAiStoppedError';
  }
}

export async function draftProbationSummary(
  ai: HrProbationAi,
  ports: HrProbationPorts,
  runtime: Pick<Runtime, 'execute' | 'query'>,
  orgId: string,
  actor: Actor,
  input: HrProbationDraftAsk,
  meter: AiMeter | 'runtime' = 'runtime',
  meterOptions?: MeterOptions,
): Promise<HrProbationDraftResult> {
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên đã đăng nhập mới tạo được nháp đánh giá thử việc');
  }

  const source = await ports.read({
    employeeId: input.employeeId,
    ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
    ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
  });
  const { preview } = source;

  const finish = async (
    status: HrProbationDraftResult['status'],
    draftNote: string | null,
  ): Promise<HrProbationDraftResult> => {
    await ports.record({
      employeeId: preview.employeeId,
      aiStatus: status,
      completedTasksCount: preview.completedTasksCount,
    }).catch(() => {});
    return { status, draftNote, preview };
  };

  const ask = ai.reader?.hrProbationSummary;
  if (!ask || source.aiStopped) {
    return finish('off', null);
  }
  if (source.aiBudgetSpent) {
    return finish('budget', null);
  }
  const hasAnyFacts =
    preview.completedTasksCount > 0 ||
    preview.attendance.monthCount > 0 ||
    preview.attendance.overtimeRequestsCount > 0;
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
      if (await ports.isAiStopped()) {
        throw new HrProbationAiStoppedError();
      }
      return baseMeter.admit(call);
    },
    record: (call, usage) => baseMeter.record(call, usage),
  };

  try {
    const out = await withAiScope({ orgId, meter: guardedMeter }, () =>
      ask(
        {
          language: input.lang ?? 'vi',
          periodStart: preview.periodStart,
          periodEnd: preview.periodEnd,
          departmentName: preview.departmentName,
          jobTitle: preview.jobTitle,
          projectsAvailable: preview.projectsAvailable,
          completedTasksCount: preview.completedTasksCount,
          completedTasks: preview.completedTasks.map((t) => ({
            title: t.title,
            projectName: t.projectName,
          })),
          attendance: preview.attendance,
        },
        {
          forbidden: [preview.employeeName],
        },
      ),
    );

    if (await ports.isAiStopped()) {
      throw new HrProbationAiStoppedError();
    }

    if (!out.ai.ok || out.summary === null) {
      if (out.ai.reason === 'budget') return finish('budget', null);
      if (out.ai.reason === 'rate_limited') return finish('busy', null);
      if (out.ai.reason === 'off') return finish('off', null);
      return finish('failed', null);
    }

    return finish('used', out.summary);
  } catch (error: unknown) {
    if (error instanceof HrProbationAiStoppedError) {
      return finish('off', null);
    }
    if (error instanceof AiBudgetExhaustedError) {
      return finish('budget', null);
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      throw error;
    }
    console.error('[hr-probation-ai] summary failed', error instanceof Error ? error.name : typeof error);
    return finish('failed', null);
  } finally {
    ticket.release();
  }
}
