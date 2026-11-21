// SPDX-License-Identifier: AGPL-3.0-only
// A made-up Shopee Open Platform for the S1 tests (#2524, #4274): an in-process `fetch` that answers the one host the adapter uses (`partner.shopeemobile.com`), in the shape of the OFFICIAL pages read on 2026-11-21
// (open.shopee.com developer guide "Authorization and Authentication", v2.shop.get_shop_info, v2.order.get_order_list, v2.order.get_order_detail):
//   - POST /api/v2/auth/token/get (the authorization code, single use) and POST /api/v2/auth/access_token/get (the refresh token, single use, REPLACED by each refresh; the access token it replaces stays valid
//     five more minutes), the answer being the object itself;
//   - GET /api/v2/shop/get_shop_info, GET /api/v2/order/get_order_list (filtered by `update_time` in [time_from, time_to], at most 15 days, paged by `cursor`) and GET /api/v2/order/get_order_detail (at most 50
//     numbers, the optional fields only when asked for), answering `{ request_id, error, message, response }`.
// It verifies the signature with its OWN implementation of the rule (written again, over the raw address, not the adapter's function), checks the timestamp window (5 minutes back, 30 seconds ahead) and that the
// access token is the current one (or the replaced one within its five minutes). Its answers carry a buyer's name, phone and address on purpose where the real API would hold them, so the tests can show none of it is kept.
// No network.
import { createHmac } from 'node:crypto';

export interface FakeShopeeCall {
  method: string;
  host: string;
  path: string;
  // The query exactly as sent, decoded.
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  url: string;
}

export interface FakeShopeeOptions {
  partnerId: string;
  partnerKey: string;
  shopId: string;
  accessToken: string;
  // The authorization codes that work once.
  codes?: readonly string[];
  // The refresh token that works now; it is spent by a refresh.
  refreshToken?: string;
  shopName?: string;
  shopRegion?: string;
  shopStatus?: string;
  // The end of the seller's authorization, in ms.
  authorizationEndsAtMs?: number;
  now?: () => number;
  // Crafts an answer instead of the fake's own (a refusal, a throttle, a hostile or malformed body); returns undefined to let the fake answer.
  intercept?: (path: string, query: Record<string, string>) => Response | undefined;
}

// The rule of the official page, written once more over the raw address text: partner id, path, timestamp, then the access token and the shop id for a shop call, HMAC-SHA256 keyed with the partner key, hex.
function expectedSign(key: string, partnerId: string, path: string, timestamp: string, accessToken: string | null, shopId: string | null): string {
  let base = '';
  base += partnerId;
  base += path;
  base += timestamp;
  if (accessToken !== null && shopId !== null) base += accessToken + shopId;
  return createHmac('sha256', key).update(base, 'utf8').digest('hex');
}

export interface FakeShopeeItem {
  itemId: number | string;
  modelId: number | string;
  name: string;
  modelName?: string;
  itemSku?: string;
  modelSku?: string;
  quantity: number;
  // Raw text written into the answer as a JSON number, so a test can plant a value a float would round.
  original: string;
  discounted: string;
}

export interface FakeShopeeOrderSpec {
  sn: string;
  status: string;
  createdMs: number;
  updatedMs: number;
  items: FakeShopeeItem[];
  pickupDoneMs?: number;
  cancelBy?: string;
  region?: string;
  currency?: string;
}

// A raw order in Shopee's shape. The amounts are written as the raw numbers the test gives (`1000.0`, `4503599627370497.5`), which is why the order is kept as TEXT, not an object: JSON.stringify would drop a
// trailing `.0` and round a long number. `buyer_*` and `recipient_address` are there on purpose and only come out when the call asks for them.
export interface FakeShopeeRaw {
  sn: string;
  status: string;
  updatedMs: number;
  // The detail record as JSON text, without the buyer fields and without the optional ones; `detail(fields)` adds what is asked for.
  detail: (fields: readonly string[]) => string;
}

