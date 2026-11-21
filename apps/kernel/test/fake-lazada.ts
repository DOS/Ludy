// SPDX-License-Identifier: AGPL-3.0-only
// A made-up Lazada Open Platform for the adapter's tests (#2524, S1 = #4237): an in-process `fetch` that answers the two read paths the adapter calls, in the shape of Lazada's API reference
// (GitHub mirror xKeNcHii/lazada-sdk, docs/api/order-api.md, read 2026-11-21). It verifies the signature with its OWN implementation of the algorithm (article 108068: the sample's rule written again,
// not the adapter's function), so a signer that drifts fails here. Its answers carry a buyer's name, phone, address and id on purpose, so the tests can show none of it gets through. No network.
import { createHmac } from 'node:crypto';

export interface FakeItem {
  // Digits only; Lazada answers an item id as a number.
  id: string;
  sku: string | null;
  name: string;
  itemPrice: string;
  paidPrice: string;
  status: string;
}

export interface FakeOrder {
  id: string;
  number: string;
  // As Lazada writes it in an answer.
  createdAt: string;
  updatedAt: string;
  items: FakeItem[];
}

export interface FakeCall {
  method: string;
  host: string;
  path: string;
  params: Record<string, string>;
}

export interface FakeLazadaOptions {
  appKey: string;
  appSecret: string;
  accessToken: string;
  orders: FakeOrder[];
  // Crafts an answer for a path instead of the fake's own (a hostile page, an HTTP error, a throttle); returns undefined to let the fake answer.
  intercept?: (path: string, params: Record<string, string>) => Response | undefined;
}

// Independent of the adapter: the rule of the official sample, written once more.
function expectedSign(secret: string, path: string, params: Record<string, string>): string {
  const keys = Object.keys(params).filter((k) => k !== 'sign').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const text = path + keys.map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha256', secret).update(text, 'utf8').digest('hex').toUpperCase();
}

const stamp = (text: string): number => Date.parse(text.replace(' ', 'T').replace(/\s*\+(\d{2})(\d{2})$/, '+$1:$2'));

// JSON in which `@@digits@@` strings are written as bare integer literals, as Lazada writes an item id (which can pass 2^53).
const json = (value: unknown): string => JSON.stringify(value).replace(/"@@(\d+)@@"/g, '$1');

const buyer = {
  customer_first_name: 'Nguyễn Văn Thử',
  customer_last_name: '',
  address_shipping: { first_name: 'Nguyễn', last_name: 'Thử', phone: '0912345678', address1: '1 Phố Thử, Hà Nội', city: 'Hà Nội', country: 'VN' },
  address_billing: { first_name: 'Nguyễn', phone: '0912345678', address1: '1 Phố Thử, Hà Nội' },
  recipient_info: { identify_no: '079099123456' },
  buyer_note: 'giao giờ hành chính',
  tax_code: '0109876543',
};

export function fakeLazada(options: FakeLazadaOptions) {
  const calls: FakeCall[] = [];
  const reply = (body: string, init: ResponseInit = { status: 200 }) => new Response(body, { headers: { 'content-type': 'application/json' }, ...init });
  const refused = (code: string, message: string) => reply(JSON.stringify({ code, type: 'ISV', message, request_id: '0b00000000000000000000000' }));

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const params = Object.fromEntries(url.searchParams.entries());
    const path = url.pathname.replace(/^\/rest/, '');
    calls.push({ method: init?.method ?? 'GET', host: url.host, path, params });
    if (url.protocol !== 'https:' || url.host !== 'api.lazada.vn' || !url.pathname.startsWith('/rest/')) throw new Error(`the fake Lazada does not serve ${url.host}`);
    const hostile = options.intercept?.(path, params);
    if (hostile) return hostile;
    if (params.sign !== expectedSign(options.appSecret, path, params) || params.app_key !== options.appKey || params.sign_method !== 'sha256') return refused('IncompleteSignature', 'The request signature does not conform to Lazada standards');
    if (params.access_token !== options.accessToken) return refused('IllegalAccessToken', 'The specified access token is invalid or expired');
    if (!/^\d{13}$/.test(params.timestamp ?? '')) return refused('MissingParameter', 'timestamp');

    if (path === '/orders/get') {
      const limit = Number(params.limit ?? '100');
      const offset = Number(params.offset ?? '0');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return refused('19', 'E019: Invalid limit');
      if (!Number.isInteger(offset) || offset < 0 || offset > 5000) return refused('14', 'E014: Invalid offset');
      const afterText = params.update_after ?? params.created_after;
      if (afterText === undefined) return refused('MissingParameter', 'Either update_after or created_after is mandatory');
      const after = stamp(afterText);
      const key = params.update_after !== undefined ? 'updatedAt' : 'createdAt';
      const matching = options.orders.filter((o) => stamp(o[key]) >= after).sort((a, b) => stamp(a.updatedAt) - stamp(b.updatedAt) || (a.id < b.id ? -1 : 1));
      const page = matching.slice(offset, offset + limit);
      return reply(
        json({
          code: '0',
          data: {
            countTotal: matching.length,
            count: page.length,
            orders: page.map((o) => ({
              order_id: o.id,
              order_number: o.number,
              created_at: o.createdAt,
              updated_at: o.updatedAt,
              statuses: [...new Set(o.items.map((i) => i.status))],
              items_count: o.items.length,
              price: o.items.reduce((sum, i) => sum + Number(i.paidPrice), 0).toFixed(2),
              ...buyer,
            })),
          },
          request_id: '0b00000000000000000000000',
        }),
      );
    }

    if (path === '/orders/items/get') {
      // The ids are read as text: a JSON parse would round an id past 2^53.
      const listed = /^\[(\d+(?:,\d+)*)\]$/.exec(params.order_ids ?? '');
      const ids = listed ? listed[1]!.split(',') : [];
      if (ids.length < 1 || ids.length > 50) return refused('38', 'E038: too many orders');
      const wanted = new Set(ids);
      const found = options.orders.filter((o) => wanted.has(o.id));
      return reply(
        json({
          code: '0',
          data: found.map((o) => ({
            order_id: `@@${o.id}@@`,
            order_number: o.number,
            order_items: o.items.map((i) => ({
              order_item_id: `@@${i.id}@@`,
              order_id: `@@${o.id}@@`,
              sku: i.sku,
              shop_sku: `${i.id}_VN-${i.id}`,
              name: i.name,
              item_price: i.itemPrice,
              paid_price: i.paidPrice,
              voucher_seller: '0.00',
              voucher_platform: '0.00',
              shipping_amount: '0.00',
              currency: 'VND',
              status: i.status,
              buyer_id: 100200300,
              tracking_code: 'LZVN000000',
              ...buyer,
            })),
          })),
          request_id: '0b00000000000000000000000',
        }),
      );
    }
    return refused('ApiNotFound', path);
  };

  return { fetch: fetchImpl, calls };
}

// An order of `n` items for the fake, with made-up names.
export function fakeOrder(over: Partial<FakeOrder> & { id: string; number: string }, items: Array<Partial<FakeItem> & { id: string }> = [{ id: '1' }]): FakeOrder {
  return {
    createdAt: '2026-11-02T09:00:00+07:00',
    updatedAt: '2026-11-02T10:00:00+07:00',
    ...over,
    items: items.map((i) => ({ sku: 'MAU-001', name: 'Áo thun mẫu cổ tròn', itemPrice: '150000.00', paidPrice: '140000.00', status: 'delivered', ...i })),
  };
}
