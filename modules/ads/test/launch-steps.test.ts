// SPDX-License-Identifier: AGPL-3.0-only
// The pure rules of a launch's steps (W2-3, #2296): which objects a plan creates and in what order, the key of each platform call, the name every object carries
// (with the launch's tag), the flight in the account's own time zone, what a step does with the ledger row it finds, and how a plan's locations and interests are
// split for the platform. Nothing here touches a database or a platform.
import { describe, expect, it } from 'vitest';
import type { AdsCampaignPlan } from '@crove/kernel-contract';
import { RECONCILE_WAIT_SECONDS, STARTED_STALE_SECONDS, dayAfter, launchCallKey, launchSteps, nameTail, objectName, parseLaunchCallKey, stepAction, stepLevel, stepVariant, targetingNames, zoneKnown, zonedMidnight } from '../src/launch-steps.ts';

const TAG = 'ludy:0123456789';
const LAUNCH = '0198f3c2-7b1e-7000-8000-0123456789ab';

describe('the steps of a launch', () => {
  it('are the campaign, the ad set, and a creative and an ad for each variant, in that order', () => {
    expect(launchSteps(1)).toEqual(['campaign', 'ad_set', 'creative_1', 'ad_1']);
    expect(launchSteps(3)).toEqual(['campaign', 'ad_set', 'creative_1', 'ad_1', 'creative_2', 'ad_2', 'creative_3', 'ad_3']);
    expect(stepLevel('campaign')).toBe('campaign');
    expect(stepLevel('ad_set')).toBe('ad_set');
    expect(stepLevel('creative_2')).toBe('creative');
    expect(stepLevel('ad_3')).toBe('ad');
    expect(stepVariant('creative_2')).toBe(2);
    expect(stepVariant('ad_3')).toBe(3);
    for (const bad of ['', 'activate', 'creative_0', 'creative_4', 'ad_', 'campaign_1']) expect(() => stepLevel(bad), bad).toThrow();
    expect(() => stepVariant('campaign')).toThrow();
  });

  it('have a key per launch, attempt and step that reads back, and never a key that is not one', () => {
    const key = launchCallKey(LAUNCH, 1, 'creative_2');
    expect(key).toBe(`ads.launch:${LAUNCH}:1:creative_2`);
    expect(parseLaunchCallKey(key)).toEqual({ launchId: LAUNCH, attempt: 1, step: 'creative_2' });
    expect(parseLaunchCallKey(launchCallKey(LAUNCH, 12, 'ad_set'))).toEqual({ launchId: LAUNCH, attempt: 12, step: 'ad_set' });
    for (const bad of ['', 'ads.launch', `ads.launch:${LAUNCH}:x:campaign`, `ads.launch:${LAUNCH}:1:Campaign`, `ads.launch:../x:1:campaign`, `social.publish:${LAUNCH}:1:campaign`, `ads.launch:${LAUNCH}:1:campaign:extra`, `ads.launch:${LAUNCH}:123:campaign`]) {
      expect(parseLaunchCallKey(bad), bad).toBeNull();
    }
  });

  it('name every object with the launch\'s tag, a different name for each, within the platform\'s limit', () => {
    const names = launchSteps(3).map((s) => objectName('Khuyến mãi cuối tuần', TAG, s));
    expect(names.every((n) => n.includes(TAG))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe(`Khuyến mãi cuối tuần ${TAG}`);
    expect(names[1]).toBe(`Khuyến mãi cuối tuần ${TAG} set`);
    expect(names[2]).toBe(`Khuyến mãi cuối tuần ${TAG} creative 1`);
    // A long name is cut to 100 characters (a creative's limit is not known to be more), the tag and what the object is never are.
    for (const s of launchSteps(3)) {
      const long = objectName('x'.repeat(500), TAG, s);
      expect(long.length).toBeLessThanOrEqual(100);
      expect(long.endsWith(` ${nameTail(TAG, s)}`), s).toBe(true);
    }
  });

  it('end every name with a tail in ASCII that is different for each step of the launch, which reconcile matches by', () => {
    const tails = launchSteps(3).map((s) => nameTail(TAG, s));
    expect(new Set(tails).size).toBe(tails.length);
    expect(tails).toEqual([TAG, `${TAG} set`, `${TAG} creative 1`, `${TAG} ad 1`, `${TAG} creative 2`, `${TAG} ad 2`, `${TAG} creative 3`, `${TAG} ad 3`]);
    expect(tails.every((t) => /^[\x20-\x7e]+$/.test(t))).toBe(true);
    // A platform that re-encodes the plan's text leaves the tail as it was.
    for (const s of launchSteps(3)) expect(objectName('Khuyến mãi'.normalize('NFD'), TAG, s).endsWith(` ${nameTail(TAG, s)}`)).toBe(true);
  });
});

describe('the flight in the account\'s own time zone', () => {
  it('starts at the first moment of the day with the zone\'s own offset on that day', () => {
    expect(zonedMidnight('2026-11-05', 'Asia/Ho_Chi_Minh')).toBe('2026-11-05T00:00:00+0700');
    expect(zonedMidnight('2026-11-05', 'UTC')).toBe('2026-11-05T00:00:00+0000');
    expect(zonedMidnight('2026-11-05', 'Asia/Kolkata')).toBe('2026-11-05T00:00:00+0530');
    expect(zonedMidnight('2026-11-05', 'Pacific/Kiritimati')).toBe('2026-11-05T00:00:00+1400');
    expect(zonedMidnight('2026-11-05', 'Pacific/Pago_Pago')).toBe('2026-11-05T00:00:00-1100');
    // Daylight saving: the offset of the day, not of the zone's standard time.
    expect(zonedMidnight('2026-01-15', 'America/Los_Angeles')).toBe('2026-01-15T00:00:00-0800');
    expect(zonedMidnight('2026-07-15', 'America/Los_Angeles')).toBe('2026-07-15T00:00:00-0700');
  });

  it('is not guessed: a zone that is missing or that this runtime does not know throws, and the launch checks it before any call', () => {
    for (const zone of [null, '', 'Mars/Phobos', 'Asia/Ho Chi Minh', 'not a zone']) {
      expect(zoneKnown(zone), String(zone)).toBe(false);
      expect(() => zonedMidnight('2026-11-05', zone), String(zone)).toThrow('unknown time zone');
    }
    for (const zone of ['UTC', 'Asia/Ho_Chi_Minh', 'America/Los_Angeles', 'Pacific/Kiritimati']) expect(zoneKnown(zone), zone).toBe(true);
  });

  it('takes the offset that holds at the zone\'s own midnight on a day its offset changes, not the one at another hour of the day', () => {
    // Los Angeles springs forward at 02:00 on 2026-03-08: its midnight is still on standard time. It falls back at 02:00 on 2026-11-01: its midnight is still on daylight time.
    expect(zonedMidnight('2026-03-08', 'America/Los_Angeles')).toBe('2026-03-08T00:00:00-0800');
    expect(zonedMidnight('2026-03-09', 'America/Los_Angeles')).toBe('2026-03-09T00:00:00-0700');
    expect(zonedMidnight('2026-11-01', 'America/Los_Angeles')).toBe('2026-11-01T00:00:00-0700');
    expect(zonedMidnight('2026-11-02', 'America/Los_Angeles')).toBe('2026-11-02T00:00:00-0800');
    // The southern hemisphere, east of UTC: Sydney springs forward on 2026-10-04 and falls back on 2026-04-05, both at 02:00 or 03:00 local.
    expect(zonedMidnight('2026-10-04', 'Australia/Sydney')).toBe('2026-10-04T00:00:00+1000');
    expect(zonedMidnight('2026-10-05', 'Australia/Sydney')).toBe('2026-10-05T00:00:00+1100');
    expect(zonedMidnight('2026-04-05', 'Australia/Sydney')).toBe('2026-04-05T00:00:00+1100');
    expect(zonedMidnight('2026-04-06', 'Australia/Sydney')).toBe('2026-04-06T00:00:00+1000');
    // Berlin springs forward at 02:00 on 2026-03-29.
    expect(zonedMidnight('2026-03-29', 'Europe/Berlin')).toBe('2026-03-29T00:00:00+0100');
    expect(zonedMidnight('2026-03-30', 'Europe/Berlin')).toBe('2026-03-30T00:00:00+0200');
  });

  it('starts a day at the first moment that exists when the zone skips its own midnight, never at an instant of the day before', () => {
    // Santiago springs forward at midnight on 2026-09-06: the clocks go from 23:59 on the 5th to 01:00 on the 6th, so 6 September starts at 01:00 (04:00Z), and the flight that
    // ends on the 5th ends at that same moment.
    expect(zonedMidnight('2026-09-06', 'America/Santiago')).toBe('2026-09-06T01:00:00-0300');
    expect(zonedMidnight('2026-09-05', 'America/Santiago')).toBe('2026-09-05T00:00:00-0400');
    expect(zonedMidnight(dayAfter('2026-09-05'), 'America/Santiago')).toBe('2026-09-06T01:00:00-0300');
    expect(Date.parse(zonedMidnight('2026-09-06', 'America/Santiago').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))).toBe(Date.parse('2026-09-06T04:00:00Z'));
    // Another zone that changes at midnight: Havana springs forward at midnight too (2026-03-08).
    expect(zonedMidnight('2026-03-08', 'America/Havana')).toBe('2026-03-08T01:00:00-0400');
    expect(zonedMidnight('2026-03-09', 'America/Havana')).toBe('2026-03-09T00:00:00-0400');
  });

  it('ends at the first moment of the day after the last day', () => {
    expect(dayAfter('2026-11-12')).toBe('2026-11-13');
    expect(dayAfter('2026-11-30')).toBe('2026-12-01');
    expect(dayAfter('2026-12-31')).toBe('2027-01-01');
    expect(dayAfter('2028-02-28')).toBe('2028-02-29');
    expect(zonedMidnight(dayAfter('2026-11-12'), 'Asia/Ho_Chi_Minh')).toBe('2026-11-13T00:00:00+0700');
  });
});