export function fakeShopeeOrder(spec: FakeShopeeOrderSpec): FakeShopeeRaw {
  const itemText = (i: FakeShopeeItem): string =>
    `{"item_id":${i.itemId},"item_name":${JSON.stringify(i.name)},"item_sku":${JSON.stringify(i.itemSku ?? '')},"model_id":${i.modelId},"model_name":${JSON.stringify(i.modelName ?? '')},"model_sku":${JSON.stringify(i.modelSku ?? '')},"model_quantity_purchased":${i.quantity},"model_original_price":${i.original},"model_discounted_price":${i.discounted},"weight":0.3}`;
  return {
    sn: spec.sn,
    status: spec.status,
    updatedMs: spec.updatedMs,
    detail: (fields) => {
      const parts = [
        `"order_sn":${JSON.stringify(spec.sn)}`,
        `"region":${JSON.stringify(spec.region ?? 'VN')}`,
        `"currency":${JSON.stringify(spec.currency ?? 'VND')}`,
        `"cod":false`,
        `"order_status":${JSON.stringify(spec.status)}`,
        `"create_time":${Math.floor(spec.createdMs / 1000)}`,
        `"update_time":${Math.floor(spec.updatedMs / 1000)}`,
        `"days_to_ship":3`,
      ];
      if (fields.includes('item_list')) parts.push(`"item_list":[${spec.items.map(itemText).join(',')}]`);
      if (fields.includes('pickup_done_time')) parts.push(`"pickup_done_time":${spec.pickupDoneMs === undefined ? 0 : Math.floor(spec.pickupDoneMs / 1000)}`);
      if (fields.includes('cancel_by') && spec.cancelBy !== undefined) parts.push(`"cancel_by":${JSON.stringify(spec.cancelBy)}`);
      if (fields.includes('buyer_username')) parts.push(`"buyer_username":"nguyenvanthu_buyer"`, `"buyer_user_id":9193214`);
      if (fields.includes('recipient_address')) parts.push(`"recipient_address":{"name":"Nguyễn Văn Thử","phone":"0901234567","full_address":"12 Đường Thử, Quận 1"}`);
      return `{${parts.join(',')}}`;
    },
  };
}

export interface FakeShopeeReturn {
  returnSn: string;
  orderSn: string;
  status: string;
  updatedMs: number;
  // 0 return and refund, 1 refund only.
  solution: number;
  items: Array<{ itemId: number | string; modelId: number | string; amount: number }>;
  reverseStatus?: string;
  validation?: string;
}

// A return in the shape of the list and the detail pages. The buyer's nickname, e-mail and pickup address are there on purpose and are never read.
const returnJson = (r: FakeShopeeReturn, detail: boolean): Record<string, unknown> => ({
  return_sn: r.returnSn,
  order_sn: r.orderSn,
  status: r.status,
  update_time: Math.floor(r.updatedMs / 1000),
  create_time: Math.floor(r.updatedMs / 1000) - 86_400,
  return_solution: r.solution,
  needs_logistics: r.solution === 0,
  refund_amount: 150000.0,
  currency: 'VND',
  reason: 'DIFFERENT_DESCRIPTION',
  user: { username: 'nguyenvanthu_buyer', email: 'buyer***@example.com', portrait: 'https://cf.shopee.sg/file/abc' },
  item: r.items.map((i) => ({ item_id: i.itemId, model_id: i.modelId, amount: i.amount, name: 'Áo thun mẫu', item_price: 120000.0, item_sku: 'AT-MAU', variation_sku: 'AT-MAU-DL' })),
  ...(detail
    ? {
        reverse_logistics_status: r.reverseStatus ?? 'LOGISTICS_REQUEST_CREATED',
        validation_type: r.validation ?? 'seller_validation',
        return_pickup_address: { name: 'Nguyễn Văn Thử', phone: '0901234567', address: '12 Đường Thử' },
      }
    : {}),
});

