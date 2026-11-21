// SPDX-License-Identifier: AGPL-3.0-only
// The TikTok Shop orders adapter (#2524, T2 = #4259; design https://github.com/DOS/Ludy/issues/2524#issuecomment-7059664269), DORMANT: nothing offers `tiktok_shop` to a deployment until the live check
// (#2522) has confirmed what this assumes, and the wiring slice (config, connect form, authorize path, worker) is not built. It sits on T1's signed caller (marketplace-tiktok.ts), so the orders poll and the
// other reads of one app and shop share one pace. Built from the OFFICIAL Partner Center pages read on 2026-11-21 (get-order-list-202309, get-order-detail-202507, search-returns-202602,
// return-refund-and-cancel-api-overview); what the pages do not say is for the live check: whether a line item is always one unit, the words the API really sends for a finished return, the decimals of a
// dong amount, and whether a page token outlives a poll.
//
// READ ONLY, three paths: the orders changed since a time (a signed POST whose exact body is the one signed), the orders by id (GET, at most 50) and the returns changed since a time (a signed POST).
// A buyer's name, phone, address, e-mail and id never leave the edge: every record is read through an allow-list of fields.
//
// WHAT A STAGE DOES TO STOCK (modules/finance/src/marketplace-orders.ts, `moveLineStock`): `shipped` and `completed` take stock out; `returned` brings it back; `cancelled` moves nothing for a line that never
// shipped but BRINGS STOCK BACK for a line that did, and is final. So a goods-gone word must not be `cancelled` after a shipment (see the stock rule below), and a return brings stock back only when the goods
// are back with the seller.
//
// CANCELLATIONS come from the order itself (status and the line's `cancel_user`): the cancellation search adds only requests still pending, which move no stock, so it is not called.
//
// THE CURSOR is two windows, `o:<iso>;r:<iso>`: the orders changed since the first and the returns changed since the second. A page token is never kept between polls (it may expire): a window whose first page
// is full and lies within one second of its start is read on by token in the same call, up to MAX_PAGES, and past that it is `not_recognized`, never skipped without a trace.
import { money, toMoney } from '@crove/l10n-vn';
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
import { cleanLabel, marketplaceDigits, marketplaceIdentifier, marketplaceMoney, notRecognized, pickAllowed } from './marketplace-adapter-kit.ts';
import { TIKTOK_HOSTS, parseTiktokSecret, testTiktokConnection, tiktokCaller, type TiktokCaller, type TiktokCredential, type TiktokOptions } from './marketplace-tiktok.ts';

// The paths this adapter calls: the orders changed since a time (POST, the body is signed), the orders by id (GET) and the returns changed since a time (POST).
const ORDERS_SEARCH_PATH = '/order/202309/orders/search';
const ORDERS_DETAIL_PATH = '/order/202507/orders';
const RETURNS_SEARCH_PATH = '/return_refund/202602/returns/search';

// The port's own page size for TikTok (50): the order list takes 1 to 100 and the return list 10 to 50, so one figure is inside both.
const PAGE_SIZE = MARKETPLACE_PLATFORM_LIMITS.tiktok_shop.pageSize;
const DETAIL_BATCH = 50;
const WINDOW_DAYS = MARKETPLACE_PLATFORM_LIMITS.tiktok_shop.windowDays;
// A resumed read starts this far before the newest record seen, so one TikTok updates late is caught; the confirm step dedupes and moves a stage forward only.
const OVERLAP_MS = 10 * 60_000;
// A full page resumes this far before its newest record, so the records that share its last second are read again rather than lost (the `*_ge` filter is in whole seconds).
const TIE_MS = 1000;
// The most pages one window reads in one call when it cannot move (a bulk change within one second).
const MAX_PAGES = 5;
const MAX_LINES_PER_ORDER = 500;
const DAY_MS = 86_400_000;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;

