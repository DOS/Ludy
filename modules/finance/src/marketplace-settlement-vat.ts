// SPDX-License-Identifier: AGPL-3.0-only
// The VAT rates a marketplace settlement's entries need (#4303 S3b, parent #2520, plan docs/plan/stock-and-marketplaces.md section 8.4). The rate of a piece is the one in force on its delivery day for the entity,
// read ONLY through marketplaceVatRateAt (the one function of the rate table: the greatest effective date on or before the day, the latest entry of that date), once per distinct day and request. No row for
// a day gives null, which holds the settlement back with words (MARKETPLACE_SETTLEMENT_WAITING_VAT_RATE) instead of posting a guessed rate; method `none` gives no VAT line. No rate is a constant here.
import type { QueryContext } from '@crove/kernel-runtime';
import type { SettlementMonth } from './marketplace-settlement-months.ts';
import { vatDatesOf, type SettlementVatRate, type SettlementVatRates } from './marketplace-settlement-posting.ts';
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

// The months (YYYY-MM) of a settlement with a piece whose day has no rate row: what the worklist says the settlement waits for.
export async function vatRateGaps(ctx: Ctx, entityId: string, months: readonly SettlementMonth[], memo?: Map<string, SettlementVatRate | null>): Promise<string[]> {
  const gaps: string[] = [];
  for (const m of months) {
    const rates = await vatRatesOfMonth(ctx, entityId, m, memo);
    if (Object.values(rates).some((rate) => rate === null)) gaps.push(m.month);
  }
  return gaps;
}
