// SPDX-License-Identifier: AGPL-3.0-only
// The VAT rates a marketplace settlement's entries need (#4303 S3b, parent #2520, plan docs/plan/stock-and-marketplaces.md section 8.4). The rate of a piece is the one in force on its delivery day for the entity,
// read ONLY through marketplaceVatRateAt (the one function of the rate table: the greatest effective date on or before the day, the latest entry of that date), once per distinct day and request. No row for
// a day gives null, which holds the settlement back with words (MARKETPLACE_SETTLEMENT_WAITING_VAT_RATE) instead of posting a guessed rate; method `none` gives no VAT line. No rate is a constant here.
import type { QueryContext } from '@ludy/kernel-runtime';
import type { SettlementMonth } from './marketplace-settlement-months.ts';
import { entryIsEmpty, vatDatesOf, type SettlementVatRate, type SettlementVatRates } from './marketplace-settlement-posting.ts';
import { MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from './marketplace-posting-map.ts';
import { booksOn } from './payroll-posting.ts';
import { marketplaceVatRateAt } from './marketplace-vat-rate.ts';

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

// The rate in force on each of the days for the entity, null where no row covers the day. `memo` shares the answers inside one request (a worklist reads many settlements of one entity).
export async function resolveVatRates(ctx: Ctx, entityId: string, days: Iterable<string>, memo: Map<string, SettlementVatRate | null> = new Map()): Promise<SettlementVatRates> {
  const out: Record<string, SettlementVatRate | null> = {};
  for (const day of days) {
    const key = `${entityId}:${day}`;
    if (!memo.has(key)) {
      const row = await marketplaceVatRateAt(ctx, entityId, day);
      memo.set(key, row === null ? null : row.method === 'deduction' && row.vatPercent !== null ? { method: 'deduction', vatPercent: row.vatPercent } : { method: 'none' });
    }
    out[day] = memo.get(key) ?? null;
  }
  return out;
}

// The rates one month's entry needs, from the days of its pieces.
export const vatRatesOfMonth = (ctx: Ctx, entityId: string, month: SettlementMonth, memo?: Map<string, SettlementVatRate | null>): Promise<SettlementVatRates> =>
  resolveVatRates(ctx, entityId, vatDatesOf({ lines: month.lines, date: month.date }), memo);

// Whether the entity's chart on `date` books a refund on its own account (TT99: 521), read from the regime's map; false for a regime with no map (the gate refuses it elsewhere).
export async function separateReturnOn(ctx: QueryContext, entityId: string, date: string, maps: Readonly<Record<string, MarketplacePostingMap>> = MARKETPLACE_POSTING_MAPS): Promise<boolean> {
  const regime = (await booksOn(ctx, entityId, date)).regime;
  const map = Object.hasOwn(maps, regime) ? maps[regime] : undefined;
  return map ? map.salesReturn.code !== map.revenue.code : false;
}

// The months of a settlement a person can be offered, with the months that wait for a VAT rate: a month with a piece whose day has no rate row waits (kept, with its gap); the others are kept only when their
// entry has something to post, which is known with the rates (a month of pieces at different rates can net to zero while 33311 is not). `separateReturn`: the regime's refund account differs from its revenue
// account (TT99), so a refund is its own debit line even at a zero net.
export async function offeredMonths(
  ctx: Ctx,
  entityId: string,
  months: readonly SettlementMonth[],
  separateReturn: boolean,
  memo?: Map<string, SettlementVatRate | null>,
): Promise<{ months: SettlementMonth[]; gaps: string[] }> {
  const kept: SettlementMonth[] = [];
  const gaps: string[] = [];
  for (const m of months) {
    const vatRates = await vatRatesOfMonth(ctx, entityId, m, memo);
    if (Object.values(vatRates).some((rate) => rate === null)) {
      gaps.push(m.month);
      kept.push(m);
      continue;
    }
    const withheld = m.lines.some((l) => /[1-9]/.test(l.taxWithheld ?? '0'));
    if (!entryIsEmpty({ lines: m.lines, date: m.date, vatRates }, separateReturn, withheld)) kept.push(m);
  }
  return { months: kept, gaps };
}
