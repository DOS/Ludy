// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth App's return, through the app's start-up (issue #4704): the one-time code leaves the address before auth-js is
// created, the tokens are handed to auth-js, a failure leaves one notice, a deployment without the feature keeps nothing, auth-js
// refreshes through the OAuth token endpoint, and a second-factor verification is followed by such a refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_CALLBACK_PATH, OAUTH_STORAGE_KEY, startOauthLogin, type OauthSignInConfig } from '../src/lib/oauth-login.ts';

const ORIGIN = 'https://app.example.test';
const CLIENT_ID = '3f2b8a9e-6c1d-4e7a-9b5f-0d1c2e3f4a5b';
const AUTH_URL = 'https://id.example.test/auth/v1';
const CONFIG: OauthSignInConfig = { clientId: CLIENT_ID, authorizeUrl: `${AUTH_URL}/oauth/authorize`, tokenUrl: `${AUTH_URL}/oauth/token`, name: null };
const CODE = 'abcdEFGH0123456789-_.~xyzABCD';

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const accessToken = (claims: Record<string, unknown> = {}) =>
  `${part({ alg: 'ES256' })}.${part({ sub: 'u-1', email: 'a@example.test', aud: 'authenticated', role: 'authenticated', client_id: CLIENT_ID, exp: 2_000_000_000, ...claims })}.c2ln`;

const seen = vi.hoisted(() => ({
  options: [] as Array<{ fetch?: typeof fetch; url?: string }>,
  constructedAt: [] as string[],
  sessions: [] as unknown[],
  setSessionError: null as unknown,
  verifyError: null as unknown,
  calls: [] as string[],
}));

vi.mock('@supabase/auth-js', () => ({
  AuthClient: class {
    mfa = {
      challengeAndVerify: async () => {
        seen.calls.push('verify');
        return { data: seen.verifyError ? null : { access_token: 'v' }, error: seen.verifyError };
      },
    };
    constructor(options: { fetch?: typeof fetch; url?: string }) {
      seen.options.push(options);
      seen.constructedAt.push((globalThis as unknown as { window: { location: { href: string } } }).window.location.href);
    }
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    }
    async initialize() {
      return { error: null };
    }
    async getSession() {
      return { data: { session: null } };
    }
    async setSession(session: unknown) {
      seen.sessions.push(session);
      if (seen.setSessionError === 'throw') throw new SyntaxError('not a token');
      return { error: seen.setSessionError };
    }
    async refreshSession() {
      seen.calls.push('refresh');
      return { data: {}, error: null };
    }
  },
}));

function installWindow(href: string) {
  const url = new URL(href);
  const storage = new Map<string, string>();
  const location = {
    get href() { return url.href; },
    get pathname() { return url.pathname; },
    get search() { return url.search; },
    get hash() { return url.hash; },
    get origin() { return url.origin; },
  };
  const history = { replaceState: (_s: unknown, _t: string, to: string) => { const next = new URL(to, url); url.pathname = next.pathname; url.search = next.search; url.hash = next.hash; } };
  const sessionStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  vi.stubGlobal('window', { location, history, sessionStorage });
  return { storage, url };
}

