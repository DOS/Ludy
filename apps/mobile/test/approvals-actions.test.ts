// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { LudyClient } from '@ludy/client';
import { createStepUpGate } from '../src/auth/step-up.ts';
import {
  approveInboxProposal,
  decideBusinessTrip,
  decideLeaveRequest,
  decideSalaryAdvance,
  decideSocialPostVariants,
  editInboxProposal,
  rejectInboxProposal,
} from '../src/screens/approvals/actions.ts';
import { fakeLocalAuth, nodeCrypto } from './helpers.ts';

describe('approval executors with biometric step-up and strict offline guard', () => {
  it('blocks mutations immediately when offline without invoking biometrics or network', async () => {
    const auth = fakeLocalAuth({ level: 'biometric', answers: [true] });
    const stepUp = createStepUpGate({ localAuth: auth, now: () => 1000 });
    let called = false;
    const client = {
      inbox: {
        approve: async () => {
          called = true;
          return {};
        },
        edit: async () => {
          called = true;
          return { revision: 2, changed: true };
        },
        reject: async () => {
          called = true;
          return { ok: true };
        },
      },
      hr: {
        leaveRequests: {
          approveL1: async () => {
            called = true;
            return {};
          },
        },
      },
    } as unknown as LudyClient;

    const r1 = await approveInboxProposal(
      { client, stepUp, crypto: nodeCrypto, isOffline: true },
      { id: 'p1', revision: 1, prompt: 'Approve invoice' },
    );
    const r2 = await editInboxProposal(
      { client, crypto: nodeCrypto, isOffline: true },
      { id: 'p1', revision: 1, lineAccounts: [{ lineNo: 1, debitAccount: '6422' }] },
    );
    const r3 = await rejectInboxProposal({ client, isOffline: true }, { id: 'p1' });
    const r4 = await decideLeaveRequest({ client, isOffline: true }, { requestId: 'l1', stage: 'approve_l1' });

    expect(r1).toEqual({ ok: false, reason: 'offline' });
    expect(r2).toEqual({ ok: false, reason: 'offline' });
    expect(r3).toEqual({ ok: false, reason: 'offline' });
    expect(r4).toEqual({ ok: false, reason: 'offline' });
    expect(auth.prompts).toHaveLength(0);
    expect(called).toBe(false);
  });

  it('requires biometric confirmation before inbox R3 approval and passes UUID idempotencyKey', async () => {
    const authDenied = fakeLocalAuth({ level: 'biometric', answers: [false] });
    const gateDenied = createStepUpGate({ localAuth: authDenied, now: () => 1000 });
    let sent = 0;
    let capturedPayload: Record<string, unknown> | null = null;
    const client = {
      inbox: {
        approve: async (input: Record<string, unknown>) => {
          sent += 1;
          capturedPayload = input;
          return { documentId: 'doc-1' };
        },
      },
    } as unknown as LudyClient;

    const cancelled = await approveInboxProposal(
      { client, stepUp: gateDenied, crypto: nodeCrypto },
      { id: 'p1', revision: 2, prompt: 'Duyệt hóa đơn' },
    );
    expect(cancelled).toEqual({ ok: false, reason: 'biometric' });
    expect(sent).toBe(0);
    expect(authDenied.prompts).toEqual(['Duyệt hóa đơn']);

    const authOk = fakeLocalAuth({ level: 'biometric', answers: [true] });
    const gateOk = createStepUpGate({ localAuth: authOk, now: () => 2000 });
    const ok = await approveInboxProposal(
      { client, stepUp: gateOk, crypto: nodeCrypto },
      {
        id: 'p1',
        revision: 2,
        prompt: 'Duyệt hóa đơn',
        acceptFailedChecks: true,
        acceptUnverifiedSignature: true,
        note: '  OK  ',
      },
    );
    expect(ok).toEqual({ ok: true, value: { documentId: 'doc-1' } });
    expect(sent).toBe(1);
    expect(capturedPayload?.note).toBe('OK');
    expect(String(capturedPayload?.idempotencyKey)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('maps STEP_UP_REQUIRED and MFA_REQUIRED refusals cleanly to kernel-step-up', async () => {
    const auth = fakeLocalAuth({ level: 'biometric', answers: [true] });
    const stepUp = createStepUpGate({ localAuth: auth, now: () => 1000 });
    const client = {
      inbox: {
        approve: async () => {
          throw Object.assign(new Error('Need 2FA'), { code: 'STEP_UP_REQUIRED', status: 403 });
        },
      },
    } as unknown as LudyClient;

    const outcome = await approveInboxProposal(
      { client, stepUp, crypto: nodeCrypto },
      { id: 'p1', revision: 1, prompt: 'Confirm' },
    );
    expect(outcome).toEqual({ ok: false, reason: 'kernel-step-up' });
  });

  it('executes inline account edit and reject without biometric prompt', async () => {
    let edited: Record<string, unknown> | null = null;
    let rejected: Record<string, unknown> | null = null;
    const client = {
      inbox: {
        edit: async (input: Record<string, unknown>) => {
          edited = input;
          return { revision: 3, changed: true };
        },
        reject: async (input: Record<string, unknown>) => {
          rejected = input;
          return { ok: true };
        },
      },
    } as unknown as LudyClient;

    const editRes = await editInboxProposal(
      { client, crypto: nodeCrypto },
      { id: 'p1', revision: 2, lineAccounts: [{ lineNo: 1, debitAccount: '6422' }] },
    );
    expect(editRes).toEqual({ ok: true, value: { revision: 3, changed: true } });
    expect(edited?.lineAccounts).toEqual([{ lineNo: 1, debitAccount: '6422' }]);

    const rejRes = await rejectInboxProposal({ client }, { id: 'p1', reason: '   ' });
    expect(rejRes).toEqual({ ok: true, value: { ok: true } });
    expect(Object.hasOwn(rejected ?? {}, 'reason')).toBe(false);
  });

  it('guards monetary HR approvals with biometrics and skips biometrics on zero-cost trips / leaves', async () => {
    const auth = fakeLocalAuth({ level: 'biometric', answers: [true, true] });
    const stepUp = createStepUpGate({ localAuth: auth, now: () => 1000, freshMs: 0 });
    const calls: string[] = [];
    const client = {
      hr: {
        salaryAdvances: {
          approveL1: async () => {
            calls.push('adv_l1');
            return { requestId: 'a1', status: 'pending_final' };
          },
          approveFinal: async () => {
            calls.push('adv_final');
            return { requestId: 'a1', status: 'approved' };
          },
          reject: async () => {
            calls.push('adv_reject');
            return { requestId: 'a1', status: 'rejected' };
          },
        },
        businessTrips: {
          approveL1: async () => {
            calls.push('trip_l1');
            return { requestId: 't1', status: 'pending_final' };
          },
          approveFinal: async () => {
            calls.push('trip_final');
            return { requestId: 't1', status: 'approved' };
          },
          reject: async () => {
            calls.push('trip_reject');
            return { requestId: 't1', status: 'rejected' };
          },
        },
        leaveRequests: {
          approveFinal: async () => {
            calls.push('leave_final');
            return { requestId: 'l1', status: 'approved', payrollLeaveEntryId: null };
          },
        },
      },
      social: {
        variants: {
          decide: async (input: Record<string, unknown>) => {
            calls.push(`social_${String(input.decision)}`);
            return { postId: 's1', decision: 'approved', variants: ['v1'], waiting: [] };
          },
        },
      },
    } as unknown as LudyClient;

    await decideSalaryAdvance({ client, stepUp }, { requestId: 'a1', stage: 'approve_final', prompt: 'Ứng lương' });
    expect(auth.prompts).toHaveLength(1);

    await decideBusinessTrip(
      { client, stepUp },
      { requestId: 't1', stage: 'approve_l1', estimatedAllowance: '1500000', prompt: 'Công tác' },
    );
    expect(auth.prompts).toHaveLength(2);

    // Zero-allowance trip and leave do not trigger biometrics.
    await decideBusinessTrip(
      { client, stepUp },
      { requestId: 't2', stage: 'approve_l1', estimatedAllowance: '0', prompt: 'Không chi phí' },
    );
    await decideLeaveRequest({ client }, { requestId: 'l1', stage: 'approve_final' });
    await decideSocialPostVariants(
      { client },
      {
        postId: 's1',
        decision: 'approved',
        variants: [{ variantId: 'v1', revision: 1, contentHash: 'sha256:' + 'a'.repeat(64), checks: ['c1'] }],
      },
    );

    expect(auth.prompts).toHaveLength(2);
    expect(calls).toEqual(['adv_final', 'trip_l1', 'trip_l1', 'leave_final', 'social_approved']);
  });
});
