// SPDX-License-Identifier: AGPL-3.0-only
// Kernel orchestration for HR Stage 6A self-service request drafting (`hr.request_draft`) and
// cited HR policy Q&A (`hr.policy_qa`) on `/hr/my` (#4526).
// Reads context/notes strictly in the caller's RLS transaction, runs Ly outside transactions through
// `withAiScope` + `memberMeter` with mid-flight kill-switch checks, and maintains 100% deterministic parity.
import {
  AiBudgetExhaustedError,
  AiMeterMissingError,
  answerSelfHrPolicyWithLy,
  draftSelfHrRequestWithLy,
  resolveSelfHrReferenceDate,
  selectPolicyQaMatches,
  withAiScope,
  type AiMeter,
  type InboxReader,
} from '@ludy/agent';
import {
  extractHrPolicyKeywords,
  isVietnamHoliday,
  type HrSelfPolicyQaAsk,
  type HrSelfPolicyQaResult,
  type HrSelfRequestDraftAsk,
  type HrSelfRequestDraftResult,
} from '@ludy/kernel-contract';
import { DomainError, type Actor, type Runtime } from '@ludy/kernel-runtime';
import type { HrSelfAiStatusContext, HrSelfPolicySearchContext } from '@ludy/mod-hr';
import type { DraftBudget } from './ai-draft-limit.ts';
import { guardAiMeter, memberMeter, type MeterOptions } from './ai-meter.ts';

export interface HrSelfAi {
  reader: Partial<Pick<InboxReader, 'hrRequestDraft' | 'hrPolicyQa'>> | null;
  draftBudget: DraftBudget;
  qaBudget: DraftBudget;
}

export interface HrSelfAiPorts {
  readDraftContext: () => Promise<HrSelfAiStatusContext>;
  searchPolicyNotes: (input: HrSelfPolicyQaAsk) => Promise<HrSelfPolicySearchContext>;
  isAiStopped: (includeNotes?: boolean) => Promise<boolean>;
}

export function hrSelfAi(
  reader: HrSelfAi['reader'],
  draftBudget: DraftBudget,
  qaBudget: DraftBudget,
): HrSelfAi {
  return { reader, draftBudget, qaBudget };
}

class HrSelfAiStoppedError extends Error {
  constructor() {
    super('AI kill switch is active');
    this.name = 'HrSelfAiStoppedError';
  }
}

function buildGuardedMeter(
  runtime: Pick<Runtime, 'execute' | 'query'>,
  actor: Actor,
  isAiStopped: (includeNotes?: boolean) => Promise<boolean>,
  includeNotes: boolean,
  meter: AiMeter | 'runtime',
  meterOptions?: MeterOptions,
  onAdmitRejected?: () => void,
): AiMeter {
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng đã đăng nhập mới dùng được trợ giúp nhân sự');
  }
  const baseMeter =
    meter === 'runtime' ? memberMeter(runtime as Runtime, actor, meterOptions ?? {}) : meter;
  return guardAiMeter(baseMeter, {
    isStopped: () => isAiStopped(includeNotes),
    stoppedError: () => new HrSelfAiStoppedError(),
    checkStoppedAfterAdmit: true,
    ...(onAdmitRejected ? { onAdmitRejected } : {}),
  });
}

