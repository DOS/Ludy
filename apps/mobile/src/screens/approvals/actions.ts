// SPDX-License-Identifier: AGPL-3.0-only
// Approval action executors: biometric step-up for R3/monetary actions, online-only writes, and kernel refusal mapping.

import { isMfaRequired, isStepUpRequired, type LudyClient } from '@ludy/client';
import type { StepUpGate } from '../../auth/step-up.ts';
import { createIdempotencyKey, isPositiveMoney, type RandomBytesPort } from './format.ts';
import { isAuthBlockingError, isLikelyNetworkError, readErrorCodeAndStatus } from './model.ts';

type ApprovalActionOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: 'biometric' | 'kernel-step-up' | 'offline' | 'auth' | 'refused';
      code?: string | null;
      message?: string;
    };

interface ApprovalActionDeps {
  client: LudyClient;
  stepUp: StepUpGate;
  crypto: RandomBytesPort;
  isOffline?: boolean;
  onKernelError?: (error: unknown) => void;
}

function mapActionError<T>(error: unknown, onKernelError?: (error: unknown) => void): ApprovalActionOutcome<T> {
  if (isStepUpRequired(error) || isMfaRequired(error)) {
    return { ok: false, reason: 'kernel-step-up' };
  }
  if (isAuthBlockingError(error)) {
    onKernelError?.(error);
    return { ok: false, reason: 'auth' };
  }
  if (isLikelyNetworkError(error)) {
    return { ok: false, reason: 'offline' };
  }
  const { code, message } = readErrorCodeAndStatus(error);
  return { ok: false, reason: 'refused', code, message };
}

function cleanOptionalNote(note: string | undefined): string | undefined {
  if (!note) return undefined;
  const trimmed = note.trim();
  return trimmed ? trimmed : undefined;
}

interface ApproveInboxInput {
  id: string;
  revision: number;
  prompt: string;
  lineAccounts?: Array<{ lineNo: number; debitAccount: string }>;
  note?: string;
  acceptFailedChecks?: boolean;
  acceptUnverifiedSignature?: boolean;
  postingDate?: string;
  idempotencyKey?: string;
}

export async function approveInboxProposal(
  deps: ApprovalActionDeps,
  input: ApproveInboxInput,
): Promise<ApprovalActionOutcome<Awaited<ReturnType<LudyClient['inbox']['approve']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey(deps.crypto);
  const note = cleanOptionalNote(input.note);
  try {
    const result = await deps.stepUp.run(input.prompt, () =>
      deps.client.inbox.approve({
        id: input.id,
        revision: input.revision,
        idempotencyKey,
        ...(input.lineAccounts && input.lineAccounts.length > 0 ? { lineAccounts: input.lineAccounts } : {}),
        ...(note ? { note } : {}),
        ...(input.acceptFailedChecks ? { acceptFailedChecks: true } : {}),
        ...(input.acceptUnverifiedSignature ? { acceptUnverifiedSignature: true } : {}),
        ...(input.postingDate ? { postingDate: input.postingDate } : {}),
      }),
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, value: result.value };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}

interface EditInboxInput {
  id: string;
  revision: number;
  lineAccounts?: Array<{ lineNo: number; debitAccount: string }>;
  exchangeRate?: string;
  legalEntityId?: string;
  idempotencyKey?: string;
}

export async function editInboxProposal(
  deps: Omit<ApprovalActionDeps, 'stepUp'>,
  input: EditInboxInput,
): Promise<ApprovalActionOutcome<Awaited<ReturnType<LudyClient['inbox']['edit']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey(deps.crypto);
  try {
    const value = await deps.client.inbox.edit({
      id: input.id,
      revision: input.revision,
      idempotencyKey,
      ...(input.lineAccounts && input.lineAccounts.length > 0 ? { lineAccounts: input.lineAccounts } : {}),
      ...(input.exchangeRate ? { exchangeRate: input.exchangeRate } : {}),
      ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}),
    });
    return { ok: true, value };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}

interface RejectInboxInput {
  id: string;
  reason?: string;
}

