// SPDX-License-Identifier: AGPL-3.0-only
// The Shopee signer and token API (#2524, S1 = #4274) against a made-up Shopee: the signature against vectors computed by an independent tool (openssl), the authorization code traded for a pair, and a connection's
// tokens renewed. THE REFRESH TOKEN ROTATES AND WORKS ONCE: the answer's pair replaces the old one whole, a second refresh with the spent token is refused by the platform, and one call is made to one host and never
// repeated. A refresh is refused only locally, by the dates (no refresh-token word is documented, so none is invented); every other trouble is a failure. And no key, code, token, address or Shopee sentence ever
// reaches a result. The sweep itself (one at a time, ifVersion, expired is not picked again) is tested in channel-refresh.db.test.ts for the refresher interface.
import { describe, expect, it } from 'vitest';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { parseShopeeSecret } from '../src/marketplace-shopee.ts';
import { signShopeeRequest } from '../src/marketplace-shopee-sign.ts';
import { SHOPEE_API_HOST, SHOPEE_REFRESH_HORIZON_SECONDS, SHOPEE_TOKEN_HOSTS, ShopeeRefresher, createShopeeToken } from '../src/marketplace-shopee-token.ts';
import { fakeShopee, type FakeShopeeOptions } from './fake-shopee.ts';

