// SPDX-License-Identifier: AGPL-3.0-only
// The Lazada marketplace adapter (#2524, S1 = #4237; ADR-0045 point 7; design note https://github.com/DOS/Ludy/issues/2524#issuecomment-7056731894), DORMANT: nothing wires it into the worker or the
// configuration yet. First built from Lazada Open Platform's documentation as mirrored on open.alitrip.com and the GitHub mirror of the API reference (xKeNcHii/lazada-sdk), then checked against the
// OFFICIAL pages of open.lazada.com, which load in a headless browser (read 2026-11-21; the table of what matched is https://github.com/DOS/Ludy/issues/2522#issuecomment-7058540099): the paths, the
// parameters, the host, the signature and the item fields below were confirmed; what stays for the live check (#2522, a person with a seller account) is what the pages do not say (the rate-limit codes,
// what masking does to an amount, the token lifetimes, and the status word of a finished return).
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
import { cleanLabel, isoDay, marketplaceDigits, marketplaceIdentifier, marketplaceMoney, notRecognized, parseMarketplaceJson, pickAllowed, readCappedAnswer, type Fetch } from './marketplace-adapter-kit.ts';

export const LAZADA_API_HOST = 'api.lazada.vn';
// The hosts the adapter's fetch is bound to. Token create and refresh (auth.lazada.com) are the token module's (marketplace-lazada-token.ts), with a fetch of its own: nothing here calls it.
export const LAZADA_HOSTS: readonly string[] = [LAZADA_API_HOST];

// The only two paths this adapter calls, both GET: the orders changed since a time, and the items of up to 50 orders.
const ORDERS_PATH = '/orders/get';
const ITEMS_PATH = '/orders/items/get';

// The documented limits: at most 100 orders a page and at most 50 order ids per items call. Offset paging is never used (the documented offset limit is 5000 and an offset over a list that changes
// while it is read skips orders): the window itself moves forward, see listOrders.
const PAGE_SIZE = MARKETPLACE_PLATFORM_LIMITS.lazada.pageSize;
const ITEMS_BATCH = 50;
// The most orders of one window that offset paging may skip (Lazada's documented offset limit).
const MAX_OFFSET = 5000;
// Offset paging is used only when a window cannot move, over a list that can change between two polls (an order read and then updated moves to the end and shifts the unread ones up). Each page therefore
// resumes this many positions before the end of the last one, so up to this many such updates between two polls cost repeats (the confirm step dedupes them) and not a skipped order.
const SKIP_BACK = 25;
const WINDOW_DAYS = MARKETPLACE_PLATFORM_LIMITS.lazada.windowDays;
// A resumed read starts this far before the newest order seen, so an order Lazada updated late is caught; the confirm step dedupes on (platform, order number, line) and moves a status forward only.
// The price: a short page resumes ten minutes before its newest order, so the window never moves past that and a shop with nothing newer re-reads that newest order and its items on every poll (two calls
// for up to 50 orders, three for 51 to 100: the items are read in batches of 50) until a newer update moves the window on or the 30-day floor passes the order. At a poll every 15 minutes that is
// about 200 to 300 calls a day for a quiet shop, far under the 10,000 a day of a test app. (A FULL page resumes a second before its newest order, see TIE_MS.)
const OVERLAP_MS = 10 * 60_000;
// A full page resumes this far before its newest order, so the orders that share its last second are read again rather than lost (whether Lazada's `update_after` is inclusive is not documented).
const TIE_MS = 1000;
// One call at a time, at least this far apart: Lazada publishes no per-second limit in what was read, and it reviews the call success rate of an app (85% to go online).
const DEFAULT_SPACING_MS = 1000;
const DAY_MS = 86_400_000;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;

