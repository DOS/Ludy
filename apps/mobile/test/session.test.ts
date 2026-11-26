// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createSessionManager, REFRESH_MARGIN_MS, type SessionManager } from '../src/auth/session.ts';
import { createVault, SESSION_KEY } from '../src/auth/vault.ts';
import { REDIRECT_URI } from '../src/config.ts';
import { accessToken, callbackFor, CLIENT_ID, ENDPOINTS, fakeBrowser, fakeLocalAuth, jsonResponse, memoryStore, nodeCrypto, scriptedFetch, SERVER, tokenResponse } from './helpers.ts';

const CONFIG_URL = `${SERVER}/api/config`;
const config = () =>
  jsonResponse(200, { signIn: 'oauth', oauthSignIn: { clientId: CLIENT_ID, authorizeUrl: ENDPOINTS.authorizeUrl, tokenUrl: ENDPOINTS.tokenUrl, name: 'DOS ID' } });

let clock = 1_800_000_000_000;
const exp = (offsetSeconds: number) => Math.floor(clock / 1000) + offsetSeconds;
const grant = (refresh: string, expiresInSeconds = 3600, tag = refresh) => tokenResponse({ access: accessToken({ expSeconds: exp(expiresInSeconds), tag }), refresh });
// Made when the request is answered, so the token's end date follows the clock of that moment.
const later = (refresh: string) => () => grant(refresh);

function build(options: { revoke?: (token: string) => Promise<void>; script?: Parameters<typeof scriptedFetch>[0]; local?: ReturnType<typeof fakeLocalAuth>; store?: ReturnType<typeof memoryStore>; browserResult?: (url: string) => Promise<{ type: 'success'; url: string } | { type: 'cancel' }> } = {}) {
  clock = 1_800_000_000_000;
  const store = options.store ?? memoryStore();
  const { fn, calls } = scriptedFetch(options.script ?? {});
  const browser = fakeBrowser(options.browserResult ?? (async (url) => ({ type: 'success', url: callbackFor(url) })));
  const local = options.local ?? fakeLocalAuth();
  const manager: SessionManager = createSessionManager({ vault: createVault(store), crypto: nodeCrypto, browser, localAuth: local, fetchFn: fn, now: () => clock, unlockPrompt: 'Mở Ludy', serverAllowed: (url) => url === SERVER, ...(options.revoke ? { revokeOnServer: options.revoke } : {}) });
  return { manager, store, calls, browser, local };
}

const signedIn = async (script: Parameters<typeof scriptedFetch>[0] = {}) => {
  const ctx = build({ script: { [CONFIG_URL]: [config()], [ENDPOINTS.tokenUrl]: [later('refresh-1'), ...(script[ENDPOINTS.tokenUrl] ?? [])] } });
  await ctx.manager.start();
  expect(await ctx.manager.signIn(SERVER)).toEqual({ ok: true });
  return ctx;
};

const stored = (store: ReturnType<typeof memoryStore>) => JSON.parse(store.data.get(SESSION_KEY) ?? 'null') as { refreshToken: string; orgSlug: string | null } | null;

