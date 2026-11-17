// SPDX-License-Identifier: AGPL-3.0-only
// The effective set of apps an org has (ADR-0053, slice d): the deployment's list cut by kernel.org.apps.
import { describe, expect, it, vi } from 'vitest';
import { effectiveModules } from '../src/lib/modules.ts';

const deployment = ['kernel', 'finance', 'social', 'crm', 'meetings'];

describe('effectiveModules', () => {
  it('keeps every module when the org has switched nothing off', () => {
    const apps = deployment.filter((m) => m !== 'kernel').map((id) => ({ id, effective: true }));
    expect(effectiveModules(deployment, apps)).toEqual(['crm', 'finance', 'kernel', 'meetings', 'social']);
  });

  it('drops a module that is not effective, whether the owner switched it off or the plan lacks it', () => {
    const apps = [
      { id: 'finance', effective: true },
      { id: 'social', effective: false },
      { id: 'crm', effective: true },
      { id: 'meetings', effective: false },
    ];
    expect(effectiveModules(deployment, apps)).toEqual(['crm', 'finance', 'kernel']);
  });

  it('never drops kernel, and leaves a module the answer does not list as the deployment has it', () => {
    expect(effectiveModules(deployment, [{ id: 'kernel', effective: false }, { id: 'social', effective: false }])).toEqual(['crm', 'finance', 'kernel', 'meetings']);
    expect(effectiveModules(['finance'], [])).toEqual(['finance', 'kernel']);
  });

  it('never adds a module the deployment does not run', () => {
    expect(effectiveModules(['kernel', 'finance'], [{ id: 'social', effective: true }])).toEqual(['finance', 'kernel']);
  });
});

// The store the shell and the router fill (ADR-0053, slice d): the deployment's list until the org's answer is in, and a version that moves only when the answer changes.
const deployment$ = vi.hoisted(() => ({ modules: ['kernel', 'finance', 'social'] as string[] }));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: deployment$.modules }) }));

describe('the org modules store', () => {
  it('stands on the deployment until the org answers, tells its listeners only of a real change, and goes back to the deployment when cleared', async () => {
    const { installedModules, setOrgModules, subscribeOrgModules } = await import('../src/lib/org-modules.ts');
    let calls = 0;
    const stop = subscribeOrgModules(() => (calls += 1));
    expect(installedModules()).toEqual(['kernel', 'finance', 'social']);
    // An answer with the deployment's modules, in any order, changes nothing.
    setOrgModules(['finance', 'kernel', 'social']);
    expect(calls).toBe(0);
    // Social switched off: one change.
    setOrgModules(['finance', 'kernel']);
    expect(calls).toBe(1);
    expect(installedModules()).toEqual(['finance', 'kernel']);
    // The same answer again: none.
    setOrgModules(['kernel', 'finance']);
    expect(calls).toBe(1);
    // Entering another org clears it: the deployment's list stands, which is a change from the answer.
    setOrgModules(null);
    expect(calls).toBe(2);
    expect(installedModules()).toEqual(['kernel', 'finance', 'social']);
    stop();
    setOrgModules(['kernel']);
    expect(calls).toBe(2);
    setOrgModules(null);
  });
});
