// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy extension's sign-in request: what the page accepts, where it sends the code, and how long it keeps a request
// while the member signs in (#2582, ADR-0047 point 10).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESKTOP_CLIENT_ID } from '@ludy/kernel-contract';
import { PENDING_CONNECT_TTL_MS, connectRedirect, filterScopesForModules, forgetConnect, parseConnectRequest, pendingConnect, rememberConnect } from '../src/lib/extension-connect.ts';

const EXTENSION = 'abcdefghijklmnopabcdefghijklmnop';
const ALLOWED = [EXTENSION];
const REDIRECT = `https://${EXTENSION}.chromiumapp.org/ludy`;
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const query = (over: Record<string, string | undefined> = {}) => {
  const params = new URLSearchParams();
  const all: Record<string, string | undefined> = { code_challenge: CHALLENGE, code_challenge_method: 'S256', redirect_uri: REDIRECT, state: 'st_1-A', scope: 'meetings', device: 'Chrome  trên máy bàn', ...over };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) params.set(k, v);
  return `?${params.toString()}`;
};

describe('parseConnectRequest', () => {
  it('accepts the extension\'s request and tidies its device name', () => {
    expect(parseConnectRequest(query(), ALLOWED)).toEqual({ client: 'extension', extensionId: EXTENSION, codeChallenge: CHALLENGE, redirect: REDIRECT, state: 'st_1-A', scopes: ['meetings'], deviceName: 'Chrome trên máy bàn' });
    expect(parseConnectRequest(query({ scope: undefined }), ALLOWED)?.scopes).toEqual(['meetings']);
    // The agenda scope (B2) rides with meetings: both is fine, agenda alone is not a request.
    expect(parseConnectRequest(query({ scope: 'meetings agenda' }), ALLOWED)?.scopes).toEqual(['agenda', 'meetings']);
    expect(parseConnectRequest(query({ scope: 'notes' }), ALLOWED)?.scopes).toEqual(['notes']);
    expect(parseConnectRequest(query({ scope: 'meetings agenda notes' }), ALLOWED)?.scopes).toEqual(['agenda', 'meetings', 'notes']);
    expect(parseConnectRequest(query({ scope: 'notes agenda' }), ALLOWED)).toBeNull();
    expect(parseConnectRequest(query({ scope: 'agenda' }), ALLOWED)).toBeNull();
    expect(filterScopesForModules(['agenda', 'meetings', 'notes'], ['notes'])).toEqual(['notes']);
    expect(filterScopesForModules(['agenda', 'meetings', 'notes'], ['meetings'])).toEqual(['agenda', 'meetings']);
    expect(filterScopesForModules(['agenda', 'meetings', 'notes'], ['crm'])).toEqual([]);
    expect(filterScopesForModules(['agenda', 'notes'], ['notes'])).toEqual(['notes']);
    expect(parseConnectRequest(query({ device: undefined }), ALLOWED)?.deviceName).toBe('');
    expect(parseConnectRequest(query({ device: 'x'.repeat(200) }), ALLOWED)?.deviceName).toHaveLength(80);
  });

  it('refuses a redirect that is not an extension\'s, a bad challenge, method, state or scope', () => {
    for (const redirect of [
      'https://evil.example/ludy',
      `http://${EXTENSION}.chromiumapp.org/`,
      `https://${EXTENSION}.chromiumapp.org.evil.example/`,
      `https://${EXTENSION}x.chromiumapp.org/`,
      `https://${EXTENSION.toUpperCase()}.chromiumapp.org/`,
      `https://${'q'.repeat(32)}.chromiumapp.org/`,
      `https://user@${EXTENSION}.chromiumapp.org/`,
      `https://${EXTENSION}.chromiumapp.org/a?b=c`,
      `https://${EXTENSION}.chromiumapp.org`,
    ]) {
      expect(parseConnectRequest(query({ redirect_uri: redirect }), ALLOWED), redirect).toBeNull();
    }
    expect(parseConnectRequest(query({ code_challenge: 'short' }), ALLOWED)).toBeNull();
    expect(parseConnectRequest(query({ code_challenge_method: 'plain' }), ALLOWED)).toBeNull();
    expect(parseConnectRequest(query({ code_challenge_method: undefined }), ALLOWED)).toBeNull();
    expect(parseConnectRequest(query({ state: '' }), ALLOWED)).toBeNull();
    expect(parseConnectRequest(query({ state: 'a b' }), ALLOWED)).toBeNull();
    expect(parseConnectRequest(query({ scope: 'meetings crm' }), ALLOWED)).toBeNull();
    expect(parseConnectRequest(query({ scope: '' }), ALLOWED)).toBeNull();
    expect(parseConnectRequest('', ALLOWED)).toBeNull();
  });
});

