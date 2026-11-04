// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order reports (#2515, ADR-0045 points 5 and 7): Shopee, TikTok Shop and Lazada's "orders" exports as .xlsx or CSV, read through one profile per platform. A profile is
// DATA: the words each wanted column is called in Vietnamese and in English, what the statuses mean, a version, and whether it was checked against a real seller's file.
//
// What is read is an ALLOW-LIST: the order number, the line, the dates, the status, the SKU, the product name, the quantity and the amounts. Every other column (the buyer's name,
// phone, email and address among them, which these files carry) has no field here, so it is never read, never returned and never stored: there is nothing to drop afterwards.
//
// **Unconfirmed until #2521.** No real file of a seller was available (plan stock-and-marketplaces.md section 7: "no sample file was seen"). Every profile below is built from the
// column names that public help pages, vendor guides and a seller's published file list, and says `confirmed: false`; the staged read shows it, and the confirm step is the
// protection against a wrong mapping. The golden files of #2521 replace the guesses by facts and flip the flag.
//
// Pure functions over the grid the sheet readers give (bank-statement-sheet.ts: rows by 1-based number, cells by 0-based column), shared by the parsing sandbox and, later, the
// screens.
import { headerKey, type StatementCell, type StatementGrid } from './bank-statement-sheet.ts';

export const MARKETPLACE_PLATFORMS = ['shopee', 'tiktok_shop', 'lazada'] as const;
export type MarketplacePlatform = (typeof MARKETPLACE_PLATFORMS)[number];

// How far an order has got. Stock goes out at `shipped` (and is kept at `completed`), comes back with `returned`; `cancelled` before shipment moves nothing. `unknown` is a status the
// profile does not know: its label is shown and nothing moves for it.
export const ORDER_STAGES = ['placed', 'shipped', 'completed', 'cancelled', 'returned', 'unknown'] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

export const ORDER_FIELDS = ['orderNo', 'lineKey', 'orderedAt', 'shippedAt', 'status', 'returnStatus', 'sku', 'itemName', 'variation', 'quantity', 'unitPrice', 'amount'] as const;
export type OrderField = (typeof ORDER_FIELDS)[number];

interface Words {
  // A header matches when its normalized text (headerKey) equals one of these or contains it, tried in order.
  contains: string[];
  // Matches only a header equal to one of these.
  exact?: string[];
}

export interface MarketplaceProfile {
  platform: MarketplacePlatform;
  // Bumped whenever the words or the statuses change; kept with every staged read.
  version: string;
  // Whether the mapping was checked against a real seller's file (#2521). False for every profile until then.
  confirmed: boolean;
  // Header words only this platform's files use: at least one must be present for the file to be taken for the platform.
  markers: string[];
  // A file with one row per unit sold (Lazada): the row's own item id is its line, and a unit is quantity 1.
  rowPerUnit: boolean;
  columns: Record<OrderField, Words>;
  // Status words by stage, tried in order of the list; a status takes the first stage one of whose words it contains.
  statuses: Array<{ stage: Exclude<OrderStage, 'unknown'>; words: string[] }>;
}

const NONE: Words = { contains: [] };

// The statuses the three platforms' pages name, Vietnamese and English, as header-style keys (no marks, lower case). Order matters: a delivery handed to the carrier is `shipped`
// before "đã giao" (delivered) is `completed`.
const COMMON_STATUSES: MarketplaceProfile['statuses'] = [
  { stage: 'cancelled', words: ['da huy', 'huy don', 'cancelled', 'canceled', 'cancellation', 'failed delivery', 'delivery failed'] },
  { stage: 'returned', words: ['hoan tra', 'tra hang', 'da hoan', 'returned', 'return completed', 'refunded'] },
  { stage: 'shipped', words: ['da giao cho don vi van chuyen', 'dang giao', 'dang van chuyen', 'dang chuyen', 'in transit', 'shipped', 'shipping'] },
  { stage: 'completed', words: ['hoan thanh', 'da giao', 'giao hang thanh cong', 'completed', 'delivered'] },
  {
    stage: 'placed',
    words: ['chua thanh toan', 'cho xac nhan', 'cho lay hang', 'can xu ly', 'cho giao', 'unpaid', 'awaiting shipment', 'awaiting collection', 'to ship', 'pending', 'packed', 'ready to ship', 'on hold', 'processing'],
  },
];

