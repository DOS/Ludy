// SPDX-License-Identifier: AGPL-3.0-only
// The pure rules of a launch's steps (W2-3, #2296): which objects a plan creates and in what order, the key of each platform call, the name every object carries
// (with the launch's tag), the flight in the account's own time zone, what a step does with the ledger row it finds, and how a plan's locations and interests are
// split for the platform. Nothing here touches a database or a platform.
import { describe, expect, it } from 'vitest';
import type { AdsCampaignPlan } from '@crove/kernel-contract';
import { RECONCILE_WAIT_SECONDS, STARTED_STALE_SECONDS, dayAfter, launchCallKey, launchSteps, objectName, parseLaunchCallKey, stepAction, stepLevel, stepVariant, targetingNames, zonedMidnight } from '../src/launch-steps.ts';

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
    // A long name is cut, the tag never is.
    for (const s of launchSteps(3)) {
      const long = objectName('x'.repeat(500), TAG, s);
      expect(long.length).toBeLessThanOrEqual(400);
      expect(long).toContain(TAG);
    }
  });
});

describe('the flight in the account\'s own time zone', () => {
  it('starts at the first moment of the day with the zone\'s own offset on that day', () => {
    expect(zonedMidnight('2026-11-05', 'Asia/Ho_Chi_Minh')).toBe('2026-11-05T00:00:00+0700');
    expect(zonedMidnight('2026-11-05', 'UTC')).toBe('2026-11-05T00:00:00+0000');
    expect(zonedMidnight('2026-11-05', null)).toBe('2026-11-05T00:00:00+0000');
    expect(zonedMidnight('2026-11-05', 'Asia/Kolkata')).toBe('2026-11-05T00:00:00+0530');
    expect(zonedMidnight('2026-11-05', 'Pacific/Kiritimati')).toBe('2026-11-05T00:00:00+1400');
    expect(zonedMidnight('2026-11-05', 'Pacific/Pago_Pago')).toBe('2026-11-05T00:00:00-1100');
    // Daylight saving: the offset of the day, not of the zone's standard time.
    expect(zonedMidnight('2026-01-15', 'America/Los_Angeles')).toBe('2026-01-15T00:00:00-0800');
    expect(zonedMidnight('2026-07-15', 'America/Los_Angeles')).toBe('2026-07-15T00:00:00-0700');
    // A zone this runtime does not know is UTC, never a throw.
    expect(zonedMidnight('2026-11-05', 'Mars/Phobos')).toBe('2026-11-05T00:00:00+0000');
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
