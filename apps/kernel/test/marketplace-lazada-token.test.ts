// SPDX-License-Identifier: AGPL-3.0-only
// The Lazada token API (#2524, S3a = #4240) against a made-up Lazada: the authorization code traded for a pair, and a connection's tokens renewed. The rotated pair is kept and the refresh life is not
// extended; a refresh token past its end, or one Lazada names as dead BY CODE, ends the connection (refused) while every other trouble is only a failure (a refusal expires a healthy connection);
// one call is made to one host and never repeated; and no token, secret, e-mail or Lazada sentence reaches a result. The sweep itself (one at a time, ifVersion, expired is not picked again) is tested in
// channel-refresh.db.test.ts, with this refresher through it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { channelRefreshers } from '../src/kernel.ts';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { parseLazadaSecret } from '../src/marketplace-lazada.ts';
import { LAZADA_AUTH_HOST, LAZADA_REFRESH_HORIZON_SECONDS, LAZADA_TOKEN_HOSTS, LazadaRefresher, createLazadaToken } from '../src/marketplace-lazada-token.ts';
import { fakeLazadaToken, type FakeTokenCall } from './fake-lazada-token.ts';

const NOW = Date.parse('2026-11-21T03:00:00Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
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

interface Setup {
  intercept?: (call: FakeTokenCall) => Response | undefined;
  refreshExpiresAtMs?: number;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: number;
}
function setup(over: Setup = {}) {
  const clock = over.now ?? NOW;
  const fake = fakeLazadaToken({ ...APP, refreshToken: 'refresh-token-0', refreshExpiresAtMs: over.refreshExpiresAtMs ?? REFRESH_END, now: () => clock, ...(over.intercept ? { intercept: over.intercept } : {}) });
  const bound = hostBoundFetch(LAZADA_TOKEN_HOSTS, over.fetch ?? fake.fetch);
  const refresher = new LazadaRefresher({ fetch: bound, now: () => new Date(clock) });
  return { fake, refresher, fetch: bound, now: () => new Date(clock) };
}
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const GOOD = { code: '0', access_token: 'access-token-9', refresh_token: 'refresh-token-9', expires_in: 2_592_000, refresh_expires_in: 12_960_000 };

describe('a refresh that works', () => {
  it('keeps the new pair, moves the access expiry, and leaves the refresh life where it was (a refresh does not extend it)', async () => {
    const { fake, refresher } = setup();
    const result = await refresher.refresh(secretOf());
    if (!('secret' in result)) throw new Error('expected a new secret');
    const next = JSON.parse(result.secret) as Record<string, unknown>;
    expect(next).toMatchObject({ accessToken: 'access-token-1', refreshToken: 'refresh-token-1', ...APP, sellerId: '1000100', country: 'vn' });
    expect(next.accessExpiresAt).toBe(new Date(NOW + 2_592_000 * 1000).toISOString());
    expect(next.refreshedAt).toBe(new Date(NOW).toISOString());
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
    // A secret with no date takes the answer's; an answer with no date leaves the secret's; neither leaves none (a mistyped old value is dropped, not kept).
    const bare = await setup().refresher.refresh(secretOf({ refreshExpiresAt: undefined }));
    if (!('secret' in bare)) throw new Error('expected a new secret');
    expect(JSON.parse(bare.secret).refreshExpiresAt).toBe(new Date(REFRESH_END).toISOString());
    const silent = setup({ intercept: () => json({ code: '0', access_token: 'access-token-9', refresh_token: 'refresh-token-9', expires_in: 2_592_000 }) });
    const kept = await silent.refresher.refresh(secretOf());
    if (!('secret' in kept)) throw new Error('expected a new secret');
    expect(JSON.parse(kept.secret).refreshExpiresAt).toBe(new Date(REFRESH_END).toISOString());
    const none = await silent.refresher.refresh(secretOf({ refreshExpiresAt: 12345 }));
    if (!('secret' in none)) throw new Error('expected a new secret');
    expect(JSON.parse(none.secret)).not.toHaveProperty('refreshExpiresAt');
  });

  it('makes one signed POST to the one host: the system parameters in the address, the refresh token in the body only, and no access token', async () => {
    const { fake, refresher } = setup();
    expect(await refresher.refresh(secretOf())).toHaveProperty('secret');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call).toMatchObject({ method: 'POST', host: LAZADA_AUTH_HOST, path: '/auth/token/refresh', form: { refresh_token: 'refresh-token-0' } });
    expect(Object.keys(call.form)).toEqual(['refresh_token']);
    expect(Object.keys(call.query).sort()).toEqual(['app_key', 'sign', 'sign_method', 'timestamp']);
    expect(call.query).toMatchObject({ app_key: APP.appKey, sign_method: 'sha256', timestamp: String(NOW) });
    for (const secret of ['refresh-token-0', 'access-token-0', APP.appSecret]) expect(call.url).not.toContain(secret);
  });

  it('is signed by the seller\'s own app: a wrong app secret in the secret is a failure, not a refusal of the token', async () => {
    const { fake, refresher } = setup();
    expect(await refresher.refresh(secretOf({ appSecret: 'some-other-secret' }))).toEqual({ failed: 'IncompleteSignature' });
    expect(fake.currentRefreshToken()).toBe('refresh-token-0');
  });

  it('takes a lifetime it does not know as a day, so a good pair is never thrown away over a field', async () => {
    for (const odd of [undefined, 5, 10 ** 10, 'soon', -1]) {
      const { refresher } = setup({ intercept: () => json({ ...GOOD, expires_in: odd }) });
      const result = await refresher.refresh(secretOf());
      if (!('secret' in result)) throw new Error(`expected a new secret for ${String(odd)}`);
      expect(JSON.parse(result.secret)).toMatchObject({ accessToken: 'access-token-9', refreshToken: 'refresh-token-9' });
      expect(result.expiresAt.getTime()).toBe(NOW + DAY);
    }
  });

  it('is not asked again within six hours of the last renewal (a short access life is due at every sweep), and is again after', async () => {
    const recent = setup();
    expect(await recent.refresher.refresh(secretOf({ refreshedAt: new Date(NOW - HOUR).toISOString() }))).toEqual({ skipped: 'recent' });
    expect(recent.fake.calls).toHaveLength(0);
    for (const at of [new Date(NOW - 7 * HOUR).toISOString(), new Date(NOW + HOUR).toISOString(), 'never', undefined]) {
      const again = setup();
      expect(await again.refresher.refresh(secretOf({ refreshedAt: at }))).toHaveProperty('secret');
      expect(again.fake.calls).toHaveLength(1);
    }
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

  it('is refused when Lazada\'s CODE says the refresh token is dead, and the result is a short code, never Lazada\'s sentence', async () => {
    const used = setup();
    // A refresh token that was already used (the pair rotated) is the fake's own refusal.
    await used.refresher.refresh(secretOf());
    expect(await used.refresher.refresh(secretOf())).toEqual({ refused: 'IllegalRefreshToken' });
    const sentence = 'The refresh token is invalid; call 555-0100 or write to a.person@example.test';
    for (const code of ['IllegalRefreshToken', 'InvalidRefreshToken', 'ExpiredRefreshToken', 'invalid_refresh_token']) {
      const hostile = setup({ intercept: () => json({ code, type: 'ISV', message: sentence }) });
      const result = await hostile.refresher.refresh(secretOf());
      expect(result).toEqual({ refused: code });
      expect(JSON.stringify(result)).not.toContain('555');
    }
  });

  it('is refused for the OAuth word invalid_grant, with or without a code, in a 200 or a 400', async () => {
    for (const reply of [() => json({ error: 'invalid_grant', error_description: 'a sentence' }), () => json({ error: 'invalid_grant' }, 400), () => json({ code: 'E1000', error: 'invalid_grant' }, 400)]) {
      const { refresher } = setup({ intercept: reply });
      expect(await refresher.refresh(secretOf())).toMatchObject({ refused: expect.stringMatching(/^(invalid_grant|E1000)$/) });
    }
  });

  it('is NOT refused by free text: a message that names the refresh token in a bad request, a signature or an app problem is a failure', async () => {
    await failed(() => json({ code: 'InvalidParameter', message: 'refresh_token is malformed' }), 'InvalidParameter');
    await failed(() => json({ code: 'IncompleteSignature', message: 'Invalid signature for refresh_token request' }), 'IncompleteSignature');
    await failed(() => json({ message: 'refresh_token API not found' }), 'BAD_ANSWER');
    await failed(() => json({ error: 'server_error', error_description: 'invalid refresh token' }), 'BAD_ANSWER');
    // A code that is not a short word cannot ride in a result, and is not a refusal either.
    await failed(() => json({ code: 'invalid refresh token, ask a.person@example.test', message: 'refresh token is invalid' }), 'UNKNOWN');
  });
});

// One call, a failure, and nothing of the secret in the result.
async function failed(intercept: (call: FakeTokenCall) => Response | undefined, expected: string) {
  const { fake, refresher } = setup({ intercept });
  const result = await refresher.refresh(secretOf());
  expect(result).toEqual({ failed: expected });
  // One call: a refresh whose answer was lost may have spent the token, so it is not sent again, nor to another host.
  expect(fake.calls).toHaveLength(1);
  const text = JSON.stringify(result);
  for (const secret of ['refresh-token-0', 'access-token-0', APP.appSecret]) expect(text).not.toContain(secret);
}

describe('every other trouble is a failure, never a refusal (a refusal ends the connection), and nothing is asked twice', () => {
  it('a throttle, an outage, an app or signature problem and a code the code does not know', async () => {
    await failed(() => json({ code: 'ApiCallLimit', message: 'refresh token call limit' }, 429), '429');
    await failed(() => json('upstream', 503), '503');
    await failed(() => json({ code: 'ApiCallLimit', type: 'ISV', message: 'Api call limit' }), 'ApiCallLimit');
    await failed(() => json({ code: 'IncompleteSignature', type: 'ISV', message: 'signature does not match' }), 'IncompleteSignature');
    await failed(() => json({ code: 'AppKeyNotFound', message: 'The app key is invalid' }), 'AppKeyNotFound');
    // A non-2xx answer is never a success, even when its body looks like one.
    await failed(() => json(GOOD, 400), 'HTTP_400');
    await failed(() => json({ ...GOOD, code: undefined }, 403), 'HTTP_403');
  });

  it('a network error, a malformed answer and an answer that is not Lazada\'s shape', async () => {
    const down = setup({ fetch: async () => Promise.reject(new Error('connect ECONNRESET refresh-token-0')) });
    expect(await down.refresher.refresh(secretOf())).toEqual({ failed: 'NETWORK' });
    await failed(() => new Response('<html>not json</html>', { status: 200 }), 'BAD_ANSWER');
    await failed(() => new Response('', { status: 200 }), 'BAD_ANSWER');
    await failed(() => json('[]'), 'BAD_ANSWER');
    await failed(() => json({ code: '0', access_token: 'access-token-9', expires_in: 2_592_000 }), 'BAD_ANSWER');
    await failed(() => json({ code: '0', access_token: 'has a space', refresh_token: 'refresh-token-9', expires_in: 2_592_000 }), 'BAD_ANSWER');
    await failed(() => json({ code: '0', access_token: 'x'.repeat(401), refresh_token: 'refresh-token-9', expires_in: 2_592_000 }), 'BAD_ANSWER');
  });

  it('an answer larger than it can be (declared and streamed)', async () => {
    await failed(() => new Response('{}', { status: 200, headers: { 'content-length': '5000000' } }), 'BAD_ANSWER');
    await failed(() => new Response(JSON.stringify({ code: '0', pad: 'x'.repeat(80_000) }), { status: 200 }), 'BAD_ANSWER');
  });
});

describe('createLazadaToken, the authorization code traded for a pair', () => {
  const input = { ...APP, code: 'auth-code-1' };
  const make = (over: Setup = {}) => {
    const s = setup(over);
    return { ...s, create: (i: Parameters<typeof createLazadaToken>[1] = input) => createLazadaToken({ fetch: s.fetch, now: s.now }, i) };
  };

  it('returns the sealed secret, the two dates and the seller, and keeps no e-mail or account name', async () => {
    const { create, fake } = make();
    const grant = await create();
    if (!('secret' in grant)) throw new Error('expected a grant');
    expect(JSON.parse(grant.secret)).toEqual({
      ...APP,
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
      accessExpiresAt: new Date(NOW + 2_592_000 * 1000).toISOString(),
      refreshExpiresAt: new Date(REFRESH_END).toISOString(),
      refreshedAt: new Date(NOW).toISOString(),
      sellerId: '1000100',
      country: 'vn',
    });
    expect(grant.accessExpiresAt.getTime()).toBe(NOW + 2_592_000 * 1000);
    expect(grant.refreshExpiresAt?.getTime()).toBe(REFRESH_END);
    expect(grant).toMatchObject({ sellerId: '1000100', country: 'vn' });
    expect(grant.secret).not.toContain('example.test');
    expect(grant.secret).not.toContain('2000200');
    // S1 reads it as the credential of a call, and the refresher takes it from here (not at once: it was just made).
    expect(parseLazadaSecret(grant.secret)).toEqual({ ...APP, accessToken: 'access-token-1' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: 'POST', host: LAZADA_AUTH_HOST, path: '/auth/token/create', form: { code: 'auth-code-1' } });
    expect(Object.keys(fake.calls[0]!.query).sort()).toEqual(['app_key', 'sign', 'sign_method', 'timestamp']);
    expect(fake.calls[0]!.url).not.toContain('auth-code-1');
    expect(await new LazadaRefresher({ fetch: hostBoundFetch(LAZADA_TOKEN_HOSTS, fake.fetch), now: () => new Date(NOW) }).refresh(grant.secret)).toEqual({ skipped: 'recent' });
    const later = await new LazadaRefresher({ fetch: hostBoundFetch(LAZADA_TOKEN_HOSTS, fake.fetch), now: () => new Date(NOW + 7 * HOUR) }).refresh(grant.secret);
    expect(later).toHaveProperty('secret');
  });

  it('sends the code alone (the official page says `uuid` is invalid and must not be used), and refuses a code or an app that is not the right shape with no call', async () => {
    const one = make();
    expect(await one.create()).toHaveProperty('secret');
    expect(one.fake.calls[0]!.form).toEqual({ code: 'auth-code-1' });
    const none = make();
    expect(await none.create({ ...input, code: 'has a space' })).toEqual({ refused: 'BAD_CODE' });
    expect(await none.create({ ...input, appSecret: '' })).toEqual({ refused: 'BAD_SECRET' });
    expect(none.fake.calls).toHaveLength(0);
  });

  it('is refused for a code Lazada names as bad, used or expired, and a code works once', async () => {
    const { create } = make();
    expect(await create()).toHaveProperty('secret');
    expect(await create()).toEqual({ refused: 'InvalidAuthorizationCode' });
    const sentence = 'The code is invalid, mail a.person@example.test';
    for (const code of ['InvalidAuthorizationCode', 'IllegalCode', 'ExpiredCode', 'UsedAuthorizationCode']) {
      const hostile = make({ intercept: () => json({ code, message: sentence }) });
      const result = await hostile.create();
      expect(result).toEqual({ refused: code });
      expect(JSON.stringify(result)).not.toContain('example.test');
    }
    expect(await make({ intercept: () => json({ error: 'invalid_grant' }, 400) }).create()).toEqual({ refused: 'invalid_grant' });
  });

  it('fails, never refuses, on a wrong app secret, a throttle, an outage or an answer that is not the shape; one call each', async () => {
    const wrong = make();
    expect(await wrong.create({ ...input, appSecret: 'some-other-secret' })).toEqual({ failed: 'IncompleteSignature' });
    for (const [reply, expected] of [
      [() => json({ code: 'ApiCallLimit' }, 429), '429'],
      [() => json('upstream', 502), '502'],
      [() => json({ code: 'InvalidParameter', message: 'the code parameter is invalid' }), 'InvalidParameter'],
      [() => json({ code: '0', access_token: 'access-token-9' }), 'BAD_ANSWER'],
      [() => new Response('<html></html>', { status: 200 }), 'BAD_ANSWER'],
    ] as const) {
      const one = make({ intercept: reply });
      const result = await one.create();
      expect(result).toEqual({ failed: expected });
      expect(one.fake.calls).toHaveLength(1);
      for (const secret of ['auth-code-1', APP.appSecret]) expect(JSON.stringify(result)).not.toContain(secret);
    }
    const down = make({ fetch: async () => Promise.reject(new Error('connect ECONNRESET')) });
    expect(await down.create()).toEqual({ failed: 'NETWORK' });
  });

  it('keeps a good pair whose lifetime or refresh life it cannot read, and leaves the seller out when the answer has none', async () => {
    const { create } = make({ intercept: () => json({ code: '0', access_token: 'access-token-9', refresh_token: 'refresh-token-9' }) });
    const grant = await create();
    if (!('secret' in grant)) throw new Error('expected a grant');
    expect(grant).toMatchObject({ refreshExpiresAt: null, sellerId: null, country: null });
    expect(grant.accessExpiresAt.getTime()).toBe(NOW + DAY);
    const kept = JSON.parse(grant.secret) as Record<string, unknown>;
    expect(kept).not.toHaveProperty('refreshExpiresAt');
    expect(kept).not.toHaveProperty('sellerId');
    expect(kept).toMatchObject({ accessToken: 'access-token-9', refreshToken: 'refresh-token-9' });
  });
});

describe('where it is wired and what it may reach', () => {
  const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'ludy-auth', WEB_DIST: '/nonexistent' };

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
    expect(LAZADA_TOKEN_HOSTS).toEqual(['auth.lazada.com']);
    const source = readFileSync(new URL('../src/marketplace-lazada-token.ts', import.meta.url), 'utf8');
    const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    expect([...code.matchAll(/\bfetchImpl\s*\(/g)]).toHaveLength(1);
    expect(code).not.toMatch(/\bglobalThis\.fetch\b|[^.\w]fetch\(|node:https?|undici|XMLHttpRequest|WebSocket/);
    // The only address in the code is a token host's path (the hosts and the two paths are constants checked here), and the method is POST alone.
    expect([...code.matchAll(/https:\/\/\S+?\?/g)].map((m) => m[0])).toEqual(['https://${host}/rest${path}?']);
    expect([...code.matchAll(/https?:\/\//g)]).toHaveLength(1);
    expect([...code.matchAll(/\bmethod:\s*'([A-Z]+)'/g)].map((m) => m[1])).toEqual(['POST']);
    expect([...code.matchAll(/postToken\(\s*[^,]+,\s*(\w+),\s*(\w+),/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual(['LAZADA_AUTH_HOST CREATE_PATH', 'LAZADA_AUTH_HOST REFRESH_PATH']);
    expect([...code.matchAll(/const (\w+_PATH) = '([^']+)'/g)].map((m) => [m[1], m[2]])).toEqual([['REFRESH_PATH', '/auth/token/refresh'], ['CREATE_PATH', '/auth/token/create']]);
    // No access token is ever put on these calls.
    expect(code).not.toMatch(/access_token\s*:/);
  });

  it('is refused by the host-bound fetch for any other host or a plain http address (the allow-list, not the code, is the wall)', async () => {
    const bound = hostBoundFetch(LAZADA_TOKEN_HOSTS, async () => json({}));
    await expect(bound('https://api.lazada.vn/rest/auth/token/refresh')).rejects.toBeInstanceOf(Error);
    await expect(bound('http://api.lazada.com/rest/auth/token/refresh')).rejects.toBeInstanceOf(Error);
    await expect(bound('https://api.lazada.com/rest/auth/token/refresh')).rejects.toBeInstanceOf(Error);
    await expect(bound('https://auth.lazada.com/rest/auth/token/create')).resolves.toBeInstanceOf(Response);
  });
});
