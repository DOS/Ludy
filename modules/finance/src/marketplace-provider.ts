// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace providers (#2519, ADR-0045 point 7, plan stock-and-marketplaces.md section 8.7): the port behind a marketplace connection and the offline provider that serves it
// with recorded orders. The org brings its own seller account; a credential is sealed in the kernel's channel layer (ADR-0025) and handed to a provider call only by the worker, and
// the port takes it as an opaque string and never logs it.
//
// The port READS only: there is no call that updates an order, a listing or a stock level at a platform. What a provider lists is written as a CSV in the layout of the platform's
// own order report (marketplaceOrdersCsv) and goes through the same intake as an uploaded file, so the parsing sandbox, the C-2 checks, the Inbox card and the member's confirmation
// apply unchanged. A poll never confirms anything.
//
// Each provider declares static capability data (page size, window and rate per platform), its hosts and the fields the org types to connect. The offline provider reaches no host,
// asks for no field and serves a small recorded set of orders for each platform: made-up SKUs and names, no buyer data of any kind, amounts as decimal strings, dates as ISO days.
// A real adapter (a later issue, one per platform with its own review) reaches its platform only through guardedRequest of @crove/kernel-runtime (egress.ts), never with a bare fetch.
import { z } from 'zod';
import { MARKETPLACE_PLATFORM_KEYS } from '@crove/kernel-contract';
import { money, toMoney } from '@crove/l10n-vn';

export type MarketplacePlatformKey = (typeof MARKETPLACE_PLATFORM_KEYS)[number];

// The adapters this build knows. `sandbox` is the offline provider; `lazada` is the real Lazada adapter (#2524), built dormant: a deployment turns it on with MARKETPLACE_PROVIDERS (a later slice).
// `tiktok_shop` is the TikTok Shop adapter (#2524, T2 = #4259), built dormant too: nothing builds it from MARKETPLACE_PROVIDERS until its wiring slice.
export const MARKETPLACE_ADAPTERS = ['sandbox', 'lazada', 'tiktok_shop'] as const;
export type MarketplaceAdapterId = (typeof MARKETPLACE_ADAPTERS)[number];

// The platforms each adapter serves, as static data: the commands check a connection against it before anything is sealed, and the adapter's capabilities are built from it.
export const MARKETPLACE_ADAPTER_PLATFORMS: Readonly<Record<MarketplaceAdapterId, readonly MarketplacePlatformKey[]>> = { sandbox: MARKETPLACE_PLATFORM_KEYS, lazada: ['lazada'], tiktok_shop: ['tiktok_shop'] };

// The adapters whose connection the seller authorizes on the platform's own page after typing their app's key and secret (Lazada): the connection holds no access token until they do.
export const MARKETPLACE_AUTHORIZED_ADAPTERS: readonly MarketplaceAdapterId[] = ['lazada'];

export function isMarketplaceAdapter(value: string): value is MarketplaceAdapterId {
  return (MARKETPLACE_ADAPTERS as readonly string[]).includes(value);
}

// What a connection test answers: a state, never the platform's own text. The same list the database's CHECK keeps.
export const MARKETPLACE_TEST_RESULTS = ['works', 'wrong_credentials', 'api_not_enabled', 'ip_not_allowed', 'unreachable'] as const;
export type MarketplaceTestResult = (typeof MARKETPLACE_TEST_RESULTS)[number];

// How a poll ended, as the connection keeps it (never the provider's own text).
export const MARKETPLACE_POLL_RESULTS = ['ok', 'unreachable', 'credentials', 'rate_limited', 'too_large', 'not_recognized'] as const;
export type MarketplacePollEnding = (typeof MARKETPLACE_POLL_RESULTS)[number];

// A failure the caller maps to a state on screen. `not_recognized`: the platform answered, but with a page the adapter will not store (a masked value, an unknown status, a malformed amount).
export const MARKETPLACE_ERROR_KINDS = ['unreachable', 'credentials', 'rate_limited', 'not_recognized'] as const;
export type MarketplaceErrorKind = (typeof MARKETPLACE_ERROR_KINDS)[number];

export class MarketplaceProviderError extends Error {
  readonly kind: MarketplaceErrorKind;
  constructor(kind: MarketplaceErrorKind) {
    super(`marketplace provider error: ${kind}`);
    this.name = 'MarketplaceProviderError';
    this.kind = kind;
  }
}

