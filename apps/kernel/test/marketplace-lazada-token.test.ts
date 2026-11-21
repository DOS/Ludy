// SPDX-License-Identifier: AGPL-3.0-only
// Renewing a Lazada connection's tokens (#2524, S3a = #4240) against a made-up Lazada token endpoint: the rotated pair is kept and the refresh life is not extended, a refresh token that is past its
// end or refused ends the connection (refused) while every other trouble is only a failure (never a refusal), one call is made to one host and never repeated, and no token, secret or Lazada
// sentence reaches a result. The sweep itself (one at a time, ifVersion, expired is not picked again) is tested in channel-refresh.db.test.ts, with this refresher through it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { channelRefreshers } from '../src/kernel.ts';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { LAZADA_REFRESH_HORIZON_SECONDS, LAZADA_TOKEN_HOST, LAZADA_TOKEN_HOSTS, LazadaRefresher } from '../src/marketplace-lazada-token.ts';
import { fakeLazadaToken, type FakeTokenCall } from './fake-lazada-token.ts';

const NOW = Date.parse('2026-11-21T03:00:00Z');
const DAY = 86_400_000;
const APP = { appKey: '123456', appSecret: 'test-only-app-secret' };
const REFRESH_END = NOW + 150 * DAY;
const secretOf = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...APP,
    accessToken: 'access-token-0',
    refreshToken: 'refresh-token-0',
    accessExpiresAt: new Date(NOW + 2 * DAY).toISOString(),
    refreshExpiresAt: new Date(REFRESH_END).toISOString(),
    sellerId: '1000100',
    country: 'vn',
    ...over,
  });

function setup(over: { intercept?: (call: FakeTokenCall) => Response | undefined; refreshExpiresAtMs?: number; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const fake = fakeLazadaToken({ ...APP, refreshToken: 'refresh-token-0', refreshExpiresAtMs: over.refreshExpiresAtMs ?? REFRESH_END, now: () => NOW, ...(over.intercept ? { intercept: over.intercept } : {}) });
  const fetchImpl = over.fetch ?? fake.fetch;
  const refresher = new LazadaRefresher({ fetch: hostBoundFetch(LAZADA_TOKEN_HOSTS, fetchImpl), now: () => new Date(NOW) });
  return { fake, refresher };
}
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('a refresh that works', () => {
  it('keeps the new pair, moves the access expiry, and leaves the refresh life where it was (a refresh does not extend it)', async () => {
    const { fake, refresher } = setup();
    const result = await refresher.refresh(secretOf());
    if (!('secret' in result)) throw new Error('expected a new secret');
    const next = JSON.parse(result.secret) as Record<string, unknown>;
    expect(next).toMatchObject({ accessToken: 'access-token-1', refreshToken: 'refresh-token-1', ...APP, sellerId: '1000100', country: 'vn' });
    expect(next.accessExpiresAt).toBe(new Date(NOW + 2_592_000 * 1000).toISOString());
    expect(result.expiresAt.getTime()).toBe(NOW + 2_592_000 * 1000);
    // The refresh life is the date it was, whole: Lazada's own countdown gave the same date.
    expect(next.refreshExpiresAt).toBe(new Date(REFRESH_END).toISOString());
    expect(fake.currentRefreshToken()).toBe('refresh-token-1');
  });

  it('believes no later date than the earlier of what it had and what the answer implies', async () => {
    // The answer counts down to a date 20 days sooner than the one the secret holds.
    const sooner = setup({ refreshExpiresAtMs: NOW + 130 * DAY });
    const result = await sooner.refresher.refresh(secretOf());
    if (!('secret' in result)) throw new Error('expected a new secret');
    expect(JSON.parse(result.secret).refreshExpiresAt).toBe(new Date(NOW + 130 * DAY).toISOString());
    // A secret with no date at all takes the answer's; an answer with no date leaves the secret's.
    const none = setup();
    const bare = await none.refresher.refresh(secretOf({ refreshExpiresAt: undefined }));
    if (!('secret' in bare)) throw new Error('expected a new secret');
    expect(JSON.parse(bare.secret).refreshExpiresAt).toBe(new Date(REFRESH_END).toISOString());
    const silent = setup({ intercept: () => json({ access_token: 'access-token-9', refresh_token: 'refresh-token-9', expires_in: 2_592_000, code: '0' }) });
    const kept = await silent.refresher.refresh(secretOf());
    if (!('secret' in kept)) throw new Error('expected a new secret');
    expect(JSON.parse(kept.secret).refreshExpiresAt).toBe(new Date(REFRESH_END).toISOString());
  });

  it('makes one signed POST to the one host: the system parameters in the address, the refresh token in the body only, and no access token', async () => {
    const { fake, refresher } = setup();
    await refresher.refresh(secretOf());
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call).toMatchObject({ method: 'POST', host: LAZADA_TOKEN_HOST, path: '/auth/token/refresh', form: { refresh_token: 'refresh-token-0' } });
    expect(Object.keys(call.query).sort()).toEqual(['app_key', 'sign', 'sign_method', 'timestamp']);
    expect(call.query).toMatchObject({ app_key: APP.appKey, sign_method: 'sha256', timestamp: String(NOW) });
    expect(call.url).not.toContain('refresh-token-0');
    expect(call.url).not.toContain('access-token-0');
    expect(call.url).not.toContain(APP.appSecret);
    // The fake checked the signature with its own implementation: had it drifted, the answer would be a refusal.
    expect(fake.calls).toHaveLength(1);
  });

  it('is signed by the seller\'s own app: a wrong app secret in the secret is a failure, not a refusal of the token', async () => {
    const { fake, refresher } = setup();
    const result = await refresher.refresh(secretOf({ appSecret: 'some-other-secret' }));
    expect(result).toEqual({ failed: 'IncompleteSignature' });
    expect(fake.currentRefreshToken()).toBe('refresh-token-0');
  });
});