// The fields of an order, of a line item and of a return the adapter reads. Anything else (recipient_address, buyer_email, buyer_message, user_id, buyer_nickname, cpf, payment, reasons, ...) is never copied.
const ORDER_FIELDS = ['id', 'status', 'create_time', 'update_time', 'rts_time', 'collection_time', 'delivery_time', 'line_items'] as const;
const LINE_FIELDS = ['id', 'sku_id', 'seller_sku', 'product_name', 'sku_name', 'display_status', 'sale_price', 'original_price', 'currency', 'cancel_user'] as const;
const RETURN_FIELDS = ['order_id', 'return_id', 'return_type', 'return_status', 'update_time', 'return_line_items'] as const;
const RETURN_LINE_FIELDS = ['order_line_item_id'] as const;
// The answers' fields that hold an id: TikTok's are 18 digits, past 2^53, and are strings in the documentation; if one ever arrives as a number it is kept as the digits written.
const ID_KEYS = ['id', 'order_id', 'return_id', 'sku_id', 'order_line_item_id'] as const;

// The stage of an order or a line by TikTok's status word. CLOSED: a word not in this table makes the page `not_recognized` and nothing is stored. The order list's `status` and a line's `display_status` use
// the same words but for `PARTIALLY_SHIPPING` (an order only); the webhook writes `CANCEL` where the API writes `CANCELLED`, so both are accepted. The stages are this code's reading of the words and are
// checked in the live trial.
export const TIKTOK_ORDER_STAGE: Readonly<Record<string, MarketplaceOrderStage>> = {
  UNPAID: 'placed',
  ON_HOLD: 'placed',
  AWAITING_SHIPMENT: 'placed',
  PARTIALLY_SHIPPING: 'shipped',
  AWAITING_COLLECTION: 'shipped',
  IN_TRANSIT: 'shipped',
  DELIVERED: 'completed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  CANCEL: 'cancelled',
};

// What a return status does to stock: `goods_back` when, for a return that sends the item back, the seller has the goods and the refund is approved or done; `no_stock` for every other word (open, rejected,
// cancelled, or a refund without goods). The official pages disagree on the words of a finished return (the overview and the Search Returns page word it differently), so BOTH families are here and the
// live check says which one the API sends. CLOSED: a word not here is `not_recognized`.
type ReturnEffect = 'goods_back' | 'no_stock';
export const TIKTOK_RETURN_STATUS: Readonly<Record<string, ReturnEffect>> = {
  // The seller has the goods and the refund is approved or done (after the quality check).
  RETURN_OR_REFUND_REQUEST_SUCCESS: 'goods_back',
  RETURN_OR_REFUND_REQUEST_COMPLETE: 'goods_back',
  REQUEST_SUCCESS: 'goods_back',
  // Still open: nothing is back yet.
  RETURN_OR_REFUND_REQUEST_PENDING: 'no_stock',
  AWAITING_BUYER_SHIP: 'no_stock',
  BUYER_SHIPPED_ITEM: 'no_stock',
  AWAITING_BUYER_RESPONSE: 'no_stock',
  REPLACEMENT_REQUEST_PENDING: 'no_stock',
  EXCHANGE_REQUEST_PENDING: 'no_stock',
  // Closed without the goods coming back (both families).
  REFUND_OR_RETURN_REQUEST_REJECT: 'no_stock',
  REJECT_RECEIVE_PACKAGE: 'no_stock',
  RETURN_OR_REFUND_REQUEST_CANCEL: 'no_stock',
  REQUEST_REJECTED: 'no_stock',
  RECEIVE_REJECTED: 'no_stock',
  RETURN_OR_REFUND_CANCEL: 'no_stock',
  // A replacement or an exchange creates a new order by itself and moves no stock here; a refund in place of one has no goods back.
  REPLACEMENT_REQUEST_REJECT: 'no_stock',
  REPLACEMENT_REQUEST_CANCEL: 'no_stock',
  REPLACEMENT_REQUEST_COMPLETE: 'no_stock',
  REPLACEMENT_REQUEST_REFUND_SUCCESS: 'no_stock',
  EXCHANGE_REQUEST_CANCEL: 'no_stock',
  EXCHANGE_REQUEST_COMPLETE: 'no_stock',
  EXCHANGE_REQUEST_REFUND_SUCCESS: 'no_stock',
};
// The return types: only `RETURN_AND_REFUND` sends the item back; `REFUND` is a refund with no return (the buyer keeps the item), `REPLACEMENT` and `EXCHANGE` make a new order.
export const TIKTOK_RETURN_TYPES: readonly string[] = ['REFUND', 'RETURN_AND_REFUND', 'REPLACEMENT', 'EXCHANGE'];
const CANCEL_USERS: ReadonlySet<string> = new Set(['BUYER', 'SELLER', 'OPERATOR', 'SYSTEM']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const vietnamDay = (ms: number): string => new Date(ms + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

// A time as TikTok writes it: whole Unix seconds, in milliseconds here. Optional ones may be missing, null or 0 (unset); one that is present and not a plausible time refuses the page.
function timeOf(value: unknown, required: boolean): number | null {
  if (!required && (value === undefined || value === null || value === 0)) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000_000_000 || value > 99_999_999_999) throw notRecognized();
  return value * 1000;
}

// The cursor: where each window starts, `o:2026-11-02T03:04:05.000Z;r:2026-11-02T03:04:05.000Z`.
const CURSOR = /^o:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z);r:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
function readCursor(since: string | null): { orders: number; returns: number } | null {
  const m = since === null ? null : CURSOR.exec(since);
  if (!m) return null;
  const orders = Date.parse(m[1]!);
  const returns = Date.parse(m[2]!);
  return Number.isNaN(orders) || Number.isNaN(returns) ? null : { orders, returns };
}
const writeCursor = (orders: number, returns: number): string => `o:${new Date(orders).toISOString()};r:${new Date(returns).toISOString()}`;