export async function rejectInboxProposal(
  deps: Pick<ApprovalActionDeps, 'client' | 'isOffline' | 'onKernelError'>,
  input: RejectInboxInput,
): Promise<ApprovalActionOutcome<Awaited<ReturnType<LudyClient['inbox']['reject']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  const reason = cleanOptionalNote(input.reason);
  try {
    const value = await deps.client.inbox.reject({
      id: input.id,
      ...(reason ? { reason } : {}),
    });
    return { ok: true, value };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}

interface DecideSocialInput {
  postId: string;
  decision: 'approved' | 'changes_requested' | 'rejected';
  comment?: string;
  variants: Array<{
    variantId: string;
    revision: number;
    contentHash: string;
    checks?: string[];
  }>;
}

export async function decideSocialPostVariants(
  deps: Pick<ApprovalActionDeps, 'client' | 'isOffline' | 'onKernelError'>,
  input: DecideSocialInput,
): Promise<ApprovalActionOutcome<Awaited<ReturnType<LudyClient['social']['variants']['decide']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  const comment = cleanOptionalNote(input.comment);
  try {
    const value = await deps.client.social.variants.decide({
      postId: input.postId,
      decision: input.decision,
      variants: input.variants,
      ...(comment ? { comment } : {}),
    });
    return { ok: true, value };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}

export type HrDecisionStage = 'approve_l1' | 'approve_final' | 'reject';

export async function decideLeaveRequest(
  deps: Pick<ApprovalActionDeps, 'client' | 'isOffline' | 'onKernelError'>,
  input: { requestId: string; stage: HrDecisionStage; note?: string },
): Promise<ApprovalActionOutcome<Awaited<ReturnType<LudyClient['hr']['leaveRequests']['approveFinal']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  const note = cleanOptionalNote(input.note);
  const payload = { requestId: input.requestId, ...(note ? { note } : {}) };
  try {
    if (input.stage === 'approve_l1') {
      return { ok: true, value: await deps.client.hr.leaveRequests.approveL1(payload) };
    }
    if (input.stage === 'approve_final') {
      return { ok: true, value: await deps.client.hr.leaveRequests.approveFinal(payload) };
    }
    return { ok: true, value: await deps.client.hr.leaveRequests.reject(payload) };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}

export async function decideSalaryAdvance(
  deps: Pick<ApprovalActionDeps, 'client' | 'stepUp' | 'isOffline' | 'onKernelError'>,
  input: { requestId: string; stage: HrDecisionStage; note?: string; prompt: string },
): Promise<ApprovalActionOutcome<Awaited<ReturnType<LudyClient['hr']['salaryAdvances']['approveFinal']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  const note = cleanOptionalNote(input.note);
  const payload = { requestId: input.requestId, ...(note ? { note } : {}) };
  try {
    if (input.stage === 'reject') {
      return { ok: true, value: await deps.client.hr.salaryAdvances.reject(payload) };
    }
    const stepped = await deps.stepUp.run(input.prompt, () =>
      input.stage === 'approve_l1'
        ? deps.client.hr.salaryAdvances.approveL1(payload)
        : deps.client.hr.salaryAdvances.approveFinal(payload),
    );
    if (!stepped.ok) return { ok: false, reason: stepped.reason };
    return { ok: true, value: stepped.value };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}

export async function decideBusinessTrip(
  deps: Pick<ApprovalActionDeps, 'client' | 'stepUp' | 'isOffline' | 'onKernelError'>,
  input: {
    requestId: string;
    stage: HrDecisionStage;
    estimatedAllowance?: string | null;
    note?: string;
    prompt: string;
  },
): Promise<ApprovalActionOutcome<Awaited<ReturnType<LudyClient['hr']['businessTrips']['approveFinal']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  const note = cleanOptionalNote(input.note);
  const payload = { requestId: input.requestId, ...(note ? { note } : {}) };
  try {
    if (input.stage === 'reject') {
      return { ok: true, value: await deps.client.hr.businessTrips.reject(payload) };
    }
    const call = () =>
      input.stage === 'approve_l1'
        ? deps.client.hr.businessTrips.approveL1(payload)
        : deps.client.hr.businessTrips.approveFinal(payload);

    if (isPositiveMoney(input.estimatedAllowance)) {
      const stepped = await deps.stepUp.run(input.prompt, call);
      if (!stepped.ok) return { ok: false, reason: stepped.reason };
      return { ok: true, value: stepped.value };
    }
    return { ok: true, value: await call() };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}
