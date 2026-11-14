// SPDX-License-Identifier: AGPL-3.0-only
// The hosted login's return, through the app's start-up (issue #2704): the one-time code leaves the address before auth-js is
// created, the session is handed to auth-js, a failure leaves one notice, and a deployment without the feature keeps nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_CALLBACK_PATH, HOSTED_STORAGE_KEY, startHostedLogin } from '../src/lib/hosted-login.ts';

const ORIGIN = 'https://app.example.test';
const TOKEN_URL = 'https://login.example.test/token';
const CONFIG = { url: 'https://login.example.test/sign-in', tokenUrl: TOKEN_URL, name: null };
const CODE = 'abcdEFGH0123456789-_.~xyzABCD';

const seen = vi.hoisted(() => ({ constructedAt: [] as string[], sessions: [] as unknown[], setSessionError: null as unknown, initializeThrows: false }));

vi.mock('@supabase/auth-js', () => ({
  AuthClient: class {
    constructor() {
      seen.constructedAt.push((globalThis as unknown as { window: { location: { href: string } } }).window.location.href);
    }
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    }
    async initialize() {
      if (seen.initializeThrows) throw new TypeError('storage unavailable');
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

function stubFetch(hosted: unknown, tokenAnswer: () => Response) {
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const target = String(input);
    if (target.endsWith('/api/config')) return new Response(JSON.stringify({ authUrl: 'https://auth.example.test/auth/v1', authAnonKey: null, hostedLogin: hosted }), { status: 200 });
    if (target === TOKEN_URL) return tokenAnswer();
    throw new Error(`unexpected ${target}`);
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

// A login started in this tab, and the address the hosted page sends the browser back to.
async function returned(storage: Map<string, string>, returnPath = '/o/acme') {
  const fake = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  const start = new URL(await startHostedLogin(CONFIG, { origin: ORIGIN, returnPath, storage: fake }));
  return `${ORIGIN}${HOSTED_CALLBACK_PATH}?code=${CODE}&state=${start.searchParams.get('state')}`;
}

beforeEach(() => {
  vi.resetModules();
  seen.constructedAt.length = 0;
  seen.sessions.length = 0;
  seen.setSessionError = null;
  seen.initializeThrows = false;
});
afterEach(() => vi.unstubAllGlobals());

describe('the hosted login return at start-up', () => {
  it('takes the code out of the address before auth-js exists, signs in with the returned session and ends on the starting path', async () => {
    const win = installWindow(`${ORIGIN}/`);
    const callbackUrl = await returned(win.storage);
    const win2 = installWindow(callbackUrl);
    win2.storage.set(HOSTED_STORAGE_KEY, win.storage.get(HOSTED_STORAGE_KEY) ?? '');
    const fetchFn = stubFetch(CONFIG, () => new Response(JSON.stringify({ access_token: 'a.b.c', refresh_token: 'r1', token_type: 'bearer' }), { status: 200 }));
    const auth = await import('../src/lib/auth.ts');
    auth.captureHostedCallback();
    // Before the config is fetched, before auth-js: the address no longer carries the code.
    expect(win2.url.search).toBe('');
    expect(win2.url.pathname).toBe('/');
    await auth.loadConfig();
    await auth.settleCallback();
    expect(seen.constructedAt).toHaveLength(1);
    expect(seen.constructedAt[0]).not.toContain('code=');
    expect(seen.sessions).toEqual([{ access_token: 'a.b.c', refresh_token: 'r1' }]);
    expect(win2.url.pathname).toBe('/o/acme');
    expect(auth.peekCallbackNotice()).toBeNull();
    expect(win2.storage.size).toBe(0);
    expect(fetchFn.mock.calls.filter(([u]) => String(u) === TOKEN_URL)).toHaveLength(1);
  });

  it('leaves one notice and no session when the token endpoint refuses, or auth-js refuses the session', async () => {
    for (const [answer, setSessionError] of [
      [() => new Response(JSON.stringify({ access_token: 'not-a-jwt', refresh_token: 'r1' }), { status: 200 }), 'throw'],
      [() => new Response('{"error":"invalid_grant"}', { status: 400 }), null],
      [() => new Response(JSON.stringify({ access_token: 'a.b.c', refresh_token: 'r1' }), { status: 200 }), new Error('bad session')],
    ] as const) {
      vi.resetModules();
      seen.sessions.length = 0;
      seen.setSessionError = setSessionError;
      const first = installWindow(`${ORIGIN}/`);
      const callbackUrl = await returned(first.storage);
      const win = installWindow(callbackUrl);
      win.storage.set(HOSTED_STORAGE_KEY, first.storage.get(HOSTED_STORAGE_KEY) ?? '');
      stubFetch(CONFIG, answer);
      const auth = await import('../src/lib/auth.ts');
      await auth.loadConfig();
      await auth.settleCallback();
      expect(auth.peekCallbackNotice()).toEqual({ error: true, code: 'hosted_login_failed' });
      expect(win.url.search).toBe('');
      expect(win.storage.size).toBe(0);
      if (setSessionError === null) expect(seen.sessions).toEqual([]);
    }
  });

  it('keeps nothing when the deployment has no hosted login: the stored attempt is discarded and nothing is sent', async () => {
    const first = installWindow(`${ORIGIN}/`);
    const callbackUrl = await returned(first.storage);
    const win = installWindow(callbackUrl);
    win.storage.set(HOSTED_STORAGE_KEY, first.storage.get(HOSTED_STORAGE_KEY) ?? '');
    const fetchFn = stubFetch(null, () => new Response('{}', { status: 200 }));
    const auth = await import('../src/lib/auth.ts');
    await auth.loadConfig();
    await auth.settleCallback();
    expect(auth.peekCallbackNotice()).toEqual({ error: true, code: 'hosted_login_failed' });
    expect(win.storage.size).toBe(0);
    expect(fetchFn.mock.calls.filter(([u]) => String(u) === TOKEN_URL)).toHaveLength(0);
  });

  it('discards the attempt when the app cannot start, so a verifier is not left behind', async () => {
    const first = installWindow(`${ORIGIN}/`);
    const callbackUrl = await returned(first.storage);
    const win = installWindow(callbackUrl);
    win.storage.set(HOSTED_STORAGE_KEY, first.storage.get(HOSTED_STORAGE_KEY) ?? '');
    const auth = await import('../src/lib/auth.ts');
    auth.captureHostedCallback();
    auth.discardHostedLogin();
    expect(win.url.search).toBe('');
    expect(win.storage.size).toBe(0);
  });

  it('discards the attempt when auth-js cannot initialize, so a verifier is not left behind', async () => {
    seen.initializeThrows = true;
    const first = installWindow(`${ORIGIN}/`);
    const callbackUrl = await returned(first.storage);
    const win = installWindow(callbackUrl);
    win.storage.set(HOSTED_STORAGE_KEY, first.storage.get(HOSTED_STORAGE_KEY) ?? '');
    const fetchFn = stubFetch(CONFIG, () => new Response('{}', { status: 200 }));
    const auth = await import('../src/lib/auth.ts');
    await auth.loadConfig();
    await expect(auth.settleCallback()).rejects.toThrow('storage unavailable');
    expect(win.storage.size).toBe(0);
    expect(win.url.search).toBe('');
    expect(fetchFn.mock.calls.filter(([u]) => String(u) === TOKEN_URL)).toHaveLength(0);
  });
});
