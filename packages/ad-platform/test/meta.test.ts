// SPDX-License-Identifier: AGPL-3.0-only
// The Meta ad adapter (ADR-0040, #2218) against recorded answers: the ad accounts of a token, the daily Insights of one
// account at account and campaign level (paged by cursor), the mapping of Meta's errors, and the OAuth connection. Every
// call the adapter makes is a GET to graph.facebook.com, and its source names no write.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GraphError, type Fetch } from '@crove/channel';
import { AdPlatformError, MetaAdsConnector, MetaAdsPlatform, META_ADS_SCOPES, adPlatforms, graphHostOnly, isAdPlatformProvider, metaAdsError, platformUserHash } from '../src/index.ts';

const SECRET = JSON.stringify({ accessToken: 'EAAB-token-not-in-urls' });
const NOW = new Date('2026-11-02T08:00:00Z');

interface Call {
  method: string;
  url: URL;
  authorization: string | null;
}

// A fetch that answers from a list of recorded bodies, in order, and remembers each request.
function recorded(answers: Array<{ status?: number; body: unknown }>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: Fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: new URL(input), authorization: new Headers(init?.headers).get('authorization') });
    const next = answers[i++];
    if (!next) throw new Error(`no recorded answer for ${input}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const platform = (fetch: Fetch) => new MetaAdsPlatform({ appSecret: 'app-secret', graphVersion: 'v24.0', fetch, now: () => NOW });

describe('the Meta ad platform', () => {
  it('is a provider of its own, with the revision window and the result kinds it reports', () => {
    const meta = platform(recorded([]).fetch);
    expect(meta.id).toBe('meta_ads');
    expect(isAdPlatformProvider('meta_ads')).toBe(true);
    expect(meta.hosts).toEqual(['graph.facebook.com']);
    expect(meta.capabilities).toEqual({ revisionDays: 28, resultKinds: ['purchase', 'lead', 'message'] });
    expect(Object.keys(adPlatforms({ sandbox: false, meta: { appSecret: 'x' } }))).toEqual(['meta_ads']);
    expect(Object.keys(adPlatforms({ sandbox: true }))).toEqual(['sandbox_ads']);
  });

  it('lists the ad accounts a token reaches, with their currency and time zone, by cursor', async () => {
    const { fetch, calls } = recorded([
      { body: { data: [{ id: 'act_1001', name: 'Cửa hàng A', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh', account_status: 1 }], paging: { cursors: { after: 'c1' }, next: 'https://graph.facebook.com/next-with-token' } } },
      { body: { data: [{ id: 'act_1002', name: '', currency: 'USD', timezone_name: 'America/Los_Angeles', account_status: 2 }, { id: 'bad id', currency: 'USD', timezone_name: 'UTC' }, { id: 'act_1003', currency: 'EU', timezone_name: 'UTC' }] } },
    ]);
    const accounts = await platform(fetch).accounts(SECRET);
    expect(accounts).toEqual([
      { externalAccountId: 'act_1001', displayName: 'Cửa hàng A', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh' },
      { externalAccountId: 'act_1002', displayName: 'Meta ad account act_1002', currency: 'USD', timeZone: 'America/Los_Angeles' },
    ]);
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['GET', '/v24.0/me/adaccounts'],
      ['GET', '/v24.0/me/adaccounts'],
    ]);
    // The second page asks by cursor, never by the `next` URL Meta sent.
    expect(calls[1]?.url.searchParams.get('after')).toBe('c1');
    // The token is in the Authorization header, with a proof, and in no URL.
    expect(calls[0]?.authorization).toBe('Bearer EAAB-token-not-in-urls');
    for (const call of calls) expect(call.url.toString()).not.toContain('EAAB');
    expect(calls[0]?.url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the daily Insights of an account at account and campaign level, as decimal strings and whole counts', async () => {
    const { fetch, calls } = recorded([
      {
        body: {
          data: [
            { date_start: '2026-10-31', spend: '1250000', impressions: '48000', clicks: '910', reach: '30100', actions: [{ action_type: 'omni_purchase', value: '12' }, { action_type: 'link_click', value: '700' }] },
            { date_start: '2026-11-01', spend: '980000.50', impressions: '41000', clicks: '800', actions: [{ action_type: 'lead', value: '3' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '9' }] },
          ],
        },
      },
      {
        body: {
          data: [{ date_start: '2026-10-31', campaign_id: '2301', campaign_name: 'Khuyến mãi mùa hè', spend: '700000', impressions: '20000', clicks: '400', reach: '15000', actions: [{ action_type: 'omni_purchase', value: '7' }] }],
          paging: { cursors: { after: 'p2' }, next: 'https://graph.facebook.com/next' },
        },
      },
      { body: { data: [{ date_start: '2026-11-01', campaign_id: '2301', campaign_name: 'Khuyến mãi mùa hè', spend: '500000', impressions: '18000', clicks: '350' }, { date_start: '2026-11-01', spend: '1', impressions: '1', clicks: '1' }] } },
    ]);
    const rows = await platform(fetch).readDaily(SECRET, 'act_1001', { from: '2026-10-31', to: '2026-11-01' });
    expect(rows).toEqual([
      { level: 'account', externalObjectId: 'act_1001', objectName: '', day: '2026-10-31', spend: '1250000', impressions: 48000, clicks: 910, reach: 30100, results: { purchase: '12' } },
      { level: 'account', externalObjectId: 'act_1001', objectName: '', day: '2026-11-01', spend: '980000.5', impressions: 41000, clicks: 800, reach: null, results: { lead: '3', message: '9' } },
      { level: 'campaign', externalObjectId: '2301', objectName: 'Khuyến mãi mùa hè', day: '2026-10-31', spend: '700000', impressions: 20000, clicks: 400, reach: 15000, results: { purchase: '7' } },
      // The row with no campaign id is not a campaign day and is left out.
      { level: 'campaign', externalObjectId: '2301', objectName: 'Khuyến mãi mùa hè', day: '2026-11-01', spend: '500000', impressions: 18000, clicks: 350, reach: null, results: {} },
    ]);
    expect(calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get('level'), c.url.searchParams.get('after')])).toEqual([
      ['GET', '/v24.0/act_1001/insights', 'account', null],
      ['GET', '/v24.0/act_1001/insights', 'campaign', null],
      ['GET', '/v24.0/act_1001/insights', 'campaign', 'p2'],
    ]);
    for (const call of calls) {
      expect(call.url.searchParams.get('time_increment')).toBe('1');
      expect(JSON.parse(call.url.searchParams.get('time_range') ?? '{}')).toEqual({ since: '2026-10-31', until: '2026-11-01' });
      // No breakdown: the rows are aggregates of the account or a campaign, never of a person (plan section 9).
      expect(call.url.searchParams.has('breakdowns')).toBe(false);
    }
  });

  it('refuses a range or an account id that is not one, before any call', async () => {
    const { fetch, calls } = recorded([]);
    const meta = platform(fetch);
    await expect(meta.readDaily(SECRET, '1001', { from: '2026-10-01', to: '2026-10-02' })).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(meta.readDaily(SECRET, 'act_1001', { from: '2026-10-02', to: '2026-10-01' })).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(meta.readDaily('not json', 'act_1001', { from: '2026-10-01', to: '2026-10-02' })).rejects.toMatchObject({ kind: 'token_expired' });
    expect(calls).toEqual([]);
  });

  it('maps a rate limit to a retry time, and an expired token, a missing permission and a passing failure to their kinds', async () => {
    const fail = (status: number, error: Record<string, unknown>) => platform(recorded([{ status, body: { error } }]).fetch).accounts(SECRET).catch((e: unknown) => e as AdPlatformError);
    const limited = await fail(400, { code: 80004, message: 'There have been too many calls from this ad-account' });
    expect(limited).toMatchObject({ kind: 'rate_limited', code: '80004' });
    expect((limited as AdPlatformError).retryAt?.toISOString()).toBe('2026-11-02T09:00:00.000Z');
    const capped = await fail(400, { code: 17, message: 'User request limit reached' });
    expect((capped as AdPlatformError).retryAt?.toISOString()).toBe('2026-11-02T08:10:00.000Z');
    expect(await fail(400, { code: 190, message: 'Error validating access token' })).toMatchObject({ kind: 'token_expired', code: '190' });
    expect(await fail(400, { code: 10, message: 'Permission denied' })).toMatchObject({ kind: 'permission' });
    expect(await fail(403, { code: 200 })).toMatchObject({ kind: 'permission' });
    expect(await fail(500, { code: 2 })).toMatchObject({ kind: 'transient' });
    expect(await fail(400, { code: 100 })).toMatchObject({ kind: 'bad_request' });
    expect(await fail(418, { code: 999 })).toMatchObject({ kind: 'unknown' });
    // Only Meta's code is kept: its message may carry a name or a token.
    expect((limited as Error).message).not.toContain('too many calls');
    expect(metaAdsError(new TypeError('fetch failed'))).toMatchObject({ kind: 'transient' });
    expect(metaAdsError(new Error('boom'))).toMatchObject({ kind: 'unknown' });
    expect(metaAdsError(new GraphError(400, { code: 4 }), () => NOW)).toMatchObject({ kind: 'rate_limited' });
  });

  it('calls no endpoint that changes anything: its source names no write, and every call it made above was a GET', () => {
    const source = readFileSync(new URL('../src/meta.ts', import.meta.url), 'utf8');
    // The OAuth token exchange is a POST of the channel layer's MetaLogin; nothing of this file posts, deletes or sends a body.
    for (const write of ["'POST'", "'PUT'", "'PATCH'", "'DELETE'", 'form:', 'multipart', 'method:']) expect(source, write).not.toContain(write);
    // The Graph client reads only through `call('GET', ...)`.
    const methods = [...source.matchAll(/\.call<[^>]*>\('([A-Z]+)'/g)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });
});

describe('the host the Meta adapter reaches', () => {
  it('lets a request to graph.facebook.com over https through, and refuses every other address before it leaves', async () => {
    const { fetch, calls } = recorded([{ body: { ok: true } }]);
    const bound = graphHostOnly(fetch);
    await expect(bound('https://graph.facebook.com/v24.0/me/adaccounts')).resolves.toBeInstanceOf(Response);
    expect(calls).toHaveLength(1);
    for (const refused of [
      'https://graph-video.facebook.com/v24.0/1/videos',
      'https://rupload.facebook.com/video-upload/v24.0/1',
      'https://www.facebook.com/v24.0/dialog/oauth',
      'https://evil.example/graph.facebook.com',
      'https://graph.facebook.com.evil.example/v24.0/me',
      'https://graph.facebook.com@evil.example/v24.0/me',
      'https://user:pass@graph.facebook.com/v24.0/me',
      'http://graph.facebook.com/v24.0/me',
      'https://graph.facebook.com:8443/v24.0/me',
      'not a url',
    ]) {
      await expect(bound(refused), refused).rejects.toMatchObject({ kind: 'unknown', code: 'HOST_NOT_ALLOWED' });
    }
    // None of the refused requests reached the network.
    expect(calls).toHaveLength(1);
  });

  it('keeps every request of the platform and of the connection on that host', async () => {
    const { fetch, calls } = recorded([
      { body: { data: [{ id: 'act_1001', name: 'A', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh' }] } },
      { body: { data: [] } },
      { body: { data: [] } },
    ]);
    const meta = platform(fetch);
    await meta.accounts(SECRET);
    await meta.readDaily(SECRET, 'act_1001', { from: '2026-10-01', to: '2026-10-02' });
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(`${call.url.protocol}//${call.url.host}`).toBe('https://graph.facebook.com');
    expect(meta.hosts).toEqual(['graph.facebook.com']);
  });
});

