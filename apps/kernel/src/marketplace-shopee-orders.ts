// SPDX-License-Identifier: AGPL-3.0-only
// The Shopee orders adapter (#2524, S1 = #4274; design https://github.com/DOS/Ludy/issues/2524#issuecomment-7061583765 and the PO's decisions in the comment after it), DORMANT: nothing offers `shopee` to a
// deployment until the live check (#2522) has confirmed what this assumes and the wiring slice (config, connect form, authorize path, worker) is built. It sits on the signed caller (marketplace-shopee.ts), so
// the orders poll and the later reads of one partner and shop share one pace. Built from the OFFICIAL pages read on 2026-11-21 (open.shopee.com: v2.order.get_order_list, v2.order.get_order_detail and the
// Data Definition page); what the pages do not say is for the live check: whether a list without a status filter returns every status, the order the list is in, whether `pickup_done_time` is always set once
// a parcel left, the real decimals of a dong amount, and what the bundle-deal price words mean in practice.
//
// READ ONLY, two paths: `get_order_list` (the orders whose UPDATE time is in a window, at most 100 a page, window at most 15 days) and `get_order_detail` (by order number, at most 50 a call). Returns (S2) and
// the escrow (S3) are other slices. A buyer's name, id, address and phone are never asked for (the optional fields named below do not include them) and every record is read through an allow-list anyway.
//
// WHAT A STAGE DOES TO STOCK (modules/finance/src/marketplace-orders.ts, `moveLineStock`): `shipped` and `completed` take stock out; `returned` brings it back; `cancelled` moves nothing for a line that never
// shipped but BRINGS STOCK BACK for a line that did, and is final. So THE STOCK RULE (accepted by the Accounting PO on #2524): a cancellation by `system` or `Ops` after the carrier picked the parcel up (the
// order carries `pickup_done_time`) is a parcel the platform gave up on, goods gone and not back: it stays `shipped` (stock stays out; a write-off is a person's bookkeeping) and never becomes `cancelled`.
// A cancellation by the buyer or the seller, or any cancellation before pickup, stays `cancelled`; one after pickup that names nobody is treated like the platform's.
//
// THE CURSOR is `o:<iso>[;s:<n>][;r:<iso>[;rs:<n>]]`: the end of the orders window read and the width the next read starts with (`;s:0` is left out). The list gives order numbers and statuses only, no time and
// no promised order, so the orders poll cannot resume in the middle of a window: it reads [cursor - 10 minutes, end], and when the list says `more` (over 100 orders: the port's page) the window is cut to the next
// narrower width: 15 days (the platform's own limit), 3 days, a day, 6 hours, an hour, 10 minutes, a minute; past that the page is `not_recognized`, never skipped without a trace. The width that worked is kept in
// the cursor: a window with no order makes the next one wider (a quiet shop is read in one call, and a burst that was cut is passed quickly), a window with orders keeps its width. A caught-up poll moves the
// cursor only when it found orders. When a window holds more eligible returns than SHOPEE_MAX_RETURN_DETAILS (or pushes orders past PAGE_SIZE), returns are taken deterministically by `(update_time, return_sn)`
// while they fit, orders advance to `end`, and `;r:<iso>[;rs:<n>]` holds the returns window before the first untaken return (without re-applying the 10-minute overlap) until returns catch up to `o:`.
import { money, toMoney } from '@ludy/l10n-vn';
import { MARKETPLACE_PLATFORM_LIMITS, MarketplaceProviderError, marketplaceCellText, type MarketplaceOrder, type MarketplaceOrderLine, type MarketplaceOrderPage, type MarketplaceOrderStage, type MarketplacePlatformKey, type MarketplaceProvider, type MarketplaceTestResult } from '@ludy/mod-finance';
import { cleanLabel, marketplaceDigits, marketplaceIdentifier, marketplaceMoney, notRecognized, pickAllowed } from './marketplace-adapter-kit.ts';
import { SHOPEE_MAX_RETURN_DETAILS, goodsBackLines, mayBringGoodsBack, readReturnDetail, readReturnList, type ReturnsWindow, type ShopeeReturn } from './marketplace-shopee-returns.ts';
import { SHOPEE_HOSTS, parseShopeeAnswer, parseShopeeSecret, shopeeCaller, testShopeeConnection, type ShopeeCaller, type ShopeeCredential, type ShopeeOptions } from './marketplace-shopee.ts';

