// SPDX-License-Identifier: AGPL-3.0-only
// What a launch is made of (W2, #2296): the ordered steps and the key of each platform call, what a step started and never settled means, the tag and
// the names that let an object be found again, the budget in the currency's smallest unit, the flight in the account's time zone, and the audience by the
// platform's ids with the names that stop a launch.
import { describe, expect, it } from 'vitest';
import type { AdsCampaignPlan } from '@crove/kernel-contract';
import {
  audienceOf,
  callKey,
  flightTimes,
  launchSteps,
  launchTag,
  nextAction,
  objectName,
  resolutionRecord,
  retrySafety,
  stepLevel,
  stepVariant,
  targetingNames,
  toMinorUnits,
  unresolved,
  zonedMidnight,
  type Resolution,
} from '../src/launch-plan.ts';

const LAUNCH = '0190c4a1-aaaa-7000-8000-000000000001';

describe('the steps of a launch', () => {
  it('create top down, activate bottom up, and end with the campaign: nothing delivers before the very last call', () => {
    expect(launchSteps(2)).toEqual(['campaign', 'ad_set', 'creative_1', 'creative_2', 'ad_1', 'ad_2', 'activate_ad_1', 'activate_ad_2', 'activate_ad_set', 'activate_campaign']);
    expect(launchSteps(1).at(-1)).toBe('activate_campaign');
    // Every creating step comes before every activation.
    const steps = launchSteps(3);
    const firstActivation = steps.findIndex((s) => stepLevel(s) === null);
    expect(steps.slice(0, firstActivation).every((s) => stepLevel(s) !== null)).toBe(true);
    expect(steps.slice(firstActivation).every((s) => stepLevel(s) === null)).toBe(true);
  });

  it('says what a step makes and which variant it is about', () => {
    expect(['campaign', 'ad_set', 'creative_2', 'ad_3', 'activate_ad_1', 'activate_ad_set', 'activate_campaign'].map(stepLevel)).toEqual(['campaign', 'ad_set', 'creative', 'ad', null, null, null]);
    expect(['campaign', 'creative_2', 'ad_3', 'activate_ad_1', 'activate_campaign'].map(stepVariant)).toEqual([null, 2, 3, 1, null]);
  });

  it('keys each call by launch, attempt and step, so the same call has the same key and a retry has a new one', () => {
    expect(callKey(LAUNCH.toUpperCase(), 1, 'ad_set')).toBe(`ads.launch:${LAUNCH}:1:ad_set`);
    expect(callKey(LAUNCH, 2, 'ad_set')).not.toBe(callKey(LAUNCH, 1, 'ad_set'));
    // A key fits the ledger's column (1 to 500 characters) and its step the pattern of the step column.
    for (const step of launchSteps(3)) {
      expect(callKey(LAUNCH, 12, step).length).toBeLessThanOrEqual(500);
      expect(step).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    }
  });
});

describe('what a step that was started and not settled means', () => {
  it('calls when there is no row, and does nothing when the call has its outcome', () => {
    expect(nextAction('none', 'reconcile_only')).toBe('call');
    expect(nextAction('none', 'idempotent')).toBe('call');
    expect(nextAction('succeeded', 'reconcile_only')).toBe('done');
    expect(nextAction('failed', 'reconcile_only')).toBe('done');
  });

  it('asks the platform before it repeats a create, and repeats a status change at once', () => {
    for (const state of ['started', 'ambiguous'] as const) {
      expect(nextAction(state, retrySafety('campaign'))).toBe('reconcile');
      expect(nextAction(state, retrySafety('creative_2'))).toBe('reconcile');
      expect(nextAction(state, retrySafety('ad_1'))).toBe('reconcile');
      expect(nextAction(state, retrySafety('activate_campaign'))).toBe('call');
      expect(nextAction(state, retrySafety('activate_ad_1'))).toBe('call');
    }
  });
});

describe('the names that let an object be found again', () => {
  it('tags a launch from its id, and every object\'s name with the tag, the plan\'s name and what the object is', () => {
    expect(launchTag(LAUNCH)).toBe('ludy:0190c4a1');
    expect(launchTag(LAUNCH.toUpperCase())).toBe('ludy:0190c4a1');
    const tag = launchTag(LAUNCH);
    expect(objectName('  Khai trương  ', tag, 'campaign')).toBe('Khai trương [ludy:0190c4a1]');
    expect(objectName('Khai trương', tag, 'ad_set')).toBe('Khai trương [ludy:0190c4a1:set]');
    expect(objectName('Khai trương', tag, 'creative_2')).toBe('Khai trương [ludy:0190c4a1:v2]');
    expect(objectName('Khai trương', tag, 'ad_2')).toBe('Khai trương [ludy:0190c4a1:v2]');
    // Within one level a name names one object, across the steps of a launch.
    const steps = launchSteps(3).filter((s) => stepLevel(s) !== null);
    const byLevel = new Map<string, string[]>();
    for (const s of steps) byLevel.set(stepLevel(s) ?? '', [...(byLevel.get(stepLevel(s) ?? '') ?? []), objectName('x', tag, s)]);
    for (const names of byLevel.values()) expect(new Set(names).size).toBe(names.length);
  });
});

describe('the budget in the currency\'s smallest unit', () => {
  it('is the amount itself for a currency with no cents and a hundred times it for one with cents', () => {
    expect(toMinorUnits('100000', 'VND')).toBe('100000');
    expect(toMinorUnits('12.34', 'USD')).toBe('1234');
    expect(toMinorUnits('5', 'USD')).toBe('500');
    // Exact where a float is not: 0.29 times 100 is 28.999999999999996 in JS.
    expect(toMinorUnits('0.29', 'USD')).toBe('29');
  });

  it('refuses an amount that is not whole in the currency\'s smallest unit, or not above zero: the approver signed that amount', () => {
    expect(() => toMinorUnits('100000.5', 'VND')).toThrow('ADS_LAUNCH_AMOUNT');
    expect(() => toMinorUnits('12.345', 'USD')).toThrow('ADS_LAUNCH_AMOUNT');
    expect(() => toMinorUnits('0', 'USD')).toThrow('ADS_LAUNCH_AMOUNT');
  });
});

