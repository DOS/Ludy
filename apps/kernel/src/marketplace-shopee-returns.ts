// SPDX-License-Identifier: AGPL-3.0-only
// The Shopee returns reader (#2524, S2 = #4282; design https://github.com/DOS/Ludy/issues/2524#issuecomment-7061583765 and the PO's decisions after it), DORMANT: nothing offers `shopee` until the live check (#2522).
// Built from the OFFICIAL pages read on 2026-11-21 (open.shopee.com: v2.returns.get_return_list, v2.returns.get_return_detail, the Data Definition and "Return Refund Management" guide pages). Only the ERP System and
// Seller In-house System app types can call these two APIs (the official permission lists).
//
// READ ONLY, two GET paths: the returns whose UPDATE time is in a window (`get_return_list`, paged by `page_no`, window at most 15 days) and one return by number (`get_return_detail`), which alone carries the
// reverse logistics status and the validation point. A buyer's nickname, e-mail, portrait and pickup address are never read: every record goes through an allow-list.
//
// WHAT A RETURN DOES TO STOCK (modules/finance/src/marketplace-orders.ts, `moveLineStock`): `returned` brings stock back. THE STOCK RULE (accepted by the Accounting PO on #2524): goods come back only when the
// parcel reached the SELLER, so a line is `returned` only when ALL hold:
//   - the return is a return AND refund (`return_solution` 0; a refund only, 1, sends nothing back and moves no stock);
//   - its status is one of the closed set that says the seller accepted or the refund went through (ACCEPTED, PROCESSING, CLOSED); a request, a cancellation, a dispute or a judgement by Shopee (REQUESTED,
//     CANCELLED, JUDGING, SELLER_DISPUTE) moves nothing: those words are not given a meaning by the pages, so only the three that name an accepted return count, and the live check (#2522) confirms them;
//   - the validation point is the seller (`validation_type` `seller_validation`); a return validated in Shopee's warehouse never reaches the seller's stock;
//   - the reverse logistics status is `LOGISTICS_DELIVERY_DONE` ("successfully delivered to seller"). `LOGISTICS_LOST` ("marked as lost") NEVER brings stock back: the goods are gone, a write-off is a person's
//     bookkeeping. Every other word (pickup retry or failed, delivery failed, the in-transit and on-the-spot words, which the pages describe but do not name) moves nothing yet;
//   - the return names the whole line (its quantity equals the line's): a partial quantity cannot be split inside one port line, so it stays as it is and a person looks (never guessed).
// A status or a solution word not in the closed tables refuses the page, as does a return that names an order or a line the answer does not hold.
import { marketplaceDigits, marketplaceIdentifier, notRecognized, pickAllowed } from './marketplace-adapter-kit.ts';
import { parseShopeeAnswer, type ShopeeCaller, type ShopeeCredential } from './marketplace-shopee.ts';

const RETURN_LIST_PATH = '/api/v2/returns/get_return_list';
const RETURN_DETAIL_PATH = '/api/v2/returns/get_return_detail';
const PAGE_SIZE = 50;
// The most list pages one window reads: past this the window is "more" and the caller cuts it narrower.
const MAX_PAGES = 3;
// The most returns one window may need a detail call for (one call each).
export const SHOPEE_MAX_RETURN_DETAILS = 40;
const MAX_ITEMS_PER_RETURN = 200;
const FUTURE_SLACK_MS = 86_400_000;

// The return statuses of the Data Definition page, and what each does. `accepted`: the seller accepted or the refund went through, so the goods may come back; `no_stock`: nothing moves.
export const SHOPEE_RETURN_STATUS: Readonly<Record<string, 'accepted' | 'no_stock'>> = {
  REQUESTED: 'no_stock',
  ACCEPTED: 'accepted',
  CANCELLED: 'no_stock',
  JUDGING: 'no_stock',
  CLOSED: 'accepted',
  PROCESSING: 'accepted',
  SELLER_DISPUTE: 'no_stock',
};
// `return_solution`: 0 return and refund, 1 refund only.
const RETURN_AND_REFUND = 0;
const REFUND_ONLY = 1;
const LIST_FIELDS = ['return_sn', 'order_sn', 'status', 'update_time', 'return_solution', 'item'] as const;
const DETAIL_FIELDS = ['return_sn', 'order_sn', 'status', 'return_solution', 'reverse_logistics_status', 'validation_type', 'item'] as const;
const ITEM_FIELDS = ['item_id', 'model_id', 'amount'] as const;
const VALIDATION_TYPES: ReadonlySet<string> = new Set(['seller_validation', 'warehouse_validation']);
const WORD = /^[A-Z][A-Z0-9_]{0,59}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// One line a return names: the line key as the orders adapter writes it (`<item id>-<model id>`) and how many units.
export interface ShopeeReturnItem {
  lineKey: string;
  quantity: number;
}

