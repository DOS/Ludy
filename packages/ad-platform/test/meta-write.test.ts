// SPDX-License-Identifier: AGPL-3.0-only
// The writer of Meta ads (ADR-0043, #2296, W2) against recorded answers: what `verify` reads, how `revokeToken` removes the permissions at Meta and
// what each answer of Meta means for it, what each creating call sends (everything PAUSED, money as a whole-number string, the token in a header and
// in no URL or body), how an object is found again by name, how names are resolved to the platform's ids, and the pin on what the writer can do at
// all: its own methods, every Graph endpoint its source names and the host. The recorded answers are written from Meta's documentation (the live
// check records what Meta really answers, plan docs/plan/ads-write.md section 5.2), so these prove the shape of the code, not Meta's behaviour.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetch } from '@crove/channel';
import { AdPlatformError, META_LIST_EDGES, META_LIVE_CHECKED_OBJECTIVES, MetaAdWriter, META_WRITE_PROVIDER, type AdSetInput } from '../src/index.ts';

const NOW = new Date('2026-11-03T08:00:00Z');
const APP_SECRET = 'app-secret';
const SECRET = JSON.stringify({ accessToken: 'write-token' });
const ACCOUNT = { externalAccountId: 'act_1001' };

interface Call {
  method: string;
  url: URL;
  authorization: string | null;
  body: URLSearchParams | null;
}

type Answer = { status?: number; body: unknown } | Error;