// One order line as read, before lines of one SKU are folded into a quantity.
interface RawLine {
  id: string;
  skuId: string;
  sku: string | null;
  itemName: string;
  unitPrice: string;
  amount: string;
  stage: MarketplaceOrderStage;
}

interface RawOrder {
  id: string;
  updatedAt: number;
  createdDay: string;
  shippedDay: string | null;
  deliveredDay: string | null;
  lines: RawLine[];
}

// One order of an answer as only the fields the adapter reads; anything malformed, unknown or masked refuses the page.
function parseOrder(entry: unknown, seenLines: Set<string>): RawOrder {
  const o = pickAllowed(entry, ORDER_FIELDS);
  const id = marketplaceDigits(o?.id, 40);
  const status = typeof o?.status === 'string' ? o.status : '';
  if (!o || id === null || !Object.hasOwn(TIKTOK_ORDER_STAGE, status)) throw notRecognized();
  const created = timeOf(o.create_time, true)!;
  const updatedAt = timeOf(o.update_time, true)!;
  const shipped = timeOf(o.rts_time, false);
  const collected = timeOf(o.collection_time, false);
  const delivered = timeOf(o.delivery_time, false);
  const raw = o.line_items;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LINES_PER_ORDER) throw notRecognized();
  const lines = raw.map((item): RawLine => {
    const l = pickAllowed(item, LINE_FIELDS);
    const lineId = marketplaceDigits(l?.id, 40);
    const skuId = marketplaceDigits(l?.sku_id, 40);
    const display = typeof l?.display_status === 'string' ? l.display_status : '';
    const price = marketplaceMoney(l?.original_price);
    const paid = marketplaceMoney(l?.sale_price);
    if (!l || lineId === null || skuId === null || price === null || paid === null || !Object.hasOwn(TIKTOK_ORDER_STAGE, display)) throw notRecognized();
    // An amount in another currency than dong, or none stated, is not stored: the shop is a Vietnam one and a figure of another currency would be booked as dong.
    if (l.currency !== 'VND') throw notRecognized();
    const cancelUser = l.cancel_user === undefined || l.cancel_user === null || l.cancel_user === '' ? null : typeof l.cancel_user === 'string' && CANCEL_USERS.has(l.cancel_user) ? l.cancel_user : undefined;
    if (cancelUser === undefined) throw notRecognized();
    const sku = l.seller_sku === undefined || l.seller_sku === null || l.seller_sku === '' ? null : marketplaceIdentifier(l.seller_sku, 100);
    if (sku === null && l.seller_sku !== undefined && l.seller_sku !== null && l.seller_sku !== '') throw notRecognized();
    // A line item id twice in a page would be one line written twice.
    if (seenLines.has(lineId)) throw notRecognized();
    seenLines.add(lineId);
    // THE STOCK RULE (accepted by the Accounting PO on #2524): a line the SYSTEM cancelled after the carrier had collected it is a parcel lost in transit (TikTok cancels after about seven days without
    // tracking progress). Its goods are gone, not back, so it stays `shipped` (stock stays out; a write-off is a person's bookkeeping) and never becomes `cancelled`, which would put it back into stock.
    let stage = TIKTOK_ORDER_STAGE[display]!;
    if (stage === 'cancelled' && cancelUser === 'SYSTEM' && collected !== null) stage = 'shipped';
    const product = typeof l.product_name === 'string' ? l.product_name : '';
    const variant = typeof l.sku_name === 'string' && l.sku_name !== '' ? ` - ${l.sku_name}` : '';
    return { id: lineId, skuId, sku, itemName: cleanLabel(`${product}${variant}`, 300), unitPrice: price, amount: paid, stage };
  });
  return { id, updatedAt, createdDay: vietnamDay(created), shippedDay: shipped === null ? null : vietnamDay(shipped), deliveredDay: delivered === null ? null : vietnamDay(delivered), lines };
}