const ORDER_LIST_PATH = '/api/v2/order/get_order_list';
const ORDER_DETAIL_PATH = '/api/v2/order/get_order_detail';

// A list page is the port's page (100 orders, the platform's own cap); a detail call takes at most 50 numbers.
const PAGE_SIZE = MARKETPLACE_PLATFORM_LIMITS.shopee.pageSize;
const DETAIL_BATCH = 50;
const WINDOW_DAYS = MARKETPLACE_PLATFORM_LIMITS.shopee.windowDays;
const DAY_MS = 86_400_000;
// The window widths a poll tries in turn, widest first, when the list says there are more than a page.
const SLICES_MS: readonly number[] = [WINDOW_DAYS * DAY_MS, 3 * DAY_MS, DAY_MS, 6 * 3_600_000, 3_600_000, 600_000, 60_000];
// A resumed read starts this far before the cursor, so an order Shopee updates late is caught; the confirm step dedupes and moves a stage forward only.
const OVERLAP_MS = 10 * 60_000;
// Held returns resume this far before the first untaken return when strictly past the first taken return's second, so whole-second filtering never loses or loops.
const TIE_MS = 1000;
const MAX_LINES_PER_ORDER = 500;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;
// A record updated later than this past the clock is not Shopee's: it would move the cursor into the future and the shop would stop syncing without a word.
const FUTURE_SLACK_MS = DAY_MS;

// The optional fields of the detail call: the items, the pickup time and who cancelled. Nothing of the buyer is asked for.
const DETAIL_FIELDS = 'item_list,pickup_done_time,cancel_by';
const ORDER_FIELDS = ['order_sn', 'region', 'currency', 'order_status', 'create_time', 'update_time', 'item_list', 'pickup_done_time', 'cancel_by'] as const;
const ITEM_FIELDS = ['item_id', 'item_name', 'item_sku', 'model_id', 'model_name', 'model_sku', 'model_quantity_purchased', 'model_original_price', 'model_discounted_price'] as const;

