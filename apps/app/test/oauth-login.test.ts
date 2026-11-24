// SPDX-License-Identifier: AGPL-3.0-only
// Signing in through the identity provider's OAuth App (issue #4704): the authorization code flow with PKCE (S256) against a fake
// OAuth 2.1 server that checks what a real one checks, the refusals of the callback (state, redirect, age, replay, a token for
// another client) and the refresh at the OAuth token endpoint.
import { describe, expect, it } from 'vitest';
import { pkceChallenge } from '../src/lib/hosted-login.ts';
import {
  OAUTH_CALLBACK_PATH,
  OAUTH_MAX_AGE_MS,
  OAUTH_SCOPE,
  OAUTH_STORAGE_KEY,
  completeOauthLogin,
  jwtClaims,
  oauthRefreshFetch,
  readOauthCallback,
  startOauthLogin,
  type OauthSignInConfig,
} from '../src/lib/oauth-login.ts';

const ORIGIN = 'https://app.example.test';
const CLIENT_ID = '3f2b8a9e-6c1d-4e7a-9b5f-0d1c2e3f4a5b';
const CONFIG: OauthSignInConfig = {
  clientId: CLIENT_ID,
  authorizeUrl: 'https://id.example.test/auth/v1/oauth/authorize',
  tokenUrl: 'https://id.example.test/auth/v1/oauth/token',
  name: 'Example ID',
};
const AUTH_URL = 'https://id.example.test/auth/v1';

function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(claims: Record<string, unknown>): string {
  return `${part({ alg: 'ES256', typ: 'JWT' })}.${part({ iss: AUTH_URL, aud: 'authenticated', sub: 'u-1', role: 'authenticated', email: 'a@example.test', iat: 1_700_000_000, exp: 1_700_003_600, ...claims })}.${Buffer.from('sig').toString('base64url')}`;
}

// A fake OAuth 2.1 server with what matters: it remembers the PKCE challenge, redirect URI and client of an authorization,
// hands out a code once, and at the token endpoint checks the verifier against the challenge, the redirect URI, the client
// id and (for a refresh) the refresh token. Its tokens carry the client id like Supabase Auth's OAuth server's do.
function fakeServer(options: { tokenClaims?: (clientId: string) => Record<string, unknown> } = {}) {
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const refreshTokens = new Map<string, string>();
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: URLSearchParams; credentials?: RequestCredentials | undefined; redirect?: RequestRedirect | undefined }> = [];
  let counter = 0;
  const tokens = (clientId: string) => {
    counter += 1;
    const refresh = `refresh-${counter}`;
    refreshTokens.set(refresh, clientId);
    return { access_token: jwt({ client_id: clientId, scope: OAUTH_SCOPE, jti: counter, ...options.tokenClaims?.(clientId) }), token_type: 'bearer', expires_in: 3600, refresh_token: refresh };
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return {
    requests,
    // What the provider's authorize endpoint and sign-in page do: refuse a request it does not know, then send the browser
    // back to the redirect URI with a code and the state.
    authorize(address: string, registeredRedirect = `${ORIGIN}${OAUTH_CALLBACK_PATH}`): string | null {
      const url = new URL(address);
      if (url.origin + url.pathname !== CONFIG.authorizeUrl) return null;
      const p = url.searchParams;
      if (p.get('response_type') !== 'code' || p.get('client_id') !== CLIENT_ID || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('state')) return null;
      if (p.get('redirect_uri') !== registeredRedirect) return null;
      const code = `code-${'x'.repeat(24)}-${codes.size}`;
      codes.set(code, { challenge: p.get('code_challenge') as string, redirectUri: registeredRedirect, clientId: CLIENT_ID });
      return `${registeredRedirect}?code=${code}&state=${p.get('state')}`;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input);
      const body = new URLSearchParams(String(init?.body ?? ''));
      requests.push({ url: target, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body, credentials: init?.credentials, redirect: init?.redirect });
      if (target !== CONFIG.tokenUrl) return json({ error: 'not_found' }, 404);
      if (body.get('client_id') !== CLIENT_ID) return json({ error: 'invalid_client' }, 401);
      if (body.get('grant_type') === 'authorization_code') {
        const stored = codes.get(body.get('code') ?? '');
        codes.delete(body.get('code') ?? '');
        if (!stored) return json({ error: 'invalid_grant' }, 400);
        if (stored.redirectUri !== body.get('redirect_uri')) return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
        if (stored.challenge !== (await pkceChallenge(body.get('code_verifier') ?? ''))) return json({ error: 'invalid_grant', error_description: 'PKCE failed' }, 400);
        return json(tokens(stored.clientId));
      }
      if (body.get('grant_type') === 'refresh_token') {
        const refresh = body.get('refresh_token') ?? '';
        const clientId = refreshTokens.get(refresh);
        refreshTokens.delete(refresh);
        if (clientId === undefined) return json({ error: 'invalid_grant' }, 400);
        return json(tokens(clientId));
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }) as typeof fetch,
  };
}