export async function draftSelfHrRequest(
  ai: HrSelfAi,
  ports: HrSelfAiPorts,
  runtime: Pick<Runtime, 'execute' | 'query'>,
  orgId: string,
  actor: Actor,
  input: HrSelfRequestDraftAsk,
  meter: AiMeter | 'runtime' = 'runtime',
  meterOptions?: MeterOptions,
): Promise<HrSelfRequestDraftResult> {
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên đã đăng nhập mới tạo được nháp đơn từ');
  }

  const resolvedRefDate = resolveSelfHrReferenceDate(input.referenceDate);
  const context = await ports.readDraftContext();
  const language = input.lang ?? 'vi';
  const baseInput = {
    text: input.text,
    language,
    isHoliday: isVietnamHoliday,
    referenceDate: resolvedRefDate,
  };

  const ask = ai.reader?.hrRequestDraft;
  if (!ask || context.aiStopped) {
    return draftSelfHrRequestWithLy(baseInput, { generate: null, aiDisabledReason: 'off' });
  }
  if (context.aiBudgetSpent) {
    return draftSelfHrRequestWithLy(baseInput, { generate: null, aiDisabledReason: 'budget' });
  }

  const ticket = ai.draftBudget.take(orgId, actor.userId);
  if (!ticket.allowed) {
    return draftSelfHrRequestWithLy(baseInput, { generate: null, aiDisabledReason: 'busy' });
  }

  const guardedMeter = buildGuardedMeter(runtime, actor, ports.isAiStopped, false, meter, meterOptions, () =>
    ticket.refund?.(),
  );

  try {
    const out = await withAiScope({ orgId, meter: guardedMeter }, () => ask(baseInput));
    if (await ports.isAiStopped(false)) {
      throw new HrSelfAiStoppedError();
    }
    return out;
  } catch (error: unknown) {
    if (error instanceof HrSelfAiStoppedError) {
      return draftSelfHrRequestWithLy(baseInput, { generate: null, aiDisabledReason: 'off' });
    }
    if (error instanceof AiBudgetExhaustedError) {
      return draftSelfHrRequestWithLy(baseInput, { generate: null, aiDisabledReason: 'budget' });
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      throw error;
    }
    console.error('[hr-self-ai] request draft failed', error instanceof Error ? error.name : typeof error);
    return draftSelfHrRequestWithLy(baseInput, { generate: null, aiDisabledReason: 'failed' });
  } finally {
    ticket.release();
  }
}

export async function askSelfHrPolicy(
  ai: HrSelfAi,
  ports: HrSelfAiPorts,
  runtime: Pick<Runtime, 'execute' | 'query'>,
  orgId: string,
  actor: Actor,
  input: HrSelfPolicyQaAsk,
  meter: AiMeter | 'runtime' = 'runtime',
  meterOptions?: MeterOptions,
): Promise<HrSelfPolicyQaResult> {
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên đã đăng nhập mới tra cứu được chính sách nhân sự');
  }

  const searched = await ports.searchPolicyNotes(input);
  const language = input.lang ?? 'vi';
  const limit = input.limit ?? 5;
  const keywords = extractHrPolicyKeywords(input.question);
  const baseInput = {
    question: input.question,
    language,
    limit,
    notesAvailable: searched.notesAvailable,
    candidates: searched.candidates,
    keywords,
  };

  if (!searched.notesAvailable) {
    return answerSelfHrPolicyWithLy(baseInput, { generate: null });
  }

  const { matches } = selectPolicyQaMatches(input.question, searched.candidates, limit, keywords);
  if (matches.length === 0) {
    return answerSelfHrPolicyWithLy(baseInput, { generate: null });
  }

  const ask = ai.reader?.hrPolicyQa;
  if (!ask || searched.aiStopped) {
    return answerSelfHrPolicyWithLy(baseInput, { generate: null, aiDisabledReason: 'off' });
  }
  if (searched.aiBudgetSpent) {
    return answerSelfHrPolicyWithLy(baseInput, { generate: null, aiDisabledReason: 'budget' });
  }

  const ticket = ai.qaBudget.take(orgId, actor.userId);
  if (!ticket.allowed) {
    return answerSelfHrPolicyWithLy(baseInput, { generate: null, aiDisabledReason: 'busy' });
  }

  const guardedMeter = buildGuardedMeter(runtime, actor, ports.isAiStopped, true, meter, meterOptions, () =>
    ticket.refund?.(),
  );

  try {
    const out = await withAiScope({ orgId, meter: guardedMeter }, () => ask(baseInput));
    if (await ports.isAiStopped(true)) {
      throw new HrSelfAiStoppedError();
    }
    return out;
  } catch (error: unknown) {
    if (error instanceof HrSelfAiStoppedError) {
      return answerSelfHrPolicyWithLy(baseInput, { generate: null, aiDisabledReason: 'off' });
    }
    if (error instanceof AiBudgetExhaustedError) {
      return answerSelfHrPolicyWithLy(baseInput, { generate: null, aiDisabledReason: 'budget' });
    }
    if (error instanceof AiMeterMissingError) {
      throw error;
    }
    if (error instanceof DomainError && (error.status === 401 || error.status === 403 || error.status === 404)) {
      throw error;
    }
    console.error('[hr-self-ai] policy qa failed', error instanceof Error ? error.name : typeof error);
    return answerSelfHrPolicyWithLy(baseInput, { generate: null, aiDisabledReason: 'failed' });
  } finally {
    ticket.release();
  }
}
