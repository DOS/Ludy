// SPDX-License-Identifier: AGPL-3.0-only
// A made-up TikTok Shop Open Platform for the T1 tests (#2524, #4256): an in-process `fetch` that answers the two hosts the adapter uses, in the shape of the OFFICIAL Partner Center pages read on
// 2026-11-21 (authorization-overview-202407, sign-your-api-request, common-parameters, common-errors, get-authorized-shops-202309):
//   - auth.tiktok-shops.com: GET /api/v2/token/get (authorization code, single use, 30 minutes) and GET /api/v2/token/refresh (rotating, the authorization end does not move), the parameters in the query;
//   - open-api.tiktokglobalshop.com: GET /authorization/202309/shops, the signed POST /order/202309/orders/search and POST /return_refund/202602/returns/search (filtered by `update_time_ge` in the signed body, ascending by
//     update time, paged by an opaque token) and GET /order/202507/orders (by `ids`), answering the made-up orders and returns the test hands in.
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
  // The raw orders and returns the order, detail and return calls answer from, in TikTok's own shape (a test builds them with fakeOrder, fakeLine and fakeReturn, which carry a buyer's data on purpose).
  orders?: Array<Record<string, unknown>>;
  returns?: Array<Record<string, unknown>>;
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
    // The search calls take the shop and a page size; the body holds the filter and is the exact text that was signed.
    if ((url.pathname === '/order/202309/orders/search' || url.pathname === '/return_refund/202602/returns/search') && method === 'POST') {
      if (!query.shop_cipher) return failure(36009004, 'Missing identifier. The `shop_cipher` query parameter is required for this request.', 400);
      const isOrders = url.pathname === '/order/202309/orders/search';
      const size = Number(query.page_size);
      const [low, high] = isOrders ? [1, 100] : [10, 50];
      if (!Number.isInteger(size) || size < low || size > high) return failure(12052000, 'Invalid page size.', 400);
      let filter: Record<string, unknown>;
      try {
        filter = JSON.parse(body ?? '') as Record<string, unknown>;
      } catch {
        return failure(12052001, 'Invalid body.', 400);
      }
      const ge = typeof filter.update_time_ge === 'number' ? filter.update_time_ge : 0;
      const source = (isOrders ? options.orders : options.returns) ?? [];
      const matching = source
        .filter((r) => !(Number(r.update_time) < ge))
        .sort((a, b) => (Number(a.update_time) || 0) - (Number(b.update_time) || 0) || String(a.id ?? a.return_id).localeCompare(String(b.id ?? b.return_id)));
      let offset = 0;
      if (query.page_token) {
        const decoded = /^o(\d{1,6})$/.exec(Buffer.from(query.page_token, 'base64').toString('utf8'));
        if (!decoded) return failure(12052002, 'Invalid page token.', 400);
        offset = Number(decoded[1]);
      }
      const page = matching.slice(offset, offset + size);
      const next = offset + size < matching.length ? Buffer.from(`o${offset + size}`).toString('base64') : '';
      const list = isOrders ? { orders: page } : page.length === 0 ? {} : { return_orders: page };
      return reply({ code: 0, message: 'Success', request_id: '2026112107000000000000000000AE', data: { next_page_token: next, total_count: matching.length, ...list } });
    }
    if (url.pathname === '/order/202507/orders' && method === 'GET') {
      if (!query.shop_cipher) return failure(36009004, 'Missing identifier. The `shop_cipher` query parameter is required for this request.', 400);
      const ids = (query.ids ?? '').split(',').filter((id) => id !== '');
      if (ids.length < 1 || ids.length > 50) return failure(12052003, 'Invalid ids.', 400);
      return reply({ code: 0, message: 'Success', request_id: '2026112107000000000000000000AF', data: { orders: (options.orders ?? []).filter((o) => ids.includes(String(o.id))) } });
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

let orderSeq = 0;

// A line item of an order in TikTok's shape: a Vietnam dong line with a SKU, and a buyer-side field planted on purpose (the adapter must drop it).
export function fakeLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  orderSeq += 1;
  return {
    id: `5770865121237${String(orderSeq).padStart(5, '0')}`,
    sku_id: '2729382476852921560',
    seller_sku: 'MAU-001',
    product_name: 'Áo thun mẫu',
    sku_name: 'Đen, L',
    display_status: 'AWAITING_SHIPMENT',
    sale_price: '150000',
    original_price: '180000',
    platform_discount: '20000',
    seller_discount: '10000',
    currency: 'VND',
    package_status: 'TO_FULFILL',
    buyer_note_on_item: 'giao giờ hành chính cho Nguyễn Văn Thử',
    ...over,
  };
}

// An order in TikTok's shape with a recipient, a buyer e-mail and a nickname planted on purpose. `update_time` and `create_time` are Unix seconds.
export function fakeOrder(over: Record<string, unknown> = {}): Record<string, unknown> {
  orderSeq += 1;
  return {
    id: `5764614130387${String(orderSeq).padStart(5, '0')}`,
    status: 'AWAITING_SHIPMENT',
    create_time: 1_795_000_000,
    update_time: 1_795_000_100,
    line_items: [fakeLine()],
    payment: { currency: 'VND', total_amount: '150000' },
    recipient_address: { name: 'Nguyễn Văn Thử', phone_number: '(+84)90***1234', full_address: '1 Đường Thử, Quận 1, TP.HCM' },
    buyer_email: 'v2b2V5@chat.seller.tiktok.test',
    buyer_message: 'Giao nhanh giúp mình',
    buyer_nickname: 'thu_nguyen_vn',
    user_id: '7021436810468230477',
    ...over,
  };
}

// A return in TikTok's shape, with the buyer's reason text planted on purpose.
export function fakeReturn(over: Record<string, unknown> = {}): Record<string, unknown> {
  orderSeq += 1;
  return {
    order_id: '576461413038700001',
    return_id: `4035318504086${String(orderSeq).padStart(5, '0')}`,
    return_type: 'RETURN_AND_REFUND',
    return_status: 'RETURN_OR_REFUND_REQUEST_SUCCESS',
    update_time: 1_795_000_200,
    create_time: 1_795_000_000,
    return_reason_text: 'Không vừa, liên hệ Nguyễn Văn Thử',
    role: 'BUYER',
    return_line_items: [{ return_line_item_id: '4035227657962164811', order_line_item_id: '577086512123700001', sku_id: '2729382476852921560' }],
    ...over,
  };
}