describe('sign in', () => {
  it('signs in through the system browser, keeps only the refresh token in the secure storage and the access token in memory', async () => {
    const { manager, store, browser, calls } = await signedIn();
    expect(manager.state()).toEqual({ status: 'active', serverUrl: SERVER, orgSlug: null });
    expect(browser.opened).toHaveLength(1);
    expect(new URL(browser.opened[0] ?? '').origin).toBe(new URL(ENDPOINTS.authorizeUrl).origin);
    expect(stored(store)?.refreshToken).toBe('refresh-1');
    const blob = store.data.get(SESSION_KEY) ?? '';
    const access = await manager.accessToken();
    expect(access).toBeTruthy();
    expect(blob).not.toContain(access ?? 'x');
    // The server config was fetched with no cookies and no redirect followed.
    expect(calls[0]?.init.credentials).toBe('omit');
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it('refuses a phone with no screen lock before anything is opened or stored', async () => {
    const ctx = build({ local: fakeLocalAuth({ level: 'none' }) });
    await ctx.manager.start();
    expect(await ctx.manager.signIn(SERVER)).toEqual({ ok: false, reason: 'no-device-lock' });
    expect(ctx.browser.opened).toHaveLength(0);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.store.data.size).toBe(0);
  });

  it('refuses an address that is not an https origin, and a server that does not offer DOS ID sign-in', async () => {
    const ctx = build({ script: { [CONFIG_URL]: [jsonResponse(200, { signIn: 'form' })] } });
    await ctx.manager.start();
    expect(await ctx.manager.signIn('http://api.example.test')).toEqual({ ok: false, reason: 'unsupported-server' });
    expect(await ctx.manager.signIn('https://api.example.test/path')).toEqual({ ok: false, reason: 'unsupported-server' });
    expect(await ctx.manager.signIn(SERVER)).toEqual({ ok: false, reason: 'unsupported-server' });
    expect(ctx.browser.opened).toHaveLength(0);
  });

  it('reports an unreachable server', async () => {
    const ctx = build({ script: { [CONFIG_URL]: [new Error('offline')] } });
    await ctx.manager.start();
    expect(await ctx.manager.signIn(SERVER)).toEqual({ ok: false, reason: 'server-unreachable' });
  });

  it('stores nothing when the person cancels the browser', async () => {
    const ctx = build({ script: { [CONFIG_URL]: [config()] }, browserResult: async () => ({ type: 'cancel' }) });
    await ctx.manager.start();
    expect(await ctx.manager.signIn(SERVER)).toEqual({ ok: false, reason: 'cancelled' });
    expect(ctx.manager.state()).toEqual({ status: 'signed-out', notice: null });
    expect(ctx.store.data.size).toBe(0);
  });

  it('never exchanges a callback with the wrong state or at the wrong address', async () => {
    for (const bad of [(url: string) => callbackFor(url, { state: 'B'.repeat(43) }), (url: string) => callbackFor(url).replace('vn.ludy.app', 'evil.app')]) {
      const ctx = build({ script: { [CONFIG_URL]: [config()] }, browserResult: async (url) => ({ type: 'success', url: bad(url) }) });
      await ctx.manager.start();
      const result = await ctx.manager.signIn(SERVER);
      expect(result.ok).toBe(false);
      expect(ctx.calls.map((c) => c.url)).toEqual([CONFIG_URL]);
      expect(ctx.store.data.size).toBe(0);
    }
  });

  it('keeps nothing in memory either when the secure storage refuses the session', async () => {
    const store = memoryStore();
    store.failSet = true;
    const ctx = build({ store, script: { [CONFIG_URL]: [config()], [ENDPOINTS.tokenUrl]: [later('refresh-1')] } });
    await ctx.manager.start();
    expect(await ctx.manager.signIn(SERVER)).toEqual({ ok: false, reason: 'storage' });
    expect(ctx.manager.state()).toEqual({ status: 'signed-out', notice: null });
    expect(await ctx.manager.accessToken()).toBeNull();
  });

  it('refuses a server address this build does not allow, before any request (a typed address must not reach Cloud\'s provider)', async () => {
    const ctx = build({ script: { 'https://evil.example/api/config': [config()] } });
    await ctx.manager.start();
    expect(await ctx.manager.signIn('https://evil.example')).toEqual({ ok: false, reason: 'unsupported-server' });
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.browser.opened).toHaveLength(0);
  });

  it('runs one sign-in at a time', async () => {
    let release: (value: { type: 'cancel' }) => void = () => undefined;
    const ctx = build({ script: { [CONFIG_URL]: [config()] }, browserResult: () => new Promise((resolve) => (release = resolve)) });
    await ctx.manager.start();
    const first = ctx.manager.signIn(SERVER);
    expect(await ctx.manager.signIn(SERVER)).toEqual({ ok: false, reason: 'busy' });
    await vi.waitFor(() => expect(ctx.browser.opened).toHaveLength(1));
    release({ type: 'cancel' });
    expect(await first).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('redirects to the registered URI', () => {
    expect(REDIRECT_URI).toBe('vn.ludy.app://oauth-login/callback');
  });
});

describe('relaunch, lock and unlock', () => {
  it('starts locked when the secure storage holds a session, and refreshes only after the biometric', async () => {
    const { store } = await signedIn();
    const ctx = build({ store, local: fakeLocalAuth({ answers: [false, true] }), script: { [ENDPOINTS.tokenUrl]: [later('refresh-2')] } });
    await ctx.manager.start();
    expect(ctx.manager.state()).toEqual({ status: 'locked', serverUrl: SERVER });
    expect(await ctx.manager.accessToken()).toBeNull();
    // A refused biometric: still locked, and no request went out.
    expect(await ctx.manager.unlock()).toEqual({ ok: false, reason: 'cancelled' });
    expect(ctx.manager.state().status).toBe('locked');
    expect(ctx.calls).toHaveLength(0);
    expect(await ctx.manager.unlock()).toEqual({ ok: true });
    expect(ctx.manager.state().status).toBe('active');
    expect(ctx.local.prompts).toEqual(['Mở Ludy', 'Mở Ludy']);
    expect(await ctx.manager.accessToken()).toBeTruthy();
    // The refresh token rotated and the new one is the stored one.
    expect(stored(store)?.refreshToken).toBe('refresh-2');
  });

  it('starts signed out when the storage is empty', async () => {
    const ctx = build();
    await ctx.manager.start();
    expect(ctx.manager.state()).toEqual({ status: 'signed-out', notice: null });
  });

  it('goes back to locked, with the session kept, when the server cannot be reached at unlock', async () => {
    const { store } = await signedIn();
    const ctx = build({ store, script: { [ENDPOINTS.tokenUrl]: [new Error('offline')] } });
    await ctx.manager.start();
    expect(await ctx.manager.unlock()).toEqual({ ok: false, reason: 'offline' });
    expect(ctx.manager.state().status).toBe('locked');
    expect(stored(store)?.refreshToken).toBe('refresh-1');
  });

  it('signs out when the provider rejects the refresh token at unlock', async () => {
    const { store } = await signedIn();
    const ctx = build({ store, script: { [ENDPOINTS.tokenUrl]: [jsonResponse(400, { error: 'invalid_grant' })] } });
    await ctx.manager.start();
    expect(await ctx.manager.unlock()).toEqual({ ok: false, reason: 'signed-out' });
    expect(ctx.manager.state()).toEqual({ status: 'signed-out', notice: 'expired' });
    expect(store.data.size).toBe(0);
  });

  it('answers busy to a second unlock while one is open', async () => {
    const { store } = await signedIn();
    const ctx = build({ store, script: { [ENDPOINTS.tokenUrl]: [later('refresh-2')] } });
    await ctx.manager.start();
    const first = ctx.manager.unlock();
    expect(await ctx.manager.unlock()).toEqual({ ok: false, reason: 'busy' });
    expect(await first).toEqual({ ok: true });
    expect(ctx.local.prompts).toHaveLength(1);
  });

  it('forgets the access token when locked and asks again', async () => {
    const { manager } = await signedIn();
    manager.lock();
    expect(manager.state()).toEqual({ status: 'locked', serverUrl: SERVER });
    expect(await manager.accessToken()).toBeNull();
  });
});

describe('refresh token rotation', () => {
  it('refreshes a token that is about to end, keeping the new refresh token before it hands out the new access token', async () => {
    const { manager, store } = await signedIn({ [ENDPOINTS.tokenUrl]: [later('refresh-2')] });
    const first = await manager.accessToken();
    clock += (3600 * 1000) - REFRESH_MARGIN_MS + 1;
    const second = await manager.accessToken();
    expect(second).not.toBe(first);
    expect(stored(store)?.refreshToken).toBe('refresh-2');
  });

  it('runs one refresh when several requests need a token at once (a second use of a rotated token would end the session)', async () => {
    const { manager, calls } = await signedIn({ [ENDPOINTS.tokenUrl]: [later('refresh-2')] });
    clock += 3600 * 1000;
    const tokens = await Promise.all([manager.accessToken(), manager.accessToken(), manager.accessToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(calls.filter((c) => c.url === ENDPOINTS.tokenUrl)).toHaveLength(2);
  });

  it('keeps the session through a refresh that fails for any reason but a rejected token', async () => {
    const { manager, store } = await signedIn({ [ENDPOINTS.tokenUrl]: [jsonResponse(503, {}), later('refresh-2')] });
    clock += 3600 * 1000;
    expect(await manager.accessToken()).toBeNull();
    expect(manager.state().status).toBe('active');
    expect(stored(store)?.refreshToken).toBe('refresh-1');
    expect(await manager.accessToken()).toBeTruthy();
    expect(stored(store)?.refreshToken).toBe('refresh-2');
  });

  it('ends the session when the provider rejects the refresh token, and clears the secure storage', async () => {
    const { manager, store } = await signedIn({ [ENDPOINTS.tokenUrl]: [jsonResponse(400, { error: 'invalid_grant' })] });
    clock += 3600 * 1000;
    expect(await manager.accessToken()).toBeNull();
    expect(manager.state()).toEqual({ status: 'signed-out', notice: 'expired' });
    expect(store.data.size).toBe(0);
  });

  it('writes nothing back when the person signed out while a refresh was in flight', async () => {
    let answer: (response: Response) => void = () => undefined;
    const { manager, store } = await signedIn({ [ENDPOINTS.tokenUrl]: [() => new Promise<Response>((resolve) => (answer = resolve))] });
    clock += 3600 * 1000;
    const pending = manager.accessToken();
    await Promise.resolve();
    await Promise.resolve();
    const out = manager.signOut();
    answer(grant('refresh-late'));
    expect(await pending).toBeNull();
    await out;
    expect(manager.state().status).toBe('signed-out');
    expect(store.data.size).toBe(0);
  });

  it('still keeps the rotated refresh token when the phone locks while a refresh is in flight', async () => {
    let answer: (response: Response) => void = () => undefined;
    const { manager, store } = await signedIn({ [ENDPOINTS.tokenUrl]: [() => new Promise<Response>((resolve) => (answer = resolve))] });
    clock += 3600 * 1000;
    const pending = manager.accessToken();
    await Promise.resolve();
    await Promise.resolve();
    manager.lock();
    answer(grant('refresh-2'));
    expect(await pending).toBeNull();
    expect(stored(store)?.refreshToken).toBe('refresh-2');
    expect(manager.state().status).toBe('locked');
  });
});

describe('sign out and revocation', () => {
  it('sign-out clears the secure storage and the memory', async () => {
    const { manager, store } = await signedIn();
    await manager.signOut();
    expect(manager.state()).toEqual({ status: 'signed-out', notice: null });
    expect(store.data.size).toBe(0);
    expect(await manager.accessToken()).toBeNull();
  });

  it('still signs out in memory when the secure storage will not clear', async () => {
    const { manager, store } = await signedIn();
    store.failRemove = true;
    await manager.signOut();
    expect(manager.state().status).toBe('signed-out');
    expect(await manager.accessToken()).toBeNull();
  });

  it('signs out when the server says the session is over (a revoked device) and ignores other errors', async () => {
    for (const code of [{ status: 401, code: 'UNAUTHENTICATED' }, { status: 401, code: 'OAUTH_CLIENT_TOKEN_REFUSED' }, { status: 401, code: 'SESSION_REVOKED_IN_ORG' }]) {
      const { manager, store } = await signedIn();
      expect(manager.reportKernelError(code)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(manager.state()).toEqual({ status: 'signed-out', notice: 'revoked' });
      expect(store.data.size).toBe(0);
    }
    const { manager } = await signedIn();
    for (const error of [{ status: 500, code: 'INTERNAL' }, { status: 403, code: 'FORBIDDEN' }, { status: 401, code: 'MFA_REQUIRED' }, new Error('offline'), null]) {
      expect(manager.reportKernelError(error)).toBe(false);
    }
    expect(manager.state().status).toBe('active');
  });

  it('ends the session on the server on the person\'s own sign-out, but not when the server ended it', async () => {
    const revoked: string[] = [];
    const ctx = build({ revoke: async (token) => void revoked.push(token), script: { [CONFIG_URL]: [config()], [ENDPOINTS.tokenUrl]: [later('refresh-1')] } });
    await ctx.manager.start();
    await ctx.manager.signIn(SERVER);
    await ctx.manager.signOut();
    expect(revoked).toHaveLength(1);
    expect(ctx.store.data.size).toBe(0);
    const again = build({ revoke: async () => Promise.reject(new Error('x')), script: { [CONFIG_URL]: [config()], [ENDPOINTS.tokenUrl]: [later('refresh-1')] } });
    await again.manager.start();
    await again.manager.signIn(SERVER);
    await again.manager.signOut();
    expect(again.store.data.size).toBe(0);
  });

  it('keeps the org the person chose', async () => {
    const { manager, store } = await signedIn();
    await manager.setOrg('acme');
    expect(manager.state()).toEqual({ status: 'active', serverUrl: SERVER, orgSlug: 'acme' });
    expect(stored(store)?.orgSlug).toBe('acme');
  });
});
