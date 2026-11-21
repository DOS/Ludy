// SPDX-License-Identifier: AGPL-3.0-only
// The Lazada marketplace adapter (#2524, S1 = #4237; ADR-0045 point 7; design note https://github.com/DOS/Ludy/issues/2524#issuecomment-7056731894), DORMANT: nothing wires it into the worker or the
// configuration yet. Built from Lazada Open Platform's documentation as mirrored on open.alitrip.com (articleIds 108068 signature, 108065 hosts, 108260 and 121098 tokens and apps, 108297 masking,
// 121327 order paging) and the GitHub mirror of the API reference (xKeNcHii/lazada-sdk, docs/api/order-api.md), read 2026-11-21. open.lazada.com itself could not be read, so every name below is a
// pointer for the live check (#2522), not a verified one.
//
// The seller registers an "In-house app" on their own Lazada developer account and types its App Key and App Secret; the authorize step adds the tokens (a later slice). The credential is the
// sealed JSON of the connection and reaches this adapter only as the opaque secret of a call. The adapter READS only: two paths, both GET (a test reads this source to keep it so). Every call goes
// through the fetch it is given, which the caller binds to LAZADA_HOSTS. A buyer's name, phone, address and id are dropped at the edge by an allow-list of fields, so no other code sees them.
import { createHmac } from 'node:crypto';
import {
  MARKETPLACE_PLATFORM_LIMITS,
  MarketplaceProviderError,
  type MarketplaceOrder,
  type MarketplaceOrderLine,
  type MarketplaceOrderPage,
  type MarketplaceOrderStage,
  type MarketplacePlatformKey,
  type MarketplaceProvider,
  type MarketplaceTestResult,
} from '@crove/mod-finance';
import { cleanLabel, isoDay, looksMasked, marketplaceIdentifier, marketplaceMoney, notRecognized, parseMarketplaceJson, pickAllowed, readCappedAnswer, type Fetch } from './marketplace-adapter-kit.ts';

export const LAZADA_API_HOST = 'api.lazada.vn';
// The hosts the adapter's fetch is bound to. Authorization (auth.lazada.com) joins in the token slice (S3): nothing here calls it.
export const LAZADA_HOSTS: readonly string[] = [LAZADA_API_HOST];

// The only two paths this adapter calls, both GET: the orders changed since a time, and the items of up to 50 orders.
const ORDERS_PATH = '/orders/get';
const ITEMS_PATH = '/orders/items/get';

// The documented limits: at most 100 orders a page, an offset of at most 5000 (past it the window is moved forward), at most 50 order ids per items call.
const PAGE_SIZE = MARKETPLACE_PLATFORM_LIMITS.lazada.pageSize;
const MAX_OFFSET = 5000;
const ITEMS_BATCH = 50;
const WINDOW_DAYS = MARKETPLACE_PLATFORM_LIMITS.lazada.windowDays;
// A resumed read starts this far before the newest order seen, so an order Lazada updated late is caught; the confirm step dedupes on (platform, order number, line) and moves a status forward only.
const OVERLAP_MS = 10 * 60_000;
// One call at a time, at least this far apart: Lazada publishes no per-second limit in what was read, and it reviews the call success rate of an app (85% to go online).
const DEFAULT_SPACING_MS = 1000;
const DAY_MS = 86_400_000;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;

// The fields of an order and of an order item the adapter reads. Anything else (customer_first_name, address_*, recipient_info, buyer_id, buyer_note, tax_code, ...) is never copied.
const ORDER_FIELDS = ['order_id', 'order_number', 'created_at', 'updated_at'] as const;
const ITEM_FIELDS = ['order_item_id', 'order_id', 'sku', 'name', 'item_price', 'paid_price', 'status', 'currency'] as const;

// The stage of an order item by Lazada's status word (lower case, as the order API returns it). CLOSED: a status not in this table makes the page `not_recognized` and nothing is stored (no
// complete official list of item statuses could be read; the table is checked in the live trial). `failed` and `lost` are no sale; the stages are the five of the port.
export const LAZADA_ITEM_STAGE: Readonly<Record<string, MarketplaceOrderStage>> = {
  unpaid: 'placed',
  pending: 'placed',
  topack: 'placed',
  ready_to_ship: 'shipped',
  toship: 'shipped',
  packed: 'shipped',
  shipped: 'shipped',
  shipping: 'shipped',
  delivered: 'completed',
  canceled: 'cancelled',
  failed: 'cancelled',
  lost: 'cancelled',
  returned: 'returned',
};