describe('a refresh that is refused', () => {
  it('is refused with no call when the refresh token has no date left, has none, or the secret is not one', async () => {
    const { fake, refresher } = setup();
    expect(await refresher.refresh(secretOf({ refreshExpiresAt: new Date(NOW).toISOString() }))).toEqual({ refused: 'REFRESH_TOKEN_EXPIRED' });
    expect(await refresher.refresh(secretOf({ refreshExpiresAt: new Date(NOW - DAY).toISOString() }))).toEqual({ refused: 'REFRESH_TOKEN_EXPIRED' });
    expect(await refresher.refresh(secretOf({ refreshToken: undefined }))).toEqual({ refused: 'NO_REFRESH_TOKEN' });
    expect(await refresher.refresh(secretOf({ refreshToken: 'has a space' }))).toEqual({ refused: 'NO_REFRESH_TOKEN' });
    expect(await refresher.refresh('not json')).toEqual({ refused: 'BAD_SECRET' });
    expect(await refresher.refresh('[]')).toEqual({ refused: 'BAD_SECRET' });
    expect(await refresher.refresh(secretOf({ appSecret: '' }))).toEqual({ refused: 'BAD_SECRET' });
    expect(fake.calls).toHaveLength(0);
  });

  it('is refused when Lazada says the refresh token is invalid or expired, and the result is a short code, never Lazada\'s sentence', async () => {
    const used = setup();
    // A refresh token that was already used (the pair rotated) is the fake's own refusal.
    await used.refresher.refresh(secretOf());
    expect(await used.refresher.refresh(secretOf())).toEqual({ refused: 'IllegalRefreshToken' });
    const sentence = 'The refresh token is invalid; call 555-0100 or write to a.person@example.test';
    const hostile = setup({ intercept: () => json({ code: 'IllegalRefreshToken', type: 'ISV', message: sentence }) });
    const result = await hostile.refresher.refresh(secretOf());
    expect(result).toEqual({ refused: 'IllegalRefreshToken' });
    expect(JSON.stringify(result)).not.toContain('555');
    // A code that is not a short word is replaced, so a sentence cannot ride in the audit reason.
    const odd = setup({ intercept: () => json({ code: 'invalid refresh token, ask a.person@example.test', message: 'refresh token is invalid' }) });
    expect(await odd.refresher.refresh(secretOf())).toEqual({ refused: 'REFUSED' });
  });
});