const NOW = Date.parse('2026-11-21T08:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const PARTNER = { partnerId: '1000012', partnerKey: 'test-only-partner-key' };
const SHOP = '77777';
const PLANTED = 'planted-sentence-sk-live-12345';

const secretOf = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...PARTNER,
    shopId: SHOP,
    accessToken: 'old-access',
    refreshToken: 'SHP_R0',
    accessExpiresAt: new Date(NOW + HOUR / 4).toISOString(),
    refreshExpiresAt: new Date(NOW + 20 * DAY).toISOString(),
    refreshedAt: new Date(NOW - 3 * HOUR).toISOString(),
    authorizationEndsAt: new Date(NOW + 200 * DAY).toISOString(),
    ...over,
  });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(over: Partial<FakeShopeeOptions> & { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const { fetch: custom, ...rest } = over;
  const fake = fakeShopee({ ...PARTNER, shopId: SHOP, accessToken: 'SHP_access', codes: ['CODE1', 'CODE2'], refreshToken: 'SHP_R0', now: () => NOW, ...rest });
  const options = { fetch: hostBoundFetch(SHOPEE_TOKEN_HOSTS, custom ?? fake.fetch), now: () => new Date(NOW) };
  return { fake, options, refresher: new ShopeeRefresher(options), create: (code: string) => createShopeeToken(options, { ...PARTNER, shopId: SHOP, code }) };
}

// Everything a result could leak, in one text.
const leaks = (result: unknown): string[] => {
  const text = JSON.stringify(result);
  return [PARTNER.partnerKey, 'SHP_R0', 'CODE1', 'old-access', PLANTED, SHOPEE_API_HOST, 'sign='].filter((word) => text.includes(word));
};

describe('signShopeeRequest', () => {
  it('matches vectors computed by openssl: a shop call signs the token and the shop, a public or token call does not', () => {
    expect(signShopeeRequest('test-only-partner-key', '1000012', '/api/v2/order/get_order_list', 1_795_000_000, { accessToken: 'tok_abc', shopId: '77777' })).toBe('964f2e66b2cd5add1103ae4cf6f0f60025b238d7458752ba7ebbca399d2f9d80');
    expect(signShopeeRequest('test-only-partner-key', '1000012', '/api/v2/auth/token/get', 1_795_000_000)).toBe('440b72edae0a3fc4f55597db14a11ba0c6c1deed997c7c133f6e72192e0dff4e');
  });
});

describe('createShopeeToken', () => {
  it('trades the code for the pair, with the life the answer gives, and seals the dates', async () => {
    const { create, fake } = setup();
    const grant = await create('CODE1');
    if (!('secret' in grant)) throw new Error('no grant');
    expect(grant.accessExpiresAt.getTime()).toBe(NOW + 4 * HOUR);
    expect(grant.refreshExpiresAt.getTime()).toBe(NOW + 30 * DAY);
    const sealed = JSON.parse(grant.secret) as Record<string, unknown>;
    expect(sealed).toMatchObject({ ...PARTNER, shopId: SHOP, accessToken: 'SHP_access_1', refreshToken: 'SHP_R1', refreshedAt: new Date(NOW).toISOString() });
    // What the fake holds is what was sealed, and the adapter's own reader takes it.
    expect(fake.state()).toMatchObject({ accessToken: 'SHP_access_1', refreshToken: 'SHP_R1' });
    expect(parseShopeeSecret(grant.secret)).toMatchObject({ partnerId: PARTNER.partnerId, shopId: SHOP, accessToken: 'SHP_access_1' });
  });

  it('keeps the end of the seller\'s authorization it is given, and only that', async () => {
    const { options } = setup();
    const ends = new Date(NOW + 100 * DAY);
    const grant = await createShopeeToken(options, { ...PARTNER, shopId: SHOP, code: 'CODE1', authorizationEndsAt: ends });
    if (!('secret' in grant)) throw new Error('no grant');
    expect(JSON.parse(grant.secret)).toMatchObject({ authorizationEndsAt: ends.toISOString() });
  });

  it('is one signed POST to the one host with the signature in the address and the code in the body, no access token', async () => {
    const { create, fake } = setup();
    await create('CODE1');
    expect(fake.calls).toHaveLength(1);
    const sent = fake.calls[0]!;
    expect(sent).toMatchObject({ method: 'POST', host: SHOPEE_API_HOST, path: '/api/v2/auth/token/get' });
    expect(Object.keys(sent.query).sort()).toEqual(['partner_id', 'sign', 'timestamp']);
    expect(sent.query.timestamp).toBe(String(NOW / 1000));
    expect(JSON.parse(sent.body ?? '{}')).toEqual({ code: 'CODE1', shop_id: Number(SHOP), partner_id: Number(PARTNER.partnerId) });
    expect(sent.url).not.toContain(PARTNER.partnerKey);
  });

  it('fails (never refuses) a code Shopee turns down, with its word kept to a closed code, and asks no second time', async () => {
    const { create, fake } = setup();
    expect(await create('CODE1')).toHaveProperty('secret');
    expect(await create('CODE1')).toEqual({ failed: 'error_auth' });
    expect(await create('NOPE')).toEqual({ failed: 'error_auth' });
    expect(fake.calls).toHaveLength(3);
  });

  it('refuses a malformed input with no call', async () => {
    const { options, fake, create } = setup();
    expect(await create('has space')).toEqual({ refused: 'BAD_CODE' });
    expect(await create('')).toEqual({ refused: 'BAD_CODE' });
    expect(await createShopeeToken(options, { partnerId: 'abc', partnerKey: PARTNER.partnerKey, shopId: SHOP, code: 'CODE1' })).toEqual({ refused: 'BAD_SECRET' });
    expect(await createShopeeToken(options, { ...PARTNER, shopId: '0', code: 'CODE1' })).toEqual({ refused: 'BAD_SHOP' });
    expect(fake.calls).toHaveLength(0);
  });

  it('treats every other trouble as a failure and keeps every word of it to a closed code', async () => {
    const odd = async (response: Response) => createShopeeToken(setup({ fetch: async () => response }).options, { ...PARTNER, shopId: SHOP, code: 'CODE1' });
    expect(await odd(json({ error: 'error_server', message: PLANTED }))).toEqual({ failed: 'error_server' });
    // A word that is secret-shaped, token-shaped or a sentence is never passed on.
    expect(await odd(json({ error: 'SHP_secret-looking-token', message: PLANTED }))).toEqual({ failed: 'UNKNOWN' });
    expect(await odd(json({ error: PLANTED }))).toEqual({ failed: 'UNKNOWN' });
    expect(await odd(json({ error: 42 }))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(json({ message: PLANTED }, 400))).toEqual({ failed: 'HTTP_400' });
    expect(await odd(json({ error: '' }, 400))).toEqual({ failed: 'HTTP_400' });
    expect(await odd(json({}, 429))).toEqual({ failed: '429' });
    expect(await odd(new Response('down', { status: 503 }))).toEqual({ failed: '503' });
    expect(await odd(new Response('<html></html>', { status: 200 }))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(json([1, 2]))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(json({ error: '' }))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(json({ error: '', access_token: 'has space', refresh_token: 'ok' }))).toEqual({ failed: 'BAD_ANSWER' });
    expect(await odd(new Response('x'.repeat(70_000)))).toEqual({ failed: 'BAD_ANSWER' });
    const down = await createShopeeToken(setup({ fetch: async () => Promise.reject(new Error(`connect ECONNREFUSED ${PARTNER.partnerKey} ${PLANTED}`)) }).options, { ...PARTNER, shopId: SHOP, code: 'CODE1' });
    expect(down).toEqual({ failed: 'NETWORK' });
    for (const result of [down]) expect(leaks(result)).toEqual([]);
  });

  it('takes a life that is not plausible as one hour, so a good pair is not thrown away over a field', async () => {
    const odd = async (expireIn: unknown) => {
      const { options } = setup({ fetch: async () => json({ error: '', message: '', access_token: 'a1', refresh_token: 'r1', expire_in: expireIn }) });
      const grant = await createShopeeToken(options, { ...PARTNER, shopId: SHOP, code: 'CODE1' });
      if (!('secret' in grant)) throw new Error('no grant');
      return grant.accessExpiresAt.getTime() - NOW;
    };
    expect(await odd(-5)).toBe(HOUR);
    expect(await odd('14400')).toBe(HOUR);
    expect(await odd(10 ** 9)).toBe(HOUR);
    expect(await odd(7200)).toBe(2 * HOUR);
  });
});

describe('ShopeeRefresher', () => {
  it('renews with the single-use token, replaces the pair whole, and moves the access and the refresh token dates but not the authorization end', async () => {
    const { refresher, fake } = setup();
    const result = await refresher.refresh(secretOf());
    if (!('secret' in result)) throw new Error('no refresh');
    expect(result.expiresAt.getTime()).toBe(NOW + 4 * HOUR);
    const sealed = JSON.parse(result.secret) as Record<string, unknown>;
    expect(sealed).toMatchObject({
      ...PARTNER,
      shopId: SHOP,
      accessToken: 'SHP_access_1',
      refreshToken: 'SHP_R1',
      accessExpiresAt: new Date(NOW + 4 * HOUR).toISOString(),
      refreshExpiresAt: new Date(NOW + 30 * DAY).toISOString(),
      refreshedAt: new Date(NOW).toISOString(),
      authorizationEndsAt: new Date(NOW + 200 * DAY).toISOString(),
    });
    expect(fake.state()).toMatchObject({ accessToken: 'SHP_access_1', refreshToken: 'SHP_R1' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: 'POST', path: '/api/v2/auth/access_token/get' });
    expect(JSON.parse(fake.calls[0]!.body ?? '{}')).toEqual({ refresh_token: 'SHP_R0', shop_id: Number(SHOP), partner_id: Number(PARTNER.partnerId) });
  });

  it('is one call even when the answer is lost, and a second refresh with the spent token is a failure, never a refusal', async () => {
    const lost = setup({ fetch: async () => Promise.reject(new Error('socket hang up')) });
    expect(await lost.refresher.refresh(secretOf())).toEqual({ failed: 'NETWORK' });
    // The platform has the refresh token spent (the answer was lost after it was sent): the same token again is turned down, and the connection is not expired by it.
    const { refresher, fake } = setup();
    expect(await refresher.refresh(secretOf())).toHaveProperty('secret');
    expect(await refresher.refresh(secretOf())).toEqual({ failed: 'error_auth' });
    expect(fake.calls).toHaveLength(2);
  });

  it('does not ask again for 30 minutes after a verdict it cannot read as a refusal, and asks again after', async () => {
    let at = NOW;
    const fake = fakeShopee({ ...PARTNER, shopId: SHOP, accessToken: 'a', refreshToken: 'SHP_R0', now: () => at });
    const options = { fetch: hostBoundFetch(SHOPEE_TOKEN_HOSTS, fake.fetch), now: () => new Date(at) };
    const refresher = new ShopeeRefresher(options);
    const stale = secretOf({ refreshToken: 'SHP_STALE' });
    expect(await refresher.refresh(stale)).toEqual({ failed: 'error_auth' });
    expect(fake.calls).toHaveLength(1);
    at += 10 * 60_000;
    expect(await refresher.refresh(stale)).toEqual({ failed: 'RECENT' });
    expect(fake.calls).toHaveLength(1);
    at += 30 * 60_000;
    expect(await refresher.refresh(stale)).toEqual({ failed: 'error_auth' });
    expect(fake.calls).toHaveLength(2);
  });

  it('refuses locally, with no call, an authorization that has ended, a refresh token past its 30 days, a missing token and a malformed secret', async () => {
    const { refresher, fake } = setup();
    expect(await refresher.refresh(secretOf({ authorizationEndsAt: new Date(NOW - 1000).toISOString() }))).toEqual({ refused: 'AUTHORIZATION_ENDED' });
    expect(await refresher.refresh(secretOf({ refreshExpiresAt: new Date(NOW - 1000).toISOString() }))).toEqual({ refused: 'REFRESH_TOKEN_EXPIRED' });
    expect(await refresher.refresh(secretOf({ refreshToken: undefined }))).toEqual({ refused: 'NO_REFRESH_TOKEN' });
    expect(await refresher.refresh('not json')).toEqual({ refused: 'BAD_SECRET' });
    expect(await refresher.refresh(JSON.stringify({ partnerId: 'x' }))).toEqual({ refused: 'BAD_SECRET' });
    expect(await refresher.refresh(secretOf({ shopId: '0' }))).toEqual({ refused: 'BAD_SECRET' });
    expect(fake.calls).toHaveLength(0);
  });

  it('a stale access token still works for five minutes after a refresh and not after', async () => {
    let at = NOW;
    const fake = fakeShopee({ ...PARTNER, shopId: SHOP, accessToken: 'old-access', refreshToken: 'SHP_R0', now: () => at });
    const refresher = new ShopeeRefresher({ fetch: hostBoundFetch(SHOPEE_TOKEN_HOSTS, fake.fetch), now: () => new Date(at) });
    await refresher.refresh(secretOf());
    const shopCall = async () => {
      const timestamp = String(Math.floor(at / 1000));
      const sign = signShopeeRequest(PARTNER.partnerKey, PARTNER.partnerId, '/api/v2/shop/get_shop_info', Number(timestamp), { accessToken: 'old-access', shopId: SHOP });
      const url = `https://${SHOPEE_API_HOST}/api/v2/shop/get_shop_info?${new URLSearchParams({ partner_id: PARTNER.partnerId, timestamp, access_token: 'old-access', shop_id: SHOP, sign })}`;
      return ((await (await fake.fetch(url)).json()) as { error: string }).error;
    };
    at += 4 * 60_000;
    expect(await shopCall()).toBe('');
    at += 2 * 60_000;
    expect(await shopCall()).toBe('error_auth');
  });

  it('names its provider, renews 30 minutes ahead, and never puts a key, code, token or address in a result', async () => {
    const { refresher } = setup();
    expect(refresher.provider).toBe('marketplace_shopee');
    expect(refresher.horizonSeconds).toBe(SHOPEE_REFRESH_HORIZON_SECONDS);
    expect(SHOPEE_REFRESH_HORIZON_SECONDS).toBe(1800);
    const wrongKey = await setup({ partnerKey: 'another-key' }).refresher.refresh(secretOf());
    const hostile = await setup({ fetch: async () => json({ error: PLANTED, message: PLANTED }) }).refresher.refresh(secretOf());
    const thrown = await setup({ fetch: async () => Promise.reject(new Error(`${PARTNER.partnerKey} ${PLANTED}`)) }).refresher.refresh(secretOf());
    const grant = await createShopeeToken(setup().options, { ...PARTNER, shopId: SHOP, code: 'CODE1' });
    expect(wrongKey).toEqual({ failed: 'error_auth' });
    for (const result of [wrongKey, hostile, thrown]) expect(leaks(result)).toEqual([]);
    // A success carries the new secret, which holds the key and the token by design: those are the sealed secret, never a message.
    expect(grant).toHaveProperty('secret');
  });
});