describe('the Meta ad connection', () => {
  const app = { appId: '123456789', appSecret: 'app-secret', graphVersion: 'v24.0' };
  const redirectUri = 'https://ludy.example.test/channels/oauth/meta_ads/callback';

  it('sends the browser to Meta\'s dialog for ads_read alone', () => {
    const connector = new MetaAdsConnector(app, { fetch: recorded([]).fetch });
    const url = new URL(connector.authorizeUrl({ state: 'state-1', redirectUri, codeChallenge: null }));
    expect(connector.provider).toBe('meta_ads');
    expect(connector.pkce).toBe(false);
    expect(url.host).toBe('www.facebook.com');
    expect(url.searchParams.get('scope')).toBe('ads_read');
    expect(META_ADS_SCOPES).toEqual(['ads_read']);
    expect(url.searchParams.get('client_id')).toBe('123456789');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('turns a code into one connection per ad account, each sealing the same long-lived token and expiring in about 60 days', async () => {
    const { fetch, calls } = recorded([
      { body: { access_token: 'short-token' } },
      { body: { access_token: 'long-token' } },
      { body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'public_profile', status: 'granted' }] } },
      { body: { id: '4242' } },
      { body: { data: [{ id: 'act_1001', name: 'Cửa hàng A', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh' }, { id: 'act_1002', name: 'Cửa hàng B', currency: 'USD', timezone_name: 'UTC' }] } },
    ]);
    const connector = new MetaAdsConnector(app, { fetch, now: () => NOW });
    const accounts = await connector.exchange({ code: 'the-code', redirectUri, codeVerifier: null });
    expect(accounts.map((a) => [a.provider, a.externalAccountId, a.displayName, a.scopes])).toEqual([
      ['meta_ads', 'act_1001', 'Cửa hàng A', ['ads_read', 'public_profile']],
      ['meta_ads', 'act_1002', 'Cửa hàng B', ['ads_read', 'public_profile']],
    ]);
    expect(accounts[0]?.expiresAt?.toISOString()).toBe('2027-01-01T08:00:00.000Z');
    expect(JSON.parse(accounts[0]?.secret ?? '{}')).toEqual({ accessToken: 'long-token' });
    expect(JSON.parse(accounts[1]?.secret ?? '{}')).toEqual({ accessToken: 'long-token' });
    // The exchange POSTs are Meta's token endpoint; what follows is read with GETs.
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET', 'GET', 'GET']);
    // Each connection carries the keyed hash of the Meta user who granted it, never the id (plan section 9).
    expect(accounts[0]?.grantedByHash).toBe(platformUserHash('app-secret', '4242'));
    expect(accounts[0]?.grantedByHash).toMatch(/^[0-9a-f]{64}$/);
    expect(accounts[1]?.grantedByHash).toBe(accounts[0]?.grantedByHash);
    expect(JSON.stringify(accounts)).not.toContain('4242');
  });

  it('refuses a grant without ads_read, and a login that reaches no ad account', async () => {
    const answers = (permissions: unknown, accounts: unknown) => [
      { body: { access_token: 'short' } },
      { body: { access_token: 'long' } },
      { body: permissions },
      { body: { id: '4242' } },
      { body: accounts },
    ];
    const denied = new MetaAdsConnector(app, { fetch: recorded(answers({ data: [{ permission: 'public_profile', status: 'granted' }] }, { data: [] })).fetch });
    await expect(denied.exchange({ code: 'c', redirectUri, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
    const none = new MetaAdsConnector(app, { fetch: recorded(answers({ data: [{ permission: 'ads_read', status: 'granted' }] }, { data: [] })).fetch });
    // Not a missing permission: the caller tells the person that this login reaches no ad account.
    expect(await none.exchange({ code: 'c', redirectUri, codeVerifier: null })).toEqual([]);
  });

  it('refuses a token that can change campaigns or the business, whatever else it holds', async () => {
    for (const forbidden of ['ads_management', 'business_management']) {
      const { fetch, calls } = recorded([
        { body: { access_token: 'short' } },
        { body: { access_token: 'long' } },
        { body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: forbidden, status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }] } },
        { body: { id: '4242' } },
        { body: { data: [{ id: 'act_1001', name: 'A', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh' }] } },
      ]);
      await expect(new MetaAdsConnector(app, { fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null }), forbidden).rejects.toMatchObject({ kind: 'denied', code: 'WRITE_PERMISSION_GRANTED' });
      // Refused before the ad accounts are listed: no call after the permissions read.
      expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET']);
    }
    // A declined one is not held.
    const { fetch } = recorded([
      { body: { access_token: 'short' } },
      { body: { access_token: 'long' } },
      { body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'declined' }] } },
      { body: { id: '4242' } },
      { body: { data: [{ id: 'act_1001', name: 'A', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh' }] } },
    ]);
    const accounts = await new MetaAdsConnector(app, { fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null });
    expect(accounts).toHaveLength(1);
  });

  it('records every permission the token holds, so an app shared with Pages publishing shows what the ads token can also do', async () => {
    const { fetch } = recorded([
      { body: { access_token: 'short' } },
      { body: { access_token: 'long' } },
      { body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }, { permission: 'ads_management', status: 'declined' }] } },
      { body: { id: '4242' } },
      { body: { data: [{ id: 'act_1001', name: 'A', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh' }] } },
    ]);
    const accounts = await new MetaAdsConnector(app, { fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null });
    // Granted only: a declined permission is not held.
    expect(accounts[0]?.scopes).toEqual(['ads_read', 'pages_manage_posts']);
  });
});
