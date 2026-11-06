// SPDX-License-Identifier: AGPL-3.0-only
// What the activation worker is given of an ad platform (ADR-0043 points 4 and 5, issue #2296, W2-4b): the two calls that switch on what a launch made, and nothing
// else. The objects of a launch are created PAUSED (W2-3) and stay so until the approved launch's last steps switch them on, one object at a time: each ad, then the ad
// set, then the campaign last (nothing delivers until the campaign is on, so a failure half way spends nothing). This is NOT a method of `AdWriter`: the launch job's
// view of the writer (launch-writers.ts) has no way to activate, the pause job's has no way either, and `setStatus` still takes `paused` and `archived` only. The view is
// a new, frozen object of closures, like the other narrowed views, so what the job holds cannot create, pause, archive, verify or revoke, not even by a cast.
//
// The caller (apps/kernel/src/ads-activate.ts) passes only the ids of objects Ludy recorded for the launch, never one found by a tag, and only after the kernel's begin
// step re-checked the stop conditions, the plan and the caps for that very call.
import { AdPlatformError } from './index.ts';

// The levels that have a status of their own to switch on. A creative has none: it delivers once an ad that uses it is on.
export const ACTIVATE_LEVELS = ['campaign', 'ad_set', 'ad'] as const;
export type ActivateLevel = (typeof ACTIVATE_LEVELS)[number];

export interface ActivateTarget {
  level: ActivateLevel;
  id: string;
}

// What the platform says an object's own status is. `other` is anything else it can say (deleted, a status Ludy does not name).
export type PlatformObjectStatus = 'active' | 'paused' | 'archived' | 'other';

export interface AdActivator {
  // Switches one object on. A failure is an `AdPlatformError` (`bad_request` and `permission` mean the platform refused it; `transient`, `rate_limited` and `unknown`
  // mean it may or may not have changed, which the caller settles with `readStatus` before it asks again). Setting a status is idempotent.
  activate(secret: string, object: ActivateTarget): Promise<void>;
  // The object's own status at the platform, with a read (changes nothing).
  readStatus(secret: string, object: ActivateTarget): Promise<{ status: PlatformObjectStatus }>;
}

const KNOWN: ReadonlySet<string> = new Set<string>(ACTIVATE_LEVELS);

// The frozen view the activation job is given: two closures and nothing else. The levels are checked here as well as in the adapters, so a call for anything else
// (a creative has no status) never reaches a platform.
export function activatorOf(activator: AdActivator): AdActivator {
  const checked = (object: ActivateTarget): ActivateTarget => {
    if (!KNOWN.has(object.level)) throw new AdPlatformError('bad_request', 'LEVEL_NOT_ACTIVATABLE');
    return { level: object.level, id: object.id };
  };
  return Object.freeze({
    activate: async (secret: string, object: ActivateTarget) => activator.activate(secret, checked(object)),
    readStatus: async (secret: string, object: ActivateTarget) => activator.readStatus(secret, checked(object)),
  });
}
