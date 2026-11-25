// SPDX-License-Identifier: AGPL-3.0-only
// The TikTok Shop token API (#2524, T1 = #4256) against a made-up TikTok: the authorization code traded for a pair, and a connection's tokens renewed. The rotated pair is kept and the seller's authorization
// end is never extended; a refresh token past that end ends the connection (refused) while every other trouble is only a failure (no refusal code is documented, so none is invented); one call is made to one
// host and never repeated; and above all the token URL, which carries the app secret, never reaches a result: no secret, code, token, address or TikTok sentence. The sweep itself (one at a time, ifVersion,
// expired is not picked again) is tested in channel-refresh.db.test.ts for the refresher interface.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { channelRefreshers } from '../src/kernel.ts';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { parseTiktokSecret } from '../src/marketplace-tiktok.ts';
import { TIKTOK_AUTH_HOST, TIKTOK_REFRESH_HORIZON_SECONDS, TIKTOK_TOKEN_HOSTS, TiktokRefresher, createTiktokToken } from '../src/marketplace-tiktok-token.ts';
import { fakeTiktok, type FakeTiktokOptions } from './fake-tiktok.ts';

const NOW = Date.parse('2026-11-21T08:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const APP = { appKey: '123abc', appSecret: 'test-only-app-secret' };
const AUTH_END = NOW + 90 * DAY;
const PLANTED = 'planted-sentence-sk-live-12345';

const secretOf = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...APP,
    accessToken: 'old-access',
    refreshToken: 'TTP_R0',
    accessExpiresAt: new Date(NOW + DAY / 2).toISOString(),
    refreshExpiresAt: new Date(AUTH_END).toISOString(),
    refreshedAt: new Date(NOW - 2 * DAY).toISOString(),
    openId: 'open-1',
    region: 'VN',
    scopes: ['seller.order.info'],
    ...over,
  });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grantBody = (over: Record<string, unknown> = {}) => ({
  code: 0,
  message: 'success',
  data: { access_token: 'TTP_new_access', access_token_expire_in: Math.floor((NOW + 7 * DAY) / 1000), refresh_token: 'TTP_new_refresh', refresh_token_expire_in: Math.floor(AUTH_END / 1000), open_id: 'open-2', seller_base_region: 'VN', user_type: 0, granted_scopes: ['seller.order.info'], ...over },
});

