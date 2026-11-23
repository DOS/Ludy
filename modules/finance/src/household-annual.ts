// SPDX-License-Identifier: AGPL-3.0-only
// The yearly rule of the household tax as S2a, S2b and the 01/CNKD show it (#3710 slice 3, plan docs/plan/stock-and-marketplaces.md section 8.5, research 2026-11-18 B1 and B2), shared so the three cannot disagree.
// The rule itself is `domain/household-annual.ts`; this file reads the dated rows it needs (the threshold, the VAT and PIT cuts) on the period's last day, runs the rule on the year-to-date revenue at that day and on
// the year-to-date revenue before the period, and builds the `yearToDate` block of the contract. Nothing here is a constant: the threshold and the cuts are rows with an effective date, a source and a status.
import type { HouseholdTrade, HouseholdVatCutAnswer, HouseholdYearToDate } from '@ludy/kernel-contract';
import { HOUSEHOLD_TRADES } from '@ludy/kernel-contract';
import type { QueryContext } from '@ludy/kernel-runtime';
import { money, sum, toMoney } from '@ludy/l10n-vn';
import { annualTax, periodTax } from './domain/household-annual.ts';
import { pickInForce } from './domain/household-rules.ts';
import { reductionInForce } from './household-vat-cut.ts';

type Ctx = Pick<QueryContext, 'trx'>;

// The code of the yearly revenue threshold in household_threshold.
export const THRESHOLD_CODE = 'no_tax_revenue';

// The revenue of the year by trade, from 1 January: `toDate` through the period's last day, `before` up to the day before the book's first day. `unassigned` is revenue with no trade; `unassignedHeld` says an unassigned
// part with an amount (gross, so two that cancel still count) is in either window, which holds the payable back.
// `unassigned` is the net amount of the parts with no trade in each window (a return is negative): the year's totals and the threshold test count it, though the tax waits for it to have a trade.
export interface YearRevenue {
  toDate: ReadonlyMap<string, string>;
  before: ReadonlyMap<string, string>;
  unassigned: { toDate: string; before: string };
  unassignedHeld: boolean;
}

export interface YearUnconfirmed {
  kind: 'reduction' | 'threshold';
  key: string;
  effectiveFrom: string;
}

export async function yearToDateBlock(
  ctx: Ctx,
  args: {
    to: string;
    trades: readonly HouseholdTrade[];
    rates: ReadonlyMap<HouseholdTrade, { vat_percent: string; pit_percent: string }>;
    answer: HouseholdVatCutAnswer | null;
    // False for S2b (the income method): no PIT by percentage, nothing to pick.
    pitApplies: boolean;
    deductionTrade: HouseholdTrade | undefined;
    revenue: YearRevenue;
  },
): Promise<{ block: HouseholdYearToDate; unconfirmed: YearUnconfirmed[] }> {
  const thresholdRows = await ctx.trx
    .selectFrom('ludy_finance.household_threshold')
    .select(['code', 'effective_from', 'amount', 'status'])
    .where('code', '=', THRESHOLD_CODE)
    .where('effective_from', '<=', args.to)
    .execute();
  const thresholdRow = pickInForce(thresholdRows, (r) => r.code, args.to)[0];
  const threshold = thresholdRow ? toMoney(money(thresholdRow.amount)) : '0';
  const vatCut = await reductionInForce(ctx, 'vat', args.to);
  const pitCut = await reductionInForce(ctx, 'pit', args.to);
  const vatCutPercent = args.answer === 'yes' && vatCut && money(vatCut.percent).gt(0) ? vatCut.percent : '0';

  const rates = new Map(args.trades.map((t) => [t, { vatPercent: args.rates.get(t)!.vat_percent, pitPercent: args.rates.get(t)!.pit_percent }]));
  const byTrade = (revenue: ReadonlyMap<string, string>) => new Map(HOUSEHOLD_TRADES.filter((t) => args.trades.includes(t)).map((t) => [t, revenue.get(t) ?? '0'] as [HouseholdTrade, string]));
  const runWith = (revenue: ReadonlyMap<string, string>, pick: HouseholdTrade | null) =>
    annualTax({
      revenue: byTrade(revenue),
      rates,
      threshold,
      vatCutPercent,
      pitCut: args.pitApplies && pitCut ? { percent: pitCut.percent, ceiling: pitCut.ceiling } : null,
      deductionTrade: pick,
      pitApplies: args.pitApplies,
    });
  const run = (revenue: ReadonlyMap<string, string>) => runWith(revenue, args.deductionTrade ?? null);
  const end = run(args.revenue.toDate);
  const before = run(args.revenue.before);
  const total = (revenue: ReadonlyMap<string, string>, unassigned: string) => toMoney(sum([...revenue.values()]).plus(money(unassigned)));
  const totalToDate = total(args.revenue.toDate, args.revenue.unassigned.toDate);
  const totalBefore = total(args.revenue.before, args.revenue.unassigned.before);
  const payable = args.revenue.unassignedHeld ? null : periodTax(end, before);
  // No trade reaches the threshold at the end of the period, or the side before it could not be worked out (a pick too small then): the deduction rule is the accountant's, so the household is not asked again.
  // A pick that works at the end but not before it (the other trade held the revenue then): if another trade is usable on both sides the household is asked again; only when none is, it is the accountant's.
  const pickFails = !args.revenue.unassignedHeld && end.held === null && before.held !== null;
  const otherUsable = pickFails && args.trades.some((t) => t !== args.deductionTrade && runWith(args.revenue.toDate, t).held === null && runWith(args.revenue.before, t).held === null);
  const deductionShort = !args.revenue.unassignedHeld && (end.held === 'short' || (pickFails && !otherUsable));
  // The PIT cut counts as used when either side of the period used it: a year that goes above the ceiling reverses it, and the signed difference is in the payable.
  const cutUsed = (r: typeof end) => !!pitCut && args.pitApplies && r.crossed && r.held === null && money(pitCut.percent).gt(0) && (pitCut.ceiling === null || money(r.revenue).lte(money(pitCut.ceiling)));
  const pitCutApplied = cutUsed(end) || cutUsed(before);

  const unconfirmed: YearUnconfirmed[] = [];
  if (thresholdRow && thresholdRow.status !== 'confirmed') unconfirmed.push({ kind: 'threshold', key: THRESHOLD_CODE, effectiveFrom: thresholdRow.effective_from });
  if (pitCut && pitCut.status !== 'confirmed' && pitCutApplied) unconfirmed.push({ kind: 'reduction', key: 'pit', effectiveFrom: pitCut.effectiveFrom });

  return {
    block: {
      year: Number(args.to.slice(0, 4)),
      revenueToDate: totalToDate,
      revenueBefore: totalBefore,
      threshold: thresholdRow ? { amount: threshold, effectiveFrom: thresholdRow.effective_from, status: thresholdRow.status } : null,
      // With revenue that has no trade yet the rule cannot run per trade, but the year's total still tells whether the threshold is crossed.
      crossed: args.revenue.unassignedHeld ? money(totalToDate).gt(money(threshold)) : end.crossed,
      deductionTrade: end.deduction,
      deductionNeeded: end.held === 'deduction' || otherUsable,
      deductionShort,
      payable,
      pitCut: pitCut && args.pitApplies ? { percent: pitCut.percent, ceiling: pitCut.ceiling, applied: pitCutApplied } : null,
    },
    unconfirmed,
  };
}
