// SPDX-License-Identifier: AGPL-3.0-only
// The two small pieces of arithmetic the percentage-method household papers share (#2517 S2a, #2518 01/CNKD), pure and in decimal.js, never JS numbers:
// - taxOn: revenue times a percentage, rounded to a whole dong; a period with net returns owes nothing (it never goes negative).
// - splitAmount: one entry's net amount shared between trades by weights (the lines the entry is built from), so the parts always add up to the amount exactly: every part but the largest is
//   rounded to the money scale, and the largest takes what is left. With no usable weight the whole amount is `unassigned`; the code never guesses a trade.
import { HOUSEHOLD_TRADES, type HouseholdTrade } from '@crove/kernel-contract';
import { money, sum, toMoney } from '@crove/l10n-vn';

export function taxOn(revenue: string, percent: string): string {
  const base = money(revenue);
  if (base.lte(0)) return '0';
  return toMoney(base.times(money(percent)).div(100).toDecimalPlaces(0));
}

export type SplitBucket = HouseholdTrade | 'unassigned';
export interface SplitWeight {
  bucket: SplitBucket;
  // A non-negative amount (a document line's net amount); a negative or empty weight counts as nothing.
  weight: string;
}
export interface SplitPart {
  bucket: SplitBucket;
  amount: string;
}

const ORDER: readonly SplitBucket[] = [...HOUSEHOLD_TRADES, 'unassigned'];

export function splitAmount(amount: string, weights: readonly SplitWeight[]): SplitPart[] {
  const byBucket = new Map<SplitBucket, ReturnType<typeof money>>();
  for (const w of weights) {
    const value = money(w.weight);
    if (value.lte(0)) continue;
    byBucket.set(w.bucket, (byBucket.get(w.bucket) ?? money(0)).plus(value));
  }
  const total = sum([...byBucket.values()]);
  if (total.lte(0)) return [{ bucket: 'unassigned', amount: toMoney(money(amount)) }];
  const buckets = ORDER.filter((b) => byBucket.has(b));
  // The largest weight takes the remainder (the first of equals in ORDER), so the parts tie to the amount to the last digit.
  const largest = buckets.reduce((best, b) => (byBucket.get(b)!.gt(byBucket.get(best)!) ? b : best), buckets[0]!);
  const whole = money(amount);
  const parts = new Map<SplitBucket, string>();
  for (const b of buckets) {
    if (b === largest) continue;
    parts.set(b, toMoney(whole.times(byBucket.get(b)!).div(total)));
  }
  parts.set(largest, toMoney(whole.minus(sum([...parts.values()]))));
  return buckets.map((bucket) => ({ bucket, amount: parts.get(bucket)! }));
}
