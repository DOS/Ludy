// SPDX-License-Identifier: AGPL-3.0-only
// The writer of Meta ads (ADR-0043, #2296, W2-1) against recorded answers: what `verify` reads, how `revokeToken` removes the permissions at Meta and
// what each answer of Meta means for it, and the pin on what the writer can do at all: its own methods, every endpoint its source names, the host,
// and the token in a header and never in a URL. The recorded answers are written from Meta's documentation (the live check records what Meta really
// answers, plan docs/plan/ads-write.md section 5.2), so these prove the shape of the code, not Meta's behaviour.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetch } from '@crove/channel';
import { AdPlatformError, MetaAdWriter, META_WRITE_PROVIDER } from '../src/index.ts';

const NOW = new Date('2026-11-03T08:00:00Z');
const APP_SECRET = 'app-secret';
const SECRET = JSON.stringify({ accessToken: 'write-token' });

interface Call {
  method: string;
  url: URL;
  authorization: string | null;
  // The form a POST sent (Meta takes the fields as application/x-www-form-urlencoded), or null.
  form: URLSearchParams | null;
}

// A fetch that answers from a list of recorded answers, in order, and remembers each request. An answer may be an error thrown by fetch itself.
function recorded(answers: Array<{ status?: number; body: unknown } | Error>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: Fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: new URL(input), authorization: new Headers(init?.headers).get('authorization'), form: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null });
    const next = answers[i++];
    if (!next) throw new Error(`no recorded answer for ${input}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const writer = (answers: Array<{ status?: number; body: unknown } | Error>) => {
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

  it('counts only a person who removed the app (190, subcode 458) as already revoked', async () => {
    const { writer: w, calls } = writer([metaError(400, 190, 458)]);
    expect(await w.revokeToken(SECRET)).toEqual({ how: 'already_invalid' });
    expect(calls).toHaveLength(1);
  });

  it('never counts any other refusal of the token as revoked: the grant may still stand, so it is an error the job ends as "revoke by hand"', async () => {
    const expected: Array<[ReturnType<typeof metaError>, string]> = [
      [metaError(400, 190, 463), '190_463'],
      [metaError(400, 190, 467), '190_467'],
      [metaError(400, 190, 460), '190_460'],
      [metaError(400, 190), '190_0'],
      [metaError(400, 102), '102'],
    ];
    for (const [body, code] of expected) {
      const { writer: w } = writer([body]);
      const error = await rejection(w.revokeToken(SECRET));
      expect([error.kind, error.code], code).toEqual(['token_expired', code]);
    }
  });

  it('never reads an error of the deployment as a refused token: a wrong app secret or proof (100, 200) is a bad request or a permission, tried and counted', async () => {
    for (const [body, kind] of [[metaError(400, 100), 'bad_request'], [metaError(400, 200), 'permission'], [metaError(403, 10), 'permission']] as const) {
      const error = await rejection(writer([body]).writer.revokeToken(SECRET));
      expect(error.kind).toBe(kind);
    }
  });

  it('keeps an error of the deployment a counted failure even when it carries a session subcode', async () => {
    for (const [body, kind] of [[metaError(400, 100, 463), 'bad_request'], [metaError(403, 200, 467), 'permission'], [metaError(400, 100, 458), 'bad_request']] as const) {
      const error = await rejection(writer([body]).writer.revokeToken(SECRET));
      expect(error.kind).toBe(kind);
    }
  });

  it('sends nothing but a DELETE to /me/permissions whatever Meta answers: no other path, method or parameter', async () => {
    const answers = [{ body: { success: true } }, metaError(400, 190, 458), metaError(400, 190, 463), metaError(500, 2), metaError(400, 4), metaError(400, 100), { body: {} }, new Error('down')];
    for (const answer of answers) {
      const { writer: w, calls } = writer([answer]);
      await w.revokeToken(SECRET).catch(() => undefined);
      expect(calls.map((c) => [c.method, c.url.origin, c.url.pathname, [...c.url.searchParams.keys()]])).toEqual([['DELETE', 'https://graph.facebook.com', '/v24.0/me/permissions', ['appsecret_proof']]]);
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
    expect(await w.verify(SECRET, { externalAccountId: 'act_1001' })).toEqual({ canRunAds: true, scopes: ['ads_management', 'ads_read', 'public_profile'] });
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['GET', '/v24.0/me/permissions'],
      ['GET', '/v24.0/act_1001'],
    ]);
    expect(calls.every((c) => c.authorization === 'Bearer write-token' && !c.url.toString().includes('write-token'))).toBe(true);
  });

  it('says a token cannot run ads when a permission is missing or was declined, without reading the account', async () => {
    const { writer: w, calls } = writer([permissions(['ads_read', 'granted'], ['ads_management', 'declined'])]);
    expect(await w.verify(SECRET, { externalAccountId: 'act_1001' })).toEqual({ canRunAds: false, scopes: ['ads_read'] });
    expect(calls).toHaveLength(1);
  });

  it('refuses an account the token does not reach, as Meta says it', async () => {
    const { writer: w } = writer([permissions(['ads_read', 'granted'], ['ads_management', 'granted']), metaError(403, 200)]);
    expect((await rejection(w.verify(SECRET, { externalAccountId: 'act_1001' }))).kind).toBe('permission');
  });

  it('refuses an account id that is not one, without calling Meta', async () => {
    const { writer: w, calls } = writer([]);
    const error = await rejection(w.verify(SECRET, { externalAccountId: '1001/../me' }));
    expect([error.kind, error.code]).toEqual(['bad_request', 'BAD_ACCOUNT']);
    expect(calls).toHaveLength(0);
  });

  it('refuses an account whose currency is not the one it is asked about: a budget is sent in the minor unit of the account\'s currency, so a stale currency could be a hundred times off', async () => {
    const granted = permissions(['ads_read', 'granted'], ['ads_management', 'granted']);
    const { writer: w, calls } = writer([granted, { body: { id: 'act_1001', currency: 'USD' } }]);
    const error = await rejection(w.verify(SECRET, { externalAccountId: 'act_1001', currency: 'VND' }));
    expect([error.kind, error.code]).toEqual(['bad_request', 'CURRENCY_MISMATCH']);
    // An answer with no currency is refused too when the caller asked for the check: it is never skipped.
    for (const body of [{ id: 'act_1001' }, { id: 'act_1001', currency: null }, { id: 'act_1001', currency: 840 }]) {
      const missing = await rejection(writer([granted, { body }]).writer.verify(SECRET, { externalAccountId: 'act_1001', currency: 'VND' }));
      expect([missing.kind, missing.code], JSON.stringify(body)).toEqual(['bad_request', 'CURRENCY_UNKNOWN']);
    }
    // The same currency passes, and a caller that names none is not asked.
    expect(await writer([granted, { body: { id: 'act_1001', currency: 'VND' } }]).writer.verify(SECRET, { externalAccountId: 'act_1001', currency: 'VND' })).toMatchObject({ canRunAds: true });
    expect(await writer([granted, { body: { id: 'act_1001', currency: 'USD' } }]).writer.verify(SECRET, { externalAccountId: 'act_1001' })).toMatchObject({ canRunAds: true });
    // The account is read with its currency, a GET and nothing else.
    expect(calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get('fields')])).toEqual([['GET', '/v24.0/me/permissions', null], ['GET', '/v24.0/act_1001', 'id,currency']]);
  });
});

const ACCOUNT_VND = { externalAccountId: 'act_1001', currency: 'VND' };
const ACCOUNT_USD = { externalAccountId: 'act_1002', currency: 'USD' };
const TAG = 'ludy:0123456789';
const TARGETING = { countries: ['VN'], regions: [{ key: '2000', name: 'Hà Nội' }], ageMin: 25, ageMax: 45, gender: 'female' as const, interests: [{ id: '6003', name: 'Coffee' }] };
const adSetInput = (over: Partial<Parameters<MetaAdWriter['createAdSet']>[2]> = {}) => ({
  name: `Cà phê ${TAG}`,
  campaignId: '111',
  objective: 'traffic' as const,
  dailyBudget: '100000',
  startTime: '2026-11-05T00:00:00+0700',
  endTime: '2026-11-12T00:00:00+0700',
  targeting: TARGETING,
  pageId: '555',
  ...over,
});
const created = (id: string) => ({ body: { id } });

describe('MetaAdWriter, the creates of a launch', () => {
  it('creates every object PAUSED, with one POST to the account\'s own edge: a campaign, an ad set and an ad can carry no other status, and a creative has none to carry', async () => {
    const { writer: w, calls } = writer([created('1001'), created('1002'), created('1003'), created('1004')]);
    expect(await w.createCampaign(SECRET, ACCOUNT_VND, { name: `Cà phê ${TAG}`, objective: 'traffic' })).toEqual({ id: '1001' });
    expect(await w.createAdSet(SECRET, ACCOUNT_VND, adSetInput({ campaignId: '1001' }))).toEqual({ id: '1002' });
    expect(await w.createCreative(SECRET, ACCOUNT_VND, { name: `Cà phê ${TAG} creative 1`, pageId: '555', linkUrl: 'https://example.com/cafe', headline: 'Cà phê ngon', primaryText: 'Ghé thử', callToAction: 'learn_more' })).toEqual({ id: '1003' });
    expect(await w.createAd(SECRET, ACCOUNT_VND, { name: `Cà phê ${TAG} ad 1`, adSetId: '1002', creativeId: '1003' })).toEqual({ id: '1004' });
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['POST', '/v24.0/act_1001/campaigns'],
      ['POST', '/v24.0/act_1001/adsets'],
      ['POST', '/v24.0/act_1001/adcreatives'],
      ['POST', '/v24.0/act_1001/ads'],
    ]);
    // Campaign, ad set and ad: status PAUSED, and nothing sends ACTIVE anywhere. The creative is created without a status (Meta has none to set on it).
    expect(calls.map((c) => c.form?.get('status') ?? null)).toEqual(['PAUSED', 'PAUSED', null, 'PAUSED']);
    for (const c of calls) expect([...(c.form?.values() ?? [])].some((v) => /ACTIVE/i.test(v)), c.url.pathname).toBe(false);
    // The campaign: the objective's own name, no special ad category, nothing that spends by itself.
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({ name: `Cà phê ${TAG}`, objective: 'OUTCOME_TRAFFIC', special_ad_categories: '[]', buying_type: 'AUCTION', status: 'PAUSED' });
    // The token is in the header with the app secret's proof, and in no URL and no body.
    expect(calls.every((c) => c.authorization === 'Bearer write-token' && c.url.searchParams.get('appsecret_proof') !== null)).toBe(true);
    expect(calls.every((c) => !c.url.toString().includes('write-token') && !(c.form?.toString() ?? '').includes('write-token'))).toBe(true);
  });

  it('sends the ad set with its budget in Meta\'s minor unit, the flight in the account\'s zone, the targeting as ids and the Page', async () => {
    const { writer: w, calls } = writer([created('1002')]);
    await w.createAdSet(SECRET, ACCOUNT_VND, adSetInput());
    const form = calls[0]?.form;
    expect(form?.get('daily_budget')).toBe('100000');
    expect(form?.get('campaign_id')).toBe('111');
    expect(form?.get('optimization_goal')).toBe('LINK_CLICKS');
    expect(form?.get('billing_event')).toBe('IMPRESSIONS');
    expect(form?.get('start_time')).toBe('2026-11-05T00:00:00+0700');
    expect(form?.get('end_time')).toBe('2026-11-12T00:00:00+0700');
    expect(JSON.parse(form?.get('promoted_object') ?? '{}')).toEqual({ page_id: '555' });
    expect(JSON.parse(form?.get('targeting') ?? '{}')).toEqual({
      geo_locations: { countries: ['VN'], regions: [{ key: '2000' }] },
      age_min: 25,
      age_max: 45,
      genders: [2],
      flexible_spec: [{ interests: [{ id: '6003', name: 'Coffee' }] }],
      targeting_automation: { advantage_audience: 0 },
    });
  });

  it('converts the daily budget with Meta\'s offset of the account\'s currency, exactly: dong as they are, dollars times a hundred (a hundred-fold error spends real money)', async () => {
    const vnd = [['100000', '100000'], ['1500000', '1500000'], ['50000.00', '50000'], ['1', '1']] as const;
    const usd = [['25.50', '2550'], ['5', '500'], ['0.50', '50'], ['0.05', '5'], ['1234567.89', '123456789'], ['10.00', '1000']] as const;
    for (const [account, cases] of [[ACCOUNT_VND, vnd], [ACCOUNT_USD, usd]] as const) {
      for (const [amount, minor] of cases) {
        const { writer: w, calls } = writer([created('1002')]);
        await w.createAdSet(SECRET, account, adSetInput({ dailyBudget: amount }));
        expect(calls[0]?.form?.get('daily_budget'), `${account.currency} ${amount}`).toBe(minor);
      }
    }
  });

  it('refuses a budget it cannot carry or a currency it has no verified offset for, before any request', async () => {
    for (const [account, dailyBudget, code] of [
      [ACCOUNT_VND, '50000.50', 'BUDGET_FRACTION'],
      [ACCOUNT_VND, '0', 'BUDGET_INVALID'],
      [ACCOUNT_VND, '-5', 'BUDGET_INVALID'],
      [ACCOUNT_VND, '1e5', 'BUDGET_INVALID'],
      [ACCOUNT_VND, '100,000', 'BUDGET_INVALID'],
      [ACCOUNT_USD, '5.123', 'BUDGET_INVALID'],
      [{ externalAccountId: 'act_1003', currency: 'XYZ' }, '100', 'CURRENCY_UNSUPPORTED'],
      [{ externalAccountId: 'act_1003', currency: 'vnd' }, '100', 'CURRENCY_UNSUPPORTED'],
    ] as const) {
      const { writer: w, calls } = writer([]);
      const error = await rejection(w.createAdSet(SECRET, account, adSetInput({ dailyBudget })));
      expect([error.kind, error.code], `${account.currency} ${dailyBudget}`).toEqual(['bad_request', code]);
      expect(calls).toHaveLength(0);
    }
  });

  it('has the Traffic objective only: Engagement and Messenger are refused before any request until the live check has passed for them', async () => {
    const { writer: w, calls } = writer([]);
    expect(w.capabilities).toMatchObject({ objectives: ['traffic'], media: false });
    expect(w.capabilities.currencies).toEqual(expect.arrayContaining(['VND', 'USD']));
    for (const objective of ['engagement', 'messenger'] as const) {
      expect(await rejection(w.createCampaign(SECRET, ACCOUNT_VND, { name: `x ${TAG}`, objective }))).toMatchObject({ kind: 'bad_request', code: 'OBJECTIVE_UNSUPPORTED' });
      expect(await rejection(w.createAdSet(SECRET, ACCOUNT_VND, adSetInput({ objective })))).toMatchObject({ kind: 'bad_request', code: 'OBJECTIVE_UNSUPPORTED' });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses ids and links that are not what they should be, before any request', async () => {
    const { writer: w, calls } = writer([]);
    expect((await rejection(w.createAdSet(SECRET, ACCOUNT_VND, adSetInput({ campaignId: '1/../x' })))).code).toBe('BAD_CAMPAIGN');
    expect((await rejection(w.createAdSet(SECRET, ACCOUNT_VND, adSetInput({ pageId: 'abc' })))).code).toBe('BAD_PAGE');
    expect((await rejection(w.createAd(SECRET, ACCOUNT_VND, { name: 'x', adSetId: '1', creativeId: '2; DROP' }))).code).toBe('BAD_OBJECT');
    for (const linkUrl of ['http://example.com/', 'javascript:alert(1)', 'not a url']) {
      expect((await rejection(w.createCreative(SECRET, ACCOUNT_VND, { name: 'x', pageId: '5', linkUrl, headline: 'h', primaryText: 'p', callToAction: 'no_button' }))).code, linkUrl).toBe('BAD_LINK');
    }
    expect((await rejection(w.createCampaign(SECRET, { externalAccountId: 'act_1/../me', currency: 'VND' }, { name: 'x', objective: 'traffic' }))).code).toBe('BAD_ACCOUNT');
    expect(calls).toHaveLength(0);
  });

  it('treats an answer with no usable id as unknown, so the caller reconciles by the tag and never creates again blind', async () => {
    for (const body of [{}, { id: 5 }, { id: '12/../3' }, { id: '' }]) {
      const error = await rejection(writer([{ body }]).writer.createCampaign(SECRET, ACCOUNT_VND, { name: `x ${TAG}`, objective: 'traffic' }));
      expect([error.kind, error.code]).toEqual(['unknown', 'NO_ID']);
    }
  });

  it('types what Meta answers: a refusal of the call, a limit with the time to wait, a network failure that may have created the object', async () => {
    const run = (answer: { status?: number; body: unknown } | Error) => rejection(writer([answer]).writer.createCampaign(SECRET, ACCOUNT_VND, { name: `x ${TAG}`, objective: 'traffic' }));
    expect(await run(metaError(400, 100))).toMatchObject({ kind: 'bad_request', code: '100' });
    expect(await run(metaError(403, 200))).toMatchObject({ kind: 'permission' });
    expect(await run(metaError(400, 190, 463))).toMatchObject({ kind: 'token_expired' });
    expect(await run(metaError(400, 17))).toMatchObject({ kind: 'rate_limited', retryAt: new Date('2026-11-03T08:10:00Z') });
    expect(await run(metaError(500, 2))).toMatchObject({ kind: 'transient' });
    expect(await run(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toMatchObject({ kind: 'transient', code: 'NETWORK' });
  });
});

describe('MetaAdWriter.findByTag and resolveTargeting', () => {
  it('lists the objects of a level whose name carries the tag, with one GET filtered by it, and keeps only what really does', async () => {
    const { writer: w, calls } = writer([{ body: { data: [{ id: '11', name: `Cà phê ${TAG}` }, { id: '12', name: 'Another launch ludy:aaaaaaaaaa' }, { id: 'x/1', name: `bad ${TAG}` }, { name: `no id ${TAG}` }] } }]);
    expect(await w.findByTag(SECRET, ACCOUNT_VND, 'ad_set', TAG)).toEqual([{ id: '11', name: `Cà phê ${TAG}` }]);
    expect(calls).toHaveLength(1);
    expect([calls[0]?.method, calls[0]?.url.pathname]).toEqual(['GET', '/v24.0/act_1001/adsets']);
    expect(calls[0]?.url.searchParams.get('fields')).toBe('id,name');
    expect(JSON.parse(calls[0]?.url.searchParams.get('filtering') ?? '[]')).toEqual([{ field: 'name', operator: 'CONTAIN', value: TAG }]);
    expect(calls[0]?.form).toBeNull();
  });

  it('reads each level from its own edge and refuses a tag that is not a launch\'s', async () => {
    for (const [level, edge] of [['campaign', 'campaigns'], ['ad_set', 'adsets'], ['creative', 'adcreatives'], ['ad', 'ads']] as const) {
      const { writer: w, calls } = writer([{ body: { data: [] } }]);
      expect(await w.findByTag(SECRET, ACCOUNT_VND, level, TAG)).toEqual([]);
      expect(calls[0]?.url.pathname).toBe(`/v24.0/act_1001/${edge}`);
    }
    const { writer: w, calls } = writer([]);
    expect((await rejection(w.findByTag(SECRET, ACCOUNT_VND, 'ad', 'ludy:'))).code).toBe('BAD_TAG');
    expect((await rejection(w.findByTag(SECRET, ACCOUNT_VND, 'ad', '" OR 1=1'))).code).toBe('BAD_TAG');
    expect(calls).toHaveLength(0);
  });

  it('resolves a region and an interest only when exactly one result carries the name, and lists the rest as unknown', async () => {
    const { writer: w, calls } = writer([
      { body: { data: [{ key: '2000', name: 'Hà Nội', type: 'region', country_code: 'VN' }, { key: '2001', name: 'Hà Nam', country_code: 'VN' }] } },
      { body: { data: [{ key: '3', name: 'Nowhere', country_code: 'VN' }] } },
      { body: { data: [{ id: '6003', name: 'coffee' }, { id: '6004', name: 'Coffee shops' }] } },
      { body: { data: [{ id: '7', name: 'Tea' }, { id: '8', name: 'Tea' }] } },
    ]);
    const out = await w.resolveTargeting(SECRET, { regions: [{ country: 'VN', name: 'Hà Nội' }, { country: 'VN', name: 'Cần Thơ' }], interests: ['Coffee', 'Tea'] });
    expect(out).toEqual({ regions: [{ country: 'VN', name: 'Hà Nội', key: '2000' }], interests: [{ name: 'Coffee', id: '6003' }], unknown: ['Cần Thơ (VN)', 'Tea'] });
    expect(calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get('type')])).toEqual([
      ['GET', '/v24.0/search', 'adgeolocation'],
      ['GET', '/v24.0/search', 'adgeolocation'],
      ['GET', '/v24.0/search', 'adinterest'],
      ['GET', '/v24.0/search', 'adinterest'],
    ]);
  });
});

describe('MetaAdWriter.setStatus', () => {
  it('pauses and archives an object, with one POST to its own edge, and has no way to activate one', async () => {
    const { writer: w, calls } = writer([{ body: { success: true } }, { body: { success: true } }]);
    await w.setStatus(SECRET, { level: 'campaign', id: '1001' }, 'paused');
    await w.setStatus(SECRET, { level: 'ad', id: '1004' }, 'archived');
    expect(calls.map((c) => [c.method, c.url.pathname, c.form?.get('status')])).toEqual([
      ['POST', '/v24.0/1001', 'PAUSED'],
      ['POST', '/v24.0/1004', 'ARCHIVED'],
    ]);
  });

  it('refuses any other status that gets past the types, before a request, and an answer that does not say success', async () => {
    const { writer: w, calls } = writer([]);
    for (const status of ['active', 'ACTIVE', 'deleted', '']) {
      expect((await rejection(w.setStatus(SECRET, { level: 'campaign', id: '1001' }, status as 'paused'))).code, status).toBe('STATUS_REFUSED');
    }
    expect((await rejection(w.setStatus(SECRET, { level: 'campaign', id: '1/../me' }, 'paused'))).code).toBe('BAD_OBJECT');
    expect(calls).toHaveLength(0);
    expect((await rejection(writer([{ body: { success: false } }]).writer.setStatus(SECRET, { level: 'campaign', id: '1001' }, 'paused'))).code).toBe('NOT_CHANGED');
  });
});

describe('what the writer can do at all', () => {
  const source = readFileSync(new URL('../src/meta-write.ts', import.meta.url), 'utf8');

  it('is the write provider\'s writer, and has exactly the methods of this slice: no delete of any ad object', () => {
    expect(new MetaAdWriter({ appSecret: APP_SECRET }).provider).toBe(META_WRITE_PROVIDER);
    // Each method is a capability: a new one is added here on purpose, with the live check that confirmed it.
    expect(Object.getOwnPropertyNames(MetaAdWriter.prototype).sort()).toEqual([
      'constructor',
      'create',
      'createAd',
      'createAdSet',
      'createCampaign',
      'createCreative',
      'findByTag',
      'resolveTargeting',
      'revokeToken',
      'setStatus',
      'verify',
    ]);
    expect(source).not.toMatch(/\b(delete|remove|archive)[A-Z]\w*\s*\(/);
    expect(source).not.toMatch(/\b(activate|resume|enable|unpause)\w*\s*\(/i);
  });

  it('names exactly the Graph endpoints of this slice: the reads, the one create call site, the pause and archive, and the revoke', () => {
    const calls = [...source.matchAll(/\.call<[\s\S]*?>\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*([^,)]+)/g)].map((m) => [m[1], m[2]]);
    expect(calls).toEqual([
      ['GET', "'me/permissions'"],
      ['GET', 'account.externalAccountId'],
      ['DELETE', "'me/permissions'"],
      ['POST', '`${account.externalAccountId}/${EDGES[level]}`'],
      ['GET', '`${account.externalAccountId}/${EDGES[level]}`'],
      ['GET', "'search'"],
      ['GET', "'search'"],
      ['POST', 'object.id'],
    ]);
    // Two POST sites (the creates and the status), one DELETE (the revoke), nothing else, and no file or multipart upload.
    expect([...source.matchAll(/'(POST|PUT|PATCH|DELETE)'/g)].map((m) => m[1])).toEqual(['DELETE', 'POST', 'POST']);
    expect(source).not.toMatch(/multipart/);
    // The statuses it can send are PAUSED and ARCHIVED, and the word ACTIVE is nowhere in it.
    expect(source).not.toMatch(/ACTIVE/);
    expect([...source.matchAll(/'(PAUSED|ARCHIVED)'/g)].map((m) => m[1])).toEqual(['PAUSED', 'PAUSED', 'ARCHIVED']);
  });

  it('keeps every request on graph.facebook.com over https', async () => {
    const { writer: w, calls } = writer([{ body: { success: true } }, { body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'granted' }] } }, { body: { id: 'act_1' } }]);
    await w.revokeToken(SECRET);
    await w.verify(SECRET, { externalAccountId: 'act_1' });
    expect(calls.every((c) => c.url.protocol === 'https:' && c.url.host === 'graph.facebook.com' && c.url.username === '' && c.url.password === '')).toBe(true);
  });
});
