// SPDX-License-Identifier: AGPL-3.0-only
// What the manage job is given of an ad platform (ADR-0043, issue #3835, ads W4): the calls that change a LIVE launch's objects, and nothing else. A launch's objects are
// created paused and switched on by the approved launch (activators.ts); managing them afterwards is a person's: pause or archive an object, switch a paused one back on
// (a resume, which is an approved R3 change), set the ad set's daily budget, set its end date, and read an object back. This is NOT a method of `AdWriter`: the launch job's
// view has no way to change a status, the pause job's can only pause by a tag, the activation job's can only switch on a launch's own objects, and this view cannot create an
// object, find one by a tag, verify a token or revoke it, not even by a cast: it is a new, frozen object of closures, like the other narrowed views.
//
// The caller (apps/kernel/src/ads-manage.ts) passes only the ids of objects Ludy recorded for the launch, and only after the kernel's begin step re-checked the stop
// conditions and, for what can raise spend, the caps for that very call.
import { AdPlatformError } from './index.ts';
import type { PlatformObjectStatus } from './activators.ts';
import type { AdWriterAccount } from './writer.ts';

// The levels that have a status of their own, and the one level that carries a budget and a schedule.
export const MANAGE_LEVELS = ['campaign', 'ad_set', 'ad'] as const;
export type ManageLevel = (typeof MANAGE_LEVELS)[number];
export const MANAGE_STATUSES = ['active', 'paused', 'archived'] as const;
export type ManageStatus = (typeof MANAGE_STATUSES)[number];

export interface ManageTarget {
  level: ManageLevel;
  id: string;
}

// What the platform says of an object now: its own status and, for an ad set, its daily budget in the account currency's own units (a decimal string) and its end time
// (ISO 8601). null for what the platform did not say.
export interface ManagedRead {
  status: PlatformObjectStatus;
  dailyBudget: string | null;
  endTime: string | null;
}

export interface AdManager {
  // Sets the status of one object. A failure is an `AdPlatformError` (`bad_request` and `permission` mean the platform refused it; `transient`, `rate_limited` and `unknown`
  // mean it may or may not have changed, which the caller settles with `read` before it asks again). Setting a status is idempotent.
  changeStatus(secret: string, object: ManageTarget, status: ManageStatus): Promise<void>;
  // Sets the ad set's daily budget, a decimal string in the account currency's own units, converted exactly to the platform's own unit (never a number).
  setBudget(secret: string, object: ManageTarget, account: AdWriterAccount, dailyBudget: string): Promise<void>;
  // Sets the ad set's end time, the first moment after its last day in the account's zone, ISO 8601 with its offset.
  setEndTime(secret: string, object: ManageTarget, endTime: string): Promise<void>;
  // Reads an object back (changes nothing).
  read(secret: string, object: ManageTarget, account: AdWriterAccount): Promise<ManagedRead>;
}

const LEVELS: ReadonlySet<string> = new Set<string>(MANAGE_LEVELS);
const STATUSES: ReadonlySet<string> = new Set<string>(MANAGE_STATUSES);

// The frozen view the manage job is given: four closures and nothing else. The levels and the statuses are checked here as well as in the adapters, so a call for anything
// else (a creative has no status, a budget belongs to an ad set) never reaches a platform.
export function managerOf(manager: AdManager): AdManager {
  const checked = (object: ManageTarget): ManageTarget => {
    if (!LEVELS.has(object.level)) throw new AdPlatformError('bad_request', 'LEVEL_NOT_MANAGEABLE');
    return { level: object.level, id: object.id };
  };
  const adSet = (object: ManageTarget): ManageTarget => {
    const target = checked(object);
    if (target.level !== 'ad_set') throw new AdPlatformError('bad_request', 'LEVEL_NOT_MANAGEABLE');
    return target;
  };
  return Object.freeze({
    changeStatus: async (secret: string, object: ManageTarget, status: ManageStatus) => {
      if (!STATUSES.has(status)) throw new AdPlatformError('bad_request', 'STATUS_REFUSED');
      return manager.changeStatus(secret, checked(object), status);
    },
    setBudget: async (secret: string, object: ManageTarget, account: AdWriterAccount, dailyBudget: string) => manager.setBudget(secret, adSet(object), account, dailyBudget),
    setEndTime: async (secret: string, object: ManageTarget, endTime: string) => manager.setEndTime(secret, adSet(object), endTime),
    read: async (secret: string, object: ManageTarget, account: AdWriterAccount) => manager.read(secret, checked(object), account),
  });
}