describe('what a step does with the ledger row it finds', () => {
  const now = new Date('2026-11-05T08:00:00Z');
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it('makes the call when there is no row, and leaves a settled one alone', () => {
    expect(stepAction(null, now)).toBe('call');
    expect(stepAction({ state: 'succeeded', updatedAt: ago(1) }, now)).toBe('settled');
    expect(stepAction({ state: 'failed', updatedAt: ago(100_000) }, now)).toBe('settled');
  });

  it('lets a call that was just begun be in flight, and reconciles it once it is old enough to be lost: never calls it again blind', () => {
    expect(stepAction({ state: 'started', updatedAt: ago(0) }, now)).toBe('wait');
    expect(stepAction({ state: 'started', updatedAt: ago(STARTED_STALE_SECONDS - 1) }, now)).toBe('wait');
    expect(stepAction({ state: 'started', updatedAt: ago(STARTED_STALE_SECONDS) }, now)).toBe('reconcile');
    expect(stepAction({ state: 'started', updatedAt: ago(100_000) }, now)).toBe('reconcile');
  });

  it('gives an unclear answer a minute for the platform to show the object, then reconciles it', () => {
    expect(stepAction({ state: 'ambiguous', updatedAt: ago(0) }, now)).toBe('wait');
    expect(stepAction({ state: 'ambiguous', updatedAt: ago(RECONCILE_WAIT_SECONDS - 1) }, now)).toBe('wait');
    expect(stepAction({ state: 'ambiguous', updatedAt: ago(RECONCILE_WAIT_SECONDS) }, now)).toBe('reconcile');
  });
});