function setup(over: Partial<FakeTiktokOptions> & { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const { fetch: custom, ...rest } = over;
  const fake = fakeTiktok({ ...APP, accessToken: 'TTP_access', codes: ['CODE1', 'CODE2'], refreshToken: 'TTP_R0', authorizationEndsAtMs: AUTH_END, now: () => NOW, ...rest });
  const fetchImpl = hostBoundFetch(TIKTOK_TOKEN_HOSTS, custom ?? fake.fetch);
  const options = { fetch: fetchImpl, now: () => new Date(NOW) };
  return { fake, options, refresher: new TiktokRefresher(options), create: (code: string) => createTiktokToken(options, { ...APP, code }) };
}

// Everything a result could leak, in one text.
const leaks = (result: unknown): string[] => {
  const text = JSON.stringify(result);
  return [APP.appSecret, 'TTP_R0', 'CODE1', PLANTED, 'auth.tiktok-shops.com', 'app_secret'].filter((word) => text.includes(word));
};

describe('createTiktokToken', () => {
  it('trades the code for the pair, keeps the dates as the answer gives them, and keeps nothing of the seller\'s name', async () => {
    const { create, fake } = setup();
    const grant = await create('CODE1');
    if (!('secret' in grant)) throw new Error('no grant');
    expect(grant.accessExpiresAt.getTime()).toBe(NOW + 7 * DAY);
    expect(grant.authorizationEndsAt?.getTime()).toBe(Math.floor(AUTH_END / 1000) * 1000);
    expect(grant.region).toBe('VN');
    const sealed = JSON.parse(grant.secret) as Record<string, unknown>;
    expect(sealed).toMatchObject({ ...APP, accessToken: 'TTP_access_1', refreshToken: 'TTP_R1', refreshedAt: new Date(NOW).toISOString(), openId: '7010736057180325637', region: 'VN' });
    expect(sealed.scopes).toEqual(['seller.order.info', 'seller.finance.info', 'seller.authorization.info']);
    expect(grant.secret).not.toContain('Nguyễn');
    expect(grant.secret).not.toContain('Cửa hàng');
    // What the fake holds is what was sealed, and the adapter's own reader takes it.
    expect(fake.state()).toMatchObject({ accessToken: 'TTP_access_1', refreshToken: 'TTP_R1' });
    expect(parseTiktokSecret(grant.secret)).toMatchObject({ appKey: APP.appKey, accessToken: 'TTP_access_1' });
  });

  it('is one GET to the one token host with the parameters in the address, no body, and no access token', async () => {
    const { create, fake } = setup();
    await create('CODE1');
    expect(fake.calls).toHaveLength(1);
    const sent = fake.calls[0]!;
    expect(sent).toMatchObject({ method: 'GET', host: TIKTOK_AUTH_HOST, path: '/api/v2/token/get', body: null });
    expect(sent.query).toEqual({ app_key: APP.appKey, app_secret: APP.appSecret, auth_code: 'CODE1', grant_type: 'authorized_code' });
    expect(sent.headers['x-tts-access-token']).toBeUndefined();
  });

  it('refuses a code that is bad, used or expired (36004004) and asks no second time', async () => {
    const { create, fake } = setup();
    expect(await create('CODE1')).toHaveProperty('secret');
    expect(await create('CODE1')).toEqual({ refused: '36004004' });
    expect(await create('NOPE')).toEqual({ refused: '36004004' });
    expect(fake.calls).toHaveLength(3);
  });

  it('refuses a malformed input with no call, and a token that is not a seller\'s with nothing sealed', async () => {
    const { options, fake, create } = setup();
    expect(await create('has space')).toEqual({ refused: 'BAD_CODE' });
    expect(await create('')).toEqual({ refused: 'BAD_CODE' });
    expect(await createTiktokToken(options, { appKey: APP.appKey, appSecret: '', code: 'CODE1' })).toEqual({ refused: 'BAD_SECRET' });
    expect(fake.calls).toHaveLength(0);
    const creator = setup({ userType: 1 });
    expect(await creator.create('CODE1')).toEqual({ refused: 'USER_TYPE' });
  });

  it('treats every other trouble as a failure, never a refusal, and keeps every word of it to a closed code', async () => {
    const wrong = await createTiktokToken(setup({ appSecret: 'another-secret' }).options, { ...APP, code: 'CODE1' });
    expect(wrong).toEqual({ failed: '10000' });
    const odd = async (response: Response) => createTiktokToken(setup({ fetch: async () => response }).options, { ...APP, code: 'CODE1' });
    expect(await odd(json({ code: 99999, message: PLANTED }))).toEqual({ failed: '99999' });
    expect(await odd(json({ code: 'bad code!', message: PLANTED }))).toEqual({ failed: 'UNKNOWN' });
    // A "code" that is secret-shaped or token-shaped text is never passed on.
    expect(await odd(json({ code: 'TTP_secret-looking-token', message: PLANTED }))).toEqual({ failed: 'UNKNOWN' });
    expect(await odd(json({ code: 'IllegalRefreshToken' }))).toEqual({ failed: 'UNKNOWN' });
    expect(await odd(json({ message: PLANTED }, 400))).toEqual({ failed: 'HTTP_400' });
    expect(await odd(json({ code: 0, message: 'ok' }, 400))).toEqual({ failed: 'HTTP_400' });
    expect(await odd(json({}, 429))).toEqual({ failed: '429' });
    expect(await odd(new Response('down', { status: 503 }))).toEqual({ failed: '503' });
    expect(await odd(new Response('<html></html>', { status: 200 }))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(json([1, 2]))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(json({ code: 0, data: {} }))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(json({ code: 0, data: { access_token: 'has space', refresh_token: 'ok' } }))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(new Response('x'.repeat(70_000)))).toEqual({ failed: 'BAD_ANSWER' });
  });

  it('puts neither the address (with the secret in it) nor the code in a result when the transport fails', async () => {
    const result = await createTiktokToken(
      setup({
        fetch: async (url) => {
          throw new Error(`connect ECONNRESET ${url} ${PLANTED}`);
        },
      }).options,
      { ...APP, code: 'CODE1' },
    );
    expect(result).toEqual({ failed: 'NETWORK' });
    expect(leaks(result)).toEqual([]);
    // A code is single use: a lost answer is never asked again.
    let calls = 0;
    const lost = setup({
      fetch: async (url) => {
        calls += 1;
        throw new Error(`connect ECONNRESET ${url}`);
      },
    });
    expect(await lost.create('CODE1')).toEqual({ failed: 'NETWORK' });
    expect(calls).toBe(1);
  });

  it('takes an expiry only when it is a Unix time in the next 400 days, else one day for the access life and none for the authorization end', async () => {
    const run = (data: Record<string, unknown>) => createTiktokToken(setup({ fetch: async () => json(grantBody(data)) }).options, { ...APP, code: 'CODE1' });
    const bad = await run({ access_token_expire_in: 5, refresh_token_expire_in: Math.floor((NOW - DAY) / 1000) });
    if (!('secret' in bad)) throw new Error('no grant');
    expect(bad.accessExpiresAt.getTime()).toBe(NOW + DAY);
    expect(bad.authorizationEndsAt).toBeNull();
    expect(JSON.parse(bad.secret)).not.toHaveProperty('refreshExpiresAt');
    const digits = await run({ access_token_expire_in: String(Math.floor((NOW + 3 * DAY) / 1000)), refresh_token_expire_in: String(Math.floor((NOW + 30 * DAY) / 1000)) });
    if (!('secret' in digits)) throw new Error('no grant');
    expect(digits.accessExpiresAt.getTime()).toBe(NOW + 3 * DAY);
    expect(digits.authorizationEndsAt?.getTime()).toBe(NOW + 30 * DAY);
    const far = await run({ access_token_expire_in: Math.floor((NOW + 1000 * DAY) / 1000) });
    if (!('secret' in far)) throw new Error('no grant');
    expect(far.accessExpiresAt.getTime()).toBe(NOW + DAY);
  });
});

describe('TiktokRefresher', () => {
  it('renews the pair, keeps what the connection already knew, and takes the scopes of the answer', async () => {
    const { refresher, fake } = setup();
    const result = await refresher.refresh(secretOf());
    if (!('secret' in result)) throw new Error('not renewed');
    expect(result.expiresAt.getTime()).toBe(NOW + 7 * DAY);
    const sealed = JSON.parse(result.secret) as Record<string, unknown>;
    expect(sealed).toMatchObject({ ...APP, accessToken: 'TTP_access_1', refreshToken: 'TTP_R1', refreshedAt: new Date(NOW).toISOString(), openId: 'open-1', region: 'VN' });
    expect(sealed.scopes).toEqual(['seller.order.info', 'seller.finance.info', 'seller.authorization.info']);
    expect(fake.state().refreshToken).toBe('TTP_R1');
  });

  it('is one GET to the one token host with the parameters in the address, and never sends an access token', async () => {
    const { refresher, fake } = setup();
    await refresher.refresh(secretOf());
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: 'GET', host: TIKTOK_AUTH_HOST, path: '/api/v2/token/refresh', body: null });
    expect(fake.calls[0]!.query).toEqual({ app_key: APP.appKey, app_secret: APP.appSecret, refresh_token: 'TTP_R0', grant_type: 'refresh_token' });
    expect(fake.calls[0]!.headers['x-tts-access-token']).toBeUndefined();
  });

  it('spends the old refresh token: the old secret fails afterwards, as a failure and not a refusal', async () => {
    const { refresher } = setup();
    expect(await refresher.refresh(secretOf())).toHaveProperty('secret');
    expect(await refresher.refresh(secretOf())).toEqual({ failed: '10002' });
  });

  it('never extends the end of the authorization: the earlier of the stored date and the answer\'s is kept', async () => {
    const later = setup({ fetch: async () => json(grantBody({ refresh_token_expire_in: Math.floor((AUTH_END + 30 * DAY) / 1000) })) });
    const keptOld = await later.refresher.refresh(secretOf());
    if (!('secret' in keptOld)) throw new Error('not renewed');
    expect(JSON.parse(keptOld.secret).refreshExpiresAt).toBe(new Date(AUTH_END).toISOString());
    const earlier = setup({ fetch: async () => json(grantBody({ refresh_token_expire_in: Math.floor((AUTH_END - 30 * DAY) / 1000) })) });
    const keptNew = await earlier.refresher.refresh(secretOf());
    if (!('secret' in keptNew)) throw new Error('not renewed');
    expect(JSON.parse(keptNew.secret).refreshExpiresAt).toBe(new Date(Math.floor((AUTH_END - 30 * DAY) / 1000) * 1000).toISOString());
    // Neither stored nor answered: none is invented.
    const none = setup({ fetch: async () => json(grantBody({ refresh_token_expire_in: 5 })) });
    const unknown = await none.refresher.refresh(secretOf({ refreshExpiresAt: undefined }));
    if (!('secret' in unknown)) throw new Error('not renewed');
    expect(JSON.parse(unknown.secret)).not.toHaveProperty('refreshExpiresAt');
  });

  it('refuses with no call when the authorization has ended, when there is no refresh token or when the secret is not a connection\'s', async () => {
    const { refresher, fake } = setup();
    expect(await refresher.refresh(secretOf({ refreshExpiresAt: new Date(NOW - 1000).toISOString() }))).toEqual({ refused: 'AUTHORIZATION_ENDED' });
    expect(await refresher.refresh(secretOf({ refreshExpiresAt: new Date(NOW).toISOString() }))).toEqual({ refused: 'AUTHORIZATION_ENDED' });
    expect(await refresher.refresh(secretOf({ refreshToken: undefined }))).toEqual({ refused: 'NO_REFRESH_TOKEN' });
    expect(await refresher.refresh(secretOf({ refreshToken: 'has space' }))).toEqual({ refused: 'NO_REFRESH_TOKEN' });
    expect(await refresher.refresh('not json')).toEqual({ refused: 'BAD_SECRET' });
    expect(await refresher.refresh('[1]')).toEqual({ refused: 'BAD_SECRET' });
    expect(await refresher.refresh(secretOf({ appSecret: undefined }))).toEqual({ refused: 'BAD_SECRET' });
    expect(fake.calls).toHaveLength(0);
  });

  it('does not rotate the pair at every sweep: a connection renewed less than six hours ago is not asked', async () => {
    const { refresher, fake } = setup();
    expect(await refresher.refresh(secretOf({ refreshedAt: new Date(NOW - HOUR).toISOString() }))).toEqual({ failed: 'RECENT' });
    expect(fake.calls).toHaveLength(0);
    expect(await refresher.refresh(secretOf({ refreshedAt: new Date(NOW - 7 * HOUR).toISOString() }))).toHaveProperty('secret');
    expect(fake.calls).toHaveLength(1);
  });

  it('renews at once a connection whose stored access token has already expired, whatever the gap says', async () => {
    const { refresher, fake } = setup();
    const result = await refresher.refresh(secretOf({ refreshedAt: new Date(NOW - HOUR).toISOString(), accessExpiresAt: new Date(NOW - 1000).toISOString() }));
    expect(result).toHaveProperty('secret');
    expect(fake.calls).toHaveLength(1);
    // Not yet expired: the gap still holds.
    expect(await refresher.refresh(secretOf({ refreshedAt: new Date(NOW - HOUR).toISOString(), accessExpiresAt: new Date(NOW + HOUR).toISOString() }))).toEqual({ failed: 'RECENT' });
  });

  it('treats every trouble as a failure (no refusal code is documented), and never repeats a call whose answer was lost', async () => {
    const odd = async (response: Response) => setup({ fetch: async () => response }).refresher.refresh(secretOf());
    expect(await odd(json({ code: 99999, message: PLANTED }))).toEqual({ failed: '99999' });
    expect(await odd(json({ code: 36004004, message: PLANTED }))).toEqual({ failed: '36004004' });
    expect(await odd(json({ code: 'bad code!' }))).toEqual({ failed: 'UNKNOWN' });
    expect(await odd(json({ code: 'TTP_secret-looking-token' }))).toEqual({ failed: 'UNKNOWN' });
    expect(await odd(json({}, 401))).toEqual({ failed: 'HTTP_401' });
    expect(await odd(json({}, 429))).toEqual({ failed: '429' });
    expect(await odd(new Response('down', { status: 502 }))).toEqual({ failed: '502' });
    expect(await odd(new Response('<html></html>'))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(json({ code: 0, data: { access_token: 'TTP_a' } }))).toEqual({ failed: 'BAD_ANSWER' });
    let calls = 0;
    const lost = setup({
      fetch: async (url) => {
        calls += 1;
        throw new Error(`connect ECONNRESET ${url}`);
      },
    });
    const result = await lost.refresher.refresh(secretOf());
    expect(result).toEqual({ failed: 'NETWORK' });
    expect(calls).toBe(1);
  });

  it('does not ask again within six hours after a verdict it cannot read as a refusal (the gap runs from the last success, so this is what stops a call at every sweep), and asks at once again after a network trouble', async () => {
    let clock = NOW;
    let calls = 0;
    let answer: 'verdict' | 'unreadable' | 'network' = 'verdict';
    const fetchImpl = hostBoundFetch(TIKTOK_TOKEN_HOSTS, async (url) => {
      calls += 1;
      if (answer === 'network') throw new Error(`boom ${url}`);
      return answer === 'verdict' ? json({ code: 99999, message: PLANTED }) : json({ code: 0, data: {} });
    });
    const refresher = new TiktokRefresher({ fetch: fetchImpl, now: () => new Date(clock) });
    // A verdict: asked once, then held back for six hours (every ten-minute sweep in between is a `RECENT` failure with no call).
    expect(await refresher.refresh(secretOf())).toEqual({ failed: '99999' });
    for (let sweep = 1; sweep <= 35; sweep += 1) {
      clock = NOW + sweep * 10 * 60_000;
      expect(await refresher.refresh(secretOf())).toEqual({ failed: 'RECENT' });
    }
    expect(calls).toBe(1);
    clock = NOW + 6 * HOUR + 60_000;
    expect(await refresher.refresh(secretOf())).toEqual({ failed: '99999' });
    expect(calls).toBe(2);
    // The hold is for that refresh token: a connection with another one is asked at once.
    expect(await refresher.refresh(secretOf({ refreshToken: 'TTP_R9' }))).toEqual({ failed: '99999' });
    expect(calls).toBe(3);
    // A success it cannot read is a verdict too.
    answer = 'unreadable';
    expect(await refresher.refresh(secretOf({ refreshToken: 'TTP_R8' }))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await refresher.refresh(secretOf({ refreshToken: 'TTP_R8' }))).toEqual({ failed: 'RECENT' });
    expect(calls).toBe(4);
    // A network trouble is not a verdict: the next sweep asks again.
    answer = 'network';
    expect(await refresher.refresh(secretOf({ refreshToken: 'TTP_R7' }))).toEqual({ failed: 'NETWORK' });
    expect(await refresher.refresh(secretOf({ refreshToken: 'TTP_R7' }))).toEqual({ failed: 'NETWORK' });
    expect(calls).toBe(6);
  });

  it('puts no secret, token, code, address or TikTok sentence in any result', async () => {
    const results = [
      await setup({ fetch: async () => json({ code: 99999, message: PLANTED }) }).refresher.refresh(secretOf()),
      await setup({ fetch: async (url) => Promise.reject(new Error(`boom ${url} ${PLANTED}`)) }).refresher.refresh(secretOf()),
      await setup({ fetch: async () => new Response(`${PLANTED} ${APP.appSecret}`, { status: 200 }) }).refresher.refresh(secretOf()),
      await setup().refresher.refresh(secretOf({ refreshExpiresAt: new Date(NOW - 1).toISOString() })),
      await setup({ appSecret: 'another-secret' }).refresher.refresh(secretOf()),
    ];
    for (const result of results) expect(leaks(result)).toEqual([]);
  });

  it('is the marketplace provider of tiktok_shop, renewing a day ahead', () => {
    const { refresher } = setup();
    expect(refresher.provider).toBe('marketplace_tiktok_shop');
    expect(refresher.horizonSeconds).toBe(TIKTOK_REFRESH_HORIZON_SECONDS);
    // The sweep's scan caps the window at seven days, and an access token lives seven.
    expect(TIKTOK_REFRESH_HORIZON_SECONDS).toBeLessThanOrEqual(7 * 86_400);
  });
});

