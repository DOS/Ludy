// SPDX-License-Identifier: AGPL-3.0-only
// The effective set of an org's apps (ADR-0053 section 1), without a database: kernel is always on; any other app is on
// only when the deployment runs it, the org holds it and did not switch it off.
import { describe, expect, it } from 'vitest';
import { entitledTo } from '@crove/kernel-runtime';
import { appEffective, switchableApps } from '../src/org-apps.ts';

const DEPLOYMENT = ['kernel', 'finance', 'social'];

describe('per-org app enablement', () => {
  it('lists the apps an org may switch: everything the build ships but kernel', () => {
    expect(switchableApps(['kernel', 'finance', 'social'])).toEqual(['finance', 'social']);
    expect(switchableApps(['finance'])).toEqual(['finance']);
  });

  it('reads entitlements as one key per module, `full` for all, kernel always', () => {
    expect(entitledTo(['full'], 'social')).toBe(true);
    expect(entitledTo(['finance'], 'finance')).toBe(true);
    expect(entitledTo(['finance'], 'social')).toBe(false);
    expect(entitledTo([], 'social')).toBe(false);
    expect(entitledTo([], 'kernel')).toBe(true);
  });

  it('is effective only with all three: the deployment, the entitlement and the org not switching it off', () => {
    const base = { deployment: DEPLOYMENT, entitlements: ['full'], appsOff: [] as string[] };
    expect(appEffective({ ...base, module: 'social' })).toBe(true);
    expect(appEffective({ ...base, module: 'social', appsOff: ['social'] })).toBe(false);
    expect(appEffective({ ...base, module: 'social', entitlements: ['finance'] })).toBe(false);
    expect(appEffective({ ...base, module: 'hr' })).toBe(false);
    // Switching off one app leaves the others.
    expect(appEffective({ ...base, module: 'finance', appsOff: ['social'] })).toBe(true);
  });

  it('keeps kernel on whatever the three say', () => {
    expect(appEffective({ module: 'kernel', deployment: [], entitlements: [], appsOff: ['kernel'] })).toBe(true);
  });
});