// One return of an answer as only the fields the adapter reads. A status or a type not in the closed tables refuses the page.
interface RawReturn {
  returnId: string;
  orderId: string;
  updatedAt: number;
  // The order line item ids the return names, only read for a return that brings goods back.
  goodsBackLines: string[];
}

function parseReturn(entry: unknown): RawReturn {
  const r = pickAllowed(entry, RETURN_FIELDS);
  const orderId = marketplaceDigits(r?.order_id, 40);
  const returnId = marketplaceDigits(r?.return_id, 40);
  const type = typeof r?.return_type === 'string' ? r.return_type : '';
  const status = typeof r?.return_status === 'string' ? r.return_status : '';
  if (!r || orderId === null || returnId === null || !TIKTOK_RETURN_TYPES.includes(type) || !Object.hasOwn(TIKTOK_RETURN_STATUS, status)) throw notRecognized();
  const updatedAt = timeOf(r.update_time, true)!;
  // Only a return that sends the item back, at a status that says the goods are with the seller, moves stock; the others are read (and checked) and ignored.
  const goodsBack = type === 'RETURN_AND_REFUND' && TIKTOK_RETURN_STATUS[status] === 'goods_back';
  const goodsBackLines: string[] = [];
  if (goodsBack) {
    const items = r.return_line_items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_LINES_PER_ORDER) throw notRecognized();
    for (const item of items) {
      const lineId = marketplaceDigits(pickAllowed(item, RETURN_LINE_FIELDS)?.order_line_item_id, 40);
      if (lineId === null) throw notRecognized();
      goodsBackLines.push(lineId);
    }
  }
  return { returnId, orderId, updatedAt, goodsBackLines };
}

// An opaque page token: kept only inside one call, so it is not stored anywhere.
function nextToken(data: Record<string, unknown>): string | null {
  const token = data.next_page_token;
  if (token === undefined || token === null || token === '') return null;
  if (typeof token !== 'string' || token.length > 2000 || !/^[\x21-\x7e]+$/.test(token)) throw notRecognized();
  return token;
}

