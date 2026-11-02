// SPDX-License-Identifier: AGPL-3.0-only
// The Meta connection that can run ads (ADR-0043, #2294, W0b) against recorded answers: the login asks for ads_read and
// ads_management, a token holding both is recorded whole, a token missing either is refused, the keyed hash of the person is the
// reader's, and nothing in the source of the connector can change anything on Meta. It is not an ad platform of the readers'
// registry.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetch } from '@crove/channel';
import { AD_PLATFORM_PROVIDERS, MetaAdsConnector, MetaWriteConnector, META_WRITE_PROVIDER, META_WRITE_SCOPES, adPlatforms, isAdPlatformProvider, platformUserHash } from '../src/index.ts';

const NOW = new Date('2026-11-02T08:00:00Z');
const app = { appId: '123456789', appSecret: 'app-secret', graphVersion: 'v24.0' };
const redirectUri = 'https://ludy.example.test/channels/oauth/metawrite_ads/callback';

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

const ACCOUNTS = { data: [{ id: 'act_1001', name: 'Cửa hàng A', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh' }, { id: 'act_1002', name: 'Cửa hàng B', currency: 'USD', timezone_name: 'UTC' }] };

// The five answers of one login: the two token exchanges, the permissions the token holds, who it is, and its ad accounts.
const login = (permissions: unknown, me: { status?: number; body: unknown } = { body: { id: '4242' } }, accounts: unknown = ACCOUNTS) => [
  { body: { access_token: 'short-token' } },
  { body: { access_token: 'long-token' } },
  { body: permissions },
  me,
  { body: accounts },
];
const granted = (...names: string[]) => ({ data: names.map((permission) => ({ permission, status: 'granted' })) });

describe('the Meta write connection', () => {
  it('sends the browser to Meta\'s dialog for ads_read and ads_management', () => {
    const connector = new MetaWriteConnector(app, { fetch: recorded([]).fetch });
    const url = new URL(connector.authorizeUrl({ state: 'state-1', redirectUri, codeChallenge: null }));
    expect(connector.provider).toBe('metawrite_ads');
    expect(META_WRITE_PROVIDER).toBe('metawrite_ads');
    expect(connector.pkce).toBe(false);
    expect(url.host).toBe('www.facebook.com');
    expect(META_WRITE_SCOPES).toEqual(['ads_read', 'ads_management']);
    expect(url.searchParams.get('scope')).toBe('ads_read,ads_management');
    expect(url.searchParams.get('client_id')).toBe('123456789');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('is not an ad platform of the readers\' registry', () => {
    expect(AD_PLATFORM_PROVIDERS).toEqual(['sandbox_ads', 'meta_ads']);
    expect(isAdPlatformProvider('metawrite_ads')).toBe(false);
    expect(Object.keys(adPlatforms({ sandbox: true, meta: { appSecret: 'x' } }))).toEqual(['sandbox_ads', 'meta_ads']);
  });

  it('turns a code into one connection per ad account, each sealing the same long-lived token and expiring in about 60 days', async () => {
    const { fetch, calls } = recorded(login(granted('ads_read', 'ads_management', 'public_profile')));
    const accounts = await new MetaWriteConnector(app, { fetch, now: () => NOW }).exchange({ code: 'the-code', redirectUri, codeVerifier: null });
    expect(accounts.map((a) => [a.provider, a.externalAccountId, a.displayName, a.scopes])).toEqual([
      ['metawrite_ads', 'act_1001', 'Cửa hàng A', ['ads_management', 'ads_read', 'public_profile']],
      ['metawrite_ads', 'act_1002', 'Cửa hàng B', ['ads_management', 'ads_read', 'public_profile']],
    ]);
    expect(accounts[0]?.expiresAt?.toISOString()).toBe('2027-01-01T08:00:00.000Z');
    expect(JSON.parse(accounts[0]?.secret ?? '{}')).toEqual({ accessToken: 'long-token' });
    expect(JSON.parse(accounts[1]?.secret ?? '{}')).toEqual({ accessToken: 'long-token' });
    // The token exchange is Meta's token endpoint; what follows is read with GETs, and nothing is sent to change an account.
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET', 'GET', 'GET']);
    expect(calls.map((c) => c.url.pathname)).toEqual(['/v24.0/oauth/access_token', '/v24.0/oauth/access_token', '/v24.0/me/permissions', '/v24.0/me', '/v24.0/me/adaccounts']);
    // The token is in the Authorization header after the exchange, and in no URL.
    for (const call of calls) expect(call.url.toString()).not.toContain('long-token');
    expect(calls[4]?.authorization).toBe('Bearer long-token');
  });

  it('records every permission the token holds and refuses none: a token that can change campaigns is what it is for', async () => {
    const { fetch } = recorded(
      login({ data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'granted' }, { permission: 'business_management', status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }, { permission: 'ads_extra_declined', status: 'declined' }] }),
    );
    const accounts = await new MetaWriteConnector(app, { fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null });
    expect(accounts).toHaveLength(2);
    // Granted only, the ones the app was given earlier included.
    expect(accounts[0]?.scopes).toEqual(['ads_management', 'ads_read', 'business_management', 'pages_manage_posts']);
  });

  it('refuses a token missing ads_management, or ads_read, before the ad accounts are listed', async () => {
    const cases: Array<[string, unknown]> = [
      ['only ads_read', granted('ads_read', 'public_profile')],
      ['ads_management declined', { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'declined' }] }],
      ['only ads_management', granted('ads_management', 'public_profile')],
      ['neither', granted('public_profile')],
    ];
    for (const [name, permissions] of cases) {
      const { fetch, calls } = recorded(login(permissions));
      await expect(new MetaWriteConnector(app, { fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null }), name).rejects.toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
      // Refused after the permissions read: nothing asks who the person is, and no ad account is listed.
      expect(calls.map((c) => c.method), name).toEqual(['POST', 'POST', 'GET']);
    }
  });

  it('hashes the person as the read connection does, so one app\'s data deletion finds both', async () => {
    const write = await new MetaWriteConnector(app, { fetch: recorded(login(granted('ads_read', 'ads_management'))).fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null });
    const read = await new MetaAdsConnector(app, { fetch: recorded(login(granted('ads_read'))).fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null });
    expect(write[0]?.grantedByHash).toBe(platformUserHash('app-secret', '4242'));
    expect(write[0]?.grantedByHash).toMatch(/^[0-9a-f]{64}$/);
    expect(write[1]?.grantedByHash).toBe(write[0]?.grantedByHash);
    // The same function and label as the reader: the two hashes of one person under one app are equal.
    expect(write[0]?.grantedByHash).toBe(read[0]?.grantedByHash);
    // Never the id itself.
    expect(JSON.stringify(write)).not.toContain('4242');
    // Another app secret keys another hash.
    const other = await new MetaWriteConnector({ ...app, appSecret: 'another-secret' }, { fetch: recorded(login(granted('ads_read', 'ads_management'))).fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null });
    expect(other[0]?.grantedByHash).not.toBe(write[0]?.grantedByHash);
  });

  it('connects without a hash when Meta does not name the person, and does not fail the login for it', async () => {
    for (const me of [{ status: 500, body: { error: { code: 1, message: 'x' } } }, { body: {} }, { body: { id: 'not-digits' } }]) {
      const { fetch } = recorded(login(granted('ads_read', 'ads_management'), me, { data: [{ id: 'act_1001', name: 'A', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh' }] }));
      const accounts = await new MetaWriteConnector(app, { fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null });
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.grantedByHash).toBeUndefined();
    }
  });

  it('skips a row that is not an ad account, and a login that reaches none is not a missing permission', async () => {
    const mixed = recorded(login(granted('ads_read', 'ads_management'), undefined, { data: [{ id: 'bad id', name: 'x' }, { id: 'act_1001', name: '', currency: 'VND', timezone_name: 'UTC' }] }));
    const accounts = await new MetaWriteConnector(app, { fetch: mixed.fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null });
    expect(accounts.map((a) => [a.externalAccountId, a.displayName])).toEqual([['act_1001', 'Meta ad account act_1001']]);
    const none = recorded(login(granted('ads_read', 'ads_management'), undefined, { data: [] }));
    expect(await new MetaWriteConnector(app, { fetch: none.fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null })).toEqual([]);
  });

  it('keeps every request on graph.facebook.com', async () => {
    const { fetch, calls } = recorded(login(granted('ads_read', 'ads_management')));
    await new MetaWriteConnector(app, { fetch, now: () => NOW }).exchange({ code: 'c', redirectUri, codeVerifier: null });
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(`${call.url.protocol}//${call.url.host}`).toBe('https://graph.facebook.com');
  });

  it('only logs in and lists accounts: its source names no write, and every call it makes is a GET', () => {
    const source = readFileSync(new URL('../src/meta-write-connector.ts', import.meta.url), 'utf8');
    // The OAuth token exchange is a request of the channel layer's MetaLogin; nothing of this file sends a body or changes an object.
    for (const write of ['POST', 'PUT', 'PATCH', 'DELETE', 'form:', 'multipart', 'method:']) expect(source, write).not.toContain(write);
    // The Graph client of this file reads only through `call('GET', ...)`.
    const methods = [...source.matchAll(/\.call<[^>]*>\('([A-Z]+)'/g)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });
});
