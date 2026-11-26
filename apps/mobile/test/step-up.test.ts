// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createStepUpGate, STEP_UP_FRESH_MS } from '../src/auth/step-up.ts';
import { fakeLocalAuth } from './helpers.ts';

function gate(answers: boolean[] = []) {
  let now = 1000;
  const local = fakeLocalAuth({ answers });
  const g = createStepUpGate({ localAuth: local, now: () => now });
  return { g, local, advance: (ms: number) => (now += ms) };
}

describe('step-up gate', () => {
  it('asks for the biometric before the action and does not run the action when it is refused', async () => {
    const { g, local } = gate([false]);
    let ran = false;
    const outcome = await g.run('Duyệt', async () => {
      ran = true;
      return 1;
    });
    expect(outcome).toEqual({ ok: false, reason: 'biometric' });
    expect(ran).toBe(false);
    expect(local.prompts).toEqual(['Duyệt']);
  });

  it('runs the action after a confirmed biometric', async () => {
    const { g } = gate([true]);
    expect(await g.run('Duyệt', async () => 'done')).toEqual({ ok: true, value: 'done' });
  });

  it('asks once for a quick run of actions and again after the window', async () => {
    const { g, local, advance } = gate();
    await g.run('a', async () => 1);
    advance(STEP_UP_FRESH_MS - 1);
    await g.run('b', async () => 1);
    expect(local.prompts).toEqual(['a']);
    advance(2);
    await g.run('c', async () => 1);
    expect(local.prompts).toEqual(['a', 'c']);
  });

  it('forgets the confirmation on reset (a lock or a sign-out)', async () => {
    const { g, local } = gate();
    await g.confirm('a');
    g.reset();
    await g.confirm('b');
    expect(local.prompts).toEqual(['a', 'b']);
  });

  it('does not let a prompt that was open when the app locked confirm anything afterwards', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const g = createStepUpGate({ localAuth: { level: async () => 'biometric', authenticate: () => new Promise<boolean>((resolve) => (finish = resolve)) }, now: () => 1 });
    const asked = g.confirm('a');
    g.reset();
    finish(true);
    expect(await asked).toBe(false);
  });

  it('shares one prompt between actions started together', async () => {
    const { g, local } = gate();
    const [a, b] = await Promise.all([g.confirm('a'), g.confirm('b')]);
    expect([a, b]).toEqual([true, true]);
    expect(local.prompts).toHaveLength(1);
  });

  it('reports the kernel\'s second-factor refusal as an outcome, and rethrows every other error', async () => {
    const { g } = gate();
    expect(await g.run('x', async () => Promise.reject({ status: 403, code: 'STEP_UP_REQUIRED' }))).toEqual({ ok: false, reason: 'kernel-step-up' });
    expect(await g.run('x', async () => Promise.reject({ status: 401, code: 'MFA_REQUIRED' }))).toEqual({ ok: false, reason: 'kernel-step-up' });
    await expect(g.run('x', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('treats a biometric API that throws as a refusal', async () => {
    const g = createStepUpGate({ localAuth: { level: async () => 'biometric', authenticate: async () => Promise.reject(new Error('hardware')) }, now: () => 1 });
    expect(await g.confirm('a')).toBe(false);
  });
});