// What a platform's API allows, as static data: orders per page, how far back one call may look and how many calls a minute. A poll never asks for more.
export interface MarketplacePlatformCapability {
  readonly pageSize: number;
  readonly windowDays: number;
  readonly ratePerMinute: number;
}

// The figures a real adapter starts from; each is replaced by the platform's published limit when that adapter is built and reviewed. Nothing here is called today.
export const MARKETPLACE_PLATFORM_LIMITS: Readonly<Record<MarketplacePlatformKey, MarketplacePlatformCapability>> = {
  shopee: { pageSize: 100, windowDays: 15, ratePerMinute: 60 },
  // TikTok Shop (#2524, T2 = #4259): a request asks for 50 (the return list takes at most 50, the order list 100) and one poll page holds at most 250 orders, which is five requests: a bulk change within one
  // second can only be read on by page token inside one call, and the orders read by id for returns count against the same figure.
  tiktok_shop: { pageSize: 250, windowDays: 30, ratePerMinute: 60 },
  lazada: { pageSize: 100, windowDays: 30, ratePerMinute: 60 },
};

export interface MarketplaceCapabilities {
  // The platforms the adapter serves, with their limits; a platform not listed cannot be connected through it.
  readonly platforms: Readonly<Partial<Record<MarketplacePlatformKey, MarketplacePlatformCapability>>>;
}

// How far an order has got, as a provider words it for every platform; the CSV writer turns it into the status words of the platform's own report.
export const MARKETPLACE_ORDER_STAGES = ['placed', 'shipped', 'completed', 'cancelled', 'returned'] as const;
export type MarketplaceOrderStage = (typeof MARKETPLACE_ORDER_STAGES)[number];