// Read one window: the records changed since `startMs`, ascending by update time. Normally one page: a short page ends the window (the next starts a little before its newest record), a full page moves the
// window to a second before its newest record. Only when a full page lies entirely within one second of the start (a bulk change) the window cannot move by time: the same window is then read on by page token,
// in this call, up to MAX_PAGES, and past that it is `not_recognized`. `cursor` is null while nothing was read (the window stays where it was).
async function readWindow<T extends { id: string; updatedAt: number }>(
  startMs: number,
  fetchPage: (token: string | null) => Promise<{ records: T[]; next: string | null; full: boolean }>,
): Promise<{ records: T[]; cursor: number | null; more: boolean }> {
  const byId = new Map<string, T>();
  let token: string | null = null;
  for (let page = 0; ; page += 1) {
    const got = await fetchPage(token);
    for (const record of got.records) byId.set(record.id, record);
    if (byId.size === 0) return { records: [], cursor: null, more: false };
    const newest = Math.max(...[...byId.values()].map((r) => r.updatedAt));
    // A page is only whole when TikTok says more waits (a token) behind a full page.
    if (!got.full || got.next === null) return { records: [...byId.values()], cursor: Math.max(startMs, newest - OVERLAP_MS), more: false };
    if (newest - TIE_MS > startMs) return { records: [...byId.values()], cursor: newest - TIE_MS, more: true };
    if (page + 1 >= MAX_PAGES) throw notRecognized();
    token = got.next;
  }
}

