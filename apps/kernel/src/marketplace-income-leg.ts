// SPDX-License-Identifier: AGPL-3.0-only
// The income leg of a marketplace poll (#4302, #2524): `listIncome` for the three readers (Lazada S5a, TikTok T3, Shopee S3), the cursor the leg keeps beside the orders cursor, and the one-day
// rule that makes every file the leg writes cover whole payment days that no other file covers (the confirm step refuses an income report whose period overlaps a stored one, and the table has an
// exclusion constraint on it).
//
// THE UNIT IS ONE CLOSED PAYMENT DAY. The income cursor is `d:<YYYY-MM-DD>`, the next day to read; a day is read only once it has been over for a whole day in Vietnam; a read gives the lines whose payment day IS that
// day and nothing else, so two files never share a day. The first read starts INCOME_FIRST_DAYS back. What each platform's day means:
// - Shopee: the day an order's escrow was released, which is the payment day of its line; one day is the whole window.
// - Lazada: a line's date is its transaction date and the line is income only once its statement is paid (the reader leaves unpaid lines out and counts them). A day with unpaid lines is NOT passed: the
//   leg waits on it (the cursor stays, nothing is written) until its statements are paid, so a late-paid line is never lost behind a cursor that moved on; past INCOME_PENDING_WAIT_DAYS it goes on
//   with what is paid, and the lines still unpaid then are not read (the one gap, named in the PR).
// - TikTok Shop: a line's day is the payout day of its statement, which may fall after the day the statement was generated, so the window looks back TIKTOK_LOOKBACK_DAYS for statements generated
//   before and paid on the day, and keeps the lines paid on it. A statement unpaid for longer than that lookback is not read (the same named gap).
// A reader refuses a window it cannot read whole (more orders than its page limit, an answer it does not recognise) as `not_recognized`: the leg records that state and the cursor stays, so a day that
// cannot be read is seen and retried, never skipped.
import { sha256Hex } from '@ludy/kernel-runtime';
import { money, toMoney } from '@ludy/l10n-vn';
import {
  MarketplaceProviderError,
  type MarketplaceIncomeLine,
  type MarketplaceIncomeOptions,
  type MarketplaceIncomePage,
  type MarketplacePlatformKey,
  type MarketplaceProvider,
} from '@ludy/mod-finance';
import { isoDay, notRecognized } from './marketplace-adapter-kit.ts';
import { lazadaFinance } from './marketplace-lazada-finance.ts';
import type { LazadaOptions } from './marketplace-lazada.ts';
import { shopeeFinance } from './marketplace-shopee-finance.ts';
import type { ShopeeOptions } from './marketplace-shopee.ts';
import { tiktokFinance, type TiktokAdjustment, type TiktokStatement } from './marketplace-tiktok-finance.ts';
import type { TiktokOptions } from './marketplace-tiktok.ts';

const DAY_MS = 86_400_000;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;
export const INCOME_FIRST_DAYS = 30;
export const INCOME_PENDING_WAIT_DAYS = 45;
export const TIKTOK_LOOKBACK_DAYS = 30;

