// SPDX-License-Identifier: AGPL-3.0-only
// The hosted login (issue #2704, docs/contracts/hosted-login.md): the PKCE start, and the callback's refusals.
import { describe, expect, it, vi } from 'vitest';
import {
  HOSTED_CALLBACK_PATH,
  HOSTED_MAX_AGE_MS,
  HOSTED_STORAGE_KEY,
  completeHostedLogin,
  pkceChallenge,
  randomToken,
  readHostedCallback,
  safeReturnPath,
  startHostedLogin,
  type HostedLoginConfig,
  type HostedStorage,
} from '../src/lib/hosted-login.ts';

const ORIGIN = 'https://app.example.test';
const CONFIG: HostedLoginConfig = { url: 'https://login.example.test/sign-in?theme=light', tokenUrl: 'https://login.example.test/token', name: null };
const CODE = 'abcdEFGH0123456789-_.~xyzABCD';

function memory(): HostedStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

// Starts a login and returns the callback the hosted page would send back for it.
async function started(storage = memory(), now = 1_000_000) {
  const address = new URL(await startHostedLogin(CONFIG, { origin: ORIGIN, returnPath: '/o/acme/inbox', storage, now: () => now }));
  const state = address.searchParams.get('state') ?? '';
  return { storage, address, state, callback: { code: CODE, state, denied: false } };
}