describe('the flight in the account\'s time zone', () => {
  it('starts a day at its midnight, with the zone\'s offset at that moment', () => {
    expect(zonedMidnight('2026-11-10', 'Asia/Ho_Chi_Minh')).toBe('2026-11-10T00:00:00+0700');
    expect(zonedMidnight('2026-11-10', 'UTC')).toBe('2026-11-10T00:00:00+0000');
    expect(zonedMidnight('2026-11-10', 'Asia/Kolkata')).toBe('2026-11-10T00:00:00+0530');
    // America/Los_Angeles changes its offset in the small hours of 1 November 2026: the day before it, summer time; the day after, standard time.
    expect(zonedMidnight('2026-11-01', 'America/Los_Angeles')).toBe('2026-11-01T00:00:00-0700');
    expect(zonedMidnight('2026-11-02', 'America/Los_Angeles')).toBe('2026-11-02T00:00:00-0800');
    expect(zonedMidnight('2026-03-08', 'America/Los_Angeles')).toBe('2026-03-08T00:00:00-0800');
    expect(zonedMidnight('2026-03-09', 'America/Los_Angeles')).toBe('2026-03-09T00:00:00-0700');
  });

  it('runs both end days in full: from the start of the first to the start of the day after the last', () => {
    expect(flightTimes('2026-11-10', '2026-11-16', 'Asia/Ho_Chi_Minh')).toEqual({ startTime: '2026-11-10T00:00:00+0700', endTime: '2026-11-17T00:00:00+0700' });
    expect(flightTimes('2026-11-10', '2026-11-10', 'Asia/Ho_Chi_Minh')).toEqual({ startTime: '2026-11-10T00:00:00+0700', endTime: '2026-11-11T00:00:00+0700' });
    expect(flightTimes('2026-12-31', '2026-12-31', 'UTC').endTime).toBe('2027-01-01T00:00:00+0000');
    expect(flightTimes('2026-10-31', '2026-11-01', 'America/Los_Angeles')).toEqual({ startTime: '2026-10-31T00:00:00-0700', endTime: '2026-11-02T00:00:00-0800' });
  });
});

const targeting: AdsCampaignPlan['targeting'] = {
  locations: [{ country: 'VN' }, { country: 'VN', region: 'Hà Nội' }, { country: 'US', region: 'Texas' }],
  ageMin: 22,
  ageMax: 45,
  gender: 'female',
  interests: ['Coffee', 'Tea'],
};
const resolved: Resolution = {
  interests: { resolved: [{ name: 'Coffee', id: '601' }, { name: 'Tea', id: '602' }], unknown: [], ambiguous: [] },
  regions: { resolved: [{ country: 'VN', name: 'Hà Nội', key: '4242' }, { country: 'US', name: 'Texas', key: '3886' }], unknown: [], ambiguous: [] },
};

describe('the audience', () => {
  it('names the interests and the regions the platform has to pin down, and not a whole country', () => {
    expect(targetingNames(targeting)).toEqual({ interests: ['Coffee', 'Tea'], regions: [{ country: 'VN', region: 'Hà Nội' }, { country: 'US', region: 'Texas' }] });
    expect(targetingNames({ ...targeting, locations: [{ country: 'VN' }], interests: [] })).toEqual({ interests: [], regions: [] });
  });

  it('is a whole country where the plan names no region, a region alone where it names one, the ids resolved and the rest as planned', () => {
    expect(audienceOf(targeting, resolved)).toEqual({
      countries: ['VN'],
      regions: [{ key: '4242', name: 'Hà Nội', country: 'VN' }, { key: '3886', name: 'Texas', country: 'US' }],
      ageMin: 22,
      ageMax: 45,
      gender: 'female',
      interests: [{ id: '601', name: 'Coffee' }, { id: '602', name: 'Tea' }],
    });
    // A plan of regions only adds no country: that would widen the audience to the whole country.
    expect(audienceOf({ ...targeting, locations: [{ country: 'VN', region: 'Hà Nội' }] }, resolved).countries).toEqual([]);
  });

  it('is stopped by a name the platform does not know or cannot tell apart, listed for the person', () => {
    expect(unresolved(resolved)).toEqual({ unknown: [], ambiguous: [] });
    const stopped: Resolution = {
      interests: { resolved: [], unknown: ['Cà phê sữa'], ambiguous: ['Fashion'] },
      regions: { resolved: [], unknown: ['VN:Đà Lạt'], ambiguous: ['VN:Quận 1'] },
    };
    expect(unresolved(stopped)).toEqual({ unknown: ['Cà phê sữa', 'VN:Đà Lạt'], ambiguous: ['Fashion', 'VN:Quận 1'] });
  });

  it('keeps for the audit the names as approved and the ids that were sent, so the two can be compared', () => {
    expect(resolutionRecord(resolved)).toEqual({
      interests: [{ name: 'Coffee', id: '601' }, { name: 'Tea', id: '602' }],
      regions: [{ country: 'VN', name: 'Hà Nội', key: '4242' }, { country: 'US', name: 'Texas', key: '3886' }],
    });
    // A copy: the record does not change with the resolution it came from.
    const record = resolutionRecord(resolved);
    record.interests[0]!.id = 'changed';
    expect(resolved.interests.resolved[0]?.id).toBe('601');
  });
});
