// SPDX-License-Identifier: AGPL-3.0-only
// Kernel orchestration for Vy summarizing completed project tasks on project acceptance minutes (#3812, Slice 3b):
// 1. Reads project metadata, caller-readable completed tasks, kill-switch state, and budget status in the human
//    caller's own transaction (sign.acceptance.source -> projects.board).
// 2. Runs Vy outside any database transaction through the AI budget meter (metered 'sign.acceptance_draft' inside withAiScope).
// 3. Returns tainted proposals only (nothing persisted or sent automatically); when AI is off, kill-switched, busy,
//    budget-exhausted, or refused, returns a structured status with empty bullets so deterministic completed tasks stand with 100% parity.
import {
  AiBudgetExhaustedError,
  AiMeterMissingError,
  withAiScope,
  type AiMeter,
  type InboxReader,
} from '@ludy/agent';
import type { SignAcceptanceDraftResult, SignAcceptanceDraftStatus } from '@ludy/kernel-contract';
import { DomainError, type Actor, type Runtime } from '@ludy/kernel-runtime';
import type { SignAcceptanceAiStatus, SignAcceptanceSource } from '@ludy/mod-sign';
import type { DraftBudget } from './ai-draft-limit.ts';
import { guardAiMeter, memberMeter, type MeterOptions } from './ai-meter.ts';

export interface SignAcceptanceAi {
  reader: Partial<Pick<InboxReader, 'signAcceptanceDraft'>> | null;
  budget: DraftBudget;
}

export function signAcceptanceAi(reader: SignAcceptanceAi['reader'], budget: DraftBudget): SignAcceptanceAi {
  return { reader, budget };
}

export interface DraftProjectAcceptanceSummaryParams {
  ai: SignAcceptanceAi;
  runtime: Pick<Runtime, 'execute' | 'query'>;
  orgId: string;
  actor: Actor;
  projectId: string;
  language?: 'vi' | 'en';
  meter: AiMeter | 'runtime';
  meterOptions?: MeterOptions;
}

class SignAcceptanceAiStoppedError extends Error {
  constructor() {
    super('AI kill switch is active');
    this.name = 'SignAcceptanceAiStoppedError';
  }
}

function emptyDraftResult(status: SignAcceptanceDraftStatus): SignAcceptanceDraftResult {
  return { status, bullets: [] };
}

export async function draftProjectAcceptanceSummary(
  params: DraftProjectAcceptanceSummaryParams,
): Promise<SignAcceptanceDraftResult> {
  const { ai, runtime, orgId, actor, projectId } = params;
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Only authenticated workspace members can draft acceptance summaries');
  }

  const source = await runtime.query<SignAcceptanceSource>(
    'sign.acceptance.source',
    { projectId },
    { actor, orgId },
  );

  const ask = ai.reader?.signAcceptanceDraft;
  if (!ask || source.aiStopped) {
    return emptyDraftResult('off');
  }
  if (source.aiBudgetSpent) {
    return emptyDraftResult('budget');
  }
  if (source.completedTasks.length === 0) {
    return emptyDraftResult('no_tasks');
  }

  const ticket = ai.budget.take(orgId, actor.userId);
  if (!ticket.allowed) {
    return emptyDraftResult('busy');
  }

  const isAiStopped = async (): Promise<boolean> => {
    const latest = await runtime.query<SignAcceptanceAiStatus>(
      'sign.acceptance.ai_status',
      { projectId },
      { actor, orgId },
    );
    return latest.aiStopped;
  };

  const baseMeter =
    params.meter === 'runtime'
      ? memberMeter(runtime as Runtime, actor, params.meterOptions ?? {})
      : params.meter;

  const guardedMeter = guardAiMeter(baseMeter, {
    isStopped: isAiStopped,
    stoppedError: () => new SignAcceptanceAiStoppedError(),
  });

  try {
    const out = await withAiScope({ orgId, meter: guardedMeter }, () =>
      ask({
        language: params.language ?? 'vi',
        projectName: source.projectName,
        completedTasks: source.completedTasks,
      }),
    );

    if (await isAiStopped()) {
      throw new SignAcceptanceAiStoppedError();
    }

    if (out.kind === 'none') {
      if (out.code === 'NO_TASKS') return emptyDraftResult('no_tasks');
      console.error(`[sign-acceptance-ai] summary refused: ${out.code}`);
      return emptyDraftResult('failed');
    }

    return {
      status: 'used',
      bullets: out.bullets,
    };
  } catch (error: unknown) {
    if (error instanceof SignAcceptanceAiStoppedError) {
      return emptyDraftResult('off');
    }
    if (error instanceof AiBudgetExhaustedError) {
      return emptyDraftResult('budget');
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      throw error;
    }
    console.error('[sign-acceptance-ai] summary failed', error instanceof Error ? error.name : typeof error);
    return emptyDraftResult('failed');
  } finally {
    ticket.release();
  }
}