describe('connectRedirect', () => {
  it('sends the code, the org and the state back to the extension, or the refusal', () => {
    const request = parseConnectRequest(query(), ALLOWED)!;
    expect(connectRedirect(request, { code: 'crc_x', org: 'acme' })).toBe(`${REDIRECT}?code=crc_x&org=acme&state=st_1-A`);
    expect(connectRedirect(request, { error: 'access_denied' })).toBe(`${REDIRECT}?error=access_denied&state=st_1-A`);
  });
});

describe('the allow-list of extension ids (#2740)', () => {
  it('refuses a well-formed chromiumapp.org address of an extension the deployment does not list', () => {
    const other = 'ponmlkjihgfedcbaponmlkjihgfedcba'.slice(0, 32).padEnd(32, 'p');
    expect(parseConnectRequest(query({ redirect_uri: `https://${other}.chromiumapp.org/ludy` }), ALLOWED)).toBeNull();
    // An empty list (an EXTENSION_IDS setting cannot make one; this is the fail-closed shape) refuses every extension.
    expect(parseConnectRequest(query(), [])).toBeNull();
    expect(parseConnectRequest(query({ redirect_uri: `https://${other}.chromiumapp.org/ludy` }), [other, EXTENSION])?.extensionId).toBe(other);
  });

  it('drops a kept request whose extension left the list', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
    const request = parseConnectRequest(query(), ALLOWED)!;
    rememberConnect(request, 1_700_000_000_000);
    expect(pendingConnect([], 1_700_000_000_000)).toBeNull();
  });
});

describe('the request kept while the member signs in', () => {
  const store = new Map<string, string>();
  const original = globalThis.sessionStorage;
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
  });
  afterEach(() => Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: original }));

  it('keeps it for ten minutes in this tab, then forgets it', () => {
    const request = parseConnectRequest(query(), ALLOWED)!;
    const now = 1_700_000_000_000;
    rememberConnect(request, now);
    expect(pendingConnect(ALLOWED, now + 1000)).toEqual(request);
    expect(pendingConnect(ALLOWED, now + PENDING_CONNECT_TTL_MS)).toBeNull();
    expect(store.size).toBe(0);
    rememberConnect(request, now);
    forgetConnect();
    expect(pendingConnect(ALLOWED, now)).toBeNull();
  });

  it('checks what storage holds as it checked the address', () => {
    store.set('ludy-pending-extension-connect', JSON.stringify({ request: { extensionId: EXTENSION, codeChallenge: CHALLENGE, redirect: 'https://evil.example/', state: 's', scopes: ['meetings'], deviceName: '' }, savedAt: Date.now() }));
    expect(pendingConnect(ALLOWED)).toBeNull();
    store.set('ludy-pending-extension-connect', 'not json');
    expect(pendingConnect(ALLOWED)).toBeNull();
    const request = parseConnectRequest(query(), ALLOWED)!;
    const now = 1_700_000_000_000;
    store.set('crove-pending-extension-connect', JSON.stringify({ request, savedAt: now }));
    expect(pendingConnect(ALLOWED, now + 1000)).toEqual(request);
    expect(store.has('ludy-pending-extension-connect')).toBe(true);
    expect(store.has('crove-pending-extension-connect')).toBe(false);
  });
});