// The stage of an order by Shopee's status word (Data Definition, OrderStatus). CLOSED: a word not in this table makes the page `not_recognized` and nothing is stored. CANCELLED and IN_CANCEL are decided
// again below by who cancelled and whether the parcel was picked up. The stages are this code's reading of the words and are checked in the live trial.
export const SHOPEE_ORDER_STAGE: Readonly<Record<string, MarketplaceOrderStage>> = {
  UNPAID: 'placed',
  PENDING: 'placed',
  INVOICE_PENDING: 'placed',
  READY_TO_SHIP: 'placed',
  PROCESSED: 'placed',
  RETRY_SHIP: 'placed',
  SHIPPED: 'shipped',
  TO_CONFIRM_RECEIVE: 'shipped',
  // The buyer asked to return it: the order is not `returned` until a return record says the goods are back (S2).
  TO_RETURN: 'shipped',
  IN_CANCEL: 'placed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
};
const CANCEL_BY: ReadonlySet<string> = new Set(['buyer', 'seller', 'system', 'ops']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const vietnamDay = (ms: number): string => new Date(ms + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

// A time as Shopee writes it: whole Unix seconds, in milliseconds here. Optional ones may be missing, null or 0 (unset); one that is present and not a plausible time refuses the page.
function timeOf(value: unknown, required: boolean): number | null {
  if (!required && (value === undefined || value === null || value === 0)) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000_000_000 || value > 99_999_999_999) throw notRecognized();
  return value * 1000;
}

const CURSOR = /^o:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(?:;s:([0-6]))?(?:;r:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(?:;rs:([0-6]))?)?$/;
interface ShopeeCursor {
  at: number;
  width: number;
  returnsAt: number | null;
  returnsWidth: number;
}
function readCursor(since: string | null): ShopeeCursor | null {
  const m = since === null ? null : CURSOR.exec(since);
  if (!m) return null;
  const at = Date.parse(m[1]!);
  const returnsAt = m[3] === undefined ? null : Date.parse(m[3]);
  if (Number.isNaN(at) || (returnsAt !== null && (Number.isNaN(returnsAt) || returnsAt > at))) return null;
  return {
    at,
    width: m[2] === undefined ? 0 : Number(m[2]),
    returnsAt,
    returnsWidth: m[4] === undefined ? 0 : Number(m[4]),
  };
}
function writeCursor(ms: number, width: number, returnsAt: number | null = null, returnsWidth = 0): string {
  const orders = `o:${new Date(ms).toISOString()}${width === 0 ? '' : `;s:${width}`}`;
  if (returnsAt === null) return orders;
  return `${orders};r:${new Date(returnsAt).toISOString()}${returnsWidth === 0 ? '' : `;rs:${returnsWidth}`}`;
}

async function readSlicedWindow<T extends { more: boolean }>(
  startMs: number,
  fromMs: number,
  maxEndMs: number,
  initialWidth: number,
  readSlice: (endMs: number) => Promise<T>,
): Promise<{ endMs: number; width: number; result: T } | null> {
  for (let width = initialWidth; width < SLICES_MS.length; width += 1) {
    // The platform allows at most 15 days between the two times.
    const endMs = Math.min(startMs + SLICES_MS[width]!, maxEndMs, fromMs + WINDOW_DAYS * DAY_MS - 1000);
    if (Math.floor(endMs / 1000) <= Math.floor(fromMs / 1000)) return null;
    const result = await readSlice(endMs);
    if (!result.more) return { endMs, width, result };
  }
  // Over a page even in the smallest window: not skipped, not stored.
  throw notRecognized();
}

// Take returns deterministically by `(updatedAt, returnSn)` while their detail calls and combined order set fit within one poll's caps; hold the rest for the next poll.
function selectReturns(
  orderNumbers: readonly string[],
  returns: readonly ShopeeReturn[],
  returnsFrom: number,
  returnsEnd: number,
): { numbers: string[]; taken: ShopeeReturn[]; heldAt: number | null } {
  const wanted = returns.filter(mayBringGoodsBack);
  const sorted = [...wanted].sort((a, b) => a.updatedAt - b.updatedAt || (a.returnSn < b.returnSn ? -1 : a.returnSn > b.returnSn ? 1 : 0));
  const union = new Set(orderNumbers);
  const taken: ShopeeReturn[] = [];
  let heldAt: number | null = null;
  let hitDetailCap = false;
  for (const ret of sorted) {
    if (taken.length >= SHOPEE_MAX_RETURN_DETAILS) {
      heldAt = ret.updatedAt;
      hitDetailCap = true;
      break;
    }
    if (!union.has(ret.orderNo) && union.size + 1 > PAGE_SIZE) {
      heldAt = ret.updatedAt;
      break;
    }
    union.add(ret.orderNo);
    taken.push(ret);
  }
  if (heldAt === null) return { numbers: [...union].sort(), taken, heldAt: null };
  const cappedHeldAt = Math.min(heldAt, returnsEnd);
  // Over 40 eligible returns within the same second cannot be split by a whole-second time filter: fail loudly rather than looping or skipping.
  if (hitDetailCap && taken.length > 0 && cappedHeldAt <= taken[0]!.updatedAt) throw notRecognized();
  const nextReturnsAt =
    hitDetailCap && taken.length > 0
      ? cappedHeldAt - TIE_MS > taken[0]!.updatedAt
        ? cappedHeldAt - TIE_MS
        : cappedHeldAt
      : Math.max(returnsFrom, cappedHeldAt - TIE_MS);
  return { numbers: [...union].sort(), taken, heldAt: nextReturnsAt };
}

interface RawOrder {
  id: string;
  createdDay: string;
  shippedDay: string | null;
  deliveredDay: string | null;
  stage: MarketplaceOrderStage;
  lines: MarketplaceOrderLine[];
  // The line keys whose goods a return brought back to the seller (S2); filled after the returns are read.
  returnedLines: Set<string>;
}

// One order of an answer as only the fields the adapter reads; anything malformed, unknown or masked refuses the page.
function parseOrder(entry: unknown, latestMs: number): RawOrder {
  const o = pickAllowed(entry, ORDER_FIELDS);
  const id = marketplaceIdentifier(o?.order_sn, 40);
  const status = typeof o?.order_status === 'string' ? o.order_status : '';
  if (!o || id === null || !/^[A-Za-z0-9]+$/.test(id) || !Object.hasOwn(SHOPEE_ORDER_STAGE, status)) throw notRecognized();
  // A shop of another market, or an amount in another currency than dong, is not stored: a figure of another currency would be booked as dong.
  if (o.region !== 'VN' || o.currency !== 'VND') throw notRecognized();
  const created = timeOf(o.create_time, true)!;
  const updated = timeOf(o.update_time, true)!;
  if (updated > latestMs) throw notRecognized();
  const pickup = timeOf(o.pickup_done_time, false);
  const cancelBy = o.cancel_by === undefined || o.cancel_by === null || o.cancel_by === '' ? null : typeof o.cancel_by === 'string' && CANCEL_BY.has(o.cancel_by.toLowerCase()) ? o.cancel_by.toLowerCase() : undefined;
  if (cancelBy === undefined) throw notRecognized();
  const raw = o.item_list;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LINES_PER_ORDER) throw notRecognized();
  const seen = new Set<string>();
  const lines = raw.map((item): MarketplaceOrderLine => {
    const l = pickAllowed(item, ITEM_FIELDS);
    const itemId = marketplaceDigits(l?.item_id, 40);
    const modelId = marketplaceDigits(l?.model_id, 40);
    const quantity = l?.model_quantity_purchased;
    const original = marketplaceMoney(l?.model_original_price);
    const discounted = marketplaceMoney(l?.model_discounted_price);
    if (!l || itemId === null || modelId === null || typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100_000 || original === null || discounted === null) throw notRecognized();
    // A negative price is not a price.
    if (original.startsWith('-') || discounted.startsWith('-')) throw notRecognized();
    // A bundle deal item answers 0 (or the price before the deal) in `model_discounted_price` by design: then the original price stands. The order's money is the escrow's job (S3); this only describes the line.
    const unit = money(discounted).gt(0) ? discounted : original;
    const lineKey = `${itemId}-${modelId}`;
    // An item and model twice in one order would be one line written twice.
    if (seen.has(lineKey)) throw notRecognized();
    seen.add(lineKey);
    const sku = [l.model_sku, l.item_sku].map((v) => (v === undefined || v === null || v === '' ? null : marketplaceIdentifier(v, 100))).find((v) => v !== null) ?? null;
    const brokenSku = [l.model_sku, l.item_sku].some((v) => v !== undefined && v !== null && v !== '' && marketplaceIdentifier(v, 100) === null);
    const name = typeof l.item_name === 'string' ? l.item_name : null;
    const variant = typeof l.model_name === 'string' && l.model_name !== '' ? ` - ${l.model_name}` : '';
    if (brokenSku || name === null) throw notRecognized();
    return { lineKey, sku, itemName: cleanLabel(`${name}${variant}`, 300), quantity: String(quantity), unitPrice: toMoney(money(unit)), amount: toMoney(money(unit).times(quantity)) };
  });
  let stage = SHOPEE_ORDER_STAGE[status]!;
  // THE STOCK RULE (see the header).
  // An unnamed canceller after pickup is read the unsafe-direction-safe way too: stock stays out and a person looks.
  if (status === 'CANCELLED' && pickup !== null && (cancelBy === null || cancelBy === 'system' || cancelBy === 'ops')) stage = 'shipped';
  // A cancellation in progress keeps the stage the order had: shipped once the parcel was picked up, else still waiting.
  if (status === 'IN_CANCEL') stage = pickup === null ? 'placed' : 'shipped';
  const shipped = stage === 'shipped' || stage === 'completed';
  return {
    id,
    createdDay: vietnamDay(created),
    shippedDay: shipped && pickup !== null ? vietnamDay(pickup) : null,
    // Shopee gives no delivery time: a completed order is dated by the day its status last changed (a stated approximation; the exact money date is the escrow's release time, S3).
    deliveredDay: stage === 'completed' ? vietnamDay(updated) : null,
    stage,
    lines,
    returnedLines: new Set<string>(),
  };
}

