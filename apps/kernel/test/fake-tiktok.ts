// SPDX-License-Identifier: AGPL-3.0-only
// A made-up TikTok Shop Open Platform for the T1 tests (#2524, #4256): an in-process `fetch` that answers the two hosts the adapter uses, in the shape of the OFFICIAL Partner Center pages read on
// 2026-11-21 (authorization-overview-202407, sign-your-api-request, common-parameters, common-errors, get-authorized-shops-202309):
//   - auth.tiktok-shops.com: GET /api/v2/token/get (authorization code, single use, 30 minutes) and GET /api/v2/token/refresh (rotating, the authorization end does not move), the parameters in the query;
//   - open-api.tiktokglobalshop.com: GET /authorization/202309/shops and a signed POST /order/202309/orders/search whose answer is empty (it exists to prove the body is signed as sent).
// It verifies the signature with its OWN implementation of the rule (written again, over the raw query text, not the adapter's function), checks the timestamp window (5 minutes back, 30 seconds ahead) and
// the `x-tts-access-token` header, and refuses `shop_cipher` where the endpoint does not take it. Its answers carry a seller's name and an owner e-mail on purpose, so the tests can show none of it is kept.
// No network.
import { createHmac } from 'node:crypto';

export interface FakeTiktokShop {
  id: string;
  name: string;
  region: string;
  sellerType: string;
  cipher: string;
  code: string;
}

export interface FakeTiktokCall {
  method: string;
  host: string;
  path: string;
  // The query exactly as sent, decoded.
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  url: string;
}

export interface FakeTiktokOptions {
  appKey: string;
  appSecret: string;
  accessToken: string;
  shops?: FakeTiktokShop[];
  // The authorization codes that work once.
  codes?: readonly string[];
  // The refresh token that works now; it is spent by a refresh.
  refreshToken?: string;
  // The one date the seller's authorization ends at, in ms (a refresh does not move it).
  authorizationEndsAtMs?: number;
  userType?: number;
  now?: () => number;
  // Crafts an answer instead of the fake's own (a refusal, a throttle, a hostile or malformed body); returns undefined to let the fake answer.
  intercept?: (host: string, path: string, query: Record<string, string>) => Response | undefined;
}

// The rule of the official page, written once more and over the raw query text: split on `&`, decode, drop `sign` and `access_token`, sort, concatenate, put the path in front and the body behind, wrap in the
// secret, HMAC-SHA256, lower-case hex.
function expectedSign(secret: string, path: string, rawQuery: string, body: string | null): string {
  const pairs = rawQuery
    .split('&')
    .filter((part) => part !== '')
    .map((part) => {
      const at = part.indexOf('=');
      return [decodeURIComponent(part.slice(0, at).replace(/\+/g, ' ')), decodeURIComponent(part.slice(at + 1).replace(/\+/g, ' '))] as const;
    })
    .filter(([key]) => key !== 'sign' && key !== 'access_token')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let text = path;
  for (const [key, value] of pairs) text += key + value;
  if (body !== null) text += body;
  return createHmac('sha256', secret).update(secret + text + secret, 'utf8').digest('hex');
}

