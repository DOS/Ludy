// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy extension's sign-in request: what the page accepts, where it sends the code, and how long it keeps a request
// while the member signs in (#2582, ADR-0047 point 10).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_CONNECT_TTL_MS, connectRedirect, forgetConnect, parseConnectRequest, pendingConnect, rememberConnect } from '../src/lib/extension-connect.ts';

const EXTENSION = 'abcdefghijklmnopabcdefghijklmnop';
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
    expect(parseConnectRequest(query())).toEqual({ codeChallenge: CHALLENGE, redirect: REDIRECT, state: 'st_1-A', scopes: ['meetings'], deviceName: 'Chrome trên máy bàn' });
    expect(parseConnectRequest(query({ scope: undefined }))?.scopes).toEqual(['meetings']);
    expect(parseConnectRequest(query({ device: undefined }))?.deviceName).toBe('');
    expect(parseConnectRequest(query({ device: 'x'.repeat(200) }))?.deviceName).toHaveLength(80);
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
      expect(parseConnectRequest(query({ redirect_uri: redirect })), redirect).toBeNull();
    }
    expect(parseConnectRequest(query({ code_challenge: 'short' }))).toBeNull();
    expect(parseConnectRequest(query({ code_challenge_method: 'plain' }))).toBeNull();
    expect(parseConnectRequest(query({ code_challenge_method: undefined }))).toBeNull();
    expect(parseConnectRequest(query({ state: '' }))).toBeNull();
    expect(parseConnectRequest(query({ state: 'a b' }))).toBeNull();
    expect(parseConnectRequest(query({ scope: 'meetings crm' }))).toBeNull();
    expect(parseConnectRequest(query({ scope: '' }))).toBeNull();
    expect(parseConnectRequest('')).toBeNull();
  });
});

describe('connectRedirect', () => {
  it('sends the code, the org and the state back to the extension, or the refusal', () => {
    const request = parseConnectRequest(query())!;
    expect(connectRedirect(request, { code: 'crc_x', org: 'acme' })).toBe(`${REDIRECT}?code=crc_x&org=acme&state=st_1-A`);
    expect(connectRedirect(request, { error: 'access_denied' })).toBe(`${REDIRECT}?error=access_denied&state=st_1-A`);
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
    const request = parseConnectRequest(query())!;
    const now = 1_700_000_000_000;
    rememberConnect(request, now);
    expect(pendingConnect(now + 1000)).toEqual(request);
    expect(pendingConnect(now + PENDING_CONNECT_TTL_MS)).toBeNull();
    expect(store.size).toBe(0);
    rememberConnect(request, now);
    forgetConnect();
    expect(pendingConnect(now)).toBeNull();
  });

  it('checks what storage holds as it checked the address', () => {
    store.set('crove-pending-extension-connect', JSON.stringify({ request: { codeChallenge: CHALLENGE, redirect: 'https://evil.example/', state: 's', scopes: ['meetings'], deviceName: '' }, savedAt: Date.now() }));
    expect(pendingConnect()).toBeNull();
    store.set('crove-pending-extension-connect', 'not json');
    expect(pendingConnect()).toBeNull();
  });
});