// The base of the key the intake gives a Shopee line (packages/l10n-vn marketplace-orders.ts, orderLines): the SKU cell when there is one, else `<name>|<variation>`, and the Shopee report has no variation column. Two
// lines of one order with the same base are told apart only by their ROW ORDER, so the comparison is on exactly this text (a SKU that ends in `|` and a line with no SKU and the same name make the same base).
// The name goes through the writer's own cell rule first (a name that starts a formula gets a leading `'`, which the reader then keeps), so the comparison is on the text the reader sees.
const intakeBaseKey = (line: MarketplaceOrderLine): string => (line.sku !== null && line.sku.trim() !== '' ? line.sku.trim() : `${marketplaceCellText(line.itemName).trim()}|`);

// The port orders of the raw ones, sorted by number. An order with lines whose goods came back answers as TWO port orders of one number: the returned lines first (stage `returned`), then the rest in the stage the
// order had, so a line never moves back (the intake dedupes by order and line and moves a stage forward only). Dates only where the stage makes them true.
function toPortOrders(orders: readonly RawOrder[]): MarketplaceOrder[] {
  const out: MarketplaceOrder[] = [];
  for (const o of [...orders].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const back = o.lines.filter((l) => o.returnedLines.has(l.lineKey));
    const rest = o.lines.filter((l) => !o.returnedLines.has(l.lineKey));
    if (back.length > 0) out.push({ orderNo: o.id, orderedAt: o.createdDay, shippedAt: o.shippedDay, deliveredAt: o.deliveredDay, stage: 'returned', lines: back });
    if (rest.length > 0) out.push({ orderNo: o.id, orderedAt: o.createdDay, shippedAt: o.shippedDay, deliveredAt: o.deliveredDay, stage: o.stage, lines: rest });
  }
  return out;
}