const tokens = { access_token: 'a.b.c', refresh_token: 'r1', token_type: 'bearer', expires_in: 3600 };
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('starting a hosted login', () => {
  it('computes the S256 challenge of RFC 7636, appendix B', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('sends the hosted page the contract parameters and keeps its own query', async () => {
    const { address, storage } = await started();
    expect(address.origin + address.pathname).toBe('https://login.example.test/sign-in');
    expect(address.searchParams.get('theme')).toBe('light');
    expect(address.searchParams.get('response_type')).toBe('code');
    expect(address.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${HOSTED_CALLBACK_PATH}`);
    expect(address.searchParams.get('code_challenge_method')).toBe('S256');
    expect(address.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(address.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The verifier itself never leaves the tab: it is in storage, and in no address.
    const kept = JSON.parse(storage.data.get(HOSTED_STORAGE_KEY) ?? '{}') as { verifier: string; state: string };
    expect(address.toString()).not.toContain(kept.verifier);
    expect(address.searchParams.get('code_challenge')).toBe(await pkceChallenge(kept.verifier));
    expect(kept.state).toBe(address.searchParams.get('state'));
    expect(kept.verifier).not.toBe(kept.state);
  });

  it('makes a different state and verifier every time', () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('replaces a state or challenge the page address already carried instead of adding a second one', async () => {
    const address = new URL(await startHostedLogin({ ...CONFIG, url: 'https://login.example.test/?state=evil&code_challenge=evil' }, { origin: ORIGIN, returnPath: '/', storage: memory() }));
    expect(address.searchParams.getAll('state')).toHaveLength(1);
    expect(address.searchParams.get('state')).not.toBe('evil');
    expect(address.searchParams.getAll('code_challenge')).toHaveLength(1);
  });
});

describe('the callback address', () => {
  it('is read only at the callback path', () => {
    expect(readHostedCallback({ pathname: HOSTED_CALLBACK_PATH, search: `?code=${CODE}&state=s` })).toEqual({ code: CODE, state: 's', denied: false });
    expect(readHostedCallback({ pathname: HOSTED_CALLBACK_PATH, search: '?error=access_denied' })).toMatchObject({ code: null, denied: true });
    expect(readHostedCallback({ pathname: '/', search: `?code=${CODE}&state=s` })).toBeNull();
    expect(readHostedCallback({ pathname: `${HOSTED_CALLBACK_PATH}/x`, search: '' })).toBeNull();
  });

  it('never makes a return path of anything but a path of this app', () => {
    expect(safeReturnPath('/o/acme/inbox?x=1')).toBe('/o/acme/inbox?x=1');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'o/acme', '/a\nb', HOSTED_CALLBACK_PATH, '']) expect(safeReturnPath(bad), bad).toBe('/');
  });
});

describe('redeeming the code', () => {
  const deps = (storage: HostedStorage, fetchFn: typeof fetch, now = 1_000_000 + 5_000) => ({ config: CONFIG, origin: ORIGIN, storage, fetchFn, now: () => now });

  it('sends the code, the verifier and the redirect_uri to the token endpoint, with nothing ambient, and returns the session', async () => {
    const { storage, callback } = await started();
    const kept = JSON.parse(storage.data.get(HOSTED_STORAGE_KEY) ?? '{}') as { verifier: string };
    const fetchFn = answer(tokens);
    const result = await completeHostedLogin(callback, deps(storage, fetchFn as unknown as typeof fetch));
    expect(result).toEqual({ ok: true, accessToken: 'a.b.c', refreshToken: 'r1', returnPath: '/o/acme/inbox' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CONFIG.tokenUrl);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(String(init.body))).toEqual({ grant_type: 'authorization_code', code: CODE, code_verifier: kept.verifier, redirect_uri: `${ORIGIN}${HOSTED_CALLBACK_PATH}` });
  });

  it('removes the state and the verifier as soon as the callback is read, and redeems at most once', async () => {
    const { storage, callback } = await started();
    const fetchFn = answer(tokens);
    await completeHostedLogin(callback, deps(storage, fetchFn as unknown as typeof fetch));
    expect(storage.data.size).toBe(0);
    expect(await completeHostedLogin(callback, deps(storage, fetchFn as unknown as typeof fetch))).toEqual({ ok: false, reason: 'missing' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('clears them even when the callback is refused, so a failed attempt starts over', async () => {
    const { storage, callback } = await started();
    expect(await completeHostedLogin({ ...callback, state: 'x'.repeat(43) }, deps(storage, answer(tokens) as unknown as typeof fetch))).toEqual({ ok: false, reason: 'state' });
    expect(storage.data.size).toBe(0);
  });

  it.each([
    ['a callback with a state this tab did not make', (c: { state: string }) => ({ ...c, state: 'A'.repeat(43) }), 'state'],
    ['a callback with no state', (c: { state: string }) => ({ ...c, state: '' }), 'state'],
    ['a callback with no code', (c: object) => ({ ...c, code: null }), 'code'],
    ['a code of characters a code never has', (c: object) => ({ ...c, code: 'a b/c?d=e&f#g-0123456789' }), 'code'],
    ['a code that is too short', (c: object) => ({ ...c, code: 'short' }), 'code'],
    ['an error the hosted page reported', (c: object) => ({ ...c, denied: true }), 'denied'],
  ])('refuses %s and sends nothing', async (_label, change, reason) => {
    const { storage, callback } = await started();
    const fetchFn = answer(tokens);
    const result = await completeHostedLogin(change(callback) as typeof callback, deps(storage, fetchFn as unknown as typeof fetch));
    expect(result).toEqual({ ok: false, reason });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a callback with nothing started in this tab (another tab, a replay, a forged link)', async () => {
    const fetchFn = answer(tokens);
    expect(await completeHostedLogin({ code: CODE, state: 'A'.repeat(43), denied: false }, deps(memory(), fetchFn as unknown as typeof fetch))).toEqual({ ok: false, reason: 'missing' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a login started more than 10 minutes ago', async () => {
    const { storage, callback } = await started(memory(), 1_000_000);
    const fetchFn = answer(tokens);
    expect(await completeHostedLogin(callback, deps(storage, fetchFn as unknown as typeof fetch, 1_000_000 + HOSTED_MAX_AGE_MS + 1))).toEqual({ ok: false, reason: 'expired' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a callback for another redirect_uri than the one the login started with', async () => {
    const { storage, callback } = await started();
    const fetchFn = answer(tokens);
    expect(await completeHostedLogin(callback, { ...deps(storage, fetchFn as unknown as typeof fetch), origin: 'https://other.example.test' })).toEqual({ ok: false, reason: 'redirect' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a token endpoint that answers an error, not JSON, or a session without both tokens', async () => {
    for (const [fetchFn, reason] of [
      [answer({ error: 'invalid_grant' }, 400), 'exchange'],
      [vi.fn(async () => new Response('<html>', { status: 200 })), 'exchange'],
      [vi.fn(async () => { throw new TypeError('network'); }), 'exchange'],
      [answer({ access_token: 'a.b.c' }), 'response'],
      [answer({ refresh_token: 'r1' }), 'response'],
      [answer({ ...tokens, token_type: 'mac' }), 'response'],
      [answer({ ...tokens, access_token: 'x'.repeat(9000) }), 'response'],
      [answer(null), 'response'],
    ] as const) {
      const { storage, callback } = await started();
      expect(await completeHostedLogin(callback, deps(storage, fetchFn as unknown as typeof fetch)), reason).toEqual({ ok: false, reason });
    }
  });

  it('treats a storage that cannot be read as nothing started', async () => {
    const broken: HostedStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => undefined, removeItem: () => undefined };
    expect(await completeHostedLogin({ code: CODE, state: 'A'.repeat(43), denied: false }, deps(broken, answer(tokens) as unknown as typeof fetch))).toEqual({ ok: false, reason: 'missing' });
  });
});