export interface ShopeeReturn {
  returnSn: string;
  orderNo: string;
  status: string;
  solution: number;
  updatedAt: number;
  items: ShopeeReturnItem[];
}

function parseItems(raw: unknown): ShopeeReturnItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS_PER_RETURN) throw notRecognized();
  const seen = new Set<string>();
  return raw.map((entry) => {
    const i = pickAllowed(entry, ITEM_FIELDS);
    const itemId = marketplaceDigits(i?.item_id, 40);
    const modelId = marketplaceDigits(i?.model_id, 40);
    const quantity = i?.amount;
    if (!i || itemId === null || modelId === null || typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100_000) throw notRecognized();
    const lineKey = `${itemId}-${modelId}`;
    // A line twice in one return is not Shopee's.
    if (seen.has(lineKey)) throw notRecognized();
    seen.add(lineKey);
    return { lineKey, quantity };
  });
}

function parseReturn(entry: unknown, fields: readonly string[], latestMs: number): { value: Omit<ShopeeReturn, 'updatedAt'> & { updatedAt: number | null }; record: Record<string, unknown> } {
  const r = pickAllowed(entry, fields as readonly (typeof LIST_FIELDS)[number][]) as Record<string, unknown> | null;
  const returnSn = marketplaceIdentifier(r?.return_sn, 40);
  const orderNo = marketplaceIdentifier(r?.order_sn, 40);
  const status = typeof r?.status === 'string' ? r.status : '';
  const solution = r?.return_solution;
  if (!r || returnSn === null || orderNo === null || !/^[A-Za-z0-9]+$/.test(returnSn) || !/^[A-Za-z0-9]+$/.test(orderNo)) throw notRecognized();
  // A status or a solution word that is not in the closed tables refuses the page: nothing is guessed about stock.
  if (!Object.hasOwn(SHOPEE_RETURN_STATUS, status) || (solution !== RETURN_AND_REFUND && solution !== REFUND_ONLY)) throw notRecognized();
  let updatedAt: number | null = null;
  if (r.update_time !== undefined) {
    const t = r.update_time;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 1_000_000_000 || t * 1000 > latestMs) throw notRecognized();
    updatedAt = t * 1000;
  }
  return { value: { returnSn, orderNo, status, solution, updatedAt, items: parseItems(r.item) }, record: r };
}

export interface ReturnsWindow {
  returns: ShopeeReturn[];
  // More than the pages this reader reads: the caller cuts the window.
  more: boolean;
}

// One page of the list: whether Shopee says more follow, and the returns on it. A page that says there is more and carries no list is contradictory, not an empty window: it would let the cursor pass returns
// that were never read.
async function readPage(call: ShopeeCaller, credential: ShopeeCredential, fromMs: number, toMs: number, page: number, nowMs: number): Promise<{ more: boolean; returns: ShopeeReturn[] }> {
  const data = await call(credential, {
    method: 'GET',
    path: RETURN_LIST_PATH,
    query: { page_no: String(page), page_size: String(PAGE_SIZE), update_time_from: String(Math.floor(fromMs / 1000)), update_time_to: String(Math.floor(toMs / 1000)) },
    parse: parseShopeeAnswer,
  });
  if (!isRecord(data) || typeof data.more !== 'boolean') throw notRecognized();
  const list = data.return;
  if (list === undefined) {
    if (data.more) throw notRecognized();
    return { more: false, returns: [] };
  }
  if (!Array.isArray(list) || list.length > PAGE_SIZE) throw notRecognized();
  const returns = list.map((entry): ShopeeReturn => {
    const { value } = parseReturn(entry, LIST_FIELDS, nowMs + FUTURE_SLACK_MS);
    if (value.updatedAt === null) throw notRecognized();
    return { ...value, updatedAt: value.updatedAt };
  });
  return { more: data.more, returns };
}

