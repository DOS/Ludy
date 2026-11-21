// SPDX-License-Identifier: AGPL-3.0-only
// The seller's authorization of a TikTok Shop connection (#4269): the address of TikTok's consent page (the app's Service ID, no secret), the trade of the one-time code for the pair through the made-up TikTok
// servers, and the choice of the shop (exactly one is kept; none or several fails in words). Nothing the seller typed, no token and no code reaches an address or a result.
import { describe, expect, it } from 'vitest';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { TIKTOK_HOSTS, parseTiktokSecret, tiktokCaller } from '../src/marketplace-tiktok.ts';
import { tiktokMarketplace } from '../src/marketplace-tiktok-orders.ts';
import { TIKTOK_AUTHORIZE_HOST, isTiktokAwaitingAuthorization, tiktokAuthorizeUrl, withTiktokAuthorize } from '../src/marketplace-tiktok-authorize.ts';
import { TIKTOK_TOKEN_HOSTS } from '../src/marketplace-tiktok-token.ts';
import { fakeShop, fakeTiktok, type FakeTiktokOptions } from './fake-tiktok.ts';

const NOW = Date.parse('2026-11-21T03:00:00Z');
const APP = { appKey: '123abc', appSecret: 'test-only-app-secret' };
const TYPED = JSON.stringify({ ...APP, serviceId: '7000000000001' });

function setup(over: Partial<FakeTiktokOptions> = {}) {
  const fake = fakeTiktok({ ...APP, accessToken: 'TTP_access', codes: ['CODE1', 'CODE2'], refreshToken: 'TTP_R0', shops: [fakeShop()], now: () => NOW, ...over });
  const options = { fetch: hostBoundFetch(TIKTOK_HOSTS, fake.fetch), now: () => new Date(NOW), sleep: async () => undefined };
  const caller = tiktokCaller(options);
  const provider = withTiktokAuthorize(tiktokMarketplace(options, caller), { tokenFetch: hostBoundFetch(TIKTOK_TOKEN_HOSTS, fake.fetch), caller, now: () => new Date(NOW) });
  return { fake, provider };
}

// Everything a result could leak, in one text.
const leaks = (result: unknown): string[] => [APP.appSecret, 'CODE1', 'app_secret', 'auth.tiktok-shops.com'].filter((word) => JSON.stringify(result).includes(word));

describe('the address of TikTok\'s consent page', () => {
  it('is on the services host with the Service ID and the state, and nothing secret', () => {
    const url = new URL(tiktokAuthorizeUrl({ appKey: '7000000000001', redirectUri: 'https://app.example.test/marketplace/oauth/tiktok_shop/callback', state: 'STATE-VALUE' }));
    expect(url.origin).toBe(`https://${TIKTOK_AUTHORIZE_HOST}`);
    expect(url.pathname).toBe('/open/authorize');
    // The return address is registered on the app in Partner Center, so it is not sent.
    expect(Object.fromEntries(url.searchParams)).toEqual({ service_id: '7000000000001', state: 'STATE-VALUE' });
    // A value with characters of a query is encoded, never split into another parameter.
    expect(new URL(tiktokAuthorizeUrl({ appKey: 'a&state=evil', redirectUri: 'x', state: 's' })).searchParams.get('state')).toBe('s');
  });

  it('is added to the provider with the Service ID as a connect field and as the public id, and the rest of the provider stays', () => {
    const { provider } = setup();
    expect(provider.id).toBe('tiktok_shop');
    expect(provider.connectFields).toEqual(['appKey', 'appSecret', 'serviceId']);
    expect(provider.authorizePublicField).toBe('serviceId');
    expect(provider.authorizeUrl).toBe(tiktokAuthorizeUrl);
    expect(typeof provider.authorize).toBe('function');
    expect(provider.hosts).toEqual([...TIKTOK_HOSTS]);
  });
});

describe('a connection nobody has authorized yet', () => {
  it('reads "not authorized yet" without a call, and a refused token as refused', async () => {
    const { provider, fake } = setup();
    expect(await provider.testConnection(TYPED)).toBe('api_not_enabled');
    expect(fake.calls).toHaveLength(0);
    expect(isTiktokAwaitingAuthorization(TYPED)).toBe(true);
    expect(isTiktokAwaitingAuthorization(JSON.stringify({ ...APP, accessToken: 'x' }))).toBe(false);
    expect(isTiktokAwaitingAuthorization('garbage')).toBe(false);
    expect(isTiktokAwaitingAuthorization(JSON.stringify({ appKey: 'a b', appSecret: 'x' }))).toBe(false);
    // A token that TikTok does not accept is not "not authorized yet".
    expect(await provider.testConnection(JSON.stringify({ ...APP, accessToken: 'bad-token' }))).toBe('wrong_credentials');
  });
});