// The sealed secret of a connection: {"appKey": "...", "appSecret": "...", "accessToken": "..."} (more fields join in the token slice and are ignored here). A malformed one is refused without echoing it.
interface LazadaCredential {
  appKey: string;
  appSecret: string;
  accessToken: string;
}

export function parseLazadaSecret(secret: string): LazadaCredential {
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    throw new MarketplaceProviderError('credentials');
  }
  const picked = pickAllowed(value, ['appKey', 'appSecret', 'accessToken'] as const);
  const fine = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 400 && v === v.trim() && /^[\x21-\x7e]+$/.test(v);
  if (!picked || !fine(picked.appKey) || !fine(picked.appSecret) || !fine(picked.accessToken)) throw new MarketplaceProviderError('credentials');
  return { appKey: picked.appKey, appSecret: picked.appSecret, accessToken: picked.accessToken };
}

// How Lazada signs a request (article 108068, the sample code): sort the parameters by key, put the API path first, then each non-empty key followed by its value, no separators, a body last (none
// for these GETs); HMAC-SHA256 with the app secret; upper-case hex.
export function signLazadaRequest(appSecret: string, path: string, params: Readonly<Record<string, string>>): string {
  let base = path;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (key !== '' && value !== undefined && value !== '') base += key + value;
  }
  return createHmac('sha256', appSecret).update(base, 'utf8').digest('hex').toUpperCase();
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
// A time as Lazada's date parameters take it: ISO 8601 with an offset, here Vietnam's +07:00.
export function lazadaStamp(ms: number): string {
  const v = new Date(ms + VIETNAM_OFFSET_MS);
  return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}T${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}+07:00`;
}

// The instant of a time as Lazada writes it in an answer: "2018-02-10T16:00:00+08:00" or "2018-02-10 16:00:00 +0800", or null when it is neither.
const STAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})$/;
export function parseLazadaTime(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = STAMP.exec(text.trim());
  if (!m) return null;
  const zone = m[3] === 'Z' ? 'Z' : `${m[3]!.slice(0, 3)}:${m[3]!.slice(-2)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(ms) || !isoDay(m[1]!) ? null : ms;
}

// The cursor: where the window of updated orders starts and how many of its orders were already read. `u:2026-11-02T03:04:05.000Z:100`.
const CURSOR = /^u:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):(\d{1,4})$/;
function readCursor(since: string | null): { start: number; skip: number } | null {
  const m = since === null ? null : CURSOR.exec(since);
  if (!m) return null;
  const start = Date.parse(m[1]!);
  return Number.isNaN(start) ? null : { start, skip: Number(m[2]) };
}
const writeCursor = (start: number, skip: number): string => `u:${new Date(start).toISOString()}:${skip}`;

