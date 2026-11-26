// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { REDIRECT_URI } from '../src/config.ts';
import { completeSignIn, endpointsFromConfig, jwtClaims, parseCallback, refreshTokens, SIGN_IN_MAX_AGE_MS, startSignIn, type PendingSignIn } from '../src/auth/oauth.ts';
import { pkceChallenge } from '../src/auth/pkce.ts';
import { accessToken, callbackFor, CLIENT_ID, counterCrypto, ENDPOINTS, jsonResponse, scriptedFetch, tokenResponse } from './helpers.ts';

const NOW = 1_800_000_000_000;
const exp = (offsetSeconds: number) => Math.floor(NOW / 1000) + offsetSeconds;

async function started() {
  return startSignIn(ENDPOINTS, { crypto: counterCrypto(), now: () => NOW });
}

describe('startSignIn', () => {
  it('builds an authorization code request with PKCE S256, state, this client and the exact redirect URI', async () => {
    const { url, pending } = await started();
    const target = new URL(url);
    expect(`${target.origin}${target.pathname}`).toBe(ENDPOINTS.authorizeUrl);
    const p = target.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe(pending.state);
    expect(p.get('code_challenge')).toBe(await pkceChallenge(counterCrypto(), pending.verifier));
    expect(p.get('client_secret')).toBeNull();
    expect(pending.state).not.toBe(pending.verifier);
    expect(url).not.toContain(pending.verifier);
  });

  it('drops anything already in the authorize endpoint address', async () => {
    const { url } = await startSignIn({ ...ENDPOINTS, authorizeUrl: `${ENDPOINTS.authorizeUrl}?redirect_uri=https://evil.example&state=x#frag` }, { crypto: counterCrypto(), now: () => NOW });
    expect(new URL(url).searchParams.getAll('redirect_uri')).toEqual([REDIRECT_URI]);
    expect(new URL(url).hash).toBe('');
  });
});

describe('parseCallback', () => {
  it('reads code and state from the exact redirect URI only', () => {
    expect(parseCallback(`${REDIRECT_URI}?code=abc&state=xyz`)).toEqual({ code: 'abc', state: 'xyz', denied: false });
    expect(parseCallback(`${REDIRECT_URI}?error=access_denied&state=xyz`)?.denied).toBe(true);
    for (const other of [
      'vn.ludy.app://oauth-login/callbackx?code=a',
      'vn.ludy.app://oauth-login/callback/?code=a',
      'vn.ludy.app://other/callback?code=a',
      'vn.ludy.app:/oauth-login/callback?code=a',
      'VN.LUDY.APP://oauth-login/callback?code=a',
      'evil.app://oauth-login/callback?code=a',
      'https://oauth-login/callback?code=a',
      ` ${REDIRECT_URI}?code=a`,
    ]) {
      expect(parseCallback(other)).toBeNull();
    }
  });

  it('refuses a parameter named twice and undecodable text', () => {
    expect(parseCallback(`${REDIRECT_URI}?code=a&code=b&state=s`)).toEqual({ code: null, state: null, denied: false });
    expect(parseCallback(`${REDIRECT_URI}?code=%E0%A4%A&state=s`)).toEqual({ code: null, state: null, denied: false });
  });
});