// A fetch that answers from a list of recorded answers, in order, and remembers each request. An answer may be an error thrown by fetch itself.
function recorded(answers: Answer[]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: Fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: new URL(input), authorization: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null });
    const next = answers[i++];
    if (!next) throw new Error(`no recorded answer for ${input}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const writer = (answers: Answer[]) => {
  const { fetch, calls } = recorded(answers);
  return { writer: new MetaAdWriter({ appSecret: APP_SECRET, graphVersion: 'v24.0', fetch, now: () => NOW }), calls };
};
const metaError = (status: number, code: number, subcode?: number) => ({ status, body: { error: { message: 'Meta text', type: 'OAuthException', code, ...(subcode === undefined ? {} : { error_subcode: subcode }) } } });
const rejection = async (promise: Promise<unknown>): Promise<AdPlatformError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdPlatformError);
  return error as AdPlatformError;
};
const json = (call: Call | undefined, field: string): Record<string, unknown> => JSON.parse(call?.body?.get(field) ?? 'null') as Record<string, unknown>;

describe('MetaAdWriter.revokeToken', () => {
  it('removes the app\'s permissions with one DELETE to me/permissions, the token in the header and the proof of the app secret', async () => {
    const { writer: w, calls } = writer([{ body: { success: true } }]);
    expect(await w.revokeToken(SECRET)).toEqual({ how: 'revoked' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe('DELETE');
    expect(call?.url.origin).toBe('https://graph.facebook.com');
    expect(call?.url.pathname).toBe('/v24.0/me/permissions');
    expect(call?.authorization).toBe('Bearer write-token');
    expect(call?.url.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', APP_SECRET).update('write-token').digest('hex'));
    // The token is in no URL.
    expect(call?.url.toString()).not.toContain('write-token');
  });

  it('counts a token Meta no longer accepts as revoked: nothing is left to revoke with it', async () => {
    for (const body of [metaError(400, 190), metaError(400, 190, 463), metaError(400, 102), metaError(400, 190, 460), metaError(400, 190, 467)]) {
      const { writer: w } = writer([body]);
      expect(await w.revokeToken(SECRET)).toEqual({ how: 'already_invalid' });
    }
  });

  it('is never done on an answer that does not say success', async () => {
    const error = await rejection(writer([{ body: { success: false } }]).writer.revokeToken(SECRET));
    expect([error.kind, error.code]).toEqual(['unknown', 'NOT_REVOKED']);
    const none = await rejection(writer([{ body: {} }]).writer.revokeToken(SECRET));
    expect([none.kind, none.code]).toEqual(['unknown', 'NOT_REVOKED']);
  });

  it('says in the error\'s kind what the caller does next: wait (with the time), try again, or a person looks', async () => {
    const hourly = await rejection(writer([metaError(400, 4)]).writer.revokeToken(SECRET));
    expect([hourly.kind, hourly.retryAt?.toISOString()]).toEqual(['rate_limited', '2026-11-03T09:00:00.000Z']);
    const score = await rejection(writer([metaError(400, 17)]).writer.revokeToken(SECRET));
    expect([score.kind, score.retryAt?.toISOString()]).toEqual(['rate_limited', '2026-11-03T08:10:00.000Z']);
    expect((await rejection(writer([metaError(500, 2)]).writer.revokeToken(SECRET))).kind).toBe('transient');
    expect((await rejection(writer([metaError(403, 200)]).writer.revokeToken(SECRET))).kind).toBe('permission');
    expect((await rejection(writer([metaError(400, 100)]).writer.revokeToken(SECRET))).kind).toBe('bad_request');
    const network = await rejection(writer([Object.assign(new Error('aborted'), { name: 'AbortError' })]).writer.revokeToken(SECRET));
    expect([network.kind, network.code]).toEqual(['transient', 'NETWORK']);
  });

  it('refuses a secret that holds no token, without calling Meta', async () => {
    for (const secret of ['not json', '{}', JSON.stringify({ accessToken: '' }), JSON.stringify({ accessToken: 5 })]) {
      const { writer: w, calls } = writer([]);
      const error = await rejection(w.revokeToken(secret));
      expect([error.kind, error.code]).toEqual(['unknown', 'BAD_SECRET']);
      expect(calls).toHaveLength(0);
    }
  });
});

describe('MetaAdWriter.verify', () => {
  const permissions = (...pairs: Array<[string, string]>) => ({ body: { data: pairs.map(([permission, status]) => ({ permission, status })) } });

  it('reads the permissions the token holds now and the account itself, and changes nothing', async () => {
    const { writer: w, calls } = writer([permissions(['ads_read', 'granted'], ['ads_management', 'granted'], ['public_profile', 'granted']), { body: { id: 'act_1001' } }]);
    expect(await w.verify(SECRET, ACCOUNT)).toEqual({ canRunAds: true, scopes: ['ads_management', 'ads_read', 'public_profile'] });
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['GET', '/v24.0/me/permissions'],
      ['GET', '/v24.0/act_1001'],
    ]);
    expect(calls.every((c) => c.authorization === 'Bearer write-token' && !c.url.toString().includes('write-token'))).toBe(true);
  });

  it('says a token cannot run ads when a permission is missing or was declined, without reading the account', async () => {
    const { writer: w, calls } = writer([permissions(['ads_read', 'granted'], ['ads_management', 'declined'])]);
    expect(await w.verify(SECRET, ACCOUNT)).toEqual({ canRunAds: false, scopes: ['ads_read'] });
    expect(calls).toHaveLength(1);
  });

  it('refuses an account the token does not reach, as Meta says it', async () => {
    const { writer: w } = writer([permissions(['ads_read', 'granted'], ['ads_management', 'granted']), metaError(403, 200)]);
    expect((await rejection(w.verify(SECRET, ACCOUNT))).kind).toBe('permission');
  });

  it('refuses an account id that is not one, without calling Meta', async () => {
    const { writer: w, calls } = writer([]);
    const error = await rejection(w.verify(SECRET, { externalAccountId: '1001/../me' }));
    expect([error.kind, error.code]).toEqual(['bad_request', 'BAD_ACCOUNT']);
    expect(calls).toHaveLength(0);
  });
});

const TARGETING: AdSetInput['targeting'] = {
  countries: ['VN'],
  regions: [{ key: '4242', name: 'Hà Nội', country: 'VN' }],
  ageMin: 22,
  ageMax: 45,
  gender: 'male',
  interests: [{ id: '6003139266461', name: 'Coffee' }],
};
const AD_SET: AdSetInput = {
  name: 'Khai trương [ludy:7f3a9c21]',
  campaignId: '120201',
  objective: 'traffic',
  pageId: '5551',
  dailyBudgetMinor: '100000',
  startTime: '2026-11-10T00:00:00+0700',
  endTime: '2026-11-17T00:00:00+0700',
  targeting: TARGETING,
};

describe('the creating calls', () => {
  it('make a campaign PAUSED with the objective of the plan, and answer the id', async () => {
    const { writer: w, calls } = writer([{ body: { id: '120201' } }]);
    expect(await w.createCampaign(SECRET, ACCOUNT, { name: 'Khai trương [ludy:7f3a9c21]', objective: 'traffic' })).toEqual({ externalId: '120201' });
    const [call] = calls;
    expect([call?.method, call?.url.origin, call?.url.pathname]).toEqual(['POST', 'https://graph.facebook.com', '/v24.0/act_1001/campaigns']);
    expect(Object.fromEntries(call?.body ?? [])).toEqual({ name: 'Khai trương [ludy:7f3a9c21]', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: '[]' });
    // The token is in the header, with the proof, and in no URL or body.
    expect(call?.authorization).toBe('Bearer write-token');
    expect(call?.url.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', APP_SECRET).update('write-token').digest('hex'));
    expect(`${call?.url} ${call?.body}`).not.toContain('write-token');
  });

  it('make an ad set PAUSED with a whole-number budget, the flight, the audience by the platform\'s ids and automatic placements', async () => {
    const { writer: w, calls } = writer([{ body: { id: '120202' } }]);
    expect(await w.createAdSet(SECRET, ACCOUNT, AD_SET)).toEqual({ externalId: '120202' });
    const [call] = calls;
    expect(call?.url.pathname).toBe('/v24.0/act_1001/adsets');
    expect(call?.body?.get('status')).toBe('PAUSED');
    expect(call?.body?.get('daily_budget')).toBe('100000');
    expect([call?.body?.get('start_time'), call?.body?.get('end_time')]).toEqual(['2026-11-10T00:00:00+0700', '2026-11-17T00:00:00+0700']);
    expect([call?.body?.get('optimization_goal'), call?.body?.get('billing_event'), call?.body?.get('destination_type'), call?.body?.get('campaign_id')]).toEqual(['LINK_CLICKS', 'IMPRESSIONS', 'WEBSITE', '120201']);
    // Traffic names no promoted object, and no placement is set (automatic placements).
    expect(call?.body?.has('promoted_object')).toBe(false);
    expect(call?.body?.has('publisher_platforms')).toBe(false);
    expect(json(call, 'targeting')).toEqual({
      geo_locations: { countries: ['VN'], regions: [{ key: '4242' }] },
      age_min: 22,
      age_max: 45,
      genders: [1],
      flexible_spec: [{ interests: [{ id: '6003139266461', name: 'Coffee' }] }],
      targeting_automation: { advantage_audience: 0 },
    });
  });

  it('leave the gender out for all, and the interests out when there are none', async () => {
    const { writer: w, calls } = writer([{ body: { id: '120202' } }]);
    await w.createAdSet(SECRET, ACCOUNT, { ...AD_SET, targeting: { ...TARGETING, gender: 'all', interests: [], regions: [] } });
    expect(json(calls[0], 'targeting')).toEqual({ geo_locations: { countries: ['VN'] }, age_min: 22, age_max: 45, targeting_automation: { advantage_audience: 0 } });
  });

  it('target a region alone as that region (never its country as well), and refuse an audience that is nowhere', async () => {
    const { writer: w, calls } = writer([{ body: { id: '120202' } }]);
    await w.createAdSet(SECRET, ACCOUNT, { ...AD_SET, targeting: { ...TARGETING, countries: [] } });
    expect((json(calls[0], 'targeting').geo_locations as Record<string, unknown>)).toEqual({ regions: [{ key: '4242' }] });
    const none = writer([]);
    const error = await rejection(none.writer.createAdSet(SECRET, ACCOUNT, { ...AD_SET, targeting: { ...TARGETING, countries: [], regions: [] } }));
    expect([error.kind, error.code]).toEqual(['bad_request', 'NO_LOCATION']);
    expect(none.calls).toHaveLength(0);
  });

  it('make a creative that runs as the Page, with the text, the headline, the link and the button', async () => {
    const { writer: w, calls } = writer([{ body: { id: '120203' } }]);
    await w.createCreative(SECRET, ACCOUNT, { name: 'Khai trương [ludy:7f3a9c21:v1]', pageId: '5551', message: 'Mời bạn ghé thử.', headline: 'Khai trương', linkUrl: 'https://example.com/khai-truong', callToAction: 'learn_more' });
    const [call] = calls;
    expect(call?.url.pathname).toBe('/v24.0/act_1001/adcreatives');
    expect(json(call, 'object_story_spec')).toEqual({
      page_id: '5551',
      link_data: { message: 'Mời bạn ghé thử.', link: 'https://example.com/khai-truong', name: 'Khai trương', call_to_action: { type: 'LEARN_MORE', value: { link: 'https://example.com/khai-truong' } } },
    });
  });

  it('make an ad PAUSED in the ad set, showing the creative', async () => {
    const { writer: w, calls } = writer([{ body: { id: '120204' } }]);
    await w.createAd(SECRET, ACCOUNT, { name: 'Khai trương [ludy:7f3a9c21:v1]', adSetId: '120202', creativeId: '120203' });
    const [call] = calls;
    expect(call?.url.pathname).toBe('/v24.0/act_1001/ads');
    expect(Object.fromEntries(call?.body ?? [])).toEqual({ name: 'Khai trương [ludy:7f3a9c21:v1]', adset_id: '120202', creative: '{"creative_id":"120203"}', status: 'PAUSED' });
  });

  it('accept only the objectives that passed the live check, and refuse the others without calling Meta', async () => {
    expect(META_LIVE_CHECKED_OBJECTIVES).toEqual(['traffic']);
    for (const objective of ['engagement', 'messenger'] as const) {
      const { writer: w, calls } = writer([]);
      const campaign = await rejection(w.createCampaign(SECRET, ACCOUNT, { name: 'x', objective }));
      const adSet = await rejection(w.createAdSet(SECRET, ACCOUNT, { ...AD_SET, objective }));
      expect([campaign.kind, campaign.code, adSet.kind, adSet.code]).toEqual(['bad_request', 'OBJECTIVE_NOT_LIVE_CHECKED', 'bad_request', 'OBJECTIVE_NOT_LIVE_CHECKED']);
      expect(calls).toHaveLength(0);
    }
  });

  it('refuse what is not shaped as the platform takes it, before calling Meta: a budget that is not whole units, an id, a name', async () => {
    const { writer: w, calls } = writer([]);
    for (const dailyBudgetMinor of ['0', '10.5', '-1', '', '1e5', '0100000']) expect((await rejection(w.createAdSet(SECRET, ACCOUNT, { ...AD_SET, dailyBudgetMinor }))).code, dailyBudgetMinor).toBe('BAD_BUDGET');
    expect((await rejection(w.createAdSet(SECRET, ACCOUNT, { ...AD_SET, campaignId: '12/../x' }))).code).toBe('BAD_CAMPAIGN');
    expect((await rejection(w.createAd(SECRET, ACCOUNT, { name: 'a', adSetId: '1', creativeId: 'x' }))).code).toBe('BAD_CREATIVE');
    expect((await rejection(w.createCampaign(SECRET, ACCOUNT, { name: '   ', objective: 'traffic' }))).code).toBe('BAD_NAME');
    expect((await rejection(w.createCampaign(SECRET, ACCOUNT, { name: 'x'.repeat(401), objective: 'traffic' }))).code).toBe('BAD_NAME');
    expect((await rejection(w.createCampaign(SECRET, { externalAccountId: 'act_1/../2' }, { name: 'x', objective: 'traffic' }))).code).toBe('BAD_ACCOUNT');
    expect(calls).toHaveLength(0);
  });

  it('are not believed when Meta answers without an id: the object may exist, so the caller finds it by name before repeating', async () => {
    const empty = await rejection(writer([{ body: {} }]).writer.createCampaign(SECRET, ACCOUNT, { name: 'x', objective: 'traffic' }));
    expect([empty.kind, empty.code]).toEqual(['unknown', 'NO_ID']);
    const odd = await rejection(writer([{ body: { id: 'abc' } }]).writer.createAd(SECRET, ACCOUNT, { name: 'x', adSetId: '1', creativeId: '2' }));
    expect([odd.kind, odd.code]).toEqual(['unknown', 'NO_ID']);
  });

  it('type a refusal by the platform\'s code, so the caller knows whether the object can exist', async () => {
    expect((await rejection(writer([metaError(400, 100)]).writer.createCampaign(SECRET, ACCOUNT, { name: 'x', objective: 'traffic' }))).kind).toBe('bad_request');
    expect((await rejection(writer([metaError(400, 17)]).writer.createCampaign(SECRET, ACCOUNT, { name: 'x', objective: 'traffic' }))).kind).toBe('rate_limited');
    expect((await rejection(writer([metaError(500, 1)]).writer.createCampaign(SECRET, ACCOUNT, { name: 'x', objective: 'traffic' }))).kind).toBe('transient');
  });
});

describe('MetaAdWriter.setStatus', () => {
  it('sets the status of one object and nothing else', async () => {
    const { writer: w, calls } = writer([{ body: { success: true } }, { body: { success: true } }]);
    await w.setStatus(SECRET, '120204', 'ACTIVE');
    await w.setStatus(SECRET, '120204', 'PAUSED');
    expect(calls.map((c) => [c.method, c.url.pathname, Object.fromEntries(c.body ?? [])])).toEqual([
      ['POST', '/v24.0/120204', { status: 'ACTIVE' }],
      ['POST', '/v24.0/120204', { status: 'PAUSED' }],
    ]);
  });

  it('is not believed on an answer that does not say success, and refuses an id that is not one', async () => {
    const error = await rejection(writer([{ body: { success: false } }]).writer.setStatus(SECRET, '120204', 'ACTIVE'));
    expect([error.kind, error.code]).toEqual(['unknown', 'NOT_SET']);
    const { writer: w, calls } = writer([]);
    expect((await rejection(w.setStatus(SECRET, '120204/../me', 'ACTIVE'))).code).toBe('BAD_OBJECT');
    expect(calls).toHaveLength(0);
  });
});

describe('MetaAdWriter.readObjects', () => {
  it('reads the status asked for, the status in effect and the codes of the reasons, level by level', async () => {
    const { writer: w, calls } = writer([
      { body: { configured_status: 'ACTIVE', effective_status: 'ACTIVE' } },
      { body: { configured_status: 'ACTIVE', effective_status: 'WITH_ISSUES', issues_info: [{ error_code: 1487225, error_summary: 'text' }] } },
      { body: { configured_status: 'ACTIVE', effective_status: 'DISAPPROVED', issues_info: [{ error_code: 1487225 }], ad_review_feedback: { global: { 1815232: 'text', 1815233: 'text' } } } },
    ]);
    const states = await w.readObjects(SECRET, [
      { level: 'campaign', externalId: '120201' },
      { level: 'ad_set', externalId: '120202' },
      { level: 'ad', externalId: '120204' },
    ]);
    expect(states).toEqual([
      { externalId: '120201', configuredStatus: 'ACTIVE', effectiveStatus: 'ACTIVE', reasons: [] },
      { externalId: '120202', configuredStatus: 'ACTIVE', effectiveStatus: 'WITH_ISSUES', reasons: ['1487225'] },
      { externalId: '120204', configuredStatus: 'ACTIVE', effectiveStatus: 'DISAPPROVED', reasons: ['1487225', '1815232', '1815233'] },
    ]);
    expect(calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get('fields')])).toEqual([
      ['GET', '/v24.0/120201', 'configured_status,effective_status,issues_info'],
      ['GET', '/v24.0/120202', 'configured_status,effective_status,issues_info'],
      ['GET', '/v24.0/120204', 'configured_status,effective_status,issues_info,ad_review_feedback'],
    ]);
  });

  it('leaves out an object Meta does not know, and fails on any other error', async () => {
    const { writer: w } = writer([metaError(400, 100, 33), { body: { configured_status: 'PAUSED', effective_status: 'PAUSED' } }]);
    expect(await w.readObjects(SECRET, [{ level: 'ad', externalId: '1' }, { level: 'ad', externalId: '2' }])).toEqual([{ externalId: '2', configuredStatus: 'PAUSED', effectiveStatus: 'PAUSED', reasons: [] }]);
    expect((await rejection(writer([metaError(400, 100)]).writer.readObjects(SECRET, [{ level: 'ad', externalId: '1' }]))).kind).toBe('bad_request');
  });
});

describe('MetaAdWriter.findByTag', () => {
  const NAME = 'Khai trương [ludy:7f3a9c21]';

  it('finds the one object of the level with exactly that name', async () => {
    const { writer: w, calls } = writer([{ body: { data: [{ id: '120201', name: NAME }, { id: '120299', name: `${NAME} copy` }] } }]);
    expect(await w.findByTag(SECRET, ACCOUNT, 'campaign', NAME)).toEqual({ kind: 'found', externalId: '120201' });
    const [call] = calls;
    expect([call?.method, call?.url.pathname]).toEqual(['GET', '/v24.0/act_1001/campaigns']);
    expect(call?.url.searchParams.get('filtering')).toBe(JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: NAME }]));
  });

  it('says missing when none is there and the list was whole, and unknowable when it cannot tell', async () => {
    expect(await writer([{ body: { data: [] } }]).writer.findByTag(SECRET, ACCOUNT, 'ad_set', NAME)).toEqual({ kind: 'missing' });
    expect(await writer([{ body: { data: [{ id: '1', name: NAME }, { id: '2', name: NAME }] } }]).writer.findByTag(SECRET, ACCOUNT, 'ad', NAME)).toEqual({ kind: 'unknowable', reason: 'duplicates' });
    expect(await writer([{ body: { data: [{ id: '1', name: 'other' }], paging: { next: 'https://graph.facebook.com/next' } } }]).writer.findByTag(SECRET, ACCOUNT, 'ad', NAME)).toEqual({ kind: 'unknowable', reason: 'truncated' });
  });

  it('reads each level from its own edge, and does not filter the creatives by name', async () => {
    const { writer: w, calls } = writer([{ body: { data: [] } }, { body: { data: [] } }, { body: { data: [] } }, { body: { data: [] } }]);
    for (const level of ['campaign', 'ad_set', 'creative', 'ad'] as const) await w.findByTag(SECRET, ACCOUNT, level, NAME);
    expect(calls.map((c) => c.url.pathname)).toEqual(['/v24.0/act_1001/campaigns', '/v24.0/act_1001/adsets', '/v24.0/act_1001/adcreatives', '/v24.0/act_1001/ads']);
    expect(calls.map((c) => c.url.searchParams.has('filtering'))).toEqual([true, true, false, true]);
  });
});

describe('MetaAdWriter.resolveTargeting', () => {
  it('pins each name to the one entry that matches it exactly, without regard to case', async () => {
    const { writer: w, calls } = writer([
      { body: { data: [{ id: '6003139266461', name: 'Coffee' }, { id: '6003139266462', name: 'Coffee shops' }] } },
      { body: { data: [{ key: '4242', name: 'Hà Nội' }] } },
    ]);
    const found = await w.resolveTargeting(SECRET, { interests: ['coffee'], regions: [{ country: 'VN', region: 'hà nội' }] });
    expect(found).toEqual({
      interests: { resolved: [{ name: 'coffee', id: '6003139266461' }], unknown: [], ambiguous: [] },
      regions: { resolved: [{ country: 'VN', name: 'hà nội', key: '4242' }], unknown: [], ambiguous: [] },
    });
    expect(calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get('type'), c.url.searchParams.get('q')])).toEqual([
      ['GET', '/v24.0/search', 'adinterest', 'coffee'],
      ['GET', '/v24.0/search', 'adgeolocation', 'hà nội'],
    ]);
    expect(calls[1]?.url.searchParams.get('country_code')).toBe('VN');
  });

  it('names what it cannot pin down: no entry is unknown, more than one is ambiguous, and one entry listed twice is one', async () => {
    const { writer: w } = writer([
      { body: { data: [{ id: '1', name: 'Travel agencies' }] } },
      { body: { data: [{ id: '2', name: 'Fashion' }, { id: '3', name: 'fashion' }] } },
      { body: { data: [{ id: '4', name: 'Tea' }, { id: '4', name: 'Tea' }] } },
      { body: { data: [] } },
      { body: { data: [{ key: '1', name: 'Quận 1' }, { key: '2', name: 'Quận 1' }] } },
    ]);
    const found = await w.resolveTargeting(SECRET, { interests: ['Travel', 'Fashion', 'Tea'], regions: [{ country: 'VN', region: 'Đà Lạt' }, { country: 'VN', region: 'Quận 1' }] });
    expect(found.interests).toEqual({ resolved: [{ name: 'Tea', id: '4' }], unknown: ['Travel'], ambiguous: ['Fashion'] });
    expect(found.regions).toEqual({ resolved: [], unknown: ['VN:Đà Lạt'], ambiguous: ['VN:Quận 1'] });
  });

  it('makes no call for a plan that names nothing', async () => {
    const { writer: w, calls } = writer([]);
    expect(await w.resolveTargeting(SECRET, { interests: [], regions: [] })).toEqual({ interests: { resolved: [], unknown: [], ambiguous: [] }, regions: { resolved: [], unknown: [], ambiguous: [] } });
    expect(calls).toHaveLength(0);
  });
});

describe('what the writer can do at all', () => {
  const source = readFileSync(new URL('../src/meta-write.ts', import.meta.url), 'utf8');

  it('is the write provider\'s writer, and has exactly these methods: no delete, remove or archive of any ad object', () => {
    expect(new MetaAdWriter({ appSecret: APP_SECRET }).provider).toBe(META_WRITE_PROVIDER);
    // Each method is a capability: a new one is added here on purpose, with the live check that confirmed it.
    expect(Object.getOwnPropertyNames(MetaAdWriter.prototype).sort()).toEqual([
      'constructor',
      'createAd',
      'createAdSet',
      'createCampaign',
      'createCreative',
      'findByTag',
      'guard',
      'readObjects',
      'resolveTargeting',
      'revokeToken',
      'setStatus',
      'verify',
    ]);
    expect(source).not.toMatch(/\b(delete|remove|archive)[A-Z]\w*\s*\(/);
  });

  it('names exactly these Graph endpoints: the only DELETE is the permission revoke, and a POST changes a status or makes a paused object', () => {
    const calls = [...source.matchAll(/\.call<[\s\S]*?>\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*([^,)]+)/g)].map((m) => [m[1], m[2]]);
    expect(calls).toEqual([
      ['GET', "'me/permissions'"],
      ['GET', 'accountId'],
      ['DELETE', "'me/permissions'"],
      ['GET', "'search'"],
      ['GET', "'search'"],
      ['POST', '`${accountId}/campaigns`'],
      ['POST', '`${accountId}/adsets`'],
      ['POST', '`${accountId}/adcreatives`'],
      ['POST', '`${accountId}/ads`'],
      ['POST', 'id'],
      ['GET', 'id'],
      ['GET', '`${accountId}/${META_LIST_EDGES[level]}`'],
    ]);
    expect(META_LIST_EDGES).toEqual({ campaign: 'campaigns', ad_set: 'adsets', creative: 'adcreatives', ad: 'ads' });
    expect(source).not.toMatch(/'(PUT|PATCH)'|multipart/);
    // Every object a create makes is PAUSED, and the only status a POST to an object can carry is the one passed to setStatus.
    expect((source.match(/status: 'PAUSED'/g) ?? []).length).toBe(3);
    expect(source).toContain('form: { status }');
  });

  it('keeps every request on graph.facebook.com over https', async () => {
    const answers: Answer[] = [{ body: { success: true } }, { body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'granted' }] } }, { body: { id: 'act_1001' } }, { body: { id: '1' } }, { body: { data: [] } }];
    const { writer: w, calls } = writer(answers);
    await w.revokeToken(SECRET);
    await w.verify(SECRET, ACCOUNT);
    await w.createCampaign(SECRET, ACCOUNT, { name: 'x', objective: 'traffic' });
    await w.findByTag(SECRET, ACCOUNT, 'ad', 'x');
    expect(calls.every((c) => c.url.protocol === 'https:' && c.url.host === 'graph.facebook.com' && c.url.username === '' && c.url.password === '')).toBe(true);
  });
});