function stubFetch(config: Record<string, unknown>, tokenAnswer: (body: URLSearchParams) => Response) {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (target.endsWith('/api/config')) return new Response(JSON.stringify({ authUrl: AUTH_URL, authAnonKey: null, ...config }), { status: 200 });
    if (target === CONFIG.tokenUrl) return tokenAnswer(new URLSearchParams(String(init?.body)));
    throw new Error(`unexpected ${target}`);
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

// A sign-in started in this tab, and the address the provider sends the browser back to.
async function returned(storage: Map<string, string>, returnPath = '/o/acme') {
  const fake = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  const start = new URL(await startOauthLogin(CONFIG, { origin: ORIGIN, returnPath, storage: fake }));
  return `${ORIGIN}${OAUTH_CALLBACK_PATH}?code=${CODE}&state=${start.searchParams.get('state')}`;
}

async function arrive(callbackSetup: (win: ReturnType<typeof installWindow>) => void = () => undefined) {
  const first = installWindow(`${ORIGIN}/`);
  const callbackUrl = await returned(first.storage);
  const win = installWindow(callbackUrl);
  win.storage.set(OAUTH_STORAGE_KEY, first.storage.get(OAUTH_STORAGE_KEY) ?? '');
  callbackSetup(win);
  return win;
}

const ON = { signIn: 'oauth', oauthSignIn: CONFIG };
const good = () => new Response(JSON.stringify({ access_token: accessToken(), refresh_token: 'r1', token_type: 'bearer', expires_in: 3600 }), { status: 200 });

beforeEach(() => {
  vi.resetModules();
  seen.options.length = 0;
  seen.constructedAt.length = 0;
  seen.sessions.length = 0;
  seen.calls.length = 0;
  seen.setSessionError = null;
  seen.verifyError = null;
});
afterEach(() => vi.unstubAllGlobals());

describe('the OAuth App return at start-up', () => {
  it('takes the code out of the address before auth-js exists, signs in with the returned tokens and ends on the starting path', async () => {
    const win = await arrive();
    const fetchFn = stubFetch(ON, good);
    const auth = await import('../src/lib/auth.ts');
    auth.captureHostedCallback();
    // Before the config is fetched, before auth-js: the address no longer carries the code.
    expect(win.url.search).toBe('');
    expect(win.url.pathname).toBe('/');
    await auth.loadConfig();
    await auth.settleCallback();
    expect(seen.constructedAt).toHaveLength(1);
    expect(seen.constructedAt[0]).not.toContain('code=');
    expect(seen.sessions).toEqual([{ access_token: accessToken(), refresh_token: 'r1' }]);
    expect(win.url.pathname).toBe('/o/acme');
    expect(auth.peekCallbackNotice()).toBeNull();
    expect(win.storage.size).toBe(0);
    expect(fetchFn.mock.calls.filter(([u]) => String(u) === CONFIG.tokenUrl)).toHaveLength(1);
  });

  it('leaves one notice and no session when the token endpoint refuses, answers with another client\'s token, or auth-js refuses the session', async () => {
    for (const [answer, setSessionError] of [
      [good, 'throw'],
      [() => new Response('{"error":"invalid_grant"}', { status: 400 }), null],
      [() => new Response(JSON.stringify({ access_token: accessToken({ client_id: 'another-client' }), refresh_token: 'r1' }), { status: 200 }), null],
      [good, new Error('bad session')],
    ] as const) {
      vi.resetModules();
      seen.sessions.length = 0;
      seen.setSessionError = setSessionError;
      const win = await arrive();
      stubFetch(ON, answer);
      const auth = await import('../src/lib/auth.ts');
      await auth.loadConfig();
      await auth.settleCallback();
      expect(auth.peekCallbackNotice()).toEqual({ error: true, code: 'oauth_login_failed' });
      expect(win.url.search).toBe('');
      expect(win.storage.size).toBe(0);
      if (setSessionError === null) expect(seen.sessions).toEqual([]);
    }
  });

  it('refuses a callback whose state is not this tab\'s, and sends nothing', async () => {
    const first = installWindow(`${ORIGIN}/`);
    await returned(first.storage);
    const win = installWindow(`${ORIGIN}${OAUTH_CALLBACK_PATH}?code=${CODE}&state=${'A'.repeat(43)}`);
    win.storage.set(OAUTH_STORAGE_KEY, first.storage.get(OAUTH_STORAGE_KEY) ?? '');
    const fetchFn = stubFetch(ON, good);
    const auth = await import('../src/lib/auth.ts');
    await auth.loadConfig();
    await auth.settleCallback();
    expect(auth.peekCallbackNotice()).toEqual({ error: true, code: 'oauth_login_failed' });
    expect(fetchFn.mock.calls.filter(([u]) => String(u) === CONFIG.tokenUrl)).toHaveLength(0);
    expect(seen.sessions).toEqual([]);
  });

  it('keeps nothing when the deployment signs in some other way: the stored attempt is discarded and nothing is sent', async () => {
    const win = await arrive();
    const fetchFn = stubFetch({}, good);
    const auth = await import('../src/lib/auth.ts');
    await auth.loadConfig();
    await auth.settleCallback();
    expect(auth.peekCallbackNotice()).toEqual({ error: true, code: 'oauth_login_failed' });
    expect(win.storage.size).toBe(0);
    expect(fetchFn.mock.calls.filter(([u]) => String(u) === CONFIG.tokenUrl)).toHaveLength(0);
  });

  it('discards the attempt when the app cannot start, so a verifier is not left behind', async () => {
    const win = await arrive();
    const auth = await import('../src/lib/auth.ts');
    auth.captureHostedCallback();
    auth.discardHostedLogin();
    expect(win.url.search).toBe('');
    expect(win.storage.size).toBe(0);
  });
});

describe('auth-js with the OAuth App', () => {
  it('refreshes at the OAuth token endpoint with the client id when the deployment signs in through the OAuth App', async () => {
    installWindow(`${ORIGIN}/`);
    const fetchFn = stubFetch(ON, good);
    const auth = await import('../src/lib/auth.ts');
    await auth.loadConfig();
    auth.auth();
    const options = seen.options[0];
    const answer = await options?.fetch?.(`${AUTH_URL}/token?grant_type=refresh_token`, { method: 'POST', body: JSON.stringify({ refresh_token: 'old' }) });
    expect(answer?.status).toBe(200);
    const sent = fetchFn.mock.calls.find(([u]) => String(u) === CONFIG.tokenUrl);
    expect(Object.fromEntries(new URLSearchParams(String(sent?.[1]?.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'old', client_id: CLIENT_ID });
  });

  it('keeps plain fetch (no token endpoint rewrite) when the deployment has no OAuth App', async () => {
    installWindow(`${ORIGIN}/`);
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/config')) return new Response(JSON.stringify({ authUrl: AUTH_URL, authAnonKey: null }), { status: 200 });
      return new Response('{"plain":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchFn);
    const auth = await import('../src/lib/auth.ts');
    await auth.loadConfig();
    auth.auth();
    const answer = await seen.options[0]?.fetch?.(`${AUTH_URL}/token?grant_type=refresh_token`, { method: 'POST', body: JSON.stringify({ refresh_token: 'old' }) });
    expect(await answer?.json()).toEqual({ plain: true });
    expect(fetchFn.mock.calls.map(([u]) => String(u))).toContain(`${AUTH_URL}/token?grant_type=refresh_token`);
  });

  it('refreshes the session right after a second-factor verification, which Supabase Auth issues without the client id', async () => {
    installWindow(`${ORIGIN}/`);
    stubFetch(ON, good);
    const auth = await import('../src/lib/auth.ts');
    await auth.loadConfig();
    const result = await auth.verifySecondFactor({ factorId: 'f', code: '123456' });
    expect(result.error).toBeNull();
    expect(seen.calls).toEqual(['verify', 'refresh']);
  });

  it('does not refresh after a failed verification, nor when the deployment has no OAuth App', async () => {
    installWindow(`${ORIGIN}/`);
    stubFetch(ON, good);
    let auth = await import('../src/lib/auth.ts');
    await auth.loadConfig();
    seen.verifyError = new Error('wrong code');
    await auth.verifySecondFactor({ factorId: 'f', code: '000000' });
    expect(seen.calls).toEqual(['verify']);
    vi.resetModules();
    seen.calls.length = 0;
    seen.verifyError = null;
    stubFetch({}, good);
    auth = await import('../src/lib/auth.ts');
    await auth.loadConfig();
    await auth.verifySecondFactor({ factorId: 'f', code: '123456' });
    expect(seen.calls).toEqual(['verify']);
  });
});
