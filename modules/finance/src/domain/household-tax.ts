// SPDX-License-Identifier: AGPL-3.0-only
// The two small pieces of arithmetic the percentage-method household papers share (#2517 S2a, #2518 01/CNKD), pure and in decimal.js, never JS numbers:
// - taxOn: revenue times a percentage, rounded to a whole dong; a period with net returns owes nothing (it never goes negative).
// - splitAmount: one entry's net amount shared between trades by signed weights (the lines the entry is built from), so the parts always add up to the amount exactly: every part but the largest is
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
  // A signed amount (a document line's net amount; an adjustment line is negative). Weights of one bucket are added; a bucket that adds up to nothing takes no part.
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
    if (value.isZero()) continue;
    byBucket.set(w.bucket, (byBucket.get(w.bucket) ?? money(0)).plus(value));
  }
  const buckets = ORDER.filter((b) => byBucket.has(b) && !byBucket.get(b)!.isZero());
  const total = sum(buckets.map((b) => byBucket.get(b)!));
  // Nothing to share by (no line, or lines that cancel out): the whole amount is unassigned, never a guessed trade.
  if (buckets.length === 0 || total.isZero()) return [{ bucket: 'unassigned', amount: toMoney(money(amount)) }];
  // Each bucket keeps its signed contribution: a mixed-sign document (goods 200000, services -100000, net 100000) gives goods 200000 and services -100000. The bucket with the largest weight in
  // absolute value takes the remainder (the first of equals in ORDER), so the parts tie to the amount to the last digit.
  const largest = buckets.reduce((best, b) => (byBucket.get(b)!.abs().gt(byBucket.get(best)!.abs()) ? b : best), buckets[0]!);
  const whole = money(amount);
  const parts = new Map<SplitBucket, string>();
  for (const b of buckets) {
    if (b === largest) continue;
    parts.set(b, toMoney(whole.times(byBucket.get(b)!).div(total)));
  }
  parts.set(largest, toMoney(whole.minus(sum([...parts.values()]))));
  return buckets.map((bucket) => ({ bucket, amount: parts.get(bucket)! }));
}
