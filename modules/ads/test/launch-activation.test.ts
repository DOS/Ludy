// SPDX-License-Identifier: AGPL-3.0-only
// The pure rules of an activation (W2-4b, #2296): which objects of a launch are switched on and in what order (each ad, then the ad set, the campaign LAST), the key of each call in
// the ledger (the launch's own key scheme, so the family is one), and which rows of earlier attempts a retry must reconcile before it creates anything. Nothing here touches a
// database or a platform.
import { describe, expect, it } from 'vitest';
import { activationCallKey, activationLevel, activationSlots, activationStep, slotOfActivationStep } from '../src/launch-activation.ts';
import { launchCallKey, parseLaunchCallKey, unsettledEarlier } from '../src/launch-steps.ts';

const LAUNCH = '0198f3c2-7b1e-7000-8000-0123456789ab';

describe('the order of an activation', () => {
  it('switches on each ad, then the ad set, and the campaign last', () => {
    expect(activationSlots(1)).toEqual(['ad_1', 'ad_set', 'campaign']);
    expect(activationSlots(3)).toEqual(['ad_1', 'ad_2', 'ad_3', 'ad_set', 'campaign']);
    expect(activationSlots(3).at(-1)).toBe('campaign');
    // A creative has no status of its own and is never a step.
    expect(activationSlots(3).some((s) => s.startsWith('creative'))).toBe(false);
  });

  it('names the level of each slot and refuses a slot that is not switched on', () => {
    expect(['campaign', 'ad_set', 'ad_2'].map(activationLevel)).toEqual(['campaign', 'ad_set', 'ad']);
    expect(() => activationLevel('creative_1')).toThrow();
    expect(() => activationLevel('ad_4')).toThrow();
  });

  it('keys a call in the launch\'s own scheme, and reads the slot back from the step', () => {
    expect(activationStep('ad_set')).toBe('activate_ad_set');
    expect(activationCallKey(LAUNCH, 2, 'campaign')).toBe(`ads.launch:${LAUNCH}:2:activate_campaign`);
    expect(parseLaunchCallKey(activationCallKey(LAUNCH, 2, 'ad_1'))).toEqual({ launchId: LAUNCH, attempt: 2, step: 'activate_ad_1' });
    expect(slotOfActivationStep('activate_ad_3')).toBe('ad_3');
    expect(slotOfActivationStep('activate_ad_set')).toBe('ad_set');
    expect(slotOfActivationStep('activate_creative_1')).toBeNull();
    expect(slotOfActivationStep('campaign')).toBeNull();
  });
});

describe('the rows of earlier attempts a retry looks at', () => {
  const row = (attempt: number, step: string, state: string) => ({ key: launchCallKey(LAUNCH, attempt, step), state });

  it('takes the started and the unclear rows of the same step of an earlier attempt, and no others', () => {
    const rows = [row(1, 'ad_set', 'ambiguous'), row(1, 'campaign', 'started'), row(2, 'ad_set', 'started'), row(1, 'ad_set', 'succeeded'), row(1, 'ad_set', 'failed'), { key: launchCallKey('0198f3c2-7b1e-7000-8000-ffffffffffff', 1, 'ad_set'), state: 'ambiguous' }];
    expect(unsettledEarlier(rows, LAUNCH, 3, 'ad_set').map((r) => r.key)).toEqual([launchCallKey(LAUNCH, 1, 'ad_set'), launchCallKey(LAUNCH, 2, 'ad_set')]);
    // The attempt itself and later ones are not "earlier".
    expect(unsettledEarlier(rows, LAUNCH, 2, 'ad_set').map((r) => parseLaunchCallKey(r.key)?.attempt)).toEqual([1]);
    expect(unsettledEarlier(rows, LAUNCH, 1, 'ad_set')).toEqual([]);
    // A row that is not of a launch call at all is ignored.
    expect(unsettledEarlier([{ key: 'social.publish:x', state: 'started' }], LAUNCH, 2, 'ad_set')).toEqual([]);
  });
});
