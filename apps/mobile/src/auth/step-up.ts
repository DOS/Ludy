// SPDX-License-Identifier: AGPL-3.0-only
// The biometric step-up gate (issue #4880): the phone asks its owner again, right before a sensitive action, and the kernel's own
// rule stays the last word. Opening the app is not a step-up: unlocking at the start of a session never counts towards one, so
// "approve this payment" always asks. Two layers, in this order:
// 1. This phone: the biometric (falling back to the phone's passcode) must have been confirmed in the last STEP_UP_FRESH_MS, so
//    a quick run of related actions asks once. A refusal or a cancel does nothing and sends nothing.
// 2. The kernel: R3 work (an approval of money, a change of members) is refused with STEP_UP_REQUIRED unless the session passed
//    a second factor in the last 5 minutes (policy P11). The local biometric is not that factor: a phone cannot prove it to the
//    kernel. When the kernel asks, the gate reports `kernel-step-up` and the screen says to verify on the web. Doing the second
//    factor on the phone belongs to the approvals issue (#4881), which is the first screen that runs R3 commands.
// Pure over LocalAuthPort and a clock, so it is unit tested.
import { isMfaRequired, isStepUpRequired } from '@ludy/client';
import type { LocalAuthPort } from './session.ts';

export const STEP_UP_FRESH_MS = 30_000;

export type StepUpOutcome<T> =
  | { ok: true; value: T }
  // The person cancelled or failed the biometric: the action was not run.
  | { ok: false; reason: 'biometric' }
  // The action ran and the kernel refused it for want of a second factor: nothing was changed.
  | { ok: false; reason: 'kernel-step-up' };

export interface StepUpGate {
  // Asks for the biometric unless one was confirmed a moment ago; true when the person is confirmed.
  confirm(prompt: string): Promise<boolean>;
  // Runs `action` only after confirm(); maps the kernel's step-up refusal to an outcome instead of an error. Any other error is the caller's.
  run<T>(prompt: string, action: () => Promise<T>): Promise<StepUpOutcome<T>>;
  // Forgets the confirmation (the app locked, or the person signed out).
  reset(): void;
}

export function createStepUpGate(deps: { localAuth: LocalAuthPort; now: () => number; freshMs?: number }): StepUpGate {
  const freshMs = deps.freshMs ?? STEP_UP_FRESH_MS;
  let confirmedAt: number | null = null;
  let asking: Promise<boolean> | null = null;
  // Bumped by reset(): a prompt that was open when the app locked must not confirm anything afterwards.
  let generation = 0;

  const confirm = (prompt: string): Promise<boolean> => {
    if (confirmedAt !== null && deps.now() - confirmedAt >= 0 && deps.now() - confirmedAt < freshMs) return Promise.resolve(true);
    // One prompt at a time: two sensitive actions started together share the answer.
    if (asking) return asking;
    const startedIn = generation;
    asking = deps.localAuth
      .authenticate(prompt)
      .catch(() => false)
      .then((ok) => {
        if (generation !== startedIn) return false;
        confirmedAt = ok ? deps.now() : null;
        return ok;
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  };

  return {
    confirm,
    async run(prompt, action) {
      if (!(await confirm(prompt))) return { ok: false, reason: 'biometric' };
      try {
        return { ok: true, value: await action() };
      } catch (error) {
        if (isStepUpRequired(error) || isMfaRequired(error)) return { ok: false, reason: 'kernel-step-up' };
        throw error;
      }
    },
    reset() {
      generation += 1;
      confirmedAt = null;
    },
  };
}
