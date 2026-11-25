// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLudyClient, isMfaRequired, isOrgAccessRevoked, isServerRefusal, isStepUpRequired, isUnauthenticated, requestHeaders } from '../src/index.ts';

afterEach(() => vi.unstubAllGlobals());

describe('requestHeaders', () => {
  it('sends the bearer token and the org, each only when there is one', () => {
    expect(requestHeaders('t', 'acme')).toEqual({ authorization: 'Bearer t', 'x-ludy-org': 'acme' });
    expect(requestHeaders(null, null)).toEqual({});
    expect(requestHeaders('t', null)).toEqual({ authorization: 'Bearer t' });
  });
});

describe('createLudyClient', () => {
  it('calls the kernel\'s RPC path at the given origin, asking for the headers on every request', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', async (request: Request) => {
      seen.push({ url: request.url, authorization: request.headers.get('authorization') });
      return new Response(JSON.stringify({ code: 'UNAUTHENTICATED', status: 401, message: 'no' }), { status: 401, headers: { 'content-type': 'application/json' } });
    });
    let n = 0;
    const client = createLudyClient({ origin: 'https://api.example.test', headers: () => requestHeaders(`token-${(n += 1)}`, null) });
    await expect(client.me.get()).rejects.toBeTruthy();
    await expect(client.me.get()).rejects.toBeTruthy();
    expect(seen.map((s) => s.url)).toEqual(['https://api.example.test/api/rpc/me/get', 'https://api.example.test/api/rpc/me/get']);
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });
});

describe('kernel refusals', () => {
  it('recognizes the codes by their code and status', () => {
    expect(isMfaRequired({ code: 'MFA_REQUIRED' })).toBe(true);
    expect(isStepUpRequired({ code: 'STEP_UP_REQUIRED' })).toBe(true);
    expect(isOrgAccessRevoked({ code: 'SESSION_REVOKED_IN_ORG' })).toBe(true);
    expect(isServerRefusal({ status: 403 })).toBe(true);
    expect(isServerRefusal({ status: 500 })).toBe(false);
    expect(isServerRefusal(null)).toBe(false);
  });

  it('calls a session dead on 401 or an unauthenticated code, but not when a second factor or an org revoke is the reason', () => {
    expect(isUnauthenticated({ status: 401 })).toBe(true);
    expect(isUnauthenticated({ code: 'UNAUTHORIZED' })).toBe(true);
    expect(isUnauthenticated({ status: 401, code: 'MFA_REQUIRED' })).toBe(false);
    expect(isUnauthenticated({ status: 401, code: 'SESSION_REVOKED_IN_ORG' })).toBe(false);
    expect(isUnauthenticated({ status: 500 })).toBe(false);
    expect(isUnauthenticated(undefined)).toBe(false);
  });
});
