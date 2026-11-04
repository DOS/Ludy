// SPDX-License-Identifier: AGPL-3.0-only
// The steps of an activation (W2-4b, issue #2296, ADR-0043 points 4 and 5, plan docs/plan/ads-write.md sections 3.6 and 9), as pure functions: which objects of a launch are
// switched on, in what order, and the key of each call in the kernel's `external_call` ledger. Nothing here touches the database or a platform: launch-activate.ts (the
// commands) and apps/kernel/src/ads-activate.ts (the job) use it. The order is the safety of the whole: each ad first, then the ad set, then the campaign LAST, so nothing
// delivers until the campaign is on and a failure half way spends nothing.
import { launchCallKey } from './launch-steps.ts';

// The level of an object that has a status of its own to switch on (a creative has none).
export type ActivationLevel = 'campaign' | 'ad_set' | 'ad';

// The step of the activation of an object: `activate_<slot>`. At most `activate_ad_set` is eleven characters past the prefix, inside the ledger's own limit.
export const activationStep = (slot: string): string => `activate_${slot}`;

// The objects a plan switches on, in order: an ad per text variant, the ad set, the campaign. `variants` is how many text variants the plan has.
export function activationSlots(variants: number): string[] {
  const slots: string[] = [];
  for (let n = 1; n <= variants; n += 1) slots.push(`ad_${n}`);
  slots.push('ad_set', 'campaign');
  return slots;
}

export function activationLevel(slot: string): ActivationLevel {
  if (slot === 'campaign' || slot === 'ad_set') return slot;
  if (/^ad_[1-3]$/.test(slot)) return 'ad';
  throw new Error(`not an object that is switched on: ${slot}`);
}

// The key of the call that switches an object on: the launch's own key scheme (`ads.launch:<launch>:<attempt>:<step>`), so a launch's calls are one family.
export const activationCallKey = (launchId: string, attempt: number, slot: string): string => launchCallKey(launchId, attempt, activationStep(slot));

// The slot an activation step is for, or null when the step is not one.
export function slotOfActivationStep(step: string): string | null {
  const match = /^activate_(ad_[1-3]|ad_set|campaign)$/.exec(step);
  return match ? (match[1] as string) : null;
}