const vietnamDay = (ms: number): string => new Date(ms + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (day: string, days: number): string => new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The cursor: two parts in the connection's one `poll_cursor` (text, 200 characters)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// `<orders part>|<income part>`. A cursor with no `|` is the orders part alone (every cursor stored before the income leg existed), an income part alone is `|d:...`. A provider's own cursor never
// holds a `|` (they are `u:`, `o:`/`s:`/`r:` words with ISO times), so the split is unambiguous; one that did would be refused by the join, never mixed up.
export interface PollCursor {
  orders: string | null;
  income: string | null;
}

export function splitPollCursor(cursor: string | null): PollCursor {
  if (cursor === null) return { orders: null, income: null };
  const at = cursor.indexOf('|');
  if (at < 0) return { orders: cursor === '' ? null : cursor, income: null };
  const orders = cursor.slice(0, at);
  const income = cursor.slice(at + 1);
  return { orders: orders === '' ? null : orders, income: income === '' ? null : income };
}

// The stored form, or null when both parts are empty. Throws for a part that holds the separator or makes the whole longer than the column.
export function joinPollCursor(parts: PollCursor): string | null {
  if ((parts.orders?.includes('|') ?? false) || (parts.income?.includes('|') ?? false)) throw new Error('a cursor part holds the separator');
  if (parts.income === null) return parts.orders;
  const joined = `${parts.orders ?? ''}|${parts.income}`;
  if (joined.length > 200) throw new Error('the cursor is longer than the column');
  return joined;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// One payment day
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const INCOME_CURSOR = /^d:(\d{4}-\d{2}-\d{2})$/;

export interface IncomeRead {
  // Every line the reader gave for the window (any payment day in it).
  lines: MarketplaceIncomeLine[];
  // Lines the reader left out because their statement is not paid yet.
  pending: number;
}

export interface FirstIncomeDayInput {
  nowMs: number;
  createdAt?: string | null;
  lastSettlementEnd?: string | null;
}

// Earliest closed payment day to start from when the income cursor is null (#4306): the later of 30 days back, the day the connection was created in Vietnam, and the day after the last standing
// settlement's period end, so early runs do not raise UNKNOWN_ORDERS or OVERLAP against already-imported reports.
export function firstIncomeDay(input: FirstIncomeDayInput): string {
  const today = vietnamDay(input.nowMs);
  let start = addDays(today, -INCOME_FIRST_DAYS);
  if (input.createdAt) {
    const parsed = Date.parse(input.createdAt);
    if (Number.isFinite(parsed)) {
      const createdDay = vietnamDay(parsed);
      if (createdDay > start) start = createdDay;
    }
  }
  if (input.lastSettlementEnd && isoDay(input.lastSettlementEnd)) {
    const afterSettlement = addDays(input.lastSettlementEnd, 1);
    if (afterSettlement > start) start = afterSettlement;
  }
  return start;
}

export interface IncomeDayOptions {
  since: string | null;
  nowMs: number;
  // Days before the payment day the window starts (the platform's statements may be generated earlier than they are paid).
  lookbackDays: number;
  // Wait on a day that still has unpaid lines (see the header).
  waitPending: boolean;
  // Earliest YYYY-MM-DD to start from when `since` is null.
  minStartDay?: string;
  read(window: { startDay: string; endDay: string }): Promise<IncomeRead>;
}

export async function readIncomeDay(options: IncomeDayOptions): Promise<MarketplaceIncomePage> {
  const today = vietnamDay(options.nowMs);
  const held = options.since === null ? null : INCOME_CURSOR.exec(options.since);
  // A cursor that is not ours is not guessed at: the poll records `not_recognized` and the cursor stays where it was.
  if (options.since !== null && (held === null || !isoDay(held[1] as string))) throw notRecognized();
  const defaultFirst = addDays(today, -INCOME_FIRST_DAYS);
  const firstDay = options.minStartDay !== undefined && isoDay(options.minStartDay) && options.minStartDay > defaultFirst ? options.minStartDay : defaultFirst;
  const day = held ? (held[1] as string) : firstDay;
  // Only a day that has been over for a whole day is read (a grace of one day: a platform may mark a release or a statement paid a little after midnight, and the cursor never goes back); the cursor
  // is anchored on the first day so the start does not drift with the calendar.
  if (day >= addDays(today, -1)) return { lines: [], nextCursor: `d:${day}` };
  const read = await options.read({ startDay: addDays(day, -options.lookbackDays), endDay: day });
  if (options.waitPending && read.pending > 0 && day > addDays(today, -INCOME_PENDING_WAIT_DAYS)) return { lines: [], nextCursor: `d:${day}` };
  const next = addDays(day, 1);
  return { lines: read.lines.filter((line) => line.paidAt === day), nextCursor: `d:${next}`, more: next < addDays(today, -1) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The three providers' `listIncome`
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// Only the fields the income path holds; what a reader carries (VAT and withholding fields, fee ids) is never passed on.
const common = (line: MarketplaceIncomeLine): MarketplaceIncomeLine => ({
  orderNo: line.orderNo,
  paidAt: line.paidAt,
  sales: line.sales,
  sellerDiscount: line.sellerDiscount,
  commission: line.commission,
  serviceFee: line.serviceFee,
  paymentFee: line.paymentFee,
  shipping: line.shipping,
  taxWithheld: line.taxWithheld,
  refund: line.refund,
  other: line.other,
  net: line.net,
});

// The shortest slice a too large window is split down to (about an hour: halves of 5400 seconds are 2700).
export const INCOME_MIN_SLICE_SECONDS = 3600;

// Read [fromSec, toSec] and, when the reader refuses it as `too_large`, the two halves and put the lines together; a slice already no longer than INCOME_MIN_SLICE_SECONDS that is still too large is
// refused as `too_large` (the day stalls visibly: the poll records the state and keeps the cursor). Every other error passes unchanged. Slices do not share an instant, so no order is read twice.
export async function readHalved(fromSec: number, toSec: number, read: (fromSec: number, toSec: number) => Promise<MarketplaceIncomeLine[]>): Promise<MarketplaceIncomeLine[]> {
  try {
    return await read(fromSec, toSec);
  } catch (error) {
    if (!(error instanceof MarketplaceProviderError) || error.kind !== 'too_large' || toSec - fromSec + 1 <= INCOME_MIN_SLICE_SECONDS) throw error;
    const middle = fromSec + Math.floor((toSec - fromSec + 1) / 2) - 1;
    return [...(await readHalved(fromSec, middle, read)), ...(await readHalved(middle + 1, toSec, read))];
  }
}

function only(platform: MarketplacePlatformKey, wanted: MarketplacePlatformKey): void {
  if (platform !== wanted) throw new MarketplaceProviderError('unreachable');
}

const adjustmentLine = (adjustment: TiktokAdjustment & { orderNo: string }): MarketplaceIncomeLine => {
  const amount = toMoney(money(adjustment.amount));
  return {
    orderNo: adjustment.orderNo,
    paidAt: adjustment.paidAt,
    sales: '0',
    sellerDiscount: '0',
    commission: '0',
    serviceFee: '0',
    paymentFee: '0',
    shipping: '0',
    taxWithheld: '0',
    refund: '0',
    other: amount,
    net: amount,
  };
};

interface TiktokStatementCache {
  byDay: Map<string, TiktokStatement[]>;
}

const windowDays = (startDay: string, endDay: string): string[] => {
  const days: string[] = [];
  for (let ms = Date.parse(startDay); ms <= Date.parse(endDay); ms += DAY_MS) days.push(new Date(ms).toISOString().slice(0, 10));
  return days;
};

export function withLazadaIncome(provider: MarketplaceProvider, options: LazadaOptions, finance = lazadaFinance(options)): MarketplaceProvider {
  const now = options.now ?? (() => new Date());
  return {
    ...provider,
    async listIncome(secret, platform, since, incomeOptions?: MarketplaceIncomeOptions) {
      only(platform, 'lazada');
      return readIncomeDay({
        since,
        nowMs: now().getTime(),
        lookbackDays: 0,
        waitPending: true,
        ...(incomeOptions?.minStartDay !== undefined ? { minStartDay: incomeOptions.minStartDay } : {}),
        read: async (window) => {
          const income = await finance.income(secret, window);
          return { lines: income.lines.map(common), pending: income.pendingLines };
        },
      });
    },
  };
}

export function withTiktokIncome(provider: MarketplaceProvider, options: TiktokOptions, finance = tiktokFinance(options)): MarketplaceProvider {
  const now = options.now ?? (() => new Date());
  return {
    ...provider,
    async listIncome(secret, platform, since, incomeOptions?: MarketplaceIncomeOptions) {
      only(platform, 'tiktok_shop');
      return readIncomeDay({
        since,
        nowMs: now().getTime(),
        lookbackDays: TIKTOK_LOOKBACK_DAYS,
        waitPending: false,
        ...(incomeOptions?.minStartDay !== undefined ? { minStartDay: incomeOptions.minStartDay } : {}),
        read: async (window) => {
          const cache = incomeOptions?.cache;
          let income;
          if (!cache) {
            income = await finance.income(secret, window, { paidDay: window.endDay, includePayments: false });
          } else {
            const key = `tiktok:statements:${sha256Hex(new TextEncoder().encode(secret))}`;
            let entry = cache.get(key) as TiktokStatementCache | undefined;
            if (!entry) {
              entry = { byDay: new Map() };
              cache.set(key, entry);
            }
            const days = windowDays(window.startDay, window.endDay);
            const missing = days.filter((d) => !entry.byDay.has(d));
            if (missing.length === days.length) {
              income = await finance.income(secret, window, { paidDay: window.endDay, includePayments: false });
              for (const d of days) entry.byDay.set(d, []);
              for (const statement of income.statements) entry.byDay.get(statement.day)?.push(statement);
            } else {
              if (missing.length > 0) {
                const fetched = await finance.statements(secret, { startDay: missing[0] as string, endDay: missing.at(-1) as string });
                const missingSet = new Set(missing);
                for (const d of missing) entry.byDay.set(d, []);
                for (const statement of fetched) if (missingSet.has(statement.day)) entry.byDay.get(statement.day)?.push(statement);
              }
              const seenIds = new Set<string>();
              const statements: TiktokStatement[] = [];
              for (const d of days) {
                for (const statement of entry.byDay.get(d) ?? []) {
                  if (seenIds.has(statement.id)) continue;
                  seenIds.add(statement.id);
                  statements.push(statement);
                }
              }
              income = await finance.income(secret, window, { paidDay: window.endDay, statements, includePayments: false });
            }
          }
          const lines = [
            ...income.lines.map(common),
            ...income.adjustments.filter((adjustment): adjustment is TiktokAdjustment & { orderNo: string } => adjustment.orderNo !== null).map(adjustmentLine),
          ];
          return { lines, pending: income.pendingStatements };
        },
      });
    },
  };
}

export function withShopeeIncome(provider: MarketplaceProvider, options: ShopeeOptions, finance = shopeeFinance(options)): MarketplaceProvider {
  const now = options.now ?? (() => new Date());
  return {
    ...provider,
    async listIncome(secret, platform, since, incomeOptions?: MarketplaceIncomeOptions) {
      only(platform, 'shopee');
      return readIncomeDay({
        since,
        nowMs: now().getTime(),
        lookbackDays: 0,
        waitPending: false,
        ...(incomeOptions?.minStartDay !== undefined ? { minStartDay: incomeOptions.minStartDay } : {}),
        // A day with more orders than one list call holds (a campaign day) is read in halves, down to about an hour, and the halves are ONE page: one file for the day, so no two files share a day.
        read: async (window) => {
          const day = window.endDay;
          const from = Date.parse(`${day}T00:00:00Z`) / 1000 - VIETNAM_OFFSET_MS / 1000;
          const lines = await readHalved(from, from + DAY_MS / 1000 - 1, async (fromSec, toSec) => (await finance.income(secret, { startDay: day, endDay: day, fromSec, toSec })).lines.map(common));
          return { lines, pending: 0 };
        },
      });
    },
  };
}