describe('every other trouble is a failure, never a refusal (a refusal ends the connection), and nothing is asked twice', () => {
  const failed = async (intercept: (call: FakeTokenCall) => Response | undefined, expected: string) => {
    const { fake, refresher } = setup({ intercept });
    const result = await refresher.refresh(secretOf());
    expect(result).toEqual({ failed: expected });
    // One call: a refresh whose answer was lost may have spent the token, so it is not sent again, nor to another host.
    expect(fake.calls).toHaveLength(1);
    const text = JSON.stringify(result);
    for (const secret of ['refresh-token-0', 'access-token-0', APP.appSecret]) expect(text).not.toContain(secret);
  };

  it('a throttle, an outage and a signature or app problem', async () => {
    await failed(() => json({ code: 'ApiCallLimit', message: 'refresh token call limit' }, 429), '429');
    await failed(() => json('upstream', 503), '503');
    await failed(() => json({ code: 'ApiCallLimit', type: 'ISV', message: 'Api call limit' }), 'ApiCallLimit');
    await failed(() => json({ code: 'IncompleteSignature', type: 'ISV', message: 'signature does not match' }), 'IncompleteSignature');
    // A code the code does not know, even with a sentence about the app, is not a refusal of the token.
    await failed(() => json({ code: 'AppKeyNotFound', message: 'The app key is invalid' }), 'AppKeyNotFound');
  });

  it('a network error, a malformed answer and an answer that is not Lazada\'s shape', async () => {
    const down = setup({ fetch: async () => Promise.reject(new Error('connect ECONNRESET refresh-token-0')) });
    expect(await down.refresher.refresh(secretOf())).toEqual({ failed: 'NETWORK' });
    await failed(() => new Response('<html>not json</html>', { status: 200 }), 'BAD_ANSWER');
    await failed(() => json('[]'), 'BAD_ANSWER');
    await failed(() => json({ code: '0', access_token: 'access-token-9', expires_in: 2_592_000 }), 'BAD_ANSWER');
    await failed(() => json({ code: '0', access_token: 'has a space', refresh_token: 'refresh-token-9', expires_in: 2_592_000 }), 'BAD_ANSWER');
    await failed(() => json({ code: '0', access_token: 'access-token-9', refresh_token: 'refresh-token-9', expires_in: 5 }), 'BAD_ANSWER');
    await failed(() => json({ code: '0', access_token: 'access-token-9', refresh_token: 'refresh-token-9', expires_in: 10 ** 10 }), 'BAD_ANSWER');
    await failed(() => json({ code: '0', access_token: 'x'.repeat(401), refresh_token: 'refresh-token-9', expires_in: 2_592_000 }), 'BAD_ANSWER');
  });

  it('an answer larger than it can be (declared and streamed)', async () => {
    await failed(() => new Response('{}', { status: 200, headers: { 'content-length': '5000000' } }), 'BAD_ANSWER');
    await failed(() => new Response(JSON.stringify({ code: '0', pad: 'x'.repeat(80_000) }), { status: 200 }), 'BAD_ANSWER');
  });
});

describe('where it is wired and what it may reach', () => {
  const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };

  it('is registered under the marketplace provider only where MARKETPLACE_PROVIDERS names lazada, renewing five days ahead', () => {
    const named = channelRefreshers(loadConfig({ ...BASE, MARKETPLACE_PROVIDERS: 'sandbox, lazada' }));
    expect(named.marketplace_lazada).toBeInstanceOf(LazadaRefresher);
    expect(named.marketplace_lazada?.provider).toBe('marketplace_lazada');
    expect(named.marketplace_lazada?.horizonSeconds).toBe(LAZADA_REFRESH_HORIZON_SECONDS);
    // The sweep's scan caps the window at seven days.
    expect(LAZADA_REFRESH_HORIZON_SECONDS).toBe(5 * 86_400);
    expect(LAZADA_REFRESH_HORIZON_SECONDS).toBeLessThanOrEqual(7 * 86_400);
    expect(channelRefreshers(loadConfig({ ...BASE, MARKETPLACE_PROVIDERS: 'sandbox' })).marketplace_lazada).toBeUndefined();
    expect(channelRefreshers(loadConfig({ ...BASE, MARKETPLACE_PROVIDERS: '' })).marketplace_lazada).toBeUndefined();
  });

  it('reaches only the one token host, through the fetch it is given, with one request site and no other network way', () => {
    expect(LAZADA_TOKEN_HOSTS).toEqual(['api.lazada.com']);
    const source = readFileSync(new URL('../src/marketplace-lazada-token.ts', import.meta.url), 'utf8');
    const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    expect([...code.matchAll(/this\s*\.\s*fetchImpl\s*\(/g)]).toHaveLength(1);
    expect(code).not.toMatch(/\bglobalThis\.fetch\b|[^.\w]fetch\(|node:https?|undici|XMLHttpRequest|WebSocket/);
    // The only address in the code is the token host's refresh path (the host and the path are constants checked above).
    expect([...code.matchAll(/https:\/\/\S+?\?/g)].map((m) => m[0])).toEqual(['https://${LAZADA_TOKEN_HOST}/rest${REFRESH_PATH}?']);
    expect([...code.matchAll(/https?:\/\//g)]).toHaveLength(1);
    // The refresh call carries no access token, and the refresh token is never in the address.
    expect(code).not.toMatch(/access_token\s*:/);
  });

  it('is refused by the host-bound fetch for any other host (the allow-list, not the refresher, is the wall)', async () => {
    const bound = hostBoundFetch(LAZADA_TOKEN_HOSTS, async () => json({}));
    await expect(bound('https://api.lazada.vn/rest/auth/token/refresh')).rejects.toBeInstanceOf(Error);
    await expect(bound('http://api.lazada.com/rest/auth/token/refresh')).rejects.toBeInstanceOf(Error);
  });
});