describe('where it is wired and what it may reach', () => {
  const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'ludy-auth', WEB_DIST: '/nonexistent' };

  it('is registered under the marketplace provider only where MARKETPLACE_PROVIDERS names tiktok_shop', () => {
    const named = channelRefreshers(loadConfig({ ...BASE, MARKETPLACE_PROVIDERS: 'sandbox, tiktok_shop' }));
    expect(named.marketplace_tiktok_shop).toBeInstanceOf(TiktokRefresher);
    expect(named.marketplace_tiktok_shop?.provider).toBe('marketplace_tiktok_shop');
    expect(channelRefreshers(loadConfig({ ...BASE, MARKETPLACE_PROVIDERS: 'sandbox' })).marketplace_tiktok_shop).toBeUndefined();
    expect(channelRefreshers(loadConfig({ ...BASE, MARKETPLACE_PROVIDERS: '' })).marketplace_tiktok_shop).toBeUndefined();
    expect(channelRefreshers(loadConfig({ ...BASE, MARKETPLACE_PROVIDERS: 'lazada' })).marketplace_tiktok_shop).toBeUndefined();
  });

  it('reaches only the one token host, through the fetch it is given, from one request site, with GET alone and no access token', () => {
    expect(TIKTOK_TOKEN_HOSTS).toEqual(['auth.tiktok-shops.com']);
    const source = readFileSync(new URL('../src/marketplace-tiktok-token.ts', import.meta.url), 'utf8');
    const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    expect([...code.matchAll(/\bfetchImpl\s*\(/g)]).toHaveLength(1);
    expect(code).not.toMatch(/\bglobalThis\.fetch\b|[^.\w]fetch\(|node:https?|undici|XMLHttpRequest|WebSocket/);
    // The only address in the code is built once, in getToken, from the host constant and a path constant.
    expect([...code.matchAll(/https?:\/\//g)]).toHaveLength(1);
    expect([...code.matchAll(/https:\/\/\S+?\?/g)].map((m) => m[0])).toEqual(['https://${TIKTOK_AUTH_HOST}${path}?']);
    expect([...code.matchAll(/\bmethod:\s*'([A-Z]+)'/g)].map((m) => m[1])).toEqual(['GET']);
    expect([...code.matchAll(/getToken\(\s*[^,]+,\s*(\w+),/g)].map((m) => m[1]).sort()).toEqual(['GET_PATH', 'REFRESH_PATH']);
    expect([...code.matchAll(/const (\w+_PATH) = '([^']+)'/g)].map((m) => [m[1], m[2]])).toEqual([['GET_PATH', '/api/v2/token/get'], ['REFRESH_PATH', '/api/v2/token/refresh']]);
    // Nothing is logged, and an error object or an address is never stored or returned.
    expect(code).not.toMatch(/console\.|logger|x-tts-access-token/);
    expect(code).not.toMatch(/failed:\s*(error|e|err)\b|\.message\b/);
  });

  it('is refused by the host-bound fetch for any other host or a plain http address (the allow-list, not the code, is the wall)', async () => {
    const bound = hostBoundFetch(TIKTOK_TOKEN_HOSTS, async () => json({}));
    await expect(bound('https://open-api.tiktokglobalshop.com/authorization/202309/shops')).rejects.toBeInstanceOf(Error);
    await expect(bound('http://auth.tiktok-shops.com/api/v2/token/get')).rejects.toBeInstanceOf(Error);
    await expect(bound('https://auth.tiktok-shops.com/api/v2/token/get')).resolves.toBeInstanceOf(Response);
  });
});