export interface LazadaOptions {
  // Bound to LAZADA_HOSTS by the caller (hostBoundFetch); the adapter uses no other.
  fetch: Fetch;
  now?: () => Date;
  // Pause between two calls.
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Lazada's own error codes that name a refused credential or a call limit. Anything else is `unreachable`. The official error table could not be read (open.lazada.com is script-rendered): these
// come from the order API reference and from SDK sources, and the live check fills the list.
const CREDENTIAL_CODES: ReadonlySet<string> = new Set(['IllegalAccessToken', 'IncompleteSignature']);
const RATE_CODES: ReadonlySet<string> = new Set(['ApiCallLimit', 'AppApiCallLimit', 'E1002']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function lazadaMarketplace(options: LazadaOptions): MarketplaceProvider {
  const now = options.now ?? (() => new Date());
  const spacingMs = options.spacingMs ?? DEFAULT_SPACING_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastCall = Number.NEGATIVE_INFINITY;

  // One signed GET; the `data` of an answer whose code is "0". A failure is one of the port's kinds, never Lazada's text.
  async function call(credential: LazadaCredential, path: string, apiParams: Record<string, string>): Promise<unknown> {
    // The slot is taken before waiting, so two calls in flight at once are spaced from each other too.
    const slot = Math.max(now().getTime(), lastCall + spacingMs);
    const wait = slot - now().getTime();
    lastCall = slot;
    if (wait > 0) await sleep(wait);
    const params: Record<string, string> = { ...apiParams, app_key: credential.appKey, timestamp: String(now().getTime()), sign_method: 'sha256', access_token: credential.accessToken };
    params.sign = signLazadaRequest(credential.appSecret, path, params);
    let response: Response;
    try {
      response = await options.fetch(`https://${LAZADA_API_HOST}/rest${path}?${new URLSearchParams(params).toString()}`, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      throw new MarketplaceProviderError('unreachable');
    }
    if (response.status === 429) throw new MarketplaceProviderError('rate_limited');
    if (response.status === 401 || response.status === 403) throw new MarketplaceProviderError('credentials');
    if (!response.ok) throw new MarketplaceProviderError('unreachable');
    let answer: unknown;
    try {
      answer = parseMarketplaceJson(await readCappedAnswer(response, () => new MarketplaceProviderError('unreachable')));
    } catch (error) {
      if (error instanceof MarketplaceProviderError) throw error;
      throw new MarketplaceProviderError('unreachable');
    }
    if (!isRecord(answer)) throw new MarketplaceProviderError('unreachable');
    const code = answer.code === undefined ? '' : String(answer.code);
    if (code !== '0') {
      if (CREDENTIAL_CODES.has(code)) throw new MarketplaceProviderError('credentials');
      if (RATE_CODES.has(code)) throw new MarketplaceProviderError('rate_limited');
      throw new MarketplaceProviderError('unreachable');
    }
    return answer.data;
  }

  // The orders of one window page, each as only the fields the adapter reads. A malformed one refuses the page.
  interface RawOrder {
    id: string;
    number: string;
    createdDay: string;
    updatedAt: number;
  }
  async function readOrders(credential: LazadaCredential, params: Record<string, string>): Promise<RawOrder[]> {
    const data = await call(credential, ORDERS_PATH, params);
    const picked = isRecord(data) ? data.orders : undefined;
    if (picked === undefined) return [];
    if (!Array.isArray(picked) || picked.length > PAGE_SIZE) throw notRecognized();
    return picked.map((entry) => {
      const o = pickAllowed(entry, ORDER_FIELDS);
      const id = marketplaceIdentifier(o?.order_id, 40);
      const number = marketplaceIdentifier(o?.order_number, 40);
      const created = parseLazadaTime(o?.created_at);
      const updatedAt = parseLazadaTime(o?.updated_at);
      if (!o || id === null || number === null || created === null || updatedAt === null) throw notRecognized();
      return { id, number, createdDay: String(o.created_at).trim().slice(0, 10), updatedAt };
    });
  }

  // The items of the orders, in batches of at most 50 ids, by order id. One order with no item, or an item of another order than the one asked, refuses the page.
  async function readItems(credential: LazadaCredential, orders: readonly RawOrder[]): Promise<Map<string, Array<{ line: MarketplaceOrderLine; stage: MarketplaceOrderStage }>>> {
    const byOrder = new Map<string, Array<{ line: MarketplaceOrderLine; stage: MarketplaceOrderStage }>>();
    for (let from = 0; from < orders.length; from += ITEMS_BATCH) {
      const batch = orders.slice(from, from + ITEMS_BATCH);
      const data = await call(credential, ITEMS_PATH, { order_ids: `[${batch.map((o) => o.id).join(',')}]` });
      if (!Array.isArray(data)) throw notRecognized();
      const asked = new Set(batch.map((o) => o.id));
      for (const group of data) {
        const orderId = marketplaceIdentifier(isRecord(group) ? group.order_id : undefined, 40);
        const items = isRecord(group) ? group.order_items : undefined;
        if (orderId === null || !asked.has(orderId) || !Array.isArray(items)) throw notRecognized();
        const rows = byOrder.get(orderId) ?? [];
        for (const raw of items) {
          const item = pickAllowed(raw, ITEM_FIELDS);
          const itemId = marketplaceIdentifier(item?.order_item_id, 40);
          const paid = marketplaceMoney(item?.paid_price);
          const price = marketplaceMoney(item?.item_price);
          const status = typeof item?.status === 'string' ? item.status.trim().toLowerCase() : '';
          const stage = Object.hasOwn(LAZADA_ITEM_STAGE, status) ? LAZADA_ITEM_STAGE[status] : undefined;
          // An item of another order, a masked or missing amount or SKU, a currency other than dong or a status not in the table: the page is not stored.
          if (!item || itemId === null || paid === null || price === null || stage === undefined) throw notRecognized();
          if (marketplaceIdentifier(item.order_id, 40) !== orderId) throw notRecognized();
          if (item.currency !== undefined && item.currency !== 'VND') throw notRecognized();
          const sku = item.sku === undefined || item.sku === null || item.sku === '' ? null : marketplaceIdentifier(item.sku, 100);
          if (sku === null && item.sku !== undefined && item.sku !== null && item.sku !== '') throw notRecognized();
          const name = typeof item.name === 'string' ? item.name : '';
          if (looksMasked(name)) throw notRecognized();
          // One order item is one unit (Lazada answers each unit as its own item): quantity 1, the item's own id as the line key.
          rows.push({ line: { lineKey: itemId, sku, itemName: cleanLabel(name, 300), quantity: '1', unitPrice: price, amount: paid }, stage });
        }
        byOrder.set(orderId, rows);
      }
    }
    for (const o of orders) if ((byOrder.get(o.id) ?? []).length === 0) throw notRecognized();
    return byOrder;
  }

  return {
    id: 'lazada',
    hosts: LAZADA_HOSTS,
    // What the seller types to connect: the App Key and App Secret of their own In-house app. The tokens are added by the authorize step (a later slice).
    connectFields: ['appKey', 'appSecret'],
    capabilities: { platforms: { lazada: MARKETPLACE_PLATFORM_LIMITS.lazada } },

    // One call: a page of one order from the last day. It proves the key, the secret and the token sign and are accepted, and nothing more.
    async testConnection(secret: string): Promise<MarketplaceTestResult> {
      try {
        const credential = parseLazadaSecret(secret);
        await readOrders(credential, { created_after: lazadaStamp(now().getTime() - DAY_MS), limit: '1', offset: '0' });
        return 'works';
      } catch (error) {
        return error instanceof MarketplaceProviderError && error.kind === 'credentials' ? 'wrong_credentials' : 'unreachable';
      }
    },

    // The orders updated since the cursor, at most one page of 100: the window starts at the cursor (the last 30 days on the first read) and the cursor says how many of its orders were read. An order
    // answers as one port order for each stage its items are in, so an order whose items are in different states keeps each item's own state.
    async listOrders(secret: string, platform: MarketplacePlatformKey, since: string | null): Promise<MarketplaceOrderPage> {
      if (platform !== 'lazada') throw new MarketplaceProviderError('unreachable');
      const credential = parseLazadaSecret(secret);
      const cursor = readCursor(since);
      const start = cursor?.start ?? now().getTime() - WINDOW_DAYS * DAY_MS;
      const skip = cursor?.skip ?? 0;
      const raw = await readOrders(credential, { update_after: lazadaStamp(start), sort_by: 'updated_at', sort_direction: 'ASC', offset: String(skip), limit: String(PAGE_SIZE) });
      // Nothing new: the cursor stays.
      if (raw.length === 0) return { orders: [], nextCursor: since };
      const items = await readItems(credential, raw);
      const grouped = new Map<string, Omit<MarketplaceOrder, 'lines'> & { lines: MarketplaceOrderLine[] }>();
      for (const order of raw) {
        for (const { line, stage } of items.get(order.id) ?? []) {
          const key = `${order.number}\u0000${stage}`;
          const existing = grouped.get(key);
          if (existing) existing.lines.push(line);
          else grouped.set(key, { orderNo: order.number, orderedAt: order.createdDay, shippedAt: null, deliveredAt: null, stage, lines: [line] });
        }
      }
      // Deterministic bytes: the same window gives the same page, so the intake's content hash recognises a page read twice.
      const orders = [...grouped.values()]
        .map((o) => ({ ...o, lines: [...o.lines].sort((a, b) => (a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0)) }))
        .sort((a, b) => (a.orderNo === b.orderNo ? (a.stage < b.stage ? -1 : 1) : a.orderNo < b.orderNo ? -1 : 1));
      const newest = Math.max(...raw.map((o) => o.updatedAt));
      let next: string;
      if (raw.length >= PAGE_SIZE) {
        // A full page: more orders wait in the same window. Past Lazada's offset limit the window moves forward to the last order seen instead (article 121327).
        next = skip + raw.length >= MAX_OFFSET ? writeCursor(raw[raw.length - 1]!.updatedAt, 0) : writeCursor(start, skip + raw.length);
      } else {
        // The window is read to its end: the next one starts a little before the newest order, and never earlier than this one.
        next = writeCursor(Math.max(start, newest - OVERLAP_MS), 0);
      }
      return { orders, nextCursor: next };
    },

    // Not in this slice: the order's money lines come with the finance reads (S5); a poll never asks for them today.
    async orderFinance() {
      return null;
    },

    // Never: Lazada has no stock endpoint (stock comes with the product read) and the port's stock list is called by nothing yet.
    async listStock() {
      return [];
    },
  };
}
