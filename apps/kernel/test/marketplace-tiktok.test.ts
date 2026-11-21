// SPDX-License-Identifier: AGPL-3.0-only
// The TikTok Shop signer, caller, shop list and connection test (#2524, T1 = #4256) against a made-up TikTok (fake-tiktok.ts): the signature checked by the fake's own implementation of the official rule
// (and by vectors computed outside this code base), the timestamp in seconds and the token in a header, every documented refusal ending as one of the port's kinds, a hostile page ending as
// `not_recognized`, and no token, secret, address or TikTok sentence in any error. No call to TikTok: the fetch is the fake.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MarketplaceProviderError } from '@crove/mod-finance';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { signTiktokRequest } from '../src/marketplace-tiktok-sign.ts';
import { TIKTOK_API_HOST, TIKTOK_HOSTS, TiktokApiError, parseTiktokSecret, testTiktokConnection, tiktokCaller, tiktokShops } from '../src/marketplace-tiktok.ts';
import { fakeShop, fakeTiktok, type FakeTiktokOptions } from './fake-tiktok.ts';

const KEY = { appKey: '123abc', appSecret: 'helloworld', accessToken: 'TTP_access_token_1' };
const SECRET = JSON.stringify({ ...KEY, shopCipher: 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3', shopId: '7000714532876273420' });
const NOW = Date.parse('2026-11-21T08:00:00Z');

function setup(over: Partial<FakeTiktokOptions> & { callerNow?: number } = {}) {
  const { callerNow, ...rest } = over;
  const fake = fakeTiktok({ ...KEY, shops: [fakeShop()], now: () => NOW, ...rest });
  const waits: number[] = [];
  const call = tiktokCaller({ fetch: hostBoundFetch(TIKTOK_HOSTS, fake.fetch), now: () => new Date(callerNow ?? NOW), sleep: async (ms) => void waits.push(ms) });
  return { call, fake, waits };
}

const outcome = async (run: () => Promise<unknown>): Promise<{ kind: string; reason: string | null }> => {
  try {
    await run();
    return { kind: 'no error', reason: null };
  } catch (error) {
    if (error instanceof TiktokApiError) return { kind: error.kind, reason: error.reason };
    return { kind: error instanceof MarketplaceProviderError ? error.kind : `other: ${String(error)}`, reason: null };
  }
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the signature', () => {
  // Computed with a separate implementation (Python hmac), from the rule of the official page.
  it('matches vectors computed outside this code base: a POST with its body, a GET, and a request with no body signed', () => {
    const query = { app_key: '123abc', timestamp: '1700000000', shop_cipher: 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3', page_size: '20', sort_field: 'create_time', sort_order: 'ASC', sign: 'ignored', access_token: 'ignored' };
    expect(signTiktokRequest('helloworld', '/order/202309/orders/search', query, '{"order_status":"UNPAID","update_time_ge":1623812664}')).toBe('37565241e284831836cfe1cc9de05f97e86b71f643894b84980274b91d72f169');
    expect(signTiktokRequest('helloworld', '/authorization/202309/shops', { app_key: '123abc', timestamp: '1700000000' }, null)).toBe('c6e43eb0571c43fa1536ec27fbebffbf647d1c3179a9757313d128db259cbb2c');
    // A multipart request is signed without its body, which the caller says by passing null (this vector fixes only the arithmetic of that case, not who decides it).
    expect(signTiktokRequest('helloworld', '/product/202309/images/upload', { app_key: '123abc', timestamp: '1700000000' }, null)).toBe('9c3a4ca09dd51d35d33231d39768bdd7be62033ce56dcb86e706c5838a923a9a');
  });

  it('leaves out `sign` and `access_token`, does not depend on the order the keys were written in, and changes with the path, the body and the secret', () => {
    const base = signTiktokRequest('s', '/p', { b: '2', a: '1' }, '{}');
    expect(signTiktokRequest('s', '/p', { a: '1', b: '2', sign: 'x', access_token: 'y' }, '{}')).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(signTiktokRequest('s', '/q', { a: '1', b: '2' }, '{}')).not.toBe(base);
    expect(signTiktokRequest('s', '/p', { a: '1', b: '2' }, '{ }')).not.toBe(base);
    expect(signTiktokRequest('t', '/p', { a: '1', b: '2' }, '{}')).not.toBe(base);
    // No body and an empty body are the same string.
    expect(signTiktokRequest('s', '/p', { a: '1' }, null)).toBe(signTiktokRequest('s', '/p', { a: '1' }, ''));
  });
});

describe('the sealed secret', () => {
  it('reads the app, the token and the shop, and refuses a malformed secret without echoing it', () => {
    expect(parseTiktokSecret(SECRET)).toEqual({ ...KEY, shopCipher: 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3', shopId: '7000714532876273420' });
    expect(parseTiktokSecret(JSON.stringify(KEY))).toEqual({ ...KEY, shopCipher: null, shopId: null });
    // What this reader returns reads back (a later slice re-seals it): explicit nulls are no shop yet.
    expect(parseTiktokSecret(JSON.stringify(parseTiktokSecret(JSON.stringify(KEY))))).toEqual({ ...KEY, shopCipher: null, shopId: null });
    for (const bad of ['not json', '{}', 'null', JSON.stringify({ ...KEY, appKey: '' }), JSON.stringify({ ...KEY, accessToken: 'has space' }), JSON.stringify({ ...KEY, appSecret: 7 }), JSON.stringify({ ...KEY, shopId: 'abc' }), JSON.stringify({ ...KEY, shopCipher: 'a b' })]) {
      expect(() => parseTiktokSecret(bad)).toThrow(MarketplaceProviderError);
    }
    try {
      parseTiktokSecret('{"appKey":"leakme"');
    } catch (error) {
      expect(String(error)).not.toContain('leakme');
    }
  });
});

describe('the call', () => {
  it('is a GET to the one API host with the token in a header, the time in seconds and a signature the fake accepts, and no access_token or shop_cipher in the address', async () => {
    const { call, fake } = setup();
    const shops = await tiktokShops(call, parseTiktokSecret(SECRET));
    expect(shops).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
    const sent = fake.calls[0]!;
    expect(sent).toMatchObject({ method: 'GET', host: TIKTOK_API_HOST, path: '/authorization/202309/shops' });
    expect(sent.query.timestamp).toBe(String(Math.floor(NOW / 1000)));
    expect(sent.query.sign).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.query.app_key).toBe('123abc');
    expect(Object.keys(sent.query).sort()).toEqual(['app_key', 'sign', 'timestamp']);
    expect(sent.headers['x-tts-access-token']).toBe(KEY.accessToken);
    // Neither the token nor the secret is in the address.
    expect(sent.url).not.toContain(KEY.accessToken);
    expect(sent.url).not.toContain(KEY.appSecret);
    expect(sent.body).toBeNull();
  });

  it('signs a POST over the exact body it sends, and the fake refuses a body that was changed after signing', async () => {
    const { call, fake } = setup();
    const body = '{"order_status":"UNPAID","update_time_ge":1623812664}';
    const data = await call(parseTiktokSecret(SECRET), { method: 'POST', path: '/order/202309/orders/search', query: { page_size: '20', shop_cipher: 'GCP_x' }, body });
    expect(data).toMatchObject({ orders: [], total_count: 0 });
    const sent = fake.calls[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.body).toBe(body);
    // The same signed address with another body is not accepted: the body is part of what is signed.
    const replay = await fake.fetch(sent.url, { method: 'POST', headers: { 'x-tts-access-token': KEY.accessToken, 'content-type': 'application/json' }, body: `${body} ` });
    expect(await replay.json()).toMatchObject({ code: 106001 });
  });

  it('refuses a request that tries to pass the signature, the token, the key or the time itself (a caller bug), with no call made', async () => {
    const { call, fake } = setup();
    for (const key of ['sign', 'access_token', 'app_key', 'timestamp']) {
      await expect(call(parseTiktokSecret(SECRET), { method: 'GET', path: '/authorization/202309/shops', query: { [key]: 'x' } })).rejects.toBeInstanceOf(RangeError);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('spaces the calls of one app and shop, and does not make another app wait', async () => {
    const { call, waits } = setup();
    const credential = parseTiktokSecret(SECRET);
    await tiktokShops(call, credential);
    await tiktokShops(call, credential);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    waits.length = 0;
    // Another app key is its own queue.
    await tiktokShops(call, { ...credential, appKey: 'other-app' }).catch(() => undefined);
    expect(waits).toHaveLength(0);
  });
});

describe('the shop list', () => {
  it('keeps only the id, the name, the market, the seller type, the cipher and the code, and nothing of the answer\'s other fields', async () => {
    const { call } = setup({ shops: [fakeShop(), fakeShop({ id: '7000714532876273421', sellerType: 'CROSS_BORDER', region: 'GB', name: 'Shop hai', cipher: 'GCP_second', code: 'GBCB1' })] });
    const shops = await tiktokShops(call, parseTiktokSecret(SECRET));
    expect(shops).toEqual([
      { id: '7000714532876273420', name: 'Cửa hàng mẫu', region: 'VN', sellerType: 'LOCAL', cipher: 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3', code: 'VNLCBA4LLU8' },
      { id: '7000714532876273421', name: 'Shop hai', region: 'GB', sellerType: 'CROSS_BORDER', cipher: 'GCP_second', code: 'GBCB1' },
    ]);
    expect(JSON.stringify(shops)).not.toContain('chu.shop');
  });

  it('is an empty list when no shop authorized the app', async () => {
    expect(await tiktokShops(setup({ shops: [] }).call, parseTiktokSecret(SECRET))).toEqual([]);
  });

  it('refuses a page with a malformed, repeated or too many shops, or a list that is not a list', async () => {
    const bad = async (shops: unknown) =>
      outcome(() =>
        tiktokShops(
          setup({ intercept: (_h, path) => (path === '/authorization/202309/shops' ? json({ code: 0, data: { shops } }) : undefined) }).call,
          parseTiktokSecret(SECRET),
        ),
      );
    const one = { id: '7000714532876273420', name: 'x', region: 'VN', seller_type: 'LOCAL', cipher: 'GCP_x', code: 'C1' };
    expect((await bad({ rows: [] })).kind).toBe('not_recognized');
    // A missing or null list is a changed or foreign answer, not "no shops": the explicit empty list above stays valid.
    expect((await bad(undefined)).kind).toBe('not_recognized');
    expect((await bad(null)).kind).toBe('not_recognized');
    expect((await bad([{ ...one, id: 'abc' }])).kind).toBe('not_recognized');
    expect((await bad([{ ...one, region: 'vn' }])).kind).toBe('not_recognized');
    expect((await bad([{ ...one, seller_type: 'OTHER' }])).kind).toBe('not_recognized');
    expect((await bad([{ ...one, cipher: 'has space' }])).kind).toBe('not_recognized');
    expect((await bad([{ ...one, cipher: undefined }])).kind).toBe('not_recognized');
    expect((await bad([one, one])).kind).toBe('not_recognized');
    expect((await bad(Array.from({ length: 101 }, (_, i) => ({ ...one, id: String(7000000000000000000 + i) })))).kind).toBe('not_recognized');
    expect((await bad([7])).kind).toBe('not_recognized');
  });
});

describe('what a refusal becomes', () => {
  const answered = (status: number, body: unknown) => ({ intercept: (_h: string, path: string) => (path === '/authorization/202309/shops' ? json(body, status) : undefined) });
  const run = (over: Partial<FakeTiktokOptions>) => outcome(() => tiktokShops(setup(over).call, parseTiktokSecret(SECRET)));

  it('maps the documented codes to the port\'s kinds, as HTTP 200 or with the status they ride on', async () => {
    expect(await run(answered(401, { code: 105002, message: 'Expired credentials.' }))).toEqual({ kind: 'credentials', reason: 'expired' });
    expect(await run(answered(200, { code: 106001, message: 'Invalid credentials. The sign is invalid.' }))).toEqual({ kind: 'credentials', reason: 'signature' });
    expect(await run(answered(200, { code: 105005, message: 'Access denied.' }))).toEqual({ kind: 'credentials', reason: 'scope' });
    expect(await run(answered(401, { code: 101000, message: 'Invalid query or header.' }))).toEqual({ kind: 'credentials', reason: 'unknown' });
    expect(await run(answered(200, { code: 36009033, message: 'Access denied. Your IP address is not in the IP allow list.' }))).toEqual({ kind: 'credentials', reason: 'ip' });
    expect(await run(answered(401, { code: 36009043, message: 'Your shop has been deactivated or is closing.' }))).toEqual({ kind: 'credentials', reason: 'inactive' });
    expect(await run(answered(401, { code: 36009044, message: 'Your seller account has been deactivated.' }))).toEqual({ kind: 'credentials', reason: 'inactive' });
    expect(await run(answered(429, { code: 36009002, message: 'Too many requests.' }))).toEqual({ kind: 'rate_limited', reason: null });
    expect(await run(answered(200, { code: 36009002, message: 'Too many requests.' }))).toEqual({ kind: 'rate_limited', reason: null });
    expect(await run(answered(429, 'not json'))).toEqual({ kind: 'rate_limited', reason: null });
  });

  it('tells the credential refusals of 36009004 from its other uses by the documented words, and a wrong clock is not a refusal', async () => {
    expect(await run(answered(401, { code: 36009004, message: 'Missing credentials. The request does not include a required signature in the query.' }))).toMatchObject({ kind: 'credentials' });
    expect(await run(answered(401, { code: 36009004, message: 'Invalid credentials. The `x-tts-access-token` header is invalid.' }))).toMatchObject({ kind: 'credentials' });
    expect(await run(answered(401, { code: 36009004, message: 'Invalid credentials. The `access_token` header is invalid.' }))).toMatchObject({ kind: 'credentials' });
    expect(await run(answered(401, { code: 36009004, message: 'Invalid credentials. Invalid `app_key` query parameter.' }))).toMatchObject({ kind: 'credentials' });
    expect(await run(answered(400, { code: 36009004, message: 'Invalid timestamp. The value must not be earlier than 5 minutes before the current time.' }))).toEqual({ kind: 'unreachable', reason: null });
    // A 401 with wording the page does not list is still a refusal of the credentials; a 400 with it is not.
    expect(await run(answered(401, { code: 36009004, message: 'The x-tts-access-token header value is not accepted.' }))).toMatchObject({ kind: 'credentials' });
    expect(await run(answered(400, { code: 36009004, message: 'Something else entirely.' }))).toEqual({ kind: 'unreachable', reason: null });
    expect(await run(answered(401, { code: 36009004, message: 'Invalid timestamp. The value must not exceed the current time by more than 30 seconds.' }))).toEqual({ kind: 'unreachable', reason: null });
    expect(await run(answered(400, { code: 36009004, message: 'Unexpected identifier. The `shop_cipher` query parameter is not required for this request.' }))).toEqual({ kind: 'unreachable', reason: null });
  });

  it('treats everything else as unreachable, and an HTTP 401 or 403 with no readable body as credentials', async () => {
    expect(await run(answered(500, { code: 36009003, message: 'Internal error.' }))).toEqual({ kind: 'unreachable', reason: null });
    expect(await run(answered(200, { code: 99999, message: 'new code' }))).toEqual({ kind: 'unreachable', reason: null });
    expect(await run(answered(200, 'not json'))).toEqual({ kind: 'unreachable', reason: null });
    expect(await run(answered(200, [1, 2]))).toEqual({ kind: 'unreachable', reason: null });
    expect(await run({ intercept: () => new Response('<html>blocked</html>', { status: 403 }) })).toEqual({ kind: 'credentials', reason: 'unknown' });
    expect(await run({ intercept: () => new Response('<html>blocked</html>', { status: 401 }) })).toEqual({ kind: 'credentials', reason: 'unknown' });
  });

  it('answers a clock that is ten minutes behind as unreachable (the gateway\'s timestamp window), never as a refusal of the credentials', async () => {
    const result = await outcome(() => tiktokShops(setup({ callerNow: NOW - 10 * 60_000 }).call, parseTiktokSecret(SECRET)));
    expect(result).toEqual({ kind: 'unreachable', reason: null });
  });

  it('puts nothing of TikTok\'s text, the address, a token or the secret in the error, whatever failed', async () => {
    const planted = 'planted-sentence-sk-live-12345';
    const capture = async (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) => {
      const call = tiktokCaller({ fetch: fetchImpl, now: () => new Date(NOW), sleep: async () => undefined });
      try {
        await tiktokShops(call, parseTiktokSecret(SECRET));
      } catch (error) {
        return `${String(error)} ${error instanceof Error ? error.message : ''} ${JSON.stringify(error)}`;
      }
      return '';
    };
    const texts = [
      await capture(async () => json({ code: 105005, message: planted }, 200)),
      await capture(async () => json({ code: 36009004, message: `Invalid credentials. ${planted}` }, 401)),
      await capture(async () => json({ code: 36009002, message: planted }, 429)),
      // A transport error that carries the address (as a fetch error can): the address has the signature, the token is in a header.
      await capture(async (url) => {
        throw new Error(`connect ECONNRESET ${url} ${planted}`);
      }),
    ];
    for (const text of texts) {
      expect(text).toContain('marketplace provider error');
      for (const forbidden of [planted, KEY.accessToken, KEY.appSecret, 'open-api.tiktokglobalshop.com', 'sign=']) expect(text).not.toContain(forbidden);
    }
  });
});

describe('the connection test', () => {
  it('says works when the shop list answers, and names what a refusal was in the port\'s words', async () => {
    expect(await testTiktokConnection(setup().call, SECRET)).toBe('works');
    expect(await testTiktokConnection(setup({ shops: [] }).call, SECRET)).toBe('works');
    expect(await testTiktokConnection(setup({ appSecret: 'another-secret' }).call, SECRET)).toBe('wrong_credentials');
    expect(await testTiktokConnection(setup({ accessToken: 'another-token' }).call, SECRET)).toBe('wrong_credentials');
    const refuse = (code: number) => ({ intercept: () => json({ code, message: 'x' }) });
    expect(await testTiktokConnection(setup(refuse(105005)).call, SECRET)).toBe('api_not_enabled');
    expect(await testTiktokConnection(setup(refuse(36009033)).call, SECRET)).toBe('ip_not_allowed');
    expect(await testTiktokConnection(setup(refuse(105002)).call, SECRET)).toBe('wrong_credentials');
    expect(await testTiktokConnection(setup(refuse(36009002)).call, SECRET)).toBe('unreachable');
    expect(await testTiktokConnection(setup({ intercept: () => new Response('down', { status: 503 }) }).call, SECRET)).toBe('unreachable');
  });

  it('is wrong_credentials for a secret that does not parse, with no call made', async () => {
    const { call, fake } = setup();
    expect(await testTiktokConnection(call, 'not json')).toBe('wrong_credentials');
    expect(fake.calls).toHaveLength(0);
  });

  it('is not a working connection when the answer has no shop list at all', async () => {
    const noList = (data: unknown) => ({ intercept: (_h: string, path: string) => (path === '/authorization/202309/shops' ? json({ code: 0, data }) : undefined) });
    expect(await testTiktokConnection(setup(noList({})).call, SECRET)).toBe('unreachable');
    expect(await testTiktokConnection(setup(noList(undefined)).call, SECRET)).toBe('unreachable');
    expect(await testTiktokConnection(setup(noList({ shops: [] })).call, SECRET)).toBe('works');
  });

  it('is unreachable when the transport fails', async () => {
    const call = tiktokCaller({ fetch: async () => Promise.reject(new Error('down')), now: () => new Date(NOW), sleep: async () => undefined });
    expect(await testTiktokConnection(call, SECRET)).toBe('unreachable');
  });
});

describe('what it may reach', () => {
  const source = readFileSync(new URL('../src/marketplace-tiktok.ts', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');

  it('reaches only the one API host, through the fetch it is given, from one request site, and calls one read path', () => {
    expect(TIKTOK_HOSTS).toEqual(['open-api.tiktokglobalshop.com']);
    expect([...code.matchAll(/\boptions\.fetch\s*\(/g)]).toHaveLength(1);
    expect(code).not.toMatch(/\bglobalThis\.fetch\b|[^.\w]fetch\(|node:https?|undici|XMLHttpRequest|WebSocket/);
    expect([...code.matchAll(/https?:\/\//g)]).toHaveLength(1);
    expect([...code.matchAll(/const (\w+_PATH) = '([^']+)'/g)].map((m) => [m[1], m[2]])).toEqual([['SHOPS_PATH', '/authorization/202309/shops']]);
    // The access token is sent in a header and never as a query parameter; nothing is logged.
    expect(code).not.toMatch(/access_token\s*:|console\.|logger/);
  });

  it('is refused by the host-bound fetch for any other host, a plain http address or the token host (the allow-list, not the code, is the wall)', async () => {
    const bound = hostBoundFetch(TIKTOK_HOSTS, async () => json({}));
    await expect(bound('https://auth.tiktok-shops.com/api/v2/token/get')).rejects.toBeInstanceOf(Error);
    await expect(bound('http://open-api.tiktokglobalshop.com/authorization/202309/shops')).rejects.toBeInstanceOf(Error);
    await expect(bound('https://example.com/')).rejects.toBeInstanceOf(Error);
    await expect(bound('https://open-api.tiktokglobalshop.com/authorization/202309/shops')).resolves.toBeInstanceOf(Response);
  });
});