describe('the trade of the code and the choice of the shop', () => {
  it('stores the pair with the one shop\'s cipher and id and the Service ID, and the provider reads it back', async () => {
    const { provider, fake } = setup();
    const result = await provider.authorize!(TYPED, 'CODE1');
    if (!('granted' in result)) throw new Error(`not granted: ${JSON.stringify(result)}`);
    expect(result.granted.accessExpiresAt.getTime()).toBe(NOW + 7 * 86_400_000);
    expect(result.granted.refreshExpiresAt).not.toBeNull();
    const sealed = JSON.parse(result.granted.secret) as Record<string, unknown>;
    expect(sealed).toMatchObject({ ...APP, serviceId: '7000000000001', shopCipher: fakeShop().cipher, shopId: fakeShop().id });
    expect(typeof sealed.accessToken).toBe('string');
    expect(typeof sealed.refreshToken).toBe('string');
    expect(parseTiktokSecret(result.granted.secret)).toMatchObject({ shopCipher: fakeShop().cipher, shopId: fakeShop().id });
    // The same secret then passes the test and the seller's name is nowhere in it.
    expect(await provider.testConnection(result.granted.secret)).toBe('works');
    expect(result.granted.secret).not.toContain('Nguyễn');
    // The code went to the token host, once; the shop list went to the API host with the new token.
    expect(fake.calls.filter((c) => c.path === '/api/v2/token/get')).toHaveLength(1);
    expect(fake.calls.some((c) => c.host === 'open-api.tiktokglobalshop.com' && c.path.includes('/shops'))).toBe(true);
  });

  it('fails in words, storing nothing, for no shop and for several shops, and keeps no text', async () => {
    const none = setup({ shops: [] });
    expect(await none.provider.authorize!(TYPED, 'CODE1')).toEqual({ failed: 'NO_SHOP' });
    const many = setup({ shops: [fakeShop(), fakeShop({ id: '7000714532876273999', cipher: 'GCP_other', name: 'Cửa hàng thứ hai', code: 'VNLCBB5MMV9' })] });
    const result = await many.provider.authorize!(TYPED, 'CODE1');
    expect(result).toEqual({ failed: 'MANY_SHOPS' });
    expect(leaks(result)).toEqual([]);
  });

  it('keeps only a Vietnam shop with a local seller: a cross-border shop or another region fails in words, with nothing stored', async () => {
    for (const over of [{ sellerType: 'CROSS_BORDER' as const }, { region: 'TH' }]) {
      const { provider } = setup({ shops: [fakeShop(over)] });
      const result = await provider.authorize!(TYPED, 'CODE1');
      expect(result).toEqual({ failed: 'NOT_LOCAL_SHOP' });
      expect(leaks(result)).toEqual([]);
    }
  });

  it('says `failed` when the shop list cannot be read, and refused for a code TikTok does not accept (used, or not a seller\'s)', async () => {
    const down = setup({ intercept: (host, path) => (host === 'open-api.tiktokglobalshop.com' && path.includes('/shops') ? new Response('down', { status: 503 }) : undefined) });
    const downResult = await down.provider.authorize!(TYPED, 'CODE1');
    expect(downResult).toEqual({ failed: 'SHOPS' });
    expect(leaks(downResult)).toEqual([]);
    const { provider } = setup();
    const refusedResult = await provider.authorize!(TYPED, 'NOT-A-CODE');
    expect(refusedResult).toMatchObject({ refused: expect.any(String) });
    expect(leaks(refusedResult)).toEqual([]);
    const creator = setup({ userType: 1 });
    expect(await creator.provider.authorize!(TYPED, 'CODE1')).toMatchObject({ refused: expect.any(String) });
  });

  it('refuses a secret that is not the seller\'s keys without calling TikTok', async () => {
    const { provider, fake } = setup();
    for (const bad of ['garbage', '{}', JSON.stringify({ appKey: 1, appSecret: 2 }), JSON.stringify({ appKey: 'a b', appSecret: 'x' })]) {
      expect(await provider.authorize!(bad, 'CODE1')).toEqual({ refused: 'BAD_SECRET' });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('a seller whose typed secret has no Service ID still authorizes (the Service ID only builds the address)', async () => {
    const { provider } = setup();
    const result = await provider.authorize!(JSON.stringify(APP), 'CODE1');
    expect(result).toMatchObject({ granted: expect.any(Object) });
  });
});
