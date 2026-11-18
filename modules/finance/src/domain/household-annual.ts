// SPDX-License-Identifier: AGPL-3.0-only
// The yearly rule of the percentage-method household tax (#3710 slice 3, research 2026-11-18 B1 and B2), pure and in decimal.js, never JS numbers:
// - Up to the yearly revenue threshold (1 billion VND from 2026, a dated row) no VAT and no PIT is owed.
// - Above it VAT is owed on ALL the revenue, trade by trade, and PIT only on the part above the threshold: the household picks the trade the deduction applies to. A household with one trade has it
//   automatic; with several, the pick is asked for and never defaulted, so a missing or too small pick holds the PIT back (`held`), never a guess.
// - The VAT cut (Decree 174) applies only when the caller says so (the household's own answer): a percentage of each trade's VAT. The PIT cut (Decree 398) is a percentage of the PIT payable (the tax, not the
//   rate), only while the year's revenue is at most the cut's ceiling.
// - A period's tax is the year-to-date tax at its last day less the year-to-date tax the day before it starts, so the periods of a year add up to the year (the crossing period carries the catch-up).
import type { HouseholdTrade } from '@crove/kernel-contract';
import { money, sum, toMoney } from '@crove/l10n-vn';
import { taxOn } from './household-tax.ts';

export interface AnnualRates {
  vatPercent: string;
  pitPercent: string;
}

export interface AnnualInput {
  // The year-to-date revenue by trade (signed: a return lowers it). A trade with no revenue may be absent.
  revenue: ReadonlyMap<HouseholdTrade, string>;
  rates: ReadonlyMap<HouseholdTrade, AnnualRates>;
  // The yearly revenue up to which nothing is owed; 0 when no row is in force.
  threshold: string;
  // The VAT cut percentage to apply; '0' when it does not apply (the answer is not yes, or no cut is in force).
  vatCutPercent: string;
  // The PIT cut: the percentage of the PIT payable and the yearly revenue up to which it holds (null: no ceiling); null when none is in force.
  pitCut: { percent: string; ceiling: string | null } | null;
  // The trade the threshold is deducted from; used only when the household has several trades with revenue.
  deductionTrade: HouseholdTrade | null;
  // False for the books that carry no PIT by percentage (S2b, the income method): no PIT, no deduction, nothing to pick.
  pitApplies: boolean;
}

export interface AnnualTax {
  revenue: string;
  crossed: boolean;
  vatBefore: string;
  vatCut: string;
  vat: string;
  pitBefore: string;
  pitCut: string;
  pit: string;
  // The trade that took the deduction (null below the threshold, or where the PIT is held back).
  deduction: HouseholdTrade | null;
  // The PIT could not be worked out; the VAT above is still exact. 'deduction': several trades and no usable pick, the household is asked. 'short': no trade reaches the threshold, so the deduction rule
  // is not known (the accountant's to give, #2520).
  held: 'deduction' | 'short' | null;
}

const ZERO = '0';

export function annualTax(input: AnnualInput): AnnualTax {
  const entries = [...input.revenue.entries()].filter(([, rev]) => !money(rev).isZero());
  const total = sum(entries.map(([, rev]) => rev));
  const empty: AnnualTax = { revenue: toMoney(total), crossed: false, vatBefore: ZERO, vatCut: ZERO, vat: ZERO, pitBefore: ZERO, pitCut: ZERO, pit: ZERO, deduction: null, held: null };
  if (total.lte(money(input.threshold))) return empty;

  const rateOf = (trade: HouseholdTrade) => {
    const r = input.rates.get(trade);
    if (!r) throw new Error(`no rate for ${trade}`);
    return r;
  };
  const vatLines = entries.map(([trade, rev]) => taxOn(rev, rateOf(trade).vatPercent));
  const vatBefore = sum(vatLines);
  const vatCut = money(input.vatCutPercent).gt(0) ? sum(vatLines.map((v) => taxOn(v, input.vatCutPercent))) : money(0);

  if (!input.pitApplies) {
    return { revenue: toMoney(total), crossed: true, vatBefore: toMoney(vatBefore), vatCut: toMoney(vatCut), vat: toMoney(vatBefore.minus(vatCut)), pitBefore: ZERO, pitCut: ZERO, pit: ZERO, deduction: null, held: null };
  }
  // The trade that takes the deduction: the only trade with revenue, or the household's pick. The research gives no rule for a trade whose revenue is below the threshold (does the rest of the deduction
  // pass to another trade?), so it is not guessed: with no trade reaching the threshold the PIT is held back as 'short' (the accountant's rule is needed, #2520); with some trade reaching it but no usable pick the
  // PIT is held back as 'deduction' (the household is asked).
  const positive = entries.filter(([, rev]) => money(rev).gt(0));
  const only = positive.length === 1 ? positive[0]![0] : null;
  const reaching = positive.filter(([, rev]) => money(rev).gte(money(input.threshold)));
  const held = (reason: 'deduction' | 'short'): AnnualTax => ({
    revenue: toMoney(total),
    crossed: true,
    vatBefore: toMoney(vatBefore),
    vatCut: toMoney(vatCut),
    vat: toMoney(vatBefore.minus(vatCut)),
    pitBefore: ZERO,
    pitCut: ZERO,
    pit: ZERO,
    deduction: null,
    held: reason,
  });
  if (only === null && reaching.length === 0) return held('short');
  const picked = only ?? input.deductionTrade;
  const pickedRevenue = picked !== null ? entries.find(([trade]) => trade === picked)?.[1] : undefined;
  if (picked === null || pickedRevenue === undefined || money(pickedRevenue).lt(money(input.threshold))) return held('deduction');
  const pitBefore = sum(entries.map(([trade, rev]) => taxOn(trade === picked ? toMoney(money(rev).minus(input.threshold)) : rev, rateOf(trade).pitPercent)));
  const cut = input.pitCut;
  const pitCut = cut && money(cut.percent).gt(0) && (cut.ceiling === null || total.lte(money(cut.ceiling))) ? money(taxOn(toMoney(pitBefore), cut.percent)) : money(0);
  return {
    revenue: toMoney(total),
    crossed: true,
    vatBefore: toMoney(vatBefore),
    vatCut: toMoney(vatCut),
    vat: toMoney(vatBefore.minus(vatCut)),
    pitBefore: toMoney(pitBefore),
    pitCut: toMoney(pitCut),
    pit: toMoney(pitBefore.minus(pitCut)),
    deduction: picked,
    held: null,
  };
}

export interface PeriodTax {
  vatBefore: string;
  vatCut: string;
  vat: string;
  pitBefore: string;
  pitCut: string;
  pit: string;
}

// The tax of a period: the year-to-date tax at its end less the year-to-date tax before it; null while either side holds the PIT back.
export function periodTax(end: AnnualTax, before: AnnualTax): PeriodTax | null {
  if (end.held !== null || before.held !== null) return null;
  const diff = (a: string, b: string) => toMoney(money(a).minus(b));
  return {
    vatBefore: diff(end.vatBefore, before.vatBefore),
    vatCut: diff(end.vatCut, before.vatCut),
    vat: diff(end.vat, before.vat),
    pitBefore: diff(end.pitBefore, before.pitBefore),
    pitCut: diff(end.pitCut, before.pitCut),
    pit: diff(end.pit, before.pit),
  };
}