describe('the names of a plan\'s targeting', () => {
  const plan = (locations: AdsCampaignPlan['targeting']['locations'], interests: string[]): AdsCampaignPlan => ({
    name: 'Thử',
    objective: 'traffic',
    dailyBudget: '100000',
    startOn: '2026-11-05',
    endOn: '2026-11-12',
    targeting: { locations, ageMin: 22, ageMax: 45, gender: 'female', interests },
    linkUrl: 'https://example.com/',
    pageConnectionId: null,
    sourcePostId: null,
    mediaFileId: null,
    variants: [{ headline: 'h', primaryText: 'p', callToAction: 'learn_more' }],
  });

  it('keeps a country as it stands, once, and a region and an interest as names to look up', () => {
    expect(targetingNames(plan([{ country: 'VN' }, { country: 'VN' }, { country: 'US' }, { country: 'VN', region: 'Hà Nội' }], ['Cà phê', 'Trà']))).toEqual({
      countries: ['VN', 'US'],
      regions: [{ country: 'VN', name: 'Hà Nội' }],
      interests: ['Cà phê', 'Trà'],
      ageMin: 22,
      ageMax: 45,
      gender: 'female',
    });
    expect(targetingNames(plan([{ country: 'VN' }], []))).toMatchObject({ countries: ['VN'], regions: [], interests: [] });
  });
});