// The fields of an order and of an order item the adapter reads. Anything else (customer_first_name, address_*, recipient_info, buyer_id, buyer_note, tax_code, ...) is never copied.
const ORDER_FIELDS = ['order_id', 'order_number', 'created_at', 'updated_at'] as const;
// The fields of an answer that hold an id, which may pass 2^53 and are kept as the digits Lazada wrote.
const ID_KEYS = ['order_id', 'order_item_id'] as const;
const ITEM_FIELDS = ['order_item_id', 'order_id', 'sku', 'name', 'item_price', 'paid_price', 'status', 'currency'] as const;

// The stage of an order item by Lazada's status word (lower case, as the order API returns it). CLOSED: a status not in this table makes the page `not_recognized` and nothing is stored. The words are the
// ones the official GetOrders page lists for its status filter (read 2026-11-21); the stages are this code's reading of them and are checked in the live trial.
//
// WHAT A STAGE DOES TO STOCK (modules/finance/src/marketplace-orders.ts, `moveLineStock`): `shipped` and `completed` take stock out; `returned` brings it back; `cancelled` moves nothing for a line that
// never shipped but BRINGS STOCK BACK for a line that did (it is the stage of a failed delivery) and is final; `placed` moves nothing. So a word whose goods are gone (lost, damaged, scrapped) or not yet back
// (a delivery that failed and is on its way back) must NOT be `cancelled` after a shipment: it stays `shipped` (stock stays out; a write-off is a person's bookkeeping) until a word says the goods are back.
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
  returned: 'returned',
  // Goods lost, damaged or scrapped in transit, or a delivery that failed and is on its way back, stay `shipped`: the stock is out and has not come back. (`lost` was `cancelled` in the first build, which
  // would have put a lost parcel back into stock; the official page confirms the word, and this changes its stage.) The words after `lost` are those the mirror lacked, found on the official page 2026-11-21.
  // The stages are the product owner's to confirm.
  lost: 'shipped',
  lost_by_3pl: 'shipped',
  damaged_by_3pl: 'shipped',
  package_scrapped: 'shipped',
  failed_delivery: 'shipped',
  shipped_back: 'shipped',
  shipped_back_failed: 'shipped',
  // The goods are back with the seller: the one new word that brings stock back.
  shipped_back_success: 'returned',
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

// The cursor: where the window of updated orders starts, `u:2026-11-02T03:04:05.000Z`, and, only while a window cannot move (see listOrders), how many of its orders were already read: `u:...:100`.
const CURSOR = /^u:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(?::(\d{1,4}))?$/;
function readCursor(since: string | null): { start: number; skip: number } | null {
  const m = since === null ? null : CURSOR.exec(since);
  const start = m ? Date.parse(m[1]!) : Number.NaN;
  return m && !Number.isNaN(start) ? { start, skip: m[2] === undefined ? 0 : Number(m[2]) } : null;
}
const writeCursor = (start: number, skip = 0): string => `u:${new Date(start).toISOString()}${skip > 0 ? `:${skip}` : ''}`;