export function fakeShopee(options: FakeShopeeOptions & { raws?: FakeShopeeRaw[]; returns?: FakeShopeeReturn[] }) {
  // `raws`: the orders the list and detail calls answer from, built with fakeShopeeOrder (which carries a buyer's data on purpose, returned only when a call asks for it).
  const calls: FakeShopeeCall[] = [];
  const nowMs = options.now ?? (() => Date.now());
  const unusedCodes = new Set(options.codes ?? []);
  let currentRefresh = options.refreshToken ?? 'SHP_R0';
  let rotation = 0;
  let accessToken = options.accessToken;
  // The access token a refresh replaced, still valid until this time (five minutes).
  let replacedAccess: { token: string; untilMs: number } | null = null;
  const raws = options.raws ?? [];
  const returns = options.returns ?? [];
  const authorizationEndsAtMs = options.authorizationEndsAtMs ?? nowMs() + 200 * 86_400_000;

  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
  const failure = (error: string, message: string, status = 200) => reply({ request_id: 'b937c04e554847789cbf3fe33a0ad5f1', error, message }, status);

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.protocol !== 'https:') throw new Error(`the fake Shopee does not serve ${url.protocol}`);
    const query = Object.fromEntries(url.searchParams.entries());
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === 'string' ? init.body : null;
    const method = init?.method ?? 'GET';
    calls.push({ method, host: url.host, path: url.pathname, query, headers, body, url: input });
    const hostile = options.intercept?.(url.pathname, query);
    if (hostile) return hostile;
    if (url.host !== 'partner.shopeemobile.com') return new Response('unknown host', { status: 404 });

    const isToken = url.pathname === '/api/v2/auth/token/get' || url.pathname === '/api/v2/auth/access_token/get';
    // The common parameters and the signature.
    const timestamp = query.timestamp ?? '';
    const skew = nowMs() - Number(timestamp) * 1000;
    if (query.partner_id !== options.partnerId) return failure('error_auth', 'Wrong partner_id.');
    if (!/^\d{10}$/.test(timestamp) || skew > 5 * 60_000 || skew < -30_000) return failure('error_auth', 'Invalid timestamp.');
    const scopeToken = isToken ? null : (query.access_token ?? '');
    const scopeShop = isToken ? null : (query.shop_id ?? '');
    if (query.sign !== expectedSign(options.partnerKey, options.partnerId, url.pathname, timestamp, scopeToken, scopeShop)) return failure('error_auth', 'Wrong sign.');

    if (url.pathname === '/api/v2/auth/token/get') {
      if (method !== 'POST') return failure('error_param', 'Wrong method.', 405);
      const parsed = JSON.parse(body ?? '{}') as { code?: string; shop_id?: number; partner_id?: number };
      if (parsed.partner_id !== Number(options.partnerId) || parsed.shop_id !== Number(options.shopId)) return failure('error_param', 'Wrong parameters.');
      if (typeof parsed.code !== 'string' || !unusedCodes.delete(parsed.code)) return failure('error_auth', 'Invalid code.');
      rotation += 1;
      accessToken = `SHP_access_${rotation}`;
      currentRefresh = `SHP_R${rotation}`;
      return reply({ request_id: 'rid', error: '', message: '', access_token: accessToken, refresh_token: currentRefresh, expire_in: 14_400, shop_id_list: [Number(options.shopId)], merchant_id_list: [] });
    }
    if (url.pathname === '/api/v2/auth/access_token/get') {
      if (method !== 'POST') return failure('error_param', 'Wrong method.', 405);
      const parsed = JSON.parse(body ?? '{}') as { refresh_token?: string; shop_id?: number; partner_id?: number };
      if (parsed.partner_id !== Number(options.partnerId) || parsed.shop_id !== Number(options.shopId)) return failure('error_param', 'Wrong parameters.');
      // A spent or wrong refresh token: the page names no word, the fake uses the generic auth error.
      if (parsed.refresh_token !== currentRefresh) return failure('error_auth', 'Invalid refresh_token.');
      if (nowMs() >= authorizationEndsAtMs) return failure('error_auth', 'Authorization expired.');
      replacedAccess = { token: accessToken, untilMs: nowMs() + 5 * 60_000 };
      rotation += 1;
      accessToken = `SHP_access_${rotation}`;
      currentRefresh = `SHP_R${rotation}`;
      return reply({ request_id: 'rid', error: '', message: '', access_token: accessToken, refresh_token: currentRefresh, expire_in: 14_400, shop_id: Number(options.shopId), partner_id: Number(options.partnerId) });
    }

    // Shop calls: the shop and the token.
    if (query.shop_id !== options.shopId) return failure('error_shop', 'shopid is invalid');
    const tokenOk = query.access_token === accessToken || (replacedAccess !== null && query.access_token === replacedAccess.token && nowMs() < replacedAccess.untilMs);
    if (!tokenOk) return failure('error_auth', 'Invalid access_token.');
    if (method !== 'GET') return failure('error_param', 'Wrong method.', 405);

    if (url.pathname === '/api/v2/shop/get_shop_info') {
      return reply({
        request_id: 'rid',
        error: '',
        message: '',
        shop_name: options.shopName ?? 'Cửa hàng Thử Nghiệm',
        region: options.shopRegion ?? 'VN',
        status: options.shopStatus ?? 'NORMAL',
        auth_time: Math.floor((nowMs() - 86_400_000) / 1000),
        expire_time: Math.floor(authorizationEndsAtMs / 1000),
        is_cb: false,
        merchant_id: null,
        response: {},
      });
    }
    if (url.pathname === '/api/v2/order/get_order_list') {
      const from = Number(query.time_from);
      const to = Number(query.time_to);
      const size = Number(query.page_size);
      if (query.time_range_field !== 'update_time' && query.time_range_field !== 'create_time') return failure('error_param', 'Wrong parameters, detail: time_range_field.');
      if (!Number.isInteger(from) || !Number.isInteger(to) || to - from > 15 * 86_400 || from >= to) return failure('order.order_list_invalid_time', 'Start time must be earlier than end time and diff in 15days.');
      if (!Number.isInteger(size) || size < 1 || size > 100) return failure('error_param', 'Wrong parameters, detail: page_size.');
      const matching = raws.filter((r) => r.updatedMs >= from * 1000 && r.updatedMs <= to * 1000).sort((a, b) => a.updatedMs - b.updatedMs);
      const offset = query.cursor === undefined || query.cursor === '' ? 0 : Number(query.cursor);
      const page = matching.slice(offset, offset + size);
      const more = offset + size < matching.length;
      return text(`{"request_id":"rid","error":"","message":"","response":{"more":${more},"next_cursor":${JSON.stringify(more ? String(offset + size) : '')},"order_list":${JSON.stringify(page.map((r) => ({ order_sn: r.sn, order_status: r.status, booking_sn: '' })))}}}`);
    }
    if (url.pathname === '/api/v2/order/get_order_detail') {
      const numbers = (query.order_sn_list ?? '').split(',').filter((n) => n !== '');
      if (numbers.length < 1 || numbers.length > 50) return failure('error_param', 'Wrong parameters, detail: order_sn_list.');
      const fields = (query.response_optional_fields ?? '').split(',');
      const found = numbers.map((n) => raws.find((r) => r.sn === n)).filter((r): r is FakeShopeeRaw => r !== undefined);
      return text(`{"request_id":"rid","error":"","message":"","response":{"order_list":[${found.map((r) => r.detail(fields)).join(',')}]}}`);
    }
    if (url.pathname === '/api/v2/returns/get_return_list') {
      const from = Number(query.update_time_from);
      const to = Number(query.update_time_to);
      const size = Number(query.page_size);
      const pageNo = Number(query.page_no);
      if (!Number.isInteger(from) || !Number.isInteger(to) || to - from > 15 * 86_400 || from >= to) return failure('error_param', 'Wrong parameters, detail: update_time.');
      if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(pageNo) || pageNo < 1) return failure('error_param', 'Wrong parameters, detail: page.');
      const matching = returns.filter((r) => r.updatedMs >= from * 1000 && r.updatedMs <= to * 1000).sort((a, b) => a.updatedMs - b.updatedMs);
      const offset = (pageNo - 1) * size;
      const page = matching.slice(offset, offset + size);
      return text(`{"request_id":"rid","error":"","message":"","response":{"more":${offset + size < matching.length},"return":${JSON.stringify(page.map((r) => returnJson(r, false)))}}}`);
    }
    if (url.pathname === '/api/v2/returns/get_return_detail') {
      const found = returns.find((r) => r.returnSn === query.return_sn);
      if (!found) return failure('error_param', 'The information you queried is not found.');
      return text(`{"request_id":"rid","error":"","message":"","response":${JSON.stringify(returnJson(found, true))}}`);
    }
    return failure('error_param', 'unknown path', 404);
  };

  return {
    fetch: fetchImpl,
    calls,
    state: () => ({ accessToken, refreshToken: currentRefresh, rotation }),
  };
}