describe('completeSignIn', () => {
  const ok = () => tokenResponse({ access: accessToken({ expSeconds: exp(3600) }), refresh: 'refresh-1' });

  it('redeems the code once at the token endpoint with the verifier, the exact redirect URI and the client id, and nothing else', async () => {
    const { url, pending } = await started();
    const { fn, calls } = scriptedFetch({ [ENDPOINTS.tokenUrl]: [ok()] });
    const result = await completeSignIn(callbackFor(url), pending, ENDPOINTS, { fetchFn: fn, now: () => NOW + 5000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tokens.refreshToken).toBe('refresh-1');
    expect(result.tokens.expiresAt).toBe(exp(3600) * 1000);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(ENDPOINTS.tokenUrl);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.credentials).toBe('omit');
    expect(call?.init.cache).toBe('no-store');
    expect(call?.init.redirect).toBe('error');
    const body = new URLSearchParams(String(call?.init.body));
    expect(Object.fromEntries(body)).toEqual({ grant_type: 'authorization_code', code: 'one-time-code-0123456789abcdef', code_verifier: pending.verifier, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID });
  });

  const refuse = async (callback: (url: string) => string, expected: string, pendingOverride?: (p: PendingSignIn) => PendingSignIn | null, now = NOW) => {
    const { url, pending } = await started();
    const { fn, calls } = scriptedFetch({ [ENDPOINTS.tokenUrl]: [ok()] });
    const result = await completeSignIn(callback(url), pendingOverride ? pendingOverride(pending) : pending, ENDPOINTS, { fetchFn: fn, now: () => now });
    expect(result).toEqual({ ok: false, reason: expected });
    // A refused callback never reaches the token endpoint.
    if (expected !== 'exchange' && expected !== 'response') expect(calls).toHaveLength(0);
  };

  it('refuses a wrong, missing or altered state', async () => {
    await refuse((url) => callbackFor(url, { state: 'A'.repeat(43) }), 'state');
    await refuse((url) => callbackFor(url).replace(/state=[^&]*/, ''), 'state');
    await refuse((url) => callbackFor(url).replace(/state=([^&]*)/, 'state=$1x'), 'state');
  });

  it('refuses a callback at any other address', async () => {
    await refuse((url) => callbackFor(url).replace('oauth-login', 'elsewhere'), 'redirect');
    await refuse((url) => callbackFor(url).replace('vn.ludy.app', 'evil.app'), 'redirect');
  });

  it('refuses a denied or code-less callback', async () => {
    await refuse((url) => `${REDIRECT_URI}?error=access_denied&state=${new URL(url).searchParams.get('state')}`, 'denied');
    await refuse((url) => callbackFor(url, { code: 'short' }), 'code');
    await refuse((url) => callbackFor(url).replace(/code=[^&]*&/, ''), 'code');
  });

  it('refuses when no sign-in is pending (a replayed callback) or the sign-in is too old', async () => {
    await refuse((url) => callbackFor(url), 'missing', () => null);
    await refuse((url) => callbackFor(url), 'expired', undefined, NOW + SIGN_IN_MAX_AGE_MS + 1);
    await refuse((url) => callbackFor(url), 'expired', (p) => ({ ...p, startedAt: NOW + 10 * 60_000 }));
  });

  it('refuses a token endpoint answer that is not this client\'s tokens', async () => {
    const answers: Response[] = [
      tokenResponse({ access: accessToken({ clientId: '11111111-2222-4333-8444-555555555555', expSeconds: exp(3600) }), refresh: 'r' }),
      tokenResponse({ access: accessToken({ expSeconds: exp(3600) }), refresh: 'r', tokenType: 'mac' }),
      tokenResponse({ access: 'not-a-jwt', refresh: 'r' }),
      tokenResponse({ access: accessToken({ expSeconds: exp(3600) }), refresh: '' }),
      new Response('<html>', { status: 200 }),
    ];
    for (const answer of answers) {
      const { url, pending } = await started();
      const { fn } = scriptedFetch({ [ENDPOINTS.tokenUrl]: [answer] });
      expect(await completeSignIn(callbackFor(url), pending, ENDPOINTS, { fetchFn: fn, now: () => NOW })).toEqual({ ok: false, reason: 'response' });
    }
  });

  it('answers exchange for a refusal or a network failure, never throwing', async () => {
    for (const answer of [jsonResponse(400, { error: 'invalid_grant' }), new Error('offline')]) {
      const { url, pending } = await started();
      const { fn } = scriptedFetch({ [ENDPOINTS.tokenUrl]: [answer] });
      expect(await completeSignIn(callbackFor(url), pending, ENDPOINTS, { fetchFn: fn, now: () => NOW })).toEqual({ ok: false, reason: 'exchange' });
    }
  });

  it('treats a token with no end date as already ended, so the next use refreshes it', async () => {
    const { url, pending } = await started();
    const bare = new Response(JSON.stringify({ access_token: `${'e30'}.${Buffer.from(JSON.stringify({ client_id: CLIENT_ID })).toString('base64url')}.c`, refresh_token: 'r' }), { status: 200 });
    const { fn } = scriptedFetch({ [ENDPOINTS.tokenUrl]: [bare] });
    const result = await completeSignIn(callbackFor(url), pending, ENDPOINTS, { fetchFn: fn, now: () => NOW });
    expect(result.ok && result.tokens.expiresAt).toBe(NOW);
  });
});

