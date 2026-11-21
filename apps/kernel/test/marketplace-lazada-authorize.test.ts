// SPDX-License-Identifier: AGPL-3.0-only
// The seller's authorization of a Lazada connection (#4238, S2b): the address of Lazada's consent page (built by the API from the public App Key, no secret involved) and the trade of the one-time code (the
// worker's, with the seller's own secret) through the made-up Lazada token API. The provider keeps its other methods, and no token or code reaches a result or the address.
import { describe, expect, it } from 'vitest';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { lazadaMarketplace } from '../src/marketplace-lazada.ts';
import { lazadaAuthorizeUrl, withLazadaAuthorize } from '../src/marketplace-lazada-authorize.ts';
import { LAZADA_TOKEN_HOSTS } from '../src/marketplace-lazada-token.ts';
import { fakeLazadaToken } from './fake-lazada-token.ts';

const NOW = Date.parse('2026-11-21T03:00:00Z');
const APP = { appKey: '123456', appSecret: 'test-only-app-secret' };
const SECRET = JSON.stringify(APP);

function setup(codes: readonly string[] = ['auth-code-1']) {
  const fake = fakeLazadaToken({ ...APP, refreshToken: 'refresh-token-0', refreshExpiresAtMs: NOW + 150 * 86_400_000, codes, now: () => NOW });
  const orders = lazadaMarketplace({ fetch: hostBoundFetch(['api.lazada.vn']), now: () => new Date(NOW) });
  const provider = withLazadaAuthorize(orders, { tokenFetch: hostBoundFetch(LAZADA_TOKEN_HOSTS, fake.fetch), now: () => new Date(NOW) });
  return { fake, provider };
}

describe('the address of Lazada\'s consent page', () => {
  it('is on the authorization host with the App Key as client_id, the return address and the state, and nothing secret', () => {
    const url = new URL(lazadaAuthorizeUrl({ appKey: '123456', redirectUri: 'https://app.example.test/marketplace/oauth/lazada/callback', state: 'STATE-VALUE' }));
    expect(url.origin).toBe('https://auth.lazada.com');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', force_auth: 'true', redirect_uri: 'https://app.example.test/marketplace/oauth/lazada/callback', client_id: '123456', state: 'STATE-VALUE' });
  });

  it('is added to the provider without changing the rest of it', () => {
    const { provider } = setup();
    expect(provider.authorizeUrl).toBe(lazadaAuthorizeUrl);
    expect(typeof provider.authorize).toBe('function');
    expect(provider.id).toBe('lazada');
    expect(provider.connectFields).toEqual(['appKey', 'appSecret']);
  });
});

describe('the trade of the code', () => {
  it('gives the new sealed secret and the dates for a good code, once', async () => {
    const { provider, fake } = setup();
    const result = await provider.authorize!(SECRET, 'auth-code-1');
    expect(result).toMatchObject({ granted: { accessExpiresAt: new Date(NOW + 2_592_000_000) } });
    if (!('granted' in result)) throw new Error('not granted');
    expect(JSON.parse(result.granted.secret)).toMatchObject({ appKey: '123456', appSecret: APP.appSecret, accessToken: expect.any(String), refreshToken: expect.any(String) });
    expect(result.granted.refreshExpiresAt).toEqual(new Date(NOW + 150 * 86_400_000));
    // The seller who authorized (a short id of Lazada's answer, never a name or an e-mail) goes to the command that refuses a different seller (#4285); the secret keeps it beside the tokens for the next authorization.
    expect(result.granted.sellerRef).toBe('1000100');
    expect(JSON.parse(result.granted.secret).sellerId).toBe('1000100');
    // One call, to the token host; the code goes in the form body, not in the address.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.host).toBe('auth.lazada.com');
    expect(fake.calls[0]?.url).not.toContain('auth-code-1');
    // A code works once: the same one again is refused, never repeated by the provider itself.
    expect(await provider.authorize!(SECRET, 'auth-code-1')).toMatchObject({ refused: expect.any(String) });
    expect(fake.calls).toHaveLength(2);
  });

  it('refuses a secret that is not the seller\'s keys, without calling Lazada, and keeps no text', async () => {
    const { provider, fake } = setup();
    for (const bad of ['garbage', '{}', JSON.stringify({ appKey: 1, appSecret: 2 }), JSON.stringify({ appKey: 'a b', appSecret: 'x' })]) {
      expect(await provider.authorize!(bad, 'auth-code-1')).toEqual({ refused: 'BAD_SECRET' });
    }
    expect(fake.calls).toHaveLength(0);
    expect(await provider.authorize!(SECRET, 'bad code')).toEqual({ refused: 'BAD_CODE' });
  });
});
