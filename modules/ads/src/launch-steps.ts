// SPDX-License-Identifier: AGPL-3.0-only
// The steps of a launch (W2-3, issue #2296, plan docs/plan/ads-write.md sections 3.4 and 9), as pure functions: which objects a plan creates at the platform and in
// what order, the key of each platform call in the kernel's `external_call` ledger, the name every object carries (with the launch's tag, so a create whose
// answer was lost is found again and never repeated), the flight in the account's own time zone, and what to do with the ledger row a step finds. Nothing here
// touches the database or a platform: launch-run.ts (the commands) and apps/kernel/src/ads-launch.ts (the job) use it.
//
// A launch creates, in this order and every one PAUSED: the campaign, the ad set, and for each text variant a creative and an ad. Nothing in W2-3 un-pauses an
// object: when the last create is recorded the launch is at the step `paused` (objects created, paused) and waits for W2-4's activation.
import type { AdsCampaignPlan } from '@crove/kernel-contract';

export const LAUNCH_LEVELS = ['campaign', 'ad_set', 'creative', 'ad'] as const;
export type LaunchLevel = (typeof LAUNCH_LEVELS)[number];

// The step recorded on the ledger row once every object exists: created, paused, waiting for the activation of W2-4.
export const LAUNCH_STEP_PAUSED = 'paused';

// A step the job begun and heard nothing of for this long is taken to be lost (the worker died between the call and its record) and is reconciled, not
// repeated; an answer the job itself marked unclear (a timeout, a lost answer) is reconciled once the platform has had a minute to show the object.
export const STARTED_STALE_SECONDS = 300;
export const RECONCILE_WAIT_SECONDS = 60;

// The steps of a plan with `variants` text variants: `campaign`, `ad_set`, then `creative_<n>` and `ad_<n>` for each variant.
export function launchSteps(variants: number): string[] {
  const steps = ['campaign', 'ad_set'];
  for (let n = 1; n <= variants; n += 1) steps.push(`creative_${n}`, `ad_${n}`);
  return steps;
}

export function stepLevel(step: string): LaunchLevel {
  if (step === 'campaign' || step === 'ad_set') return step;
  if (/^creative_[1-3]$/.test(step)) return 'creative';
  if (/^ad_[1-3]$/.test(step)) return 'ad';
  throw new Error(`unknown launch step: ${step}`);
}

// The variant a creative or an ad step is for (1 to 3).
export function stepVariant(step: string): number {
  const match = /^(?:creative|ad)_([1-3])$/.exec(step);
  if (!match) throw new Error(`not a variant step: ${step}`);
  return Number(match[1]);
}

// The key of a platform call: the launch, the attempt (a person's retry of a launch that needed attention makes a new one) and the step. Deterministic, so the
// same call is the same row of the ledger and a second begin finds the first.
export function launchCallKey(launchId: string, attempt: number, step: string): string {
  return `ads.launch:${launchId}:${attempt}:${step}`;
}

const KEY = /^ads\.launch:([0-9a-f-]{36}):(\d{1,2}):([a-z][a-z0-9_]{0,31})$/;
export function parseLaunchCallKey(key: string): { launchId: string; attempt: number; step: string } | null {
  const match = KEY.exec(key);
  return match ? { launchId: match[1] as string, attempt: Number(match[2]), step: match[3] as string } : null;
}

// The tail of an object's name: the launch's tag and what the object is (ASCII, so nothing a platform does to the plan's own text can change it). Reconcile
// matches an object by this tail: two steps of one launch never have the same.
export function nameTail(tag: string, step: string): string {
  const level = stepLevel(step);
  return `${tag}${level === 'campaign' ? '' : level === 'ad_set' ? ' set' : ` ${level} ${stepVariant(step)}`}`;
}

// The longest an object's name is made (the platform's limit for a creative's is not known to be more [U]): the plan's name is cut to leave room for the tail.
export const OBJECT_NAME_MAX = 100;

