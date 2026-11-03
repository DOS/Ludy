// SPDX-License-Identifier: AGPL-3.0-only
// What a launch is made of (W2, issue #2296, plan docs/plan/ads-write.md sections 3.4 and 4, ADR-0043 point 5): the ordered steps with the deterministic
// key of each platform call, what a step that was started and not settled means, the name every object carries so it can be found again, and how an
// approved plan becomes what the platform's writer takes (the budget in the currency's smallest unit, the flight as moments in the account's time zone,
// the audience by the platform's ids). No database and no network: the commands and the job decide from these, and the tests pin them. Money is a decimal
// string and every conversion goes through decimal.js (AGENTS.md "Money").
import { Decimal } from 'decimal.js';
import type { AdsCampaignPlan } from '@crove/kernel-contract';
import { currencyDecimals } from './domain.ts';

// ---- Steps and keys ----

// The steps of a launch, in order. Creating steps make one object each (the platform has no idempotency key for them), the activations come last and
// children first, so nothing delivers until the campaign itself is switched on, which is the very last call: a launch that stops before it has spent nothing.
export type LaunchStep = string;

export function launchSteps(variants: number): LaunchStep[] {
  const each = Array.from({ length: variants }, (_, i) => i + 1);
  return [
    'campaign',
    'ad_set',
    ...each.map((n) => `creative_${n}`),
    ...each.map((n) => `ad_${n}`),
    ...each.map((n) => `activate_ad_${n}`),
    'activate_ad_set',
    'activate_campaign',
  ];
}

// The kind of object a creating step makes, or null for an activation.
export function stepLevel(step: LaunchStep): 'campaign' | 'ad_set' | 'creative' | 'ad' | null {
  if (step === 'campaign') return 'campaign';
  if (step === 'ad_set') return 'ad_set';
  if (/^creative_\d+$/.test(step)) return 'creative';
  if (/^ad_\d+$/.test(step)) return 'ad';
  return null;
}

// The 1-based number of the variant a step is about, or null (the campaign, the ad set and their activations).
export function stepVariant(step: LaunchStep): number | null {
  const match = /^(?:creative|ad|activate_ad)_(\d+)$/.exec(step);
  return match ? Number(match[1]) : null;
}

// The deterministic key of a platform call: the launch, the attempt (a person's retry starts a new one) and the step. The same key is the same call.
export const callKey = (launchId: string, attempt: number, step: LaunchStep): string => `ads.launch:${launchId.toLowerCase()}:${attempt}:${step}`;

// What repeating a step does at the platform (the kernel's retry safety). A create can make a second object, so it is never repeated before the
// platform was asked whether the first exists; a status change to the same status changes nothing.
export type RetrySafety = 'idempotent' | 'reconcile_only';
export const retrySafety = (step: LaunchStep): RetrySafety => (stepLevel(step) === null ? 'idempotent' : 'reconcile_only');

// What to do with a step, from the state of its call row and its retry safety: make the call, ask the platform first, or nothing (it has its outcome).
// A row still `started` is a run that died or a call that has not finished: it is treated as the call whose answer was lost.
export type CallState = 'none' | 'started' | 'succeeded' | 'failed' | 'ambiguous';
export type StepAction = 'call' | 'reconcile' | 'done';
export function nextAction(state: CallState, safety: RetrySafety): StepAction {
  if (state === 'none') return 'call';
  if (state === 'succeeded' || state === 'failed') return 'done';
  return safety === 'idempotent' ? 'call' : 'reconcile';
}

// ---- Names ----

// The tag every created object carries in its name, from the launch's id: the platform lists an account's objects by name, so an object created and
// never recorded is found again by it. Eight hex digits of the id, unique per launch for practical purposes (the database refuses a clash).
export const launchTag = (launchId: string): string => `ludy:${launchId.replace(/-/g, '').toLowerCase().slice(0, 8)}`;

// The name of the object a step makes: the plan's name, the tag and what the object is, so every name is unique to its launch and step.
export function objectName(planName: string, tag: string, step: LaunchStep): string {
  const variant = stepVariant(step);
  const mark = stepLevel(step) === 'campaign' ? tag : stepLevel(step) === 'ad_set' ? `${tag}:set` : `${tag}:v${variant ?? 1}`;
  return `${planName.trim()} [${mark}]`;
}

