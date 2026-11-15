// SPDX-License-Identifier: AGPL-3.0-only
import { money, toMoney } from '../money.ts';
import { PayrollRefusedError, type RuleRef } from './calculator.ts';
import { PAYROLL_RULES } from './rules/index.ts';
import { ruleInForce, type PayrollRule } from './rule-types.ts';

type Decimal = ReturnType<typeof money>;

// Pure deterministic annual-leave balance calculator (issue #3348, #2540 slice 1a): Labor Code 2019 Arts. 113 & 114
// and Decree 145/2020/ND-CP Art. 66. Uses decimal.js for all day fractions and balances, never JS floats.

export const LEAVE_CATEGORIES = ['standard', 'heavy', 'special_heavy'] as const;
export type LeaveCategory = (typeof LEAVE_CATEGORIES)[number];

export const LEAVE_ENTRY_KINDS = ['opening_balance', 'annual_leave', 'personal_paid', 'unpaid_leave'] as const;
export type LeaveEntryKind = (typeof LEAVE_ENTRY_KINDS)[number];

export interface LeaveEntry {
  kind: LeaveEntryKind;
  /** Calendar month in YYYY-MM format. Entries outside the requested year (or after asOfMonth) are ignored after validation. */
  month: string;
  /** Non-negative decimal string supporting 0.5-day increments. */
  days: string;
}

export interface LeaveBalanceInput {
  /** Calendar year YYYY. */
  year: string;
  category: LeaveCategory;
  /** ISO date YYYY-MM-DD when employment began. */
  hireDate: string;
  /** ISO date YYYY-MM-DD when employment ended, or null / omitted if still active. */
  endedOn?: string | null;
  /** Optional opening balance carried into the year as a non-negative decimal string. */
  openingBalanceDays?: string;
  /** Leave entries; entries belonging to `year` (and <= `asOfMonth` when provided) are aggregated by kind. */
  entries?: readonly LeaveEntry[];
  /** Optional evaluation cutoff month YYYY-MM within `year` for accrued-to-date calculation. */
  asOfMonth?: string;
  /** Optional explicit override of eligible working months (0..12) within `year`. */
  eligibleMonths?: number;
  /** Optional monthly standard working days (e.g. '26') so unpaid_leave entries can reduce a month below halfMonthWorkingDaysRatio. */
  standardWorkingDays?: string;
  /** Optional per-month standard working days override keyed by YYYY-MM. */
  workingDaysByMonth?: Readonly<Record<string, string>>;
}