// The returns whose update time is in [fromMs, toMs]: every page up to MAX_PAGES (the list is not promised in any order, so a window is read whole or not at all). Offset paging has no snapshot: a return
// updated between two page reads leaves the window and shifts the rows behind it, so a later page could start after a return that was never read, and the change can happen between ANY two pages. After more
// than one page the whole window is therefore read a second time, page for page, and taken only when both reads agree return for return; otherwise it is NOT taken as whole (`more`: the caller cuts it
// narrower, and the changed return, now updated after the window's end, falls in the next window). A window of one page needs no second read (one request is one answer).
export async function readReturnList(call: ShopeeCaller, credential: ShopeeCredential, fromMs: number, toMs: number, nowMs: number): Promise<ReturnsWindow> {
  const out: ShopeeReturn[] = [];
  const seen = new Set<string>();
  let pages = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const read = await readPage(call, credential, fromMs, toMs, page, nowMs);
    pages = page;
    for (const value of read.returns) {
      // A return number twice in the pages is not Shopee's.
      if (seen.has(value.returnSn)) throw notRecognized();
      seen.add(value.returnSn);
      out.push(value);
    }
    if (!read.more) break;
    if (page === MAX_PAGES) return { returns: out, more: true };
  }
  if (pages === 1) return { returns: out, more: false };
  const again: string[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const read = await readPage(call, credential, fromMs, toMs, page, nowMs);
    again.push(...read.returns.map((r) => r.returnSn));
    // The second read must end where the first did: a page that says more beyond the last one read is a change.
    if (page === pages && read.more) return { returns: out, more: true };
  }
  const agrees = again.length === out.length && again.every((sn, i) => sn === out[i]?.returnSn);
  return { returns: out, more: !agrees };
}

// The facts of one return the stock rule needs and the list does not carry.
export interface ShopeeReturnDetail {
  returnSn: string;
  // The detail's own status and solution: the stock rule is judged on them again, since the list was read a moment earlier.
  status: string;
  solution: number;
  reverseStatus: string | null;
  validation: 'seller_validation' | 'warehouse_validation' | null;
  items: ShopeeReturnItem[];
}

export async function readReturnDetail(call: ShopeeCaller, credential: ShopeeCredential, expected: ShopeeReturn, nowMs: number): Promise<ShopeeReturnDetail> {
  const data = await call(credential, { method: 'GET', path: RETURN_DETAIL_PATH, query: { return_sn: expected.returnSn }, parse: parseShopeeAnswer });
  if (!isRecord(data)) throw notRecognized();
  const { value, record } = parseReturn(data, DETAIL_FIELDS, nowMs + FUTURE_SLACK_MS);
  // The detail must be the return asked for, of the same order, in the same state and solution as the list said (it was read a moment apart: a change in between is read again by the next poll).
  if (value.returnSn !== expected.returnSn || value.orderNo !== expected.orderNo) throw notRecognized();
  const reverse = record.reverse_logistics_status;
  const validation = record.validation_type;
  if (reverse !== undefined && reverse !== null && reverse !== '' && (typeof reverse !== 'string' || !WORD.test(reverse))) throw notRecognized();
  if (validation !== undefined && validation !== null && validation !== '' && (typeof validation !== 'string' || !VALIDATION_TYPES.has(validation))) throw notRecognized();
  return {
    returnSn: value.returnSn,
    status: value.status,
    solution: value.solution,
    reverseStatus: typeof reverse === 'string' && reverse !== '' ? reverse : null,
    validation: validation === 'seller_validation' || validation === 'warehouse_validation' ? validation : null,
    items: value.items,
  };
}

// Whether a return of this list entry could bring goods back, so its detail is worth a call: a return and refund whose status says it was accepted.
export const mayBringGoodsBack = (r: ShopeeReturn): boolean => r.solution === RETURN_AND_REFUND && SHOPEE_RETURN_STATUS[r.status] === 'accepted';

// The lines whose goods are back at the seller, by the stock rule above, for the lines of the order the return belongs to (line key to quantity). A line the return names that the order does not hold refuses the
// page; a line named for fewer units than the order line holds is left alone.
export function goodsBackLines(detail: ShopeeReturnDetail, lines: ReadonlyMap<string, number>): string[] {
  // The five conditions of the header are all judged on the DETAIL (the list only decided that it was worth asking): a return that changed between the two reads stops being one that brings goods back.
  if (detail.solution !== RETURN_AND_REFUND || SHOPEE_RETURN_STATUS[detail.status] !== 'accepted') return [];
  if (detail.validation !== 'seller_validation' || detail.reverseStatus !== 'LOGISTICS_DELIVERY_DONE') return [];
  const back: string[] = [];
  for (const item of detail.items) {
    const held = lines.get(item.lineKey);
    if (held === undefined) throw notRecognized();
    if (item.quantity === held) back.push(item.lineKey);
  }
  return back;
}