// ---- Money and time ----

// A decimal string in the currency's own units as a whole-number string of its smallest unit (a dong is its own smallest unit, a dollar is a hundred
// cents). An amount with more decimals than the currency has is refused, never rounded: the approver signed that amount.
export function toMinorUnits(amount: string, currency: string): string {
  const minor = new Decimal(amount).times(new Decimal(10).pow(currencyDecimals(currency)));
  if (!minor.isInteger() || minor.lte(0)) throw new Error('ADS_LAUNCH_AMOUNT: the amount is not a whole number of the currency\'s smallest unit');
  return minor.toFixed();
}

// The offset of a time zone at an instant, in minutes east of UTC.
function offsetMinutes(timeZone: string, at: Date): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(part);
  if (!match || !match[1]) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

// The start of a calendar day in a time zone, as ISO 8601 with the zone's offset at that moment ('2026-11-10T00:00:00+0700').
export function zonedMidnight(day: string, timeZone: string): string {
  const guess = Date.parse(`${day}T00:00:00Z`);
  let offset = offsetMinutes(timeZone, new Date(guess));
  let instant = guess - offset * 60_000;
  // Near a change of offset the first guess can be an hour off: the offset at the instant itself is the one that counts.
  const settled = offsetMinutes(timeZone, new Date(instant));
  if (settled !== offset) {
    offset = settled;
    instant = guess - offset * 60_000;
  }
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${day}T00:00:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

// The flight as the platform takes it: from the start of the first day to the start of the day after the last (both days run in full).
export function flightTimes(startOn: string, endOn: string, timeZone: string): { startTime: string; endTime: string } {
  const after = new Date(Date.parse(`${endOn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { startTime: zonedMidnight(startOn, timeZone), endTime: zonedMidnight(after, timeZone) };
}

// ---- The audience ----

// The names of a plan's audience the platform has to pin down: the interests, and the regions (a region is a name inside a country).
export function targetingNames(targeting: AdsCampaignPlan['targeting']): { interests: string[]; regions: Array<{ country: string; region: string }> } {
  return {
    interests: [...targeting.interests],
    regions: targeting.locations.flatMap((l) => (l.region ? [{ country: l.country, region: l.region }] : [])),
  };
}

// What the platform's search found for those names (the writer's `TargetingResolution`, structurally).
export interface Resolution {
  interests: { resolved: Array<{ name: string; id: string }>; unknown: string[]; ambiguous: string[] };
  regions: { resolved: Array<{ country: string; name: string; key: string }>; unknown: string[]; ambiguous: string[] };
}

// The names that stop a launch: one the platform does not know, or one it cannot tell from another. Empty when everything was pinned down.
export function unresolved(resolution: Resolution): { unknown: string[]; ambiguous: string[] } {
  return { unknown: [...resolution.interests.unknown, ...resolution.regions.unknown], ambiguous: [...resolution.interests.ambiguous, ...resolution.regions.ambiguous] };
}

// The audience as the writer takes it, from the plan and what was resolved. A location without a region is its whole country; one with a region is that
// region alone (its country is not added, which would widen the audience to all of it).
export function audienceOf(targeting: AdsCampaignPlan['targeting'], resolution: Resolution) {
  const countries = [...new Set(targeting.locations.filter((l) => !l.region).map((l) => l.country))];
  return {
    countries,
    regions: resolution.regions.resolved.map((r) => ({ key: r.key, name: r.name, country: r.country })),
    ageMin: targeting.ageMin,
    ageMax: targeting.ageMax,
    gender: targeting.gender,
    interests: resolution.interests.resolved.map((i) => ({ id: i.id, name: i.name })),
  };
}

// What the audit keeps of the resolution: the names as approved and the ids that were sent, so what went to the platform can be compared with what
// the approver signed (the PO's condition on interests, 2026-11-03).
export function resolutionRecord(resolution: Resolution): { interests: Array<{ name: string; id: string }>; regions: Array<{ country: string; name: string; key: string }> } {
  return { interests: resolution.interests.resolved.map((i) => ({ ...i })), regions: resolution.regions.resolved.map((r) => ({ ...r })) };
}