describe('Ludy Desktop sign-in (ADR-0055 slice 2, #4515)', () => {
  const LOOPBACK = 'http://127.0.0.1:49152/ludy-desktop/callback';
  const desktop = (over: Record<string, string | undefined> = {}) => query({ client: 'desktop', redirect_uri: LOOPBACK, scope: undefined, device: 'Ludy Desktop, Windows', ...over });

  it('accepts a loopback request with no scope, bound to the reserved desktop id, whatever the extension list holds', () => {
    expect(parseConnectRequest(desktop(), [])).toEqual({
      client: 'desktop',
      extensionId: DESKTOP_CLIENT_ID,
      codeChallenge: CHALLENGE,
      redirect: LOOPBACK,
      state: 'st_1-A',
      scopes: [],
      deviceName: 'Ludy Desktop, Windows',
    });
    // Least privilege: when desktop capture is off, any requested scope stays refused.
    for (const scope of ['meetings', 'agenda', 'notes', 'meetings agenda', 'crm']) expect(parseConnectRequest(desktop({ scope }), []), scope).toBeNull();
  });

  it('allows meetings and agenda for Ludy Desktop only when desktop capture is enabled, and still refuses notes', () => {
    expect(parseConnectRequest(desktop(), [], { desktopCapture: true })?.scopes).toEqual([]);
    expect(parseConnectRequest(desktop({ scope: 'meetings' }), [], { desktopCapture: true })?.scopes).toEqual(['meetings']);
    expect(parseConnectRequest(desktop({ scope: 'meetings agenda' }), [], { desktopCapture: true })?.scopes).toEqual(['agenda', 'meetings']);
    for (const scope of ['agenda', 'notes', 'meetings notes', 'meetings agenda notes', 'crm']) {
      expect(parseConnectRequest(desktop({ scope }), [], { desktopCapture: true }), scope).toBeNull();
    }
    const scoped = parseConnectRequest(desktop({ scope: 'meetings' }), [], { desktopCapture: true })!;
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
    rememberConnect(scoped, 1_700_000_000_000);
    expect(pendingConnect([], 1_700_000_000_500, { desktopCapture: true })).toEqual(scoped);
    rememberConnect(scoped, 1_700_000_000_000);
    expect(pendingConnect([], 1_700_000_000_500)).toBeNull();
  });

  it('refuses a redirect that is not exactly the loopback callback, and any other client', () => {
    for (const redirect of [
      'http://127.0.0.1:49152/other',
      'http://127.0.0.1:49152/ludy-desktop/callback?x=1',
      'http://localhost:49152/ludy-desktop/callback',
      'http://127.0.0.2:49152/ludy-desktop/callback',
      'https://127.0.0.1:49152/ludy-desktop/callback',
      'http://127.0.0.1/ludy-desktop/callback',
      'http://127.0.0.1:80/ludy-desktop/callback',
      'http://127.0.0.1:65536/ludy-desktop/callback',
      'http://user@127.0.0.1:49152/ludy-desktop/callback',
      'http://127.0.0.1:49152@evil.example/ludy-desktop/callback',
      'https://evil.example/ludy-desktop/callback',
      REDIRECT,
    ]) {
      expect(parseConnectRequest(desktop({ redirect_uri: redirect }), []), redirect).toBeNull();
    }
    expect(parseConnectRequest(desktop({ client: 'mobile' }), [])).toBeNull();
    expect(parseConnectRequest(desktop({ code_challenge_method: 'plain' }), [])).toBeNull();
    expect(parseConnectRequest(desktop({ state: '' }), [])).toBeNull();
    // A loopback redirect without the desktop marker is not an extension's request.
    expect(parseConnectRequest(query({ redirect_uri: LOOPBACK }), ALLOWED)).toBeNull();
  });

  it('sends the code back to the loopback address and keeps the marker while the member signs in', () => {
    const request = parseConnectRequest(desktop(), [])!;
    expect(connectRedirect(request, { code: 'crc_x', org: 'acme' })).toBe(`${LOOPBACK}?code=crc_x&org=acme&state=st_1-A`);
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
    rememberConnect(request, 1_700_000_000_000);
    expect(pendingConnect([], 1_700_000_000_500)).toEqual(request);
  });
});