export interface LeaveBalanceResult {
  year: string;
  eligibleMonths: number;
  /** Pro-rated calendar-year base annual leave days under Labor Code 2019 Art. 113. */
  entitlementDays: string;
  /** Full years of service completed with the employer as of the evaluation date. */
  seniorityYears: number;
  /** Pro-rated seniority bonus days under Labor Code 2019 Art. 114 (+1 day per full 5 years). */
  seniorityDays: string;
  /** Sum of `entitlementDays` and `seniorityDays`. */
  totalEntitlementDays: string;
  /** Sum of `openingBalanceDays` and any `'opening_balance'` entries in `year`. */
  openingDays: string;
  /** Sum of `'annual_leave'` entries in `year`. */
  takenAnnualDays: string;
  /** Signed balance (`totalEntitlementDays + openingDays - takenAnnualDays`); negative when taken exceeds available leave. */
  signedBalanceDays: string;
  /** Remaining annual leave days clamped at `'0'`. */
  remainingAnnualDays: string;
  /** Days taken beyond available annual leave (`'0'` when within balance). */
  exceededAnnualDays: string;
  /** Paid personal leave days (Labor Code 2019 Art. 115), tracked separately without consuming annual leave. */
  personalPaidDays: string;
  /** Unpaid leave days keyed by YYYY-MM for months in `year` with unpaid leave > 0. */
  unpaidDaysByMonth: Record<string, string>;
  rulesUsed: RuleRef[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_PATTERN = new RegExp('^\\d{4}$');
const ISO_DATE_PATTERN = new RegExp('^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$');
const CALENDAR_MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const FIRST_DAY = '01';
const LAST_MONTH = CALENDAR_MONTHS[CALENDAR_MONTHS.length - 1];
const YEAR_FLOOR = '0001';
const DATE_FLOOR = '0001-01-01';

function invalid(what: string): PayrollRefusedError {
  return new PayrollRefusedError('invalid_input', `invalid leave balance input: ${what}`);
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseIsoDate(name: string, value: string): DateParts {
  if (!ISO_DATE_PATTERN.test(value) || value < DATE_FLOOR) {
    throw invalid(`${name} must be a valid YYYY-MM-DD date`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || !date.toISOString().startsWith(value)) {
    throw invalid(`${name} is not a real calendar date`);
  }
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function parseNonNegativeDays(name: string, value: string | undefined, required = false): Decimal {
  if (value === undefined || value.trim() === '') {
    if (required) throw invalid(`${name} is required`);
    return money(0);
  }
  let parsed: Decimal;
  try {
    parsed = money(value);
  } catch {
    throw invalid(`${name} is not a decimal number`);
  }
  if (parsed.isNegative()) throw invalid(`${name} cannot be negative`);
  return parsed;
}

function parsePositiveWorkingDays(name: string, value: string): Decimal {
  const parsed = parseNonNegativeDays(name, value, true);
  if (!parsed.greaterThan(0)) throw invalid(`${name} must be above zero`);
  return parsed;
}

function monthEndIso(yearNum: number, monthIndexZeroBased: number, ym: string): string {
  const daysInMonth = new Date(Date.UTC(yearNum, monthIndexZeroBased + 1, 0)).getUTCDate();
  return `${ym}-${String(daysInMonth)}`;
}

function completedYears(hireDate: string, evalDate: string): number {
  if (evalDate < hireDate) return 0;
  const hire = parseIsoDate('hireDate', hireDate);
  const evalParts = parseIsoDate('evalDate', evalDate);
  let years = evalParts.year - hire.year;
  if (evalParts.month < hire.month || (evalParts.month === hire.month && evalParts.day < hire.day)) {
    years -= 1;
  }
  return years < 0 ? 0 : years;
}

/**
 * Pure deterministic annual-leave balance calculator for a calendar year.
 * Pro-rates statutory leave by eligible months in `year`, adds seniority bonus (+1 day per full 5 years),
 * aggregates opening balance, annual leave taken, paid personal leave (without deducting annual leave),
 * and monthly unpaid leave.
 */
export function calculateLeaveBalance(input: LeaveBalanceInput, rules: readonly PayrollRule[] = PAYROLL_RULES): LeaveBalanceResult {
  if (!YEAR_PATTERN.test(input.year) || input.year < YEAR_FLOOR) {
    throw invalid('year must be YYYY');
  }
  if (!LEAVE_CATEGORIES.includes(input.category)) {
    throw invalid(`unknown leave category: ${String(input.category)}`);
  }
  parseIsoDate('hireDate', input.hireDate);
  const endedOn = input.endedOn ?? null;
  if (endedOn !== null) {
    parseIsoDate('endedOn', endedOn);
    if (endedOn < input.hireDate) throw invalid('endedOn cannot precede hireDate');
  }
  if (input.asOfMonth !== undefined) {
    if (!MONTH.test(input.asOfMonth) || !input.asOfMonth.startsWith(`${input.year}-`)) {
      throw invalid('asOfMonth must be YYYY-MM within year');
    }
  }
  if (input.eligibleMonths !== undefined) {
    if (!Number.isInteger(input.eligibleMonths) || input.eligibleMonths < 0 || input.eligibleMonths > CALENDAR_MONTHS.length) {
      throw invalid('eligibleMonths must be an integer between 0 and 12');
    }
  }
  if (input.standardWorkingDays !== undefined) {
    parsePositiveWorkingDays('standardWorkingDays', input.standardWorkingDays);
  }
  for (const [ym, days] of Object.entries(input.workingDaysByMonth ?? {})) {
    if (!MONTH.test(ym)) throw invalid(`workingDaysByMonth key ${ym} must be YYYY-MM`);
    parsePositiveWorkingDays(`workingDaysByMonth[${ym}]`, days);
  }

  const zero = money(0);
  let openingTotal = parseNonNegativeDays('openingBalanceDays', input.openingBalanceDays);
  let takenAnnual = zero;
  let personalPaid = zero;
  const unpaidByMonth = new Map<string, Decimal>();

  for (const entry of input.entries ?? []) {
    if (!LEAVE_ENTRY_KINDS.includes(entry.kind)) {
      throw invalid(`unknown leave entry kind: ${String(entry.kind)}`);
    }
    if (!MONTH.test(entry.month)) {
      throw invalid(`entry month ${entry.month} must be YYYY-MM`);
    }
    const days = parseNonNegativeDays(`entry(${entry.kind}, ${entry.month}).days`, entry.days, true);
    if (!entry.month.startsWith(`${input.year}-`)) continue;
    if (input.asOfMonth !== undefined && entry.month > input.asOfMonth) continue;

    if (entry.kind === 'opening_balance') {
      openingTotal = openingTotal.plus(days);
    } else if (entry.kind === 'annual_leave') {
      takenAnnual = takenAnnual.plus(days);
    } else if (entry.kind === 'personal_paid') {
      personalPaid = personalPaid.plus(days);
    } else {
      unpaidByMonth.set(entry.month, (unpaidByMonth.get(entry.month) ?? zero).plus(days));
    }
  }

  const yearNum = new Date(`${input.year}-${FIRST_DAY}-${FIRST_DAY}T00:00:00Z`).getUTCFullYear();
  const cutoffMonth = input.asOfMonth ?? `${input.year}-${LAST_MONTH}`;
  const cutoffIdx = CALENDAR_MONTHS.findIndex((m) => `${input.year}-${m}` === cutoffMonth);
  const yearCutoffDate = monthEndIso(yearNum, cutoffIdx, cutoffMonth);
  const ruleLookupDate = input.asOfMonth !== undefined ? `${input.asOfMonth}-${FIRST_DAY}` : yearCutoffDate;

  const rule = ruleInForce(rules, 'annual_leave', 'default', ruleLookupDate);
  if (rule === undefined) {
    throw new PayrollRefusedError('no_rule_in_force', `no annual_leave rule for default in force on ${ruleLookupDate}`);
  }
  if (!Number.isInteger(rule.value.seniorityYearsStep) || rule.value.seniorityYearsStep <= 0) {
    throw invalid('annual_leave seniorityYearsStep must be a positive integer');
  }

  const halfRatio = money(rule.value.halfMonthWorkingDaysRatio);
  let eligibleMonths = 0;
  if (input.eligibleMonths !== undefined) {
    eligibleMonths = input.eligibleMonths;
  } else {
    for (let idx = 0; idx < CALENDAR_MONTHS.length; idx++) {
      const mm = CALENDAR_MONTHS[idx];
      if (mm === undefined) continue;
      const ym = `${input.year}-${mm}`;
      if (input.asOfMonth !== undefined && ym > input.asOfMonth) continue;
      const monthStart = `${ym}-${FIRST_DAY}`;
      const monthEnd = monthEndIso(yearNum, idx, ym);
      if (input.hireDate > monthEnd) continue;
      if (endedOn !== null && endedOn < monthStart) continue;

      const daysInMonth = new Date(Date.UTC(yearNum, idx + 1, 0)).getUTCDate();
      const startDay = input.hireDate > monthStart ? parseIsoDate('hireDate', input.hireDate).day : 1;
      const endDay = endedOn !== null && endedOn < monthEnd ? parseIsoDate('endedOn', endedOn).day : daysInMonth;
      const activeDays = endDay >= startDay ? endDay - startDay + 1 : 0;
      if (activeDays === 0) continue;

      const calendarRatio = money(String(activeDays)).div(String(daysInMonth));
      const monthStd = input.workingDaysByMonth?.[ym] ?? input.standardWorkingDays;
      const unpaidInMonth = unpaidByMonth.get(ym) ?? zero;
      const effectiveRatio = monthStd !== undefined && unpaidInMonth.greaterThan(0) ? calendarRatio.minus(unpaidInMonth.div(money(monthStd))) : calendarRatio;
      if (effectiveRatio.greaterThanOrEqualTo(halfRatio)) {
        eligibleMonths += 1;
      }
    }
  }

  const seniorityEvalDate = endedOn !== null && endedOn < yearCutoffDate ? endedOn : yearCutoffDate;
  const seniorityYears = completedYears(input.hireDate, seniorityEvalDate);
  const senioritySteps = money(String(seniorityYears)).div(String(rule.value.seniorityYearsStep)).floor();
  const fullSeniorityDays = senioritySteps.times(money(rule.value.seniorityExtraDays));

  const baseDaysPerYear =
    input.category === 'standard'
      ? rule.value.standardDaysPerYear
      : input.category === 'heavy'
        ? rule.value.heavyDaysPerYear
        : rule.value.specialHeavyDaysPerYear;
  const monthsInYear = String(CALENDAR_MONTHS.length);
  const entitlementDays = toMoney(money(baseDaysPerYear).times(String(eligibleMonths)).div(monthsInYear));
  const seniorityDays = toMoney(fullSeniorityDays.times(String(eligibleMonths)).div(monthsInYear));
  const totalEntitlement = money(entitlementDays).plus(money(seniorityDays));
  const signedBalance = totalEntitlement.plus(openingTotal).minus(takenAnnual);
  const remainingAnnual = signedBalance.isNegative() ? zero : signedBalance;
  const exceededAnnual = signedBalance.isNegative() ? signedBalance.negated() : zero;

  const unpaidDaysByMonth: Record<string, string> = {};
  for (const ym of [...unpaidByMonth.keys()].sort()) {
    const val = unpaidByMonth.get(ym);
    if (val !== undefined && val.greaterThan(0)) {
      unpaidDaysByMonth[ym] = toMoney(val);
    }
  }

  return {
    year: input.year,
    eligibleMonths,
    entitlementDays,
    seniorityYears,
    seniorityDays,
    totalEntitlementDays: toMoney(totalEntitlement),
    openingDays: toMoney(openingTotal),
    takenAnnualDays: toMoney(takenAnnual),
    signedBalanceDays: toMoney(signedBalance),
    remainingAnnualDays: toMoney(remainingAnnual),
    exceededAnnualDays: toMoney(exceededAnnual),
    personalPaidDays: toMoney(personalPaid),
    unpaidDaysByMonth,
    rulesUsed: [{ id: rule.id, kind: rule.kind, key: rule.key, effectiveFrom: rule.effectiveFrom, status: rule.status }],
  };
}