// One line of an order: decimal strings for the quantity and the money, no buyer field of any kind.
export interface MarketplaceOrderLine {
  lineKey: string;
  sku: string | null;
  itemName: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface MarketplaceOrder {
  orderNo: string;
  // ISO days (YYYY-MM-DD).
  orderedAt: string;
  shippedAt: string | null;
  // The day of successful delivery (the completion column of the platform's report), or null while the platform gives none. Revenue belongs to its month (#2520, working answer A5).
  deliveredAt: string | null;
  stage: MarketplaceOrderStage;
  lines: readonly MarketplaceOrderLine[];
}

export interface MarketplaceOrderPage {
  orders: MarketplaceOrder[];
  // Where the next poll resumes: opaque, at most 200 characters. The cursor given when there is nothing new.
  nextCursor: string | null;
  // True when the provider knows more orders wait behind this page (a full page): the poll may read the next page in the same run. Left out, the poll reads one page per run, as before.
  more?: boolean;
}

// What a platform paid and kept for one order (the figures of an income report, #2516), decimal strings.
export interface MarketplaceOrderFinance {
  orderNo: string;
  sales: string;
  commission: string;
  serviceFee: string;
  paymentFee: string;
  shipping: string;
  net: string;
}

export interface MarketplaceStockLevel {
  platform: MarketplacePlatformKey;
  sku: string;
  quantity: string;
}

// What trading a seller's one-time authorization code gives: the new sealed secret of the connection (the seller's keys with the tokens) and the dates, or why not. `refused`: the platform says the code is
// bad, used or expired (the seller authorizes again); `failed`: anything else. A short word each, never the platform's text.
export type MarketplaceAuthorizeResult =
  | { granted: { secret: string; accessExpiresAt: Date; refreshExpiresAt: Date | null } }
  | { refused: string }
  | { failed: string };

export interface MarketplaceProvider {
  readonly id: MarketplaceAdapterId;
  // The hosts this adapter's calls are bound to (through guardedRequest).
  readonly hosts: readonly string[];
  // The fields the org types to connect its own seller account: their names, in the order the form shows them. They are sealed together at the edge and reach the adapter only as
  // the opaque secret of a call; the offline provider needs none.
  readonly connectFields: readonly string[];
  readonly capabilities: MarketplaceCapabilities;
  // Only an adapter the seller authorizes on the platform's own page (Lazada): the address of that page for an app key, a return address and a state, and the trade of the code the page returns. The
  // trade runs in the worker, with the seller's own secret; the API only builds the address.
  authorizeUrl?(input: { appKey: string; redirectUri: string; state: string }): string;
  authorize?(secret: string, code: string): Promise<MarketplaceAuthorizeResult>;
  testConnection(secret: string): Promise<MarketplaceTestResult>;
  // The orders changed since the cursor (null: from the start of the platform's window), at most one page.
  listOrders(secret: string, platform: MarketplacePlatformKey, since: string | null): Promise<MarketplaceOrderPage>;
  orderFinance(secret: string, orderNo: string): Promise<MarketplaceOrderFinance | null>;
  listStock(secret: string): Promise<MarketplaceStockLevel[]>;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The offline provider
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// The offline provider needs no account: its connection is sealed with this fixed word, so a credential row exists for the flow and holds nothing of the org's.
export const SANDBOX_MARKETPLACE_SECRET = 'sandbox';

interface Recorded {
  orderNo: string;
  orderedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  stage: MarketplaceOrderStage;
  lines: ReadonlyArray<[sku: string, name: string, quantity: string, unitPrice: string]>;
}

// Three recorded orders for each platform, in the order they were "placed". The names are made up, the order numbers carry the platform's own look, and no buyer is named.
const RECORDED: Readonly<Record<MarketplacePlatformKey, readonly Recorded[]>> = {
  shopee: [
    { orderNo: '2611A0001', orderedAt: '2026-11-02', shippedAt: '2026-11-03', deliveredAt: '2026-11-05', stage: 'completed', lines: [['MAU-001', 'Áo thun mẫu cổ tròn', '2', '150000'], ['MAU-002', 'Mũ vải mẫu', '1', '90000']] },
    { orderNo: '2611A0002', orderedAt: '2026-11-04', shippedAt: '2026-11-05', deliveredAt: null, stage: 'shipped', lines: [['MAU-001', 'Áo thun mẫu cổ tròn', '1', '150000']] },
    { orderNo: '2611A0003', orderedAt: '2026-11-06', shippedAt: null, deliveredAt: null, stage: 'placed', lines: [['MAU-003', 'Túi vải mẫu', '3', '65000']] },
  ],
  tiktok_shop: [
    { orderNo: '5771000001', orderedAt: '2026-11-01', shippedAt: '2026-11-02', deliveredAt: '2026-11-04', stage: 'completed', lines: [['MAU-002', 'Mũ vải mẫu', '2', '88000']] },
    { orderNo: '5771000002', orderedAt: '2026-11-03', shippedAt: null, deliveredAt: null, stage: 'cancelled', lines: [['MAU-003', 'Túi vải mẫu', '1', '65000']] },
    { orderNo: '5771000003', orderedAt: '2026-11-05', shippedAt: '2026-11-06', deliveredAt: null, stage: 'shipped', lines: [['MAU-001', 'Áo thun mẫu cổ tròn', '1', '149000']] },
  ],
  lazada: [
    { orderNo: '9101000001', orderedAt: '2026-11-02', shippedAt: '2026-11-03', deliveredAt: '2026-11-05', stage: 'completed', lines: [['MAU-001', 'Áo thun mẫu cổ tròn', '1', '152000'], ['MAU-003', 'Túi vải mẫu', '1', '66000']] },
    { orderNo: '9101000002', orderedAt: '2026-11-04', shippedAt: '2026-11-05', deliveredAt: '2026-11-07', stage: 'returned', lines: [['MAU-002', 'Mũ vải mẫu', '1', '91000']] },
    { orderNo: '9101000003', orderedAt: '2026-11-06', shippedAt: null, deliveredAt: null, stage: 'placed', lines: [['MAU-002', 'Mũ vải mẫu', '2', '91000']] },
  ],
};

const SANDBOX_STOCK: ReadonlyArray<[sku: string, quantity: string]> = [
  ['MAU-001', '40'],
  ['MAU-002', '25'],
  ['MAU-003', '60'],
];

export interface SandboxMarketplaceOptions {
  // How many orders a page holds; the default is the platform's own (all of the recorded ones fit), a test passes a smaller one to read a platform in pages.
  pageSize?: number;
}

const CURSOR = /^sandbox:(\d{1,6})$/;

function orderOf(r: Recorded): MarketplaceOrder {
  return {
    orderNo: r.orderNo,
    orderedAt: r.orderedAt,
    shippedAt: r.shippedAt,
    deliveredAt: r.deliveredAt,
    stage: r.stage,
    lines: r.lines.map(([sku, itemName, quantity, unitPrice], index) => ({ lineKey: `${r.orderNo}-${index + 1}`, sku, itemName, quantity, unitPrice, amount: toMoney(money(quantity).times(unitPrice)) })),
  };
}

export function createSandboxMarketplaceProvider(options: SandboxMarketplaceOptions = {}): MarketplaceProvider {
  const refuse = (secret: string) => {
    if (secret !== SANDBOX_MARKETPLACE_SECRET) throw new MarketplaceProviderError('credentials');
  };
  return {
    id: 'sandbox',
    hosts: [],
    connectFields: [],
    capabilities: { platforms: Object.fromEntries(MARKETPLACE_ADAPTER_PLATFORMS.sandbox.map((platform) => [platform, MARKETPLACE_PLATFORM_LIMITS[platform]])) },
    async testConnection(secret) {
      return secret === SANDBOX_MARKETPLACE_SECRET ? 'works' : 'wrong_credentials';
    },
    async listOrders(secret, platform, since) {
      refuse(secret);
      const served = since === null ? 0 : Number(CURSOR.exec(since)?.[1] ?? Number.NaN);
      if (!Number.isInteger(served)) throw new MarketplaceProviderError('unreachable');
      const all = RECORDED[platform];
      const size = Math.max(1, Math.min(options.pageSize ?? MARKETPLACE_PLATFORM_LIMITS[platform].pageSize, MARKETPLACE_PLATFORM_LIMITS[platform].pageSize));
      const page = all.slice(served, served + size);
      // Nothing new: the cursor stays where it was.
      return { orders: page.map(orderOf), nextCursor: page.length === 0 ? since : `sandbox:${served + page.length}` };
    },
    async orderFinance(secret, orderNo) {
      refuse(secret);
      for (const platform of MARKETPLACE_PLATFORM_KEYS) {
        const found = RECORDED[platform].find((r) => r.orderNo === orderNo);
        if (!found) continue;
        const sales = orderOf(found).lines.reduce((total, line) => total.plus(line.amount), money('0'));
        const commission = sales.times('0.05');
        const serviceFee = sales.times('0.03');
        const paymentFee = sales.times('0.02');
        const shipping = money('15000');
        return {
          orderNo,
          sales: toMoney(sales),
          commission: toMoney(commission),
          serviceFee: toMoney(serviceFee),
          paymentFee: toMoney(paymentFee),
          shipping: toMoney(shipping),
          net: toMoney(sales.minus(commission).minus(serviceFee).minus(paymentFee).minus(shipping)),
        };
      }
      return null;
    },
    async listStock(secret) {
      refuse(secret);
      return MARKETPLACE_PLATFORM_KEYS.flatMap((platform) => SANDBOX_STOCK.map(([sku, quantity]) => ({ platform, sku, quantity })));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A page of orders as the platform's own report
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// The header and status words of each platform's profile (@crove/l10n-vn, marketplace-orders.ts) that the writer below uses, so the file reads through the same profile as one a seller
// downloads. There is NO buyer column in any layout: a provider's page never carried one into this process, and the report has none to read.
interface Layout {
  head: readonly string[];
  // The cells of one row, in the order of `head`. A free-text cell (a product name) goes through `text`; ids, SKUs, days and numbers are written as they are.
  row(order: MarketplaceOrder, line: MarketplaceOrderLine, unit: UnitShare, text: (value: string) => string): string[];
  // A platform with a row per unit (Lazada) writes a line of n units as n rows.
  rowPerUnit: boolean;
}

// One unit of a line: its number (from 1), and its share of the line's amount. The units of a line add up to the line's amount exactly: the last one carries the remainder.
interface UnitShare {
  index: number;
  amount: string;
}

const VN_STATUS: Record<MarketplaceOrderStage, string> = { placed: 'Chờ lấy hàng', shipped: 'Đang giao', completed: 'Hoàn thành', cancelled: 'Đã hủy', returned: 'Hoàn trả' };
const EN_STATUS: Record<MarketplaceOrderStage, string> = { placed: 'Awaiting shipment', shipped: 'In transit', completed: 'Completed', cancelled: 'Cancelled', returned: 'Returned' };

const LAYOUTS: Readonly<Record<MarketplacePlatformKey, Layout>> = {
  shopee: {
    head: ['Mã đơn hàng', 'Ngày đặt hàng', 'Ngày gửi hàng', 'Trạng Thái Đơn Hàng', 'SKU phân loại hàng', 'Tên sản phẩm', 'Giá ưu đãi', 'Số lượng', 'Tổng giá bán (sản phẩm)', 'Thời gian hoàn thành đơn hàng'],
    rowPerUnit: false,
    row: (o, l, _unit, text) => [o.orderNo, o.orderedAt, o.shippedAt ?? '', VN_STATUS[o.stage], l.sku ?? '', text(l.itemName), decimal(l.unitPrice), decimal(l.quantity), decimal(l.amount), o.deliveredAt ?? ''],
  },
  tiktok_shop: {
    head: ['Order ID', 'Order Status', 'Order Substatus', 'Seller SKU', 'Product Name', 'Quantity', 'SKU Unit Original Price', 'SKU Subtotal After Discount', 'Created Time', 'Shipped Time', 'Delivered Time'],
    rowPerUnit: false,
    row: (o, l, _unit, text) => [o.orderNo, EN_STATUS[o.stage], EN_STATUS[o.stage], l.sku ?? '', text(l.itemName), decimal(l.quantity), decimal(l.unitPrice), decimal(l.amount), o.orderedAt, o.shippedAt ?? '', o.deliveredAt ?? ''],
  },
  lazada: {
    head: ['orderNumber', 'orderItemId', 'status', 'createTime', 'shippedTime', 'itemName', 'sellerSku', 'unitPrice', 'paidPrice', 'deliveredTime'],
    rowPerUnit: true,
    // One row per unit: the unit's own item id, and its share of the line's amount (a whole number of units). A line of ONE unit keeps its item id as it is, so a polled item and the same item in a
    // report a seller downloads (which carries the bare `orderItemId`) have the same line key and are one line; only a line of several units gets `-<unit>` after its key.
    row: (o, l, unit, text) => [o.orderNo, l.quantity === '1' ? l.lineKey : `${l.lineKey}-${unit.index}`, EN_STATUS[o.stage], o.orderedAt, o.shippedAt ?? '', text(l.itemName), l.sku ?? '', decimal(l.unitPrice), decimal(unit.amount), o.deliveredAt ?? ''],
  },
};

// A free-text cell (a product name the seller chose) as plain text: a leading = + - @, tab or carriage return would start a formula in a spreadsheet, so it gets a ' in front. Only
// names go through this; an SKU, an order number, a day or an amount is written as it is, because the parsing sandbox reads those back exactly and no spreadsheet ever opens the file.
const FORMULA_START = /^[=+\-@\t\r]/;
const plainText = (value: string): string => (FORMULA_START.test(value) ? `'${value}` : value);
// The reader takes one point followed by exactly three digits for a thousands group ("125.125" is read as 125125). Four digits are never grouped, and the reader gives the value back
// without the extra zero, so a number with three decimals is written with a zero added.
const decimal = (value: string): string => value.replace(/\.(\d{3})$/, (_, digits: string) => `.${digits}0`);

// A cell as CSV: always quoted, a quote doubled.
const cell = (value: string): string => `"${value.replaceAll('"', '""')}"`;

// The number of units of a line on a platform that writes a row for each, or null when the quantity is no whole number of at least 1.
const wholeUnits = (quantity: string): number | null => {
  const q = money(quantity);
  return q.isInteger() && q.gte(1) && q.lte(100_000) ? q.toNumber() : null;
};

// The most rows one file may carry (the same as EXTRACT_LIMITS.maxOrderLines of the parsing sandbox; a test keeps the two equal). The rows are counted BEFORE any is built (#2840 point 1), so a page
// of a few lines with huge quantities on a platform that writes a row for each unit is refused early and never materialised.
export const MARKETPLACE_CSV_MAX_ROWS = 20_000;

// How many rows a page of orders writes in the platform's layout: one for each line, on a platform with a row per unit one for each unit. A line a per-unit layout cannot carry (a fractional or
// absurd quantity) counts as one row here; splitWritableOrders names those, and writing one throws.
export function marketplaceCsvRows(platform: MarketplacePlatformKey, orders: readonly MarketplaceOrder[]): number {
  const perUnit = LAYOUTS[platform].rowPerUnit;
  let rows = 0;
  for (const order of orders) {
    for (const line of order.lines) rows += perUnit ? (wholeUnits(line.quantity) ?? 1) : 1;
  }
  return rows;
}

// What a page can be written as: the orders the layout can carry, and how many it cannot (a platform that writes a row for each unit cannot carry a line of 1.5 units). Those are named
// by the caller, never written half and never dropped without a trace.
export function splitWritableOrders(platform: MarketplacePlatformKey, orders: readonly MarketplaceOrder[]): { writable: MarketplaceOrder[]; refused: number } {
  if (!LAYOUTS[platform].rowPerUnit) return { writable: [...orders], refused: 0 };
  const writable = orders.filter((order) => order.lines.every((line) => wholeUnits(line.quantity) !== null));
  return { writable, refused: orders.length - writable.length };
}

// The CSV of a page of orders in the layout of the platform's report, with a first row of headers. One row for each line (Lazada: for each unit; the units add up to the line's amount
// exactly, the last carrying the remainder). With `connectionId`, a first row of one cell names the connection, so two connections of one platform never write the same bytes (the intake
// dedupes a file by its hash per org) and an Inbox file is tied to its connection; the profile finder skips a row with fewer than three headers, and the row holds no order data.
// Deterministic: the same orders for the same connection give the same bytes, so the same page read twice is the same file and the intake recognises it. A line a platform's layout cannot
// carry throws; the caller removes those first (splitWritableOrders).
export function marketplaceOrdersCsv(platform: MarketplacePlatformKey, orders: readonly MarketplaceOrder[], connectionId?: string): string {
  const layout = LAYOUTS[platform];
  if (marketplaceCsvRows(platform, orders) > MARKETPLACE_CSV_MAX_ROWS) throw new Error('the page writes more rows than one file may carry');
  const rows: string[][] = [];
  if (connectionId !== undefined) rows.push([`Ludy marketplace connection ${connectionId}`]);
  rows.push([...layout.head]);
  for (const order of orders) {
    for (const line of order.lines) {
      if (!layout.rowPerUnit) {
        rows.push(layout.row(order, line, { index: 1, amount: line.amount }, plainText));
        continue;
      }
      const units = wholeUnits(line.quantity);
      if (units === null) throw new Error('a line of a non-integer quantity cannot be written one row for each unit');
      const total = money(line.amount);
      // The share of each unit but the last is the line over its units, cut down at four decimals; the last carries what is left, so the units add up to the line.
      const share = total.dividedBy(units).toDecimalPlaces(4, 1);
      const last = total.minus(share.times(units - 1));
      for (let unit = 1; unit <= units; unit += 1) {
        rows.push(layout.row(order, { ...line, quantity: String(units) }, { index: unit, amount: toMoney(unit === units ? last : share) }, plainText));
      }
    }
  }
  return `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`;
}

// The days a page of orders spans, for the file's name: the first and the last order day.
export function ordersSpan(orders: readonly MarketplaceOrder[]): { from: string; to: string } | null {
  const days = orders.map((o) => o.orderedAt).sort();
  const from = days[0];
  const to = days.at(-1);
  return from === undefined || to === undefined ? null : { from, to };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A page as a provider returns it, checked before anything is written (#2840 point 2)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const noControl = (value: string): boolean => ![...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
const validDay = (value: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
};
const zDay = z.string().refine(validDay);
const zIdent = (max: number) => z.string().min(1).max(max).refine(noControl);
const zAmount = z.string().regex(/^-?\d{1,16}(\.\d{1,4})?$/);
const zQuantity = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/).refine((value) => Number(value) > 0);

// Strict: a field the port does not name (a buyer's name, an address) is a provider's bug and refuses the page, so nothing a provider adds can ride along into a file.
export const zMarketplaceOrderPage = z.strictObject({
  orders: z
    .array(
      z.strictObject({
        orderNo: zIdent(100),
        orderedAt: zDay,
        shippedAt: zDay.nullable(),
        deliveredAt: zDay.nullable(),
        stage: z.enum(MARKETPLACE_ORDER_STAGES),
        lines: z
          .array(
            z.strictObject({
              lineKey: zIdent(120),
              sku: zIdent(100).nullable(),
              // Counted in characters, as the adapters cut it: 300 characters outside the basic plane are 600 UTF-16 units. The unit bound only limits the work of counting.
              itemName: z.string().max(1200).refine(noControl).refine((value) => Array.from(value).length <= 300),
              quantity: zQuantity,
              unitPrice: zAmount,
              amount: zAmount,
            }),
          )
          .min(1)
          .max(500),
      }),
    )
    .max(1000),
  nextCursor: z.string().max(200).nullable(),
  more: z.boolean().optional(),
});

// The page when it is one the writer may take, or null: decimal strings, real calendar days, known stages, bounded lengths, no field the port does not name. The caller maps null to the poll
// state `not_recognized` and leaves the cursor where it was; the provider's own text is never kept.
export function parseMarketplaceOrderPage(page: unknown): MarketplaceOrderPage | null {
  const parsed = zMarketplaceOrderPage.safeParse(page);
  return parsed.success ? (parsed.data as MarketplaceOrderPage) : null;
}