// The name of an object: the plan's name, the launch's tag and what it is. The tag is in every name (`ludy:` and ten characters), which is how reconcile
// finds an object that was created and never recorded.
export function objectName(planName: string, tag: string, step: string): string {
  const tail = ` ${nameTail(tag, step)}`;
  return `${planName.slice(0, OBJECT_NAME_MAX - tail.length)}${tail}`;
}

// A step the job could not settle (an answer it cannot tell, a platform that could not be asked, a name that matches more than one object) is looked at again by the
// sweep; after this many calls, or this long since its first call, a person is told (the launch needs attention) instead of the same question being asked for ever.
export const UNCLEAR_MAX_CALLS = 3;
export const UNCLEAR_GIVE_UP_SECONDS = 3600;

// The first moment of a day in the account's own time zone as ISO 8601 with its offset (`2026-11-05T00:00:00+0700`), for the start and the end of a flight (the
// end is the first moment of the day after the last day). A zone this runtime does not know is UTC.
export function zonedMidnight(day: string, zone: string | null): string {
  // The zone's offset at an instant, in minutes east of UTC (0 for a zone this runtime does not know).
  const offsetAt = (instant: number): number => {
    try {
      const part = new Intl.DateTimeFormat('en-US', { timeZone: zone ?? 'UTC', timeZoneName: 'longOffset' }).formatToParts(new Date(instant)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
      const match = /^GMT([+-])(\d{2}):?(\d{2})?$/.exec(part);
      return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? '0')) : 0;
    } catch {
      return 0;
    }
  };
  // The offset that holds at the zone's own midnight, not at some other hour of that day: a zone that changes its offset on that day (daylight saving) has two.
  // First the offset at the UTC midnight of the day, which puts the guess of the instant near the local midnight; if the zone's offset there is another one, that
  // is the one at local midnight (the change happened between the two instants).
  const base = Date.parse(`${day}T00:00:00Z`);
  const guess = offsetAt(base);
  const offset = offsetAt(base - guess * 60_000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${day}T00:00:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

export const dayAfter = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// What a step does with the ledger row it finds for its key (`row` is null when there is none yet):
// - `call`: no row, so begin makes it (committed as started) and the job makes the call;
// - `reconcile`: a row the job began and never settled, old enough to be lost (started), or marked unclear and past the wait (ambiguous): ask the platform for
//   the object by its tag before anything is created again;
// - `wait`: a call that may still be in flight, or an unclear one inside its wait: nothing now;
// - `settled`: a row that already succeeded (the object is recorded) or failed (the platform refused it: the launch needs attention).
export type StepAction = 'call' | 'reconcile' | 'wait' | 'settled';
export function stepAction(row: { state: string; updatedAt: Date } | null, now: Date): StepAction {
  if (!row) return 'call';
  if (row.state === 'succeeded' || row.state === 'failed') return 'settled';
  const age = (now.getTime() - row.updatedAt.getTime()) / 1000;
  if (row.state === 'started') return age >= STARTED_STALE_SECONDS ? 'reconcile' : 'wait';
  return age >= RECONCILE_WAIT_SECONDS ? 'reconcile' : 'wait';
}

// The names of a plan's locations and interests, split the way the platform takes them: a location with no region is a country as it stands, one with a
// region is a region to look up (the platform's key for it), and an interest is a name to look up.
export interface TargetingNames {
  countries: string[];
  regions: Array<{ country: string; name: string }>;
  interests: string[];
  ageMin: number;
  ageMax: number;
  gender: 'all' | 'male' | 'female';
}
export function targetingNames(plan: AdsCampaignPlan): TargetingNames {
  const countries = new Set<string>();
  const regions: Array<{ country: string; name: string }> = [];
  for (const location of plan.targeting.locations) {
    if (location.region) regions.push({ country: location.country, name: location.region });
    else countries.add(location.country);
  }
  return { countries: [...countries], regions, interests: [...plan.targeting.interests], ageMin: plan.targeting.ageMin, ageMax: plan.targeting.ageMax, gender: plan.targeting.gender };
}