export function shopeeMarketplace(options: ShopeeOptions, caller: ShopeeCaller = shopeeCaller(options)): MarketplaceProvider {
  const now = options.now ?? (() => new Date());

  // One list call: the order numbers whose update time is in [fromMs, toMs]. `more` means the window holds over one page.
  async function listWindow(credential: ShopeeCredential, fromMs: number, toMs: number): Promise<{ numbers: string[]; more: boolean }> {
    const data = await caller(credential, {
      method: 'GET',
      path: ORDER_LIST_PATH,
      query: { time_range_field: 'update_time', time_from: String(Math.floor(fromMs / 1000)), time_to: String(Math.floor(toMs / 1000)), page_size: String(PAGE_SIZE), request_order_status_pending: 'true' },
      parse: parseShopeeAnswer,
    });
    if (!isRecord(data) || typeof data.more !== 'boolean') throw notRecognized();
    const list = data.order_list;
    if (list === undefined) return { numbers: [], more: false };
    if (!Array.isArray(list) || list.length > PAGE_SIZE) throw notRecognized();
    const numbers = list.map((entry) => {
      const e = pickAllowed(entry, ['order_sn'] as const);
      const id = marketplaceIdentifier(e?.order_sn, 40);
      if (id === null || !/^[A-Za-z0-9]+$/.test(id)) throw notRecognized();
      return id;
    });
    // An order number twice in one answer is not Shopee's: it would write the same lines twice.
    if (new Set(numbers).size !== numbers.length) throw notRecognized();
    return { numbers, more: data.more };
  }

  // The orders by number, at most 50 a call. An order asked for and not answered, or answered and not asked for, refuses the page.
  async function readDetails(credential: ShopeeCredential, numbers: readonly string[]): Promise<RawOrder[]> {
    const out: RawOrder[] = [];
    const latest = now().getTime() + FUTURE_SLACK_MS;
    for (let from = 0; from < numbers.length; from += DETAIL_BATCH) {
      const batch = numbers.slice(from, from + DETAIL_BATCH);
      const data = await caller(credential, {
        method: 'GET',
        path: ORDER_DETAIL_PATH,
        query: { order_sn_list: batch.join(','), response_optional_fields: DETAIL_FIELDS, request_order_status_pending: 'true' },
        parse: parseShopeeAnswer,
      });
      const list = isRecord(data) ? data.order_list : undefined;
      if (!Array.isArray(list) || list.length !== batch.length) throw notRecognized();
      const got = new Map<string, RawOrder>();
      for (const entry of list) {
        const order = parseOrder(entry, latest);
        if (!batch.includes(order.id) || got.has(order.id)) throw notRecognized();
        got.set(order.id, order);
      }
      for (const id of batch) out.push(got.get(id)!);
    }
    return out;
  }

  return {
    id: 'shopee',
    hosts: SHOPEE_HOSTS,
    // What the seller types to connect: the Partner ID and Partner Key of their own app (Preferred and Mall sellers only; the form says so). The authorize step adds the shop and the tokens (the wiring slice).
    connectFields: ['partnerId', 'partnerKey'],
    capabilities: { platforms: { shopee: MARKETPLACE_PLATFORM_LIMITS.shopee } },

    // One call: the shop info.
    testConnection(secret: string): Promise<MarketplaceTestResult> {
      return testShopeeConnection(caller, secret);
    },

    // The orders changed since the cursor (never earlier than 15 days back: the capability's window), at most one page of 100.
    async listOrders(secret: string, platform: MarketplacePlatformKey, since: string | null): Promise<MarketplaceOrderPage> {
      if (platform !== 'shopee') throw new MarketplaceProviderError('unreachable');
      const credential = parseShopeeSecret(secret);
      const nowMs = now().getTime();
      const floor = nowMs - WINDOW_DAYS * DAY_MS;
      const cursor = readCursor(since);
      const ordersStart = Math.max(cursor?.at ?? floor, floor);
      const ordersFrom = Math.max(ordersStart - OVERLAP_MS, floor);

      let ordersEnd = ordersStart;
      let ordersWidth = cursor?.width ?? 0;
      let read: { numbers: string[]; more: boolean } = { numbers: [], more: false };
      let returnsFrom = ordersFrom;
      let returnsEnd = ordersStart;
      let returnsWidth = ordersWidth;
      let found: ReturnsWindow = { returns: [], more: false };
      let returnsSkipped = false;

      if (cursor === null || cursor.returnsAt === null) {
        const synced = await readSlicedWindow(ordersStart, ordersFrom, nowMs, ordersWidth, async (endMs) => {
          const ordersRead = await listWindow(credential, ordersFrom, endMs);
          const returnsFound = await readReturnList(caller, credential, ordersFrom, endMs, nowMs);
          return { ordersRead, returnsFound, more: ordersRead.more || returnsFound.more };
        });
        if (synced === null) return { orders: [], nextCursor: since };
        ordersEnd = synced.endMs;
        ordersWidth = synced.width;
        read = synced.result.ordersRead;
        returnsEnd = synced.endMs;
        returnsWidth = synced.width;
        found = synced.result.returnsFound;
      } else {
        if (ordersStart < nowMs) {
          const ordersSliced = await readSlicedWindow(ordersStart, ordersFrom, nowMs, ordersWidth, (endMs) => listWindow(credential, ordersFrom, endMs));
          if (ordersSliced !== null) {
            ordersEnd = ordersSliced.endMs;
            ordersWidth = ordersSliced.width;
            read = ordersSliced.result;
          }
        }
        returnsFrom = Math.max(cursor.returnsAt, floor);
        returnsWidth = cursor.returnsWidth;
        const returnsSliced = await readSlicedWindow(returnsFrom, returnsFrom, Math.min(ordersEnd, nowMs), returnsWidth, (endMs) =>
          readReturnList(caller, credential, returnsFrom, endMs, nowMs),
        );
        if (returnsSliced === null) {
          returnsEnd = returnsFrom;
          returnsSkipped = true;
        } else {
          returnsEnd = returnsSliced.endMs;
          returnsWidth = returnsSliced.width;
          found = returnsSliced.result;
        }
      }

      const selected = selectReturns(read.numbers, found.returns, returnsFrom, returnsEnd);
      let nextReturnsAt: number | null = null;
      let nextReturnsWidth = 0;
      if (selected.heldAt !== null) {
        nextReturnsAt = selected.heldAt;
        nextReturnsWidth = returnsWidth;
      } else if (returnsSkipped || returnsEnd < ordersEnd) {
        nextReturnsAt = returnsEnd;
        nextReturnsWidth = returnsSkipped ? returnsWidth : found.returns.length === 0 ? Math.max(0, returnsWidth - 1) : returnsWidth;
      }
      const nextOrdersWidth = ordersEnd < nowMs && read.numbers.length === 0 ? Math.max(0, ordersWidth - 1) : ordersWidth;
      const nextCursor = writeCursor(ordersEnd, nextOrdersWidth, nextReturnsAt, nextReturnsWidth);
      const hasMore = ordersEnd < nowMs || (nextReturnsAt !== null && Math.floor(ordersEnd / 1000) > Math.floor(nextReturnsAt / 1000));

      if (selected.numbers.length === 0) {
        // Caught up with nothing new: the cursor stays. Catching up through empty time (or clearing a held returns cursor): the cursor moves on.
        if ((cursor === null || cursor.returnsAt === null) && ordersEnd >= nowMs && nextReturnsAt === null) return { orders: [], nextCursor: since };
        if (nextCursor === since) return { orders: [], nextCursor: since };
        return { orders: [], nextCursor, more: hasMore };
      }
      const details = await readDetails(credential, selected.numbers);
      const byNumber = new Map(details.map((o) => [o.id, o] as const));
      // The returns that could bring goods back, one detail call each: the lines whose goods reached the seller are `returned`. An order that has not shipped (or was cancelled) cannot have goods coming back.
      for (const ret of selected.taken) {
        const order = byNumber.get(ret.orderNo);
        if (!order) throw notRecognized();
        // An order that has not shipped (or was cancelled) cannot have goods coming back: no call is made for it.
        if (order.stage !== 'shipped' && order.stage !== 'completed') continue;
        // The intake names a Shopee line by its SKU (else its name) and numbers a repeat `#2` in ROW ORDER, so writing the returned lines first would give a returned line the key of its sibling. An order whose lines
        // do not all have their own key is therefore never split: its returns are left to a person (stock understated, never invented).
        if (new Set(order.lines.map(intakeBaseKey)).size !== order.lines.length) continue;
        const detail = await readReturnDetail(caller, credential, ret, nowMs);
        const held = new Map(order.lines.map((l) => [l.lineKey, Number(l.quantity)] as const));
        const back = goodsBackLines(detail, held);
        for (const key of back) order.returnedLines.add(key);
      }
      return { orders: toPortOrders(details), nextCursor, more: hasMore };
    },

    // Not in this slice: the order's money lines come with the escrow reads (S3); a poll never asks for them today.
    async orderFinance() {
      return null;
    },

    // Never: the port's stock list is called by nothing yet, and the orders path has no stock endpoint.
    async listStock() {
      return [];
    },
  };
}