async function signIn(server: ReturnType<typeof fakeServer>, storage = memory(), now = 1_000_000) {
  const address = await startOauthLogin(CONFIG, { origin: ORIGIN, returnPath: '/o/acme/inbox', storage, now: () => now });
  const back = server.authorize(address);
  const callback = back ? (readOauthCallback({ pathname: new URL(back).pathname, search: new URL(back).search }) as NonNullable<ReturnType<typeof readOauthCallback>>) : null;
  return { storage, address: new URL(address), callback, deps: (fetchFn: typeof fetch = server.fetch, at = now) => ({ config: CONFIG, origin: ORIGIN, storage, fetchFn, now: () => at }) };
}

describe('starting the sign-in', () => {
  it('sends the authorize endpoint the code flow parameters: client id, exact redirect URI, scope, state and an S256 challenge', async () => {
    const { address, storage } = await signIn(fakeServer());
    expect(address.origin + address.pathname).toBe(CONFIG.authorizeUrl);
    const p = address.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/oauth-login/callback`);
    expect(p.get('scope')).toBe('openid email profile');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const kept = JSON.parse(storage.data.get(OAUTH_STORAGE_KEY) ?? '{}') as { verifier: string; state: string };
    // The verifier is in this tab's storage and in no address; the challenge is its hash.
    expect(address.toString()).not.toContain(kept.verifier);
    expect(p.get('code_challenge')).toBe(await pkceChallenge(kept.verifier));
    expect(kept.state).toBe(p.get('state'));
    expect(p.has('client_secret')).toBe(false);
  });

  it('drops any query the configured endpoint carried: nothing there stands in for a parameter it sets', async () => {
    const address = new URL(await startOauthLogin({ ...CONFIG, authorizeUrl: `${CONFIG.authorizeUrl}?client_id=evil&state=evil&scope=admin` }, { origin: ORIGIN, returnPath: '/', storage: memory() }));
    expect(address.searchParams.getAll('client_id')).toEqual([CLIENT_ID]);
    expect(address.searchParams.getAll('scope')).toEqual(['openid email profile']);
    expect(address.searchParams.get('state')).not.toBe('evil');
  });
});

describe('the whole sign-in against a fake OAuth 2.1 server', () => {
  it('redeems the code once, with the verifier, the redirect URI and the client id, and no cookie or secret', async () => {
    const server = fakeServer();
    const { callback, deps, storage } = await signIn(server);
    expect(callback).not.toBeNull();
    const result = await completeOauthLogin(callback!, deps());
    expect(result).toMatchObject({ ok: true, returnPath: '/o/acme/inbox', refreshToken: 'refresh-1' });
    const claims = jwtClaims(result.ok ? result.accessToken : '');
    expect(claims?.['client_id']).toBe(CLIENT_ID);
    expect(storage.data.size).toBe(0);
    const [request] = server.requests;
    expect(request).toMatchObject({ url: CONFIG.tokenUrl, method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(request?.body ?? [])).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: `${ORIGIN}/oauth-login/callback` });
    expect(request?.body.has('client_secret')).toBe(false);
    // A replay of the same callback finds nothing in the tab and sends nothing.
    server.requests.length = 0;
    expect(await completeOauthLogin(callback!, deps())).toEqual({ ok: false, reason: 'missing' });
    expect(server.requests).toHaveLength(0);
  });

  it('refuses a state that is not the one this tab made, before anything is sent', async () => {
    const server = fakeServer();
    const { callback, deps } = await signIn(server);
    expect(await completeOauthLogin({ ...callback!, state: 'A'.repeat(43) }, deps())).toEqual({ ok: false, reason: 'state' });
    expect(server.requests).toHaveLength(0);
  });

  it('refuses a callback with no state, or no usable code', async () => {
    for (const change of [{ state: null }, { code: null }, { code: 'short' }, { code: `${'a'.repeat(20)}<script>` }]) {
      const server = fakeServer();
      const { callback, deps } = await signIn(server);
      const result = await completeOauthLogin({ ...callback!, ...change }, deps());
      expect(result.ok, JSON.stringify(change)).toBe(false);
      expect(server.requests).toHaveLength(0);
    }
  });

  it('refuses a callback that arrives at another origin than the redirect URI the sign-in started with', async () => {
    const server = fakeServer();
    const { callback, deps } = await signIn(server);
    expect(await completeOauthLogin(callback!, { ...deps(), origin: 'https://evil.example.test' })).toEqual({ ok: false, reason: 'redirect' });
    expect(server.requests).toHaveLength(0);
  });

  it("is refused by the provider when the redirect URI is not the registered one: no code, so no sign-in", async () => {
    const server = fakeServer();
    const address = await startOauthLogin(CONFIG, { origin: 'https://evil.example.test', returnPath: '/', storage: memory() });
    expect(server.authorize(address)).toBeNull();
    // And a code redeemed with another redirect URI than it was issued for is refused by the token endpoint.
    const { callback, deps } = await signIn(server);
    const result = await completeOauthLogin(callback!, { ...deps(async (input, init) => {
      const body = new URLSearchParams(String(init?.body));
      body.set('redirect_uri', 'https://evil.example.test/oauth-login/callback');
      return server.fetch(input, { ...init, body: body.toString() });
    }) });
    expect(result).toEqual({ ok: false, reason: 'exchange' });
  });

  it('refuses a sign-in older than ten minutes, a denied one, and a tab with nothing started', async () => {
    const server = fakeServer();
    const old = await signIn(server, memory(), 1_000_000);
    expect(await completeOauthLogin(old.callback!, old.deps(server.fetch, 1_000_000 + OAUTH_MAX_AGE_MS + 1))).toEqual({ ok: false, reason: 'expired' });
    const denied = await signIn(server);
    expect(await completeOauthLogin({ code: null, state: null, denied: true }, denied.deps())).toEqual({ ok: false, reason: 'denied' });
    expect(await completeOauthLogin({ code: 'c'.repeat(24), state: 'A'.repeat(43), denied: false }, { config: CONFIG, origin: ORIGIN, storage: memory(), fetchFn: server.fetch })).toEqual({ ok: false, reason: 'missing' });
    expect(server.requests).toHaveLength(0);
  });

  it('refuses tokens issued to another client, and an answer that is not tokens', async () => {
    const other = fakeServer({ tokenClaims: () => ({ client_id: 'another-client' }) });
    const signed = await signIn(other);
    expect(await completeOauthLogin(signed.callback!, signed.deps())).toEqual({ ok: false, reason: 'response' });
    for (const [fetchFn, reason] of [
      [(async () => new Response(JSON.stringify({ access_token: jwt({}), refresh_token: 'r' }), { status: 200 })) as typeof fetch, 'response'],
      [(async () => new Response(JSON.stringify({ access_token: 'x', refresh_token: '' }), { status: 200 })) as typeof fetch, 'response'],
      [(async () => new Response('<html>', { status: 200 })) as typeof fetch, 'response'],
      [(async () => new Response('{}', { status: 500 })) as typeof fetch, 'exchange'],
      [(async () => { throw new TypeError('offline'); }) as typeof fetch, 'exchange'],
    ] as const) {
      const { callback, deps } = await signIn(fakeServer());
      expect(await completeOauthLogin(callback!, deps(fetchFn)), reason).toEqual({ ok: false, reason });
    }
  });

  it('reads the callback only at its own path', () => {
    expect(readOauthCallback({ pathname: OAUTH_CALLBACK_PATH, search: '?code=abc&state=def' })).toEqual({ code: 'abc', state: 'def', denied: false });
    expect(readOauthCallback({ pathname: OAUTH_CALLBACK_PATH, search: '?error=access_denied' })).toEqual({ code: null, state: null, denied: true });
    expect(readOauthCallback({ pathname: '/hosted-login/callback', search: '?code=abc' })).toBeNull();
    expect(readOauthCallback({ pathname: '/', search: '?code=abc&state=def' })).toBeNull();
  });
});

describe('refreshing a session of the OAuth App', () => {
  async function session() {
    const server = fakeServer();
    const { callback, deps } = await signIn(server);
    const result = await completeOauthLogin(callback!, deps());
    if (!result.ok) throw new Error('sign-in failed');
    server.requests.length = 0;
    const passed: string[] = [];
    const base = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === CONFIG.tokenUrl) return server.fetch(input, init);
      passed.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response('{"passed":true}', { status: 200 });
    }) as typeof fetch;
    return { server, refreshToken: result.refreshToken, passed, fetchFn: oauthRefreshFetch(base, { authUrl: AUTH_URL, config: CONFIG }) };
  }
  const refreshRequest = (refreshToken: string) => ({ method: 'POST', headers: { 'content-type': 'application/json;charset=UTF-8' }, body: JSON.stringify({ refresh_token: refreshToken }) });

  it("sends auth-js's refresh to the OAuth token endpoint with the client id, and answers in Supabase Auth's shape with the user from the token", async () => {
    const { server, refreshToken, fetchFn, passed } = await session();
    const answer = await fetchFn(`${AUTH_URL}/token?grant_type=refresh_token`, refreshRequest(refreshToken));
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as Record<string, any>;
    expect(body).toMatchObject({ token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-2', user: { id: 'u-1', email: 'a@example.test', aud: 'authenticated', role: 'authenticated' } });
    expect(jwtClaims(body['access_token'])?.['client_id']).toBe(CLIENT_ID);
    expect(Object.fromEntries(server.requests[0]?.body ?? [])).toEqual({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID });
    // The refresh did not go to Supabase Auth's own /token.
    expect(passed).toEqual([]);
  });

  it('passes every other request through unchanged, the password and PKCE grants included', async () => {
    const { fetchFn, passed } = await session();
    for (const [url, method] of [[`${AUTH_URL}/user`, 'GET'], [`${AUTH_URL}/logout?scope=local`, 'POST'], [`${AUTH_URL}/token?grant_type=password`, 'POST'], [`${AUTH_URL}/token?grant_type=pkce`, 'POST'], ['https://other.example.test/token?grant_type=refresh_token', 'POST'], [`${AUTH_URL}/token?grant_type=refresh_token`, 'GET']] as const) {
      const answer = await fetchFn(url, { method });
      expect(await answer.json()).toEqual({ passed: true });
    }
    expect(passed).toHaveLength(6);
  });

  it('passes a rejected refresh token on as 400 invalid_grant, so auth-js ends the session; a used refresh token is rejected', async () => {
    const { refreshToken, fetchFn } = await session();
    expect((await fetchFn(`${AUTH_URL}/token?grant_type=refresh_token`, refreshRequest(refreshToken))).status).toBe(200);
    const second = await fetchFn(`${AUTH_URL}/token?grant_type=refresh_token`, refreshRequest(refreshToken));
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await fetchFn(`${AUTH_URL}/token?grant_type=refresh_token`, { method: 'POST', body: '{}' })).status).toBe(400);
  });

  it('keeps the session through a refusal that does not reject the refresh token: 429, invalid_client, a server error, an unreadable answer are 503 for auth-js to retry', async () => {
    for (const [status, body] of [[429, '{"error":"rate_limited"}'], [400, '{"error":"invalid_client"}'], [401, '{"error":"invalid_client"}'], [500, '{}'], [400, '<html>'], [403, '']] as const) {
      const refresh = oauthRefreshFetch((async () => new Response(body, { status })) as typeof fetch, { authUrl: AUTH_URL, config: CONFIG });
      const answer = await refresh(`${AUTH_URL}/token?grant_type=refresh_token`, refreshRequest('r1'));
      expect(answer.status, `${status} ${body}`).toBe(503);
    }
  });

  it("refuses a refreshed token that is not the app's client's, and lets a network failure throw so auth-js retries", async () => {
    const odd = oauthRefreshFetch((async () => new Response(JSON.stringify({ access_token: jwt({ client_id: 'another-client' }), refresh_token: 'r2', token_type: 'bearer', expires_in: 60 }), { status: 200 })) as typeof fetch, { authUrl: AUTH_URL, config: CONFIG });
    expect((await odd(`${AUTH_URL}/token?grant_type=refresh_token`, refreshRequest('r1'))).status).toBe(502);
    const offline = oauthRefreshFetch((async () => { throw new TypeError('offline'); }) as typeof fetch, { authUrl: AUTH_URL, config: CONFIG });
    await expect(offline(`${AUTH_URL}/token?grant_type=refresh_token`, refreshRequest('r1'))).rejects.toThrow('offline');
  });
});
