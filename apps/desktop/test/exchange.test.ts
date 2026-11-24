// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ExchangeError, exchangeCode, type FetchLike } from '../src/exchange.ts';
import { checkSession } from '../src/session-check.ts';

const TOKEN = `crx_${'t'.repeat(43)}`;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('exchangeCode', () => {
  it('posts the code, the verifier and the desktop marker, with no Origin and no redirects', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return json(200, { token: TOKEN, tokenId: 'tid', orgId: 'oid', scopes: [], expiresAt: '2027-02-01T00:00:00.000Z' });
    };
    const done = await exchangeCode(fetchImpl, 'https://ludy.example.vn', 'crc_x', 'verifier');
    expect(done).toEqual({ token: TOKEN, tokenId: 'tid', orgId: 'oid', scopes: [], expiresAt: '2027-02-01T00:00:00.000Z' });
    expect(seen!.url).toBe('https://ludy.example.vn/api/extension/token');
    expect(seen!.init.method).toBe('POST');
    expect(JSON.parse(String(seen!.init.body))).toEqual({ code: 'crc_x', codeVerifier: 'verifier', client: 'desktop' });
    expect(Object.keys(seen!.init.headers as Record<string, string>).map((h) => h.toLowerCase())).not.toContain('origin');
    expect(seen!.init.redirect).toBe('error');
  });

  it.each([
    [400, 'invalid_code'],
    [429, 'rate_limited'],
    [503, 'unreachable'],
    [404, 'unexpected'],
  ])('maps %i to %s', async (status, failure) => {
    await expect(exchangeCode(async () => json(status, {}), 'https://l', 'c', 'v')).rejects.toMatchObject({ failure });
  });

  it('maps a network failure to unreachable and a malformed answer to unexpected', async () => {
    await expect(exchangeCode(async () => { throw new TypeError('offline'); }, 'https://l', 'c', 'v')).rejects.toBeInstanceOf(ExchangeError);
    await expect(exchangeCode(async () => json(200, { token: 'nope' }), 'https://l', 'c', 'v')).rejects.toMatchObject({ failure: 'unexpected' });
  });
});

describe('checkSession', () => {
  it('sends the token only as a bearer on /api/extension/me', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const status = await checkSession(async (url, init) => {
      seen = { url: String(url), headers: init?.headers as Record<string, string> };
      return json(200, { client: 'desktop' });
    }, 'https://ludy.example.vn', TOKEN);
    expect(status).toBe('valid');
    expect(seen!.url).toBe('https://ludy.example.vn/api/extension/me');
    expect(seen!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
  it('treats 401 as revoked and everything else as unreachable', async () => {
    expect(await checkSession(async () => json(401, { code: 'EXTENSION_TOKEN_INVALID' }), 'https://l', TOKEN)).toBe('revoked');
    expect(await checkSession(async () => json(500, {}), 'https://l', TOKEN)).toBe('unreachable');
    expect(await checkSession(async () => { throw new TypeError('offline'); }, 'https://l', TOKEN)).toBe('unreachable');
  });
});