// `caller` is the one signed call of the TikTok adapters; pass the same instance to a later finance reader so one app and shop is paced across both.
export function tiktokMarketplace(options: TiktokOptions, caller: TiktokCaller = tiktokCaller(options)): MarketplaceProvider {
  const now = options.now ?? (() => new Date());

  // The shop the poll reads: the connection must have chosen one (T1's shop list gives its cipher); without one there is nothing to ask.
  const shopOf = (credential: TiktokCredential): string => {
    if (credential.shopCipher === null) throw new MarketplaceProviderError('credentials');
    return credential.shopCipher;
  };

  async function searchOrders(credential: TiktokCredential, startMs: number, token: string | null) {
    const query: Record<string, string> = { page_size: String(PAGE_SIZE), sort_field: 'update_time', sort_order: 'ASC', shop_cipher: shopOf(credential), ...(token === null ? {} : { page_token: token }) };
    // The body is the exact text signed and sent.
    const data = await caller(credential, { method: 'POST', path: ORDERS_SEARCH_PATH, query, body: JSON.stringify({ update_time_ge: Math.floor(startMs / 1000) }) }, ID_KEYS);
    if (!isRecord(data)) throw notRecognized();
    const list = data.orders;
    // A reply that counts orders but carries no list cannot be an empty page: it would read as `ok` with nothing staged, on the same window, on every poll.
    if (list === undefined) {
      if (Number(data.total_count) > 0) throw notRecognized();
      return { records: [] as RawOrder[], next: null, full: false };
    }
    if (!Array.isArray(list) || list.length > PAGE_SIZE) throw notRecognized();
    const seenLines = new Set<string>();
    const seen = new Set<string>();
    const records = list.map((entry) => {
      const order = parseOrder(entry, seenLines);
      // An order id twice in one answer is not TikTok's: it would write the same lines twice.
      if (seen.has(order.id)) throw notRecognized();
      seen.add(order.id);
      return order;
    });
    return { records, next: nextToken(data), full: records.length >= PAGE_SIZE };
  }

  async function searchReturns(credential: TiktokCredential, startMs: number, token: string | null) {
    const query: Record<string, string> = { page_size: String(PAGE_SIZE), sort_field: 'update_time', sort_order: 'ASC', shop_cipher: shopOf(credential), ...(token === null ? {} : { page_token: token }) };
    const data = await caller(credential, { method: 'POST', path: RETURNS_SEARCH_PATH, query, body: JSON.stringify({ update_time_ge: Math.floor(startMs / 1000) }) }, ID_KEYS);
    if (!isRecord(data)) throw notRecognized();
    // `return_orders` is omitted when the page holds no return.
    const list = data.return_orders;
    if (list === undefined) {
      if (Number(data.total_count) > 0) throw notRecognized();
      return { records: [] as Array<RawReturn & { id: string }>, next: null, full: false };
    }
    if (!Array.isArray(list) || list.length > PAGE_SIZE) throw notRecognized();
    const records = list.map((entry) => {
      const r = parseReturn(entry);
      return { ...r, id: r.returnId };
    });
    return { records, next: nextToken(data), full: records.length >= PAGE_SIZE };
  }

  // The orders by id (at most 50 a call), for the returns whose order was not in the orders page. An order asked for and not answered refuses the page.
  async function readOrdersById(credential: TiktokCredential, ids: readonly string[]): Promise<RawOrder[]> {
    const out: RawOrder[] = [];
    for (let from = 0; from < ids.length; from += DETAIL_BATCH) {
      const batch = ids.slice(from, from + DETAIL_BATCH);
      const data = await caller(credential, { method: 'GET', path: ORDERS_DETAIL_PATH, query: { ids: batch.join(','), shop_cipher: shopOf(credential) } }, ID_KEYS);
      const list = isRecord(data) ? data.orders : undefined;
      if (!Array.isArray(list) || list.length > DETAIL_BATCH) throw notRecognized();
      const seenLines = new Set<string>();
      const got = new Map<string, RawOrder>();
      for (const entry of list) {
        const order = parseOrder(entry, seenLines);
        if (!batch.includes(order.id) || got.has(order.id)) throw notRecognized();
        got.set(order.id, order);
      }
      for (const id of batch) {
        const order = got.get(id);
        if (order === undefined) throw notRecognized();
        out.push(order);
      }
    }
    return out;
  }

  // The port orders of the raw ones: lines of one SKU, one price and one stage are folded into one line of that quantity (a line item is one unit, so the quantity is how many there are), and an order
  // whose lines are in different stages answers as one port order for each stage.
  function toPortOrders(orders: readonly RawOrder[]): MarketplaceOrder[] {
    const grouped = new Map<string, Omit<MarketplaceOrder, 'lines'> & { lines: MarketplaceOrderLine[] }>();
    for (const order of orders) {
      const byStage = new Map<MarketplaceOrderStage, Map<string, { skuId: string; sku: string | null; itemName: string; unitPrice: string; quantity: number; amount: ReturnType<typeof money> }>>();
      for (const line of order.lines) {
        const stageLines = byStage.get(line.stage) ?? new Map();
        const key = `${line.skuId}\u0000${line.unitPrice}`;
        const have = stageLines.get(key);
        if (have) {
          have.quantity += 1;
          have.amount = have.amount.plus(line.amount);
        } else {
          stageLines.set(key, { skuId: line.skuId, sku: line.sku, itemName: line.itemName, unitPrice: line.unitPrice, quantity: 1, amount: money(line.amount) });
        }
        byStage.set(line.stage, stageLines);
      }
      for (const [stage, stageLines] of byStage) {
        // Dates only where the stage makes them true: a cancelled order shipped nothing, and only a completed or returned one was delivered.
        const shipped = stage === 'shipped' || stage === 'completed' || stage === 'returned';
        const delivered = stage === 'completed' || stage === 'returned';
        const sorted = [...stageLines.values()].sort((a, b) => (a.skuId === b.skuId ? (a.unitPrice < b.unitPrice ? -1 : 1) : a.skuId < b.skuId ? -1 : 1));
        // The line key: the SKU id, with `~n` after the first for a second price of the same SKU, so two lines never share one.
        const seenSku = new Map<string, number>();
        const lines = sorted.map((l): MarketplaceOrderLine => {
          const n = (seenSku.get(l.skuId) ?? 0) + 1;
          seenSku.set(l.skuId, n);
          return { lineKey: n === 1 ? l.skuId : `${l.skuId}~${n}`, sku: l.sku, itemName: l.itemName, quantity: String(l.quantity), unitPrice: l.unitPrice, amount: toMoney(l.amount) };
        });
        grouped.set(`${order.id}\u0000${stage}`, { orderNo: order.id, orderedAt: order.createdDay, shippedAt: shipped ? order.shippedDay : null, deliveredAt: delivered ? order.deliveredDay : null, stage, lines });
      }
    }
    // Deterministic bytes: the same window gives the same page, so the intake's content hash recognises a page read twice.
    return [...grouped.values()].sort((a, b) => (a.orderNo === b.orderNo ? (a.stage < b.stage ? -1 : 1) : a.orderNo < b.orderNo ? -1 : 1));
  }

  return {
    id: 'tiktok_shop',
    hosts: TIKTOK_HOSTS,
    // What the seller types to connect: the App Key and App Secret of their own app. The authorize step adds the tokens and the shop (the wiring slice).
    connectFields: ['appKey', 'appSecret'],
    capabilities: { platforms: { tiktok_shop: MARKETPLACE_PLATFORM_LIMITS.tiktok_shop } },

    // T1's test: one call, the shop list.
    testConnection(secret: string): Promise<MarketplaceTestResult> {
      return testTiktokConnection(caller, secret);
    },

    // The orders (and the returns) changed since the cursor. The windows start at the cursor (never earlier than 30 days back: the capability's window).
    async listOrders(secret: string, platform: MarketplacePlatformKey, since: string | null): Promise<MarketplaceOrderPage> {
      if (platform !== 'tiktok_shop') throw new MarketplaceProviderError('unreachable');
      const credential = parseTiktokSecret(secret);
      shopOf(credential);
      const floor = now().getTime() - WINDOW_DAYS * DAY_MS;
      const cursor = readCursor(since);
      const ordersStart = Math.max(cursor?.orders ?? floor, floor);
      const returnsStart = Math.max(cursor?.returns ?? floor, floor);

      const ordersRead = await readWindow(ordersStart, (token) => searchOrders(credential, ordersStart, token));
      const returnsRead = await readWindow(returnsStart, (token) => searchReturns(credential, returnsStart, token));

      // The lines a return says came back, by order.
      const backByOrder = new Map<string, Set<string>>();
      for (const r of returnsRead.records) {
        if (r.goodsBackLines.length === 0) continue;
        const set = backByOrder.get(r.orderId) ?? new Set<string>();
        for (const lineId of r.goodsBackLines) set.add(lineId);
        backByOrder.set(r.orderId, set);
      }
      // A return whose order is not in this page: the order is read by id so its lines can be named.
      const byId = new Map(ordersRead.records.map((o) => [o.id, o] as const));
      const missing = [...backByOrder.keys()].filter((id) => !byId.has(id)).sort();
      if (missing.length > 0) for (const order of await readOrdersById(credential, missing)) byId.set(order.id, order);
      for (const [orderId, lineIds] of backByOrder) {
        const order = byId.get(orderId);
        if (!order) throw notRecognized();
        for (const lineId of lineIds) {
          const line = order.lines.find((l) => l.id === lineId);
          // A return that names a line the order does not hold is not TikTok's answer.
          if (!line) throw notRecognized();
          if (line.stage !== 'cancelled') line.stage = 'returned';
        }
      }

      // Nothing new in either window: the cursor stays.
      if (ordersRead.cursor === null && returnsRead.cursor === null) return { orders: [], nextCursor: since };
      const next = writeCursor(ordersRead.cursor ?? ordersStart, returnsRead.cursor ?? returnsStart);
      return { orders: toPortOrders([...byId.values()]), nextCursor: next, more: ordersRead.more || returnsRead.more };
    },

    // Not in this slice: the order's money lines come with the finance reads (T3); a poll never asks for them today.
    async orderFinance() {
      return null;
    },

    // Never: the port's stock list is called by nothing yet, and the orders path has no stock endpoint.
    async listStock() {
      return [];
    },
  };
}