export function fakeTiktok(options: FakeTiktokOptions) {
  const calls: FakeTiktokCall[] = [];
  const nowMs = options.now ?? (() => Date.now());
  const unusedCodes = new Set(options.codes ?? []);
  let currentRefresh = options.refreshToken ?? 'TTP_R0';
  let rotation = 0;
  let accessToken = options.accessToken;
  const authorizationEndsAtMs = options.authorizationEndsAtMs ?? nowMs() + 90 * 86_400_000;
  const shops = options.shops ?? [];

  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const failure = (code: number, message: string, status = 200) => reply({ code, message, request_id: '2026112107000000000000000000AA' }, status);

  const grantData = () => ({
    access_token: accessToken,
    access_token_expire_in: Math.floor(nowMs() / 1000) + 7 * 86_400,
    refresh_token: currentRefresh,
    refresh_token_expire_in: Math.floor(authorizationEndsAtMs / 1000),
    open_id: '7010736057180325637',
    seller_name: 'Cửa hàng Thử Nghiệm của Nguyễn Văn Thử',
    seller_base_region: 'VN',
    user_type: options.userType ?? 0,
    granted_scopes: ['seller.order.info', 'seller.finance.info', 'seller.authorization.info'],
  });

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.protocol !== 'https:') throw new Error(`the fake TikTok does not serve ${url.protocol}`);
    const rawQuery = url.search.replace(/^\?/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === 'string' ? init.body : null;
    const method = init?.method ?? 'GET';
    calls.push({ method, host: url.host, path: url.pathname, query, headers, body, url: input });
    const hostile = options.intercept?.(url.host, url.pathname, query);
    if (hostile) return hostile;

    if (url.host === 'auth.tiktok-shops.com') {
      if (method !== 'GET') return failure(36009010, 'Invalid method.', 405);
      if (query.app_key !== options.appKey || query.app_secret !== options.appSecret) return failure(10000, 'Invalid app credentials.');
      if (url.pathname === '/api/v2/token/get') {
        if (query.grant_type !== 'authorized_code') return failure(10001, 'Invalid grant type.');
        const code = query.auth_code ?? '';
        if (!unusedCodes.has(code)) return failure(36004004, 'Invalid auth code.');
        unusedCodes.delete(code);
        rotation += 1;
        accessToken = `${options.accessToken}_${rotation}`;
        currentRefresh = `TTP_R${rotation}`;
        return reply({ code: 0, message: 'success', request_id: '2026112107000000000000000000AB', data: grantData() });
      }
      if (url.pathname === '/api/v2/token/refresh') {
        if (query.grant_type !== 'refresh_token') return failure(10001, 'Invalid grant type.');
        if (query.refresh_token !== currentRefresh) return failure(10002, 'The refresh token is not valid.');
        rotation += 1;
        accessToken = `${options.accessToken}_${rotation}`;
        currentRefresh = `TTP_R${rotation}`;
        return reply({ code: 0, message: 'success', request_id: '2026112107000000000000000000AC', data: grantData() });
      }
      return failure(36009009, 'Invalid path.', 404);
    }

    if (url.host !== 'open-api.tiktokglobalshop.com') throw new Error(`the fake TikTok does not serve ${url.host}`);
    const signed = method === 'POST' ? body : null;
    if (query.sign === undefined) return failure(36009004, 'Missing credentials. The request does not include a required signature in the query.', 401);
    if (query.app_key !== options.appKey) return failure(36009004, 'Invalid credentials. Invalid `app_key` query parameter.', 401);
    if (!/^\d{10}$/.test(query.timestamp ?? '')) return failure(36009004, 'Invalid timestamp. The value of the `timestamp` query parameter must not be lesser than 0.', 400);
    const skewSeconds = Number(query.timestamp) - Math.floor(nowMs() / 1000);
    if (skewSeconds < -300) return failure(36009004, 'Invalid timestamp. The value of the `timestamp` query parameter must not be earlier than 5 minutes before the current time.', 400);
    if (skewSeconds > 30) return failure(36009004, 'Invalid timestamp. The value of the `timestamp` query parameter must not exceed the current time by more than 30 seconds.', 400);
    if (query.sign !== expectedSign(options.appSecret, url.pathname, rawQuery, signed)) return failure(106001, 'Invalid credentials. The `sign` query parameter is invalid.', 401);
    if (headers['x-tts-access-token'] !== accessToken) return failure(36009004, 'Invalid credentials. The `x-tts-access-token` header is invalid.', 401);

    if (url.pathname === '/authorization/202309/shops' && method === 'GET') {
      if (query.shop_cipher !== undefined) return failure(36009004, 'Unexpected identifier. The `shop_cipher` query parameter is not required for this request.', 400);
      return reply({
        code: 0,
        message: 'Success',
        request_id: '2026112107000000000000000000AD',
        data: { shops: shops.map((s) => ({ id: s.id, name: s.name, region: s.region, seller_type: s.sellerType, cipher: s.cipher, code: s.code, owner_email: 'chu.shop@example.test' })) },
      });
    }
    if (url.pathname === '/order/202309/orders/search' && method === 'POST') {
      return reply({ code: 0, message: 'Success', request_id: '2026112107000000000000000000AE', data: { next_page_token: '', total_count: 0, orders: [] } });
    }
    return failure(36009009, 'Invalid path. The specified path does not match any available endpoint.', 404);
  };

  return {
    fetch: fetchImpl,
    calls,
    // What the fake holds now, so a test can compare it with what the adapter sealed.
    state: () => ({ accessToken, refreshToken: currentRefresh, authorizationEndsAtMs }),
  };
}

export function fakeShop(over: Partial<FakeTiktokShop> = {}): FakeTiktokShop {
  return { id: '7000714532876273420', name: 'Cửa hàng mẫu', region: 'VN', sellerType: 'LOCAL', cipher: 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3', code: 'VNLCBA4LLU8', ...over };
}