export interface LazadaOptions {
  // Bound to LAZADA_HOSTS by the caller (hostBoundFetch); the adapter uses no other.
  fetch: Fetch;
  now?: () => Date;
  // Pause between two calls.
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Lazada's own error codes that name a refused credential or a call limit. Anything else is `unreachable`. `IllegalAccessToken` and `SellerNotVerified` are on official pages ("The specified access token is
// invalid or expired"; "the seller's store opening process has not been completed": the seller must act in Seller Center, and the closest closed kind of the port is `credentials`, whose message says
// "reconnect", which does not finish a store opening: a message of its own is a follow-up, the kinds being a closed list of a shared module). `IncompleteSignature` is on the official token page. The
// rate-limit codes are not on any official page read; they come from SDK sources, and the live check fills the list.
const CREDENTIAL_CODES: ReadonlySet<string> = new Set(['IllegalAccessToken', 'IncompleteSignature', 'SellerNotVerified']);
const RATE_CODES: ReadonlySet<string> = new Set(['ApiCallLimit', 'AppApiCallLimit', 'E1002']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function lazadaMarketplace(options: LazadaOptions): MarketplaceProvider {
  const now = options.now ?? (() => new Date());
  const spacingMs = options.spacingMs ?? DEFAULT_SPACING_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Per app key (Lazada limits per app): the start time of its last call, and a queue that lets one call at a time wait for its turn. The interval is measured from when the last call ACTUALLY started
  // (not from a slot reserved earlier), so a stalled event loop cannot release two waiting calls at once, and one app's calls never hold up another app's.
  const lastStart = new Map<string, number>();
  const queue = new Map<string, Promise<void>>();
  async function takeTurn(appKey: string): Promise<void> {
    const before = queue.get(appKey) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.set(appKey, before.then(() => mine));
    await before;
    try {
      const wait = (lastStart.get(appKey) ?? Number.NEGATIVE_INFINITY) + spacingMs - now().getTime();
      if (wait > 0) await sleep(wait);
      lastStart.set(appKey, now().getTime());
    } finally {
      release();
    }
  }

  // One signed GET; the `data` of an answer whose code is "0". A failure is one of the port's kinds, never Lazada's text.
  async function call(credential: LazadaCredential, path: string, apiParams: Record<string, string>): Promise<unknown> {
    await takeTurn(credential.appKey);
    const params: Record<string, string> = { ...apiParams, app_key: credential.appKey, timestamp: String(now().getTime()), sign_method: 'sha256', access_token: credential.accessToken };
    params.sign = signLazadaRequest(credential.appSecret, path, params);
    let response: Response;
    try {
      response = await options.fetch(`https://${LAZADA_API_HOST}/rest${path}?${new URLSearchParams(params).toString()}`, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      throw new MarketplaceProviderError('unreachable');
    }
    if (!response.ok) {
      // The body is released, not left to hold the connection until the transport cleans up.
      await response.body?.cancel().catch(() => undefined);
      throw new MarketplaceProviderError(response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'credentials' : 'unreachable');
    }
    let answer: unknown;
    try {
      answer = parseMarketplaceJson(await readCappedAnswer(response, () => new MarketplaceProviderError('unreachable')), ID_KEYS);
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
    if (picked === undefined) {
      // A reply that counts orders but carries no list cannot be an empty page: it would read as `ok` with nothing staged, on the same window, on every poll.
      if (isRecord(data) && (Number(data.countTotal) > 0 || Number(data.count) > 0)) throw notRecognized();
      return [];
    }
    if (!Array.isArray(picked) || picked.length > PAGE_SIZE) throw notRecognized();
    const seen = new Set<string>();
    return picked.map((entry) => {
      const o = pickAllowed(entry, ORDER_FIELDS);
      const id = marketplaceDigits(o?.order_id, 40);
      const number = marketplaceIdentifier(o?.order_number, 40);
      const created = parseLazadaTime(o?.created_at);
      const updatedAt = parseLazadaTime(o?.updated_at);
      // An order id twice in one answer is not Lazada's: it would write the same line twice.
      if (!o || id === null || number === null || created === null || updatedAt === null || seen.has(id)) throw notRecognized();
      seen.add(id);
      // The order's day is the day in Vietnam, whatever offset Lazada wrote the time in.
      return { id, number, createdDay: new Date(created + VIETNAM_OFFSET_MS).toISOString().slice(0, 10), updatedAt };
    });
  }

  // The items of the orders, in batches of at most 50 ids, by order id. One order with no item, or an item of another order than the one asked, refuses the page.
  async function readItems(credential: LazadaCredential, orders: readonly RawOrder[]): Promise<Map<string, Array<{ line: MarketplaceOrderLine; stage: MarketplaceOrderStage }>>> {
    const byOrder = new Map<string, Array<{ line: MarketplaceOrderLine; stage: MarketplaceOrderStage }>>();
    // An item id twice in a page would be one line written twice.
    const seenItems = new Set<string>();
    for (let from = 0; from < orders.length; from += ITEMS_BATCH) {
      const batch = orders.slice(from, from + ITEMS_BATCH);
      const data = await call(credential, ITEMS_PATH, { order_ids: `[${batch.map((o) => o.id).join(',')}]` });
      if (!Array.isArray(data)) throw notRecognized();
      const asked = new Set(batch.map((o) => o.id));
      for (const group of data) {
        const orderId = marketplaceDigits(isRecord(group) ? group.order_id : undefined, 40);
        const items = isRecord(group) ? group.order_items : undefined;
        if (orderId === null || !asked.has(orderId) || !Array.isArray(items)) throw notRecognized();
        const rows = byOrder.get(orderId) ?? [];
        for (const raw of items) {
          const item = pickAllowed(raw, ITEM_FIELDS);
          const itemId = marketplaceDigits(item?.order_item_id, 40);
          const paid = marketplaceMoney(item?.paid_price);
          const price = marketplaceMoney(item?.item_price);
          const status = typeof item?.status === 'string' ? item.status.trim().toLowerCase() : '';
          const stage = Object.hasOwn(LAZADA_ITEM_STAGE, status) ? LAZADA_ITEM_STAGE[status] : undefined;
          // An item of another order, a masked or missing amount or SKU, a currency other than dong or a status not in the table: the page is not stored.
          if (!item || itemId === null || paid === null || price === null || stage === undefined) throw notRecognized();
          if (marketplaceDigits(item.order_id, 40) !== orderId) throw notRecognized();
          if (item.currency !== undefined && item.currency !== 'VND') throw notRecognized();
          const sku = item.sku === undefined || item.sku === null || item.sku === '' ? null : marketplaceIdentifier(item.sku, 100);
          if (sku === null && item.sku !== undefined && item.sku !== null && item.sku !== '') throw notRecognized();
          // A product name is the seller's own text: an asterisk in it (a size, a footnote) is not a mask, so only an order number, a SKU and an amount are checked for one.
          const name = typeof item.name === 'string' ? item.name : '';
          if (seenItems.has(itemId)) throw notRecognized();
          seenItems.add(itemId);
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

    // The orders updated since the cursor, at most one page of 100 (raw orders: an order whose items are in different states answers as one port order for each state, so a port page may hold more
    // port orders than that). The window starts at the cursor (never earlier than 30 days back: the capability's window) and is read ascending by update time. Normally it is read from offset 0 and moves
    // forward: a full page resumes a second before its newest order, a short page ten minutes before it, so an order Lazada updates between two pages moves to the end of the list and is read later, and
    // no position is skipped. Only when a full page lies entirely within a second of the window's start (a bulk change) the window cannot move; the same window is then continued by offset until it is
    // read to its end, or shown as `not_recognized` at Lazada's offset limit of 5000 (never skipped without a trace). Each such page resumes SKIP_BACK positions early, so a few orders updated between two polls cost repeats, not a skipped order. Repeats are the confirm step's to dedupe.
    async listOrders(secret: string, platform: MarketplacePlatformKey, since: string | null): Promise<MarketplaceOrderPage> {
      if (platform !== 'lazada') throw new MarketplaceProviderError('unreachable');
      const credential = parseLazadaSecret(secret);
      const floor = now().getTime() - WINDOW_DAYS * DAY_MS;
      const cursor = readCursor(since);
      const start = Math.max(cursor?.start ?? floor, floor);
      // A start the floor moved is a different window: the orders already read there are not known.
      const skip = cursor && cursor.start >= floor && cursor.skip < MAX_OFFSET ? cursor.skip : 0;
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
        // A full page: more orders wait.
        const moved = newest - TIE_MS;
        if (moved > start) {
          next = writeCursor(moved);
        } else {
          // Every order of the page lies within a second of the window's start: continue the same window by offset (a little back from the end of this page, SKIP_BACK), and stop (visibly) at the offset limit.
          const nextSkip = skip + raw.length - SKIP_BACK;
          if (nextSkip >= MAX_OFFSET) throw notRecognized();
          next = writeCursor(start, nextSkip);
        }
      } else {
        // The window is read to its end: the next one starts a little before the newest order, and never earlier than this one.
        next = writeCursor(Math.max(start, newest - OVERLAP_MS));
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
