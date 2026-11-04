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

// Which object of a launch a name is, from its tail (the inverse of `nameTail`): the tag and what the object is. null for a name that does not carry the tag, or
// whose tail is not one of the launch's steps (an object that cannot be told, which the pause job still pauses but does not record). `variants` is how many text
// variants the plan has (a creative or an ad past that is not one of this launch's).
export function slotOfName(tag: string, name: string, variants: number): string | null {
  const at = name.indexOf(tag);
  if (at < 0) return null;
  const tail = name.slice(at + tag.length);
  if (tail === '') return 'campaign';
  if (tail === ' set') return 'ad_set';
  const match = /^ (creative|ad) ([1-3])$/.exec(tail);
  if (!match || Number(match[2]) > variants) return null;
  return `${match[1] === 'creative' ? 'creative' : 'ad'}_${match[2]}`;
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

// Whether a time zone name is one this runtime knows. The account's zone is what the platform's sync recorded; the flight cannot be put in one that is missing or
// that this runtime cannot read.
export function zoneKnown(zone: string | null): zone is string {
  if (!zone) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions();
    return true;
  } catch {
    return false;
  }
}

// The first moment of a day in the account's own time zone as ISO 8601 with its local time and offset (`2026-11-05T00:00:00+0700`), for the start and the end of a flight
// (the end is the first moment of the day after the last day). It throws for a zone that is not known (`zoneKnown`). When the zone skips its own midnight on that day (a
// daylight-saving change at midnight: Santiago on 6 September 2026, where the clocks go from 23:59 to 01:00), the day starts at the first moment that exists, so that
// is the answer (`2026-09-06T01:00:00-0300`): never an instant of the day before.
export function zonedMidnight(day: string, zone: string | null): string {
  // A zone this runtime does not know (none recorded, or a name it cannot read) is not guessed as UTC: a flight window put in the wrong zone drifts away from the
  // days the launch's commitment holds. The launch checks the zone before any call (`zoneKnown`); this throws if it is asked anyway.
  if (!zoneKnown(zone)) throw new Error('unknown time zone');
  // The zone's offset at an instant, in minutes east of UTC.
  const offsetAt = (instant: number): number => {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(instant)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /^GMT([+-])(\d{2}):?(\d{2})?$/.exec(part);
    return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? '0')) : 0;
  };
  const clock = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const localOf = (instant: number): { date: string; time: string } => {
    const parts = clock.formatToParts(new Date(instant));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}` };
  };
  // The first minute whose local date is the day or later. Local dates only grow with the instant, and every zone's offset is between -12 and +14 hours, so it lies
  // between 15 hours before the UTC midnight of the day (still the day before, wherever) and 15 hours after it (already the day, wherever); a bisection finds it. At
  // the zone's own midnight it is that midnight, with the offset that holds there (a zone that changes its offset on that day has two); where midnight is skipped it
  // is the first moment after the skip.
  const base = Date.parse(`${day}T00:00:00Z`);
  let low = base - 15 * 3_600_000;
  let high = base + 15 * 3_600_000;
  while (high - low > 60_000) {
    const mid = low + Math.floor((high - low) / 120_000) * 60_000;
    if (localOf(mid).date >= day) high = mid;
    else low = mid;
  }
  const local = localOf(high);
  const offset = offsetAt(high);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${local.date}T${local.time}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
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