describe('refreshTokens', () => {
  it('sends the refresh token and the client id and answers the rotated tokens', async () => {
    const { fn, calls } = scriptedFetch({ [ENDPOINTS.tokenUrl]: [tokenResponse({ access: accessToken({ expSeconds: exp(3600) }), refresh: 'refresh-2' })] });
    const result = await refreshTokens(ENDPOINTS, 'refresh-1', { fetchFn: fn, now: () => NOW });
    expect(result.ok && result.tokens.refreshToken).toBe('refresh-2');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: CLIENT_ID });
    expect(calls[0]?.init.credentials).toBe('omit');
  });

  it('ends the session only when the provider rejects the refresh token itself', async () => {
    const cases: Array<[Response | Error, 'rejected' | 'unavailable']> = [
      [jsonResponse(400, { error: 'invalid_grant' }), 'rejected'],
      [jsonResponse(400, { error: 'invalid_client' }), 'unavailable'],
      [jsonResponse(401, { error: 'invalid_grant' }), 'unavailable'],
      [jsonResponse(429, {}), 'unavailable'],
      [jsonResponse(500, {}), 'unavailable'],
      [new Response('oops', { status: 400 }), 'unavailable'],
      [new Error('offline'), 'unavailable'],
      [tokenResponse({ access: accessToken({ clientId: '11111111-2222-4333-8444-555555555555', expSeconds: exp(3600) }), refresh: 'r' }), 'unavailable'],
    ];
    for (const [answer, expected] of cases) {
      const { fn } = scriptedFetch({ [ENDPOINTS.tokenUrl]: [answer] });
      expect(await refreshTokens(ENDPOINTS, 'refresh-1', { fetchFn: fn, now: () => NOW })).toEqual({ ok: false, reason: expected });
    }
  });
});

describe('endpointsFromConfig', () => {
  const config = (over: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => ({ signIn: 'oauth', oauthSignIn: { clientId: CLIENT_ID.toUpperCase(), authorizeUrl: ENDPOINTS.authorizeUrl, tokenUrl: ENDPOINTS.tokenUrl, name: 'DOS ID', ...over }, ...root });

  it('accepts the web app\'s own view of the deployment', () => {
    expect(endpointsFromConfig(config())).toEqual(ENDPOINTS);
  });

  it('refuses a server that does not sign in with an OAuth App', () => {
    expect(endpointsFromConfig(config({}, { signIn: 'form' }))).toBeNull();
    expect(endpointsFromConfig({ signIn: 'oauth', oauthSignIn: null })).toBeNull();
    expect(endpointsFromConfig(null)).toBeNull();
    expect(endpointsFromConfig('oauth')).toBeNull();
  });

  it('refuses unsafe or split endpoints', () => {
    expect(endpointsFromConfig(config({ clientId: 'not-a-uuid' }))).toBeNull();
    expect(endpointsFromConfig(config({ tokenUrl: 'http://id.example.test/token' }))).toBeNull();
    expect(endpointsFromConfig(config({ authorizeUrl: 'https://user:pw@id.example.test/authorize' }))).toBeNull();
    expect(endpointsFromConfig(config({ tokenUrl: 'https://other.example.test/token' }))).toBeNull();
    expect(endpointsFromConfig(config({ tokenUrl: 'https://id.example.test/token#x' }))).toBeNull();
    expect(endpointsFromConfig(config({ tokenUrl: 7 }))).toBeNull();
  });

  it('allows http only for a developer\'s own machine', () => {
    const local = { authorizeUrl: 'http://localhost:54321/auth/v1/oauth/authorize', tokenUrl: 'http://localhost:54321/auth/v1/oauth/token' };
    expect(endpointsFromConfig(config(local))?.tokenUrl).toBe(local.tokenUrl);
  });
});

describe('jwtClaims', () => {
  it('reads a payload and refuses what is not a token', () => {
    expect(jwtClaims(accessToken({ expSeconds: 5 }))?.['client_id']).toBe(CLIENT_ID);
    expect(jwtClaims('a.b')).toBeNull();
    expect(jwtClaims('a.!!!.c')).toBeNull();
    expect(jwtClaims(`a.${Buffer.from('[1]').toString('base64url')}.c`)).toBeNull();
  });
});