export const MARKETPLACE_PROFILES: readonly MarketplaceProfile[] = [
  {
    // "Order.all" of the Shopee seller centre. Vietnamese headers from a Vietnamese seller's file as far as help pages quote them, the English ones of the same product beside them.
    platform: 'shopee',
    version: 'shopee-2026-11-a',
    confirmed: false,
    markers: ['ma don hang', 'trang thai don hang', 'sku phan loai hang', 'sku reference no', 'deal price', 'shopee voucher', 'gia uu dai', 'tong gia ban san pham'],
    rowPerUnit: false,
    columns: {
      orderNo: { contains: ['ma don hang', 'order id'] },
      lineKey: NONE,
      orderedAt: { contains: ['ngay dat hang', 'order creation date', 'order date'] },
      shippedAt: { contains: ['ngay gui hang', 'thoi gian giao hang cho don vi van chuyen', 'ship time', 'shipping date'] },
      status: { contains: ['trang thai don hang', 'order status'] },
      returnStatus: { contains: ['trang thai tra hang hoan tien', 'return refund status', 'return status'] },
      sku: { contains: ['sku phan loai hang', 'sku reference no', 'sku san pham', 'parent sku reference no', 'sku'] },
      itemName: { contains: ['ten san pham', 'product name'] },
      variation: { contains: ['ten phan loai hang', 'variation name'] },
      quantity: { contains: ['so luong', 'quantity'] },
      unitPrice: { contains: ['gia uu dai', 'deal price', 'gia goc', 'original price'] },
      amount: { contains: ['tong gia ban san pham', 'product subtotal', 'tong gia ban'] },
    },
    statuses: COMMON_STATUSES,
  },
  {
    // The order export of TikTok Shop's Seller Center (Manage Orders, Export Orders). First-party column list in English; one row per SKU line.
    platform: 'tiktok_shop',
    version: 'tiktok-shop-2026-11-a',
    confirmed: false,
    markers: ['order substatus', 'sku subtotal after discount', 'sku seller discount', 'sku platform discount', 'sku unit original price', 'package id', 'seller sku', 'ma sku nguoi ban'],
    rowPerUnit: false,
    columns: {
      orderNo: { contains: ['order id', 'ma don hang'] },
      lineKey: NONE,
      orderedAt: { contains: ['created time', 'order created time', 'thoi gian tao', 'order creation time'] },
      shippedAt: { contains: ['shipped time', 'rts time', 'thoi gian giao cho van chuyen'] },
      status: { contains: ['order status', 'trang thai don hang'] },
      returnStatus: { contains: ['cancelation return type', 'cancellation return type', 'cancel return type'] },
      sku: { contains: ['seller sku', 'ma sku nguoi ban', 'sku id'] },
      itemName: { contains: ['product name', 'ten san pham'] },
      variation: { contains: ['variation', 'phan loai'] },
      quantity: { contains: ['quantity', 'so luong'] },
      unitPrice: { contains: ['sku unit original price', 'don gia'] },
      amount: { contains: ['sku subtotal after discount', 'tong phu sau giam gia'] },
    },
    statuses: COMMON_STATUSES,
  },
  {
    // The order export of Lazada Seller Center: one row per unit with its own `orderItemId` and no quantity column; headers are the API's camelCase names, which headerKey joins.
    platform: 'lazada',
    version: 'lazada-2026-11-a',
    confirmed: false,
    markers: ['ordernumber', 'orderitemid', 'lazadasku', 'sellersku', 'ma don hang lazada'],
    rowPerUnit: true,
    columns: {
      orderNo: { contains: ['ordernumber', 'order number'] },
      lineKey: { contains: ['orderitemid', 'order item id'] },
      orderedAt: { contains: ['createtime', 'create time', 'created at'] },
      shippedAt: { contains: ['shippedtime', 'shipped time'] },
      status: { contains: [], exact: ['status'] },
      returnStatus: NONE,
      sku: { contains: ['sellersku', 'seller sku', 'shopsku', 'shop sku', 'lazadasku'] },
      itemName: { contains: ['itemname', 'item name'] },
      variation: { contains: ['variation'] },
      quantity: { contains: ['quantity'] },
      unitPrice: { contains: ['unitprice', 'unit price'] },
      amount: { contains: ['paidprice', 'paid price'] },
    },
    statuses: COMMON_STATUSES,
  },
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const cellText = (cell: StatementCell | undefined): string => (cell?.value ?? '').trim();

// The 0-based column of each field of a profile (null when the file has none). A column is claimed once, fields in the order of ORDER_FIELDS minus the ones that share words, with the
// most specific words first inside a field.
function claim(profile: MarketplaceProfile, headers: Map<number, string>): Record<OrderField, number | null> {
  const columns = Object.fromEntries(ORDER_FIELDS.map((f) => [f, null])) as Record<OrderField, number | null>;
  const taken = new Set<number>();
  // The specific fields before the ones whose words are short ("sku", "status", "quantity") so a longer header is not taken by a shorter word.
  const order: OrderField[] = ['orderNo', 'lineKey', 'returnStatus', 'orderedAt', 'shippedAt', 'status', 'itemName', 'variation', 'sku', 'quantity', 'unitPrice', 'amount'];
  for (const field of order) {
    const words = profile.columns[field];
    for (const word of words.contains) {
      const hit = [...headers].find(([col, key]) => !taken.has(col) && (key === word || key.includes(word)));
      if (hit) {
        columns[field] = hit[0];
        taken.add(hit[0]);
        break;
      }
    }
    if (columns[field] === null && words.exact) {
      const hit = [...headers].find(([col, key]) => !taken.has(col) && words.exact?.includes(key));
      if (hit) {
        columns[field] = hit[0];
        taken.add(hit[0]);
      }
    }
  }
  return columns;
}

export interface OrderMapping {
  profile: MarketplaceProfile;
  headerRow: number;
  columns: Record<OrderField, number | null>;
  // The header text each field was read from.
  headers: Array<{ field: OrderField; header: string }>;
}

// The platform's profile and the header row: the first of the first 30 rows that names an order number and a quantity (or, for a file with a row per unit, an item id) and at least one
// word only that platform uses. When two platforms fit equally the file is not taken for either.
export function findOrderColumns(rows: StatementGrid): OrderMapping | null {
  const numbers = [...rows.keys()].sort((a, b) => a - b).slice(0, 30);
  for (const n of numbers) {
    const headers = new Map<number, string>();
    const labels = new Map<number, string>();
    for (const [col, cell] of rows.get(n) ?? []) {
      const key = headerKey(cellText(cell));
      if (key) {
        headers.set(col, key);
        labels.set(col, cellText(cell));
      }
    }
    if (headers.size < 3) continue;
    const fits: Array<{ profile: MarketplaceProfile; columns: Record<OrderField, number | null>; score: number }> = [];
    for (const profile of MARKETPLACE_PROFILES) {
      if (!profile.markers.some((marker) => [...headers.values()].some((key) => key === marker || key.includes(marker)))) continue;
      const columns = claim(profile, headers);
      const hasLine = profile.rowPerUnit ? columns.lineKey !== null : columns.quantity !== null;
      if (columns.orderNo === null || !hasLine) continue;
      fits.push({ profile, columns, score: ORDER_FIELDS.filter((f) => columns[f] !== null).length });
    }
    fits.sort((a, b) => b.score - a.score);
    const best = fits[0];
    if (!best || (fits[1] && fits[1].score === best.score)) continue;
    return {
      profile: best.profile,
      headerRow: n,
      columns: best.columns,
      headers: ORDER_FIELDS.flatMap((field) => {
        const col = best.columns[field];
        return col === null ? [] : [{ field, header: labels.get(col) ?? '' }];
      }),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Reading the lines
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// Why a row below the header was not read as a line of an order. `no_order_no` (a totals or notice row) is ignored by the confirm step; every other reason stops the file.
export const ORDER_SKIP_REASONS = ['no_order_no', 'bad_quantity', 'bad_amount', 'bad_date', 'bad_id', 'too_long'] as const;
export type OrderSkipReason = (typeof ORDER_SKIP_REASONS)[number];

export interface OrderLine {
  rowNo: number;
  orderNo: string;
  // The line inside the order: the unit's own item id (Lazada), else the SKU with the variation, else the product name; a second row with the same key in one order gets "#2" and so on.
  lineKey: string;
  // YYYY-MM-DD, or null when the file has no such column or the cell is empty.
  orderedAt: string | null;
  shippedAt: string | null;
  stage: OrderStage;
  // The status as the file words it (cut), kept so a person sees what an `unknown` stage was.
  statusLabel: string | null;
  sku: string | null;
  itemName: string | null;
  // A positive decimal string.
  quantity: string;
  // Decimal strings (the file's own sign), or null when the file has no such column or the cell is empty.
  unitPrice: string | null;
  amount: string | null;
}

export interface OrderRead {
  mapping: OrderMapping;
  lines: OrderLine[];
  skipped: Array<{ rowNo: number; reason: OrderSkipReason }>;
  // Every distinct status label the profile does not know, cut, at most 20.
  unknownStatuses: string[];
}

const MAX_LABEL = 100;
const MAX_ID = 64;
const MAX_KEY = 120;
const MAX_SKU = 100;
const MAX_NAME = 200;

const clip = (text: string, max: number): string => text.slice(0, max);

// A number cell is the digits Excel stored; a text cell is what was typed: Vietnamese 1.234.567 or 1,234,567.50 or 1234567.5, with a currency sign, spaces or a minus in front. null when it is
// not a number. Never rounds.
export function readDecimal(cell: StatementCell | undefined): string | null | 'bad' {
  const raw = cellText(cell);
  if (raw === '') return null;
  let text = raw.replace(/[\s ]/g, '').replace(/(?:₫|đ|vnd|vnđ|d)$/i, '').replace(/^(?:₫|đ|vnd|vnđ)/i, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }
  if (!/^\d[\d.,]*$/.test(text)) return 'bad';
  const dot = text.lastIndexOf('.');
  const comma = text.lastIndexOf(',');
  let normalized: string;
  if (dot >= 0 && comma >= 0) {
    // Both: the later one is the decimal mark, the other groups thousands.
    const decimalMark = dot > comma ? '.' : ',';
    const group = decimalMark === '.' ? ',' : '.';
    normalized = text.split(group).join('').replace(decimalMark, '.');
  } else if (dot >= 0 || comma >= 0) {
    const mark = dot >= 0 ? '.' : ',';
    const parts = text.split(mark);
    // 1.234.567 or 1,234,567: groups of three after the first part are thousands. One mark with other digit counts is a decimal mark.
    const grouped = parts.length > 1 && parts.slice(1).every((p) => p.length === 3) && parts[0] !== undefined && parts[0].length >= 1 && parts[0].length <= 3 && (parts.length > 2 || parts[0] !== '0');
    normalized = grouped ? parts.join('') : parts.length === 2 ? `${parts[0]}.${parts[1]}` : '';
  } else {
    normalized = text;
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return 'bad';
  const trimmed = normalized.replace(/^0+(?=\d)/, '');
  if (trimmed.length > 24) return 'bad';
  const isZero = /^0(\.0+)?$/.test(trimmed);
  return negative && !isZero ? `-${trimmed}` : trimmed;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function validDay(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// The calendar day of a date or date-time cell: 2026-10-30 14:05, 30/10/2026, 30-10-2026 14:05:00, 30 Oct 2026 13:23. null when it is none of these.
export function readDay(cell: StatementCell | undefined): string | null {
  const text = cellText(cell);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T\s].*)?$/.exec(text);
  if (m) return validDay(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:\s.*)?$/.exec(text);
  if (m) {
    const month = MONTHS[(m[2] ?? '').slice(0, 3).toLowerCase()];
    return month ? validDay(Number(m[3]), month, Number(m[1])) : null;
  }
  return null;
}

// The stage of a status the file words, and whether the profile knew it.
export function stageOf(profile: MarketplaceProfile, label: string): OrderStage {
  const key = headerKey(label);
  if (key === '') return 'unknown';
  for (const { stage, words } of profile.statuses) if (words.some((w) => key === w || key.includes(w))) return stage;
  return 'unknown';
}

// A return the platform has accepted or completed; a request still open does not bring the goods back.
const RETURN_DONE = ['hoan thanh', 'da chap nhan', 'da hoan', 'completed', 'accepted', 'refunded', 'return'];

// An id that a spreadsheet turned into a number has lost its last digits: a number of 16 or more digits (a double holds 15), or one with an exponent.
function brokenId(cell: StatementCell | undefined): boolean {
  const text = cellText(cell);
  return /^\d+(?:\.\d+)?e\+?\d+$/i.test(text) || (cell?.kind === 'number' && /^\d{16,}$/.test(text));
}

// The lines of the file under its header, at most maxRows of them; null when the file has more. Rows with no order number and nothing else in them are blank and not reported.
export function orderLines(rows: StatementGrid, mapping: OrderMapping, maxRows: number): OrderRead | null {
  const { profile, headerRow, columns } = mapping;
  const out: OrderLine[] = [];
  const skipped: OrderRead['skipped'] = [];
  const unknown = new Set<string>();
  const seen = new Map<string, number>();
  const cell = (row: ReadonlyMap<number, StatementCell>, field: OrderField) => (columns[field] === null ? undefined : row.get(columns[field] as number));
  const text = (row: ReadonlyMap<number, StatementCell>, field: OrderField) => cellText(cell(row, field));
  let rowCount = 0;
  for (const rowNo of [...rows.keys()].sort((a, b) => a - b)) {
    if (rowNo <= headerRow) continue;
    const row = rows.get(rowNo) as ReadonlyMap<number, StatementCell>;
    const mapped = ORDER_FIELDS.filter((f) => columns[f] !== null).some((f) => text(row, f) !== '');
    if (!mapped) continue;
    rowCount++;
    if (rowCount > maxRows) return null;
    const orderNo = text(row, 'orderNo');
    if (orderNo === '') {
      skipped.push({ rowNo, reason: 'no_order_no' });
      continue;
    }
    if (orderNo.length > MAX_ID || brokenId(cell(row, 'orderNo')) || brokenId(cell(row, 'lineKey'))) {
      skipped.push({ rowNo, reason: orderNo.length > MAX_ID ? 'too_long' : 'bad_id' });
      continue;
    }
    // Quantity: the file's column, or one unit for a file with a row per unit.
    let quantity: string;
    if (columns.quantity === null) {
      quantity = '1';
    } else {
      const q = readDecimal(cell(row, 'quantity'));
      if (q === null || q === 'bad' || q.startsWith('-') || /^0(\.0+)?$/.test(q)) {
        skipped.push({ rowNo, reason: 'bad_quantity' });
        continue;
      }
      quantity = q;
    }
    const price = readDecimal(cell(row, 'unitPrice'));
    const amount = readDecimal(cell(row, 'amount'));
    if (price === 'bad' || amount === 'bad') {
      skipped.push({ rowNo, reason: 'bad_amount' });
      continue;
    }
    const orderedText = text(row, 'orderedAt');
    const shippedText = text(row, 'shippedAt');
    const orderedAt = orderedText === '' ? null : readDay(cell(row, 'orderedAt'));
    const shippedAt = shippedText === '' ? null : readDay(cell(row, 'shippedAt'));
    if ((orderedText !== '' && orderedAt === null) || (shippedText !== '' && shippedAt === null)) {
      skipped.push({ rowNo, reason: 'bad_date' });
      continue;
    }
    const statusLabel = text(row, 'status');
    let stage = stageOf(profile, statusLabel);
    // A return the platform accepted or completed brings the goods back, whatever the order status says.
    const returnKey = headerKey(text(row, 'returnStatus'));
    if (returnKey !== '' && !/^(khong|none|no|n a)$/.test(returnKey) && RETURN_DONE.some((w) => returnKey.includes(w))) stage = 'returned';
    if (stage === 'unknown' && statusLabel !== '') unknown.add(clip(statusLabel, MAX_LABEL));
    const sku = text(row, 'sku');
    const name = text(row, 'itemName');
    const variation = text(row, 'variation');
    const baseKey = profile.rowPerUnit && text(row, 'lineKey') !== '' ? text(row, 'lineKey') : sku !== '' ? (variation !== '' ? `${sku}|${variation}` : sku) : `${name}|${variation}`;
    const orderKey = `${orderNo}\u0000${baseKey}`;
    const count = (seen.get(orderKey) ?? 0) + 1;
    seen.set(orderKey, count);
    out.push({
      rowNo,
      orderNo: clip(orderNo, MAX_ID),
      lineKey: clip(count === 1 ? baseKey : `${baseKey}#${count}`, MAX_KEY),
      orderedAt,
      shippedAt,
      stage,
      statusLabel: statusLabel === '' ? null : clip(statusLabel, MAX_LABEL),
      sku: sku === '' ? null : clip(sku, MAX_SKU),
      itemName: name === '' ? null : clip(name, MAX_NAME),
      quantity,
      unitPrice: price,
      amount,
    });
  }
  return { mapping, lines: out, skipped, unknownStatuses: [...unknown].slice(0, 20) };
}
