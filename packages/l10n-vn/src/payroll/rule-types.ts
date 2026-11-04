// SPDX-License-Identifier: AGPL-3.0-only
import type { Money } from '../money.ts';

// Payroll rules are dated data (ADR-0046 point 2, docs/plan/payroll.md section 6.2): one row per kind, key and
// effective date, with the text it comes from and a status. A rule change is a new row, never an edit of an old
// one, so a closed month recomputes to the same figures.

/** `commentary` until the accountant (#2535) has read the primary text and flips the row by pull request. */
export type RuleStatus = 'confirmed' | 'commentary';

/** How sure the cited text is, in the plan's words: the primary text was read, a government page, a vendor or news page, or not found. */
export type RuleConfidence = 'primary' | 'gov' | 'commentary' | 'unverified';

export interface RuleSource {
  /** The text and where it comes from: the instrument, the article, what the figure is, and any conflict between sources. */
  cite: string;
  confidence: RuleConfidence;
}

export const REGIONS = ['I', 'II', 'III', 'IV'] as const;
export type Region = (typeof REGIONS)[number];

/** A rate or multiple travels as a decimal string. A percent is written as a percent ("1.5" is 1.5%). */
export type Percent = string;

/** What a bound of the insurance wage is a multiple of. */
export type WageBasis = 'reference_level' | 'regional_minimum_wage';

export interface WageBound {
  basis: WageBasis;
  multiple: string;
}

/** The two bases of the insurance wage: BHXH and BHYT share one, BHTN has its own. */
export type InsuranceWageBase = 'social' | 'unemployment';

export interface PitBracket {
  /** Upper end of the bracket in taxable income per month; null for the open top bracket. */
  upTo: Money | null;
  percent: Percent;
}

export type OvertimeExemptionMode = 'premium_only' | 'whole_pay';

/**
 * The value each kind of rule carries. A kind has one or more keys (a region, a fund, a deduction name):
 * - `minimum_wage`: the region ('I' to 'IV').
 * - `reference_level`: 'default'.
 * - `insurance_wage_bounds`: the insurance wage base ('social' or 'unemployment').
 * - `insurance_rate`: the fund (retirement_death, sickness_maternity, work_accident, health, unemployment).
 * - `union_fee`: 'employer'.
 * - `insurance_suspension`: 'unpaid_leave'.
 * - `pit_brackets`: 'resident_monthly'.
 * - `pit_deduction`: personal, dependent, dependent_income_limit, voluntary_pension_cap.
 * - `pit_withholding`: 'no_or_short_contract'.
 * - `pit_meal_cash_cap`, `pit_overtime_exemption`, `overtime_multiples`, `night_premium`, `deduction_cap`,
 *   `standard_hours`: 'default'.
 */
export interface RuleValues {
  minimum_wage: { monthly: Money; hourly: Money };
  reference_level: { amount: Money };
  insurance_wage_bounds: { floor: WageBound; cap: WageBound };
  insurance_rate: { employerPercent: Percent; employeePercent: Percent; wageBase: InsuranceWageBase };
  union_fee: { employerPercent: Percent; wageBase: InsuranceWageBase };
  insurance_suspension: { unpaidWorkingDays: string };
  pit_brackets: { brackets: readonly PitBracket[] };
  pit_deduction: { monthly: Money };
  pit_withholding: { percent: Percent; paymentThreshold: Money; progressiveFromContractMonths: number };
  pit_meal_cash_cap: { monthly: Money };
  pit_overtime_exemption: { mode: OvertimeExemptionMode };
  overtime_multiples: { normal_day: string; weekly_rest_day: string; holiday: string };
  night_premium: { nightWork: string; nightOvertimeExtra: string };
  deduction_cap: { percent: Percent };
  standard_hours: { perDay: string };
}

export type RuleKind = keyof RuleValues;

export interface RuleRow<K extends RuleKind = RuleKind> {
  /** `<kind>.<key>@<effectiveFrom>`: unique, and what a calculation records as the rule it used. */
  id: string;
  kind: K;
  key: string;
  /** ISO date (YYYY-MM-DD). The row is in force from this day until a later row of the same kind and key. */
  effectiveFrom: string;
  source: RuleSource;
  status: RuleStatus;
  value: RuleValues[K];
}

export type PayrollRule = { [K in RuleKind]: RuleRow<K> }[RuleKind];

export interface RuleDefinition<K extends RuleKind> {
  kind: K;
  key: string;
  effectiveFrom: string;
  status: RuleStatus;
  source: RuleSource;
  value: RuleValues[K];
}

/** Builds a row; the id follows from kind, key and date so two rows cannot disagree about it. */
export function defineRule<K extends RuleKind>(definition: RuleDefinition<K>): RuleRow<K> {
  return { id: `${definition.kind}.${definition.key}@${definition.effectiveFrom}`, ...definition };
}

/** The rule of this kind and key in force on an ISO date: the row with the latest effective date not after it. */
export function ruleInForce<K extends RuleKind>(rules: readonly PayrollRule[], kind: K, key: string, onDate: string): RuleRow<K> | undefined {
  let found: RuleRow<K> | undefined;
  for (const row of rules) {
    if (row.kind !== kind || row.key !== key || row.effectiveFrom > onDate) continue;
    if (found === undefined || row.effectiveFrom > found.effectiveFrom) found = row as RuleRow<K>;
  }
  return found;
}
