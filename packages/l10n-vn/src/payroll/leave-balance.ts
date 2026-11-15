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

export const LEAVE_WORKWEEKS = ['mon_fri', 'mon_sat', 'all_days'] as const;
export type LeaveWorkweek = (typeof LEAVE_WORKWEEKS)[number];

export interface LeaveEntry {
  kind: LeaveEntryKind;
  /** Calendar month in YYYY-MM format. Entries outside the requested year (or after asOfMonth) are ignored after validation. */
  month: string;
  /** Non-negative decimal string supporting 0.5-day increments. */
  days: string;
  /** For `'unpaid_leave'`, marks employer-approved unpaid leave eligible for Decree 145/2020 Art. 65(4) (up to 1 month/year counted). */
  approved?: boolean;
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
  /** Workweek schedule (`'mon_fri'`, `'mon_sat'`, `'all_days'`) used to count working days; defaults to `'mon_sat'` (6-day week). */
  workweek?: LeaveWorkweek;
  /** Optional actual working days worked in YYYY-MM (net of partial employment and unpaid leave); requires `workingDaysByMonth[month]` or `standardWorkingDays`. */
  workedDaysByMonth?: Readonly<Record<string, string>>;
  /** Optional paid public-holiday days in YYYY-MM (Labor Code 2019 Art. 112 / Decree 145 Art. 65); added alongside `workedDaysByMonth` without consuming annual or personal paid leave. */
  paidHolidayDaysByMonth?: Readonly<Record<string, string>>;
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
const NON_NEGATIVE_DECIMAL = new RegExp('^\\d+(?:\\.\\d+)?$');
const NEGATIVE_DECIMAL = new RegExp('^-\\d+(?:\\.\\d+)?$');
const CALENDAR_MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
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
  if (value === undefined) {
    if (required) throw invalid(`${name} is required`);
    return money(0);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    if (required) throw invalid(`${name} is required`);
    return money(0);
  }
  if (NEGATIVE_DECIMAL.test(trimmed)) {
    throw invalid(`${name} cannot be negative`);
  }
  if (!NON_NEGATIVE_DECIMAL.test(trimmed)) {
    throw invalid(`${name} is not a decimal number`);
  }
  return money(trimmed);
}

function isScheduledWorkday(yearNum: number, monthIdxZeroBased: number, day: number, workweek: LeaveWorkweek): boolean {
  if (workweek === 'all_days') return true;
  const wd = WEEKDAY_NAMES[new Date(Date.UTC(yearNum, monthIdxZeroBased, day)).getUTCDay()];
  if (workweek === 'mon_sat') return wd !== 'sun';
  return wd !== 'sun' && wd !== 'sat';
}

function countWorkdaysInSpan(
  yearNum: number,
  monthIdxZeroBased: number,
  startDay: number,
  endDay: number,
  workweek: LeaveWorkweek,
): number {
  let count = 0;
  for (let day = startDay; day <= endDay; day++) {
    if (isScheduledWorkday(yearNum, monthIdxZeroBased, day, workweek)) count += 1;
  }
  return count;
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

interface Rational {
  num: bigint;
  den: bigint;
}

const ZERO_BI = BigInt('0');
const ONE_BI = BigInt('1');
const TEN_BI = BigInt('10');
const ZERO_RATIONAL: Rational = { num: ZERO_BI, den: ONE_BI };

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < ZERO_BI ? -a : a;
  let y = b < ZERO_BI ? -b : b;
  while (y !== ZERO_BI) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === ZERO_BI ? ONE_BI : x;
}

function makeRational(num: bigint, den: bigint): Rational {
  if (den < ZERO_BI) return makeRational(-num, -den);
  if (num === ZERO_BI) return ZERO_RATIONAL;
  const g = gcdBigInt(num, den);
  return { num: num / g, den: den / g };
}

function toRational(d: Decimal): Rational {
  const fixed = d.toFixed();
  const dot = fixed.indexOf('.');
  if (dot === -1) return { num: BigInt(fixed), den: ONE_BI };
  const intPart = fixed.slice(0, dot);
  const fracPart = fixed.slice(dot + 1);
  return makeRational(BigInt(`${intPart}${fracPart}`), TEN_BI ** BigInt(fracPart.length));
}

function addRational(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.den + b.num * a.den, a.den * b.den);
}

function subRational(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.den - b.num * a.den, a.den * b.den);
}

function mulRational(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.num, a.den * b.den);
}

function divRational(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.den, a.den * b.num);
}

function cmpRational(a: Rational, b: Rational): number {
  const diff = a.num * b.den - b.num * a.den;
  return diff > ZERO_BI ? 1 : diff < ZERO_BI ? -1 : 0;
}

/**
 * Consumes Decree 145/2020/ND-CP Art. 65(4) approved unpaid-leave allowance for one month
 * using exact rational arithmetic so multi-month fractions never accumulate division rounding error.
 */
function consumeApprovedUnpaidAllowance(
  approvedInMonth: Decimal,
  totalMonthWork: Decimal,
  allowanceMonthsRemaining: Rational,
): { coveredDays: Rational; uncoveredApproved: Rational; nextAllowance: Rational } {
  const approved = toRational(approvedInMonth);
  const totalWork = toRational(totalMonthWork);
  if (approved.num <= ZERO_BI || allowanceMonthsRemaining.num <= ZERO_BI || totalWork.num <= ZERO_BI) {
    return { coveredDays: ZERO_RATIONAL, uncoveredApproved: approved, nextAllowance: allowanceMonthsRemaining };
  }
  const maxCoveredDays = mulRational(allowanceMonthsRemaining, totalWork);
  if (cmpRational(approved, maxCoveredDays) <= 0) {
    const consumedFraction = divRational(approved, totalWork);
    const nextAllowance = subRational(allowanceMonthsRemaining, consumedFraction);
    return {
      coveredDays: approved,
      uncoveredApproved: ZERO_RATIONAL,
      nextAllowance: nextAllowance.num < ZERO_BI ? ZERO_RATIONAL : nextAllowance,
    };
  }
  return {
    coveredDays: maxCoveredDays,
    uncoveredApproved: subRational(approved, maxCoveredDays),
    nextAllowance: ZERO_RATIONAL,
  };
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
  if (input.workweek !== undefined && !LEAVE_WORKWEEKS.includes(input.workweek)) {
    throw invalid(`unknown workweek: ${String(input.workweek)}`);
  }
  for (const [ym, days] of Object.entries(input.workingDaysByMonth ?? {})) {
    if (!MONTH.test(ym)) throw invalid(`workingDaysByMonth key ${ym} must be YYYY-MM`);
    parsePositiveWorkingDays(`workingDaysByMonth[${ym}]`, days);
  }
  for (const [ym, days] of Object.entries(input.workedDaysByMonth ?? {})) {
    if (!MONTH.test(ym)) throw invalid(`workedDaysByMonth key ${ym} must be YYYY-MM`);
    parseNonNegativeDays(`workedDaysByMonth[${ym}]`, days, true);
  }
  for (const [ym, days] of Object.entries(input.paidHolidayDaysByMonth ?? {})) {
    if (!MONTH.test(ym)) throw invalid(`paidHolidayDaysByMonth key ${ym} must be YYYY-MM`);
    parseNonNegativeDays(`paidHolidayDaysByMonth[${ym}]`, days, true);
  }

  const zero = money(0);
  let openingTotal = parseNonNegativeDays('openingBalanceDays', input.openingBalanceDays);
  let takenAnnual = zero;
  let personalPaid = zero;
  const unpaidByMonth = new Map<string, Decimal>();
  const approvedUnpaidByMonth = new Map<string, Decimal>();
  const unapprovedUnpaidByMonth = new Map<string, Decimal>();
  const paidLeaveByMonth = new Map<string, Decimal>();

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
      paidLeaveByMonth.set(entry.month, (paidLeaveByMonth.get(entry.month) ?? zero).plus(days));
    } else if (entry.kind === 'personal_paid') {
      personalPaid = personalPaid.plus(days);
      paidLeaveByMonth.set(entry.month, (paidLeaveByMonth.get(entry.month) ?? zero).plus(days));
    } else {
      unpaidByMonth.set(entry.month, (unpaidByMonth.get(entry.month) ?? zero).plus(days));
      const bucket = entry.approved === true ? approvedUnpaidByMonth : unapprovedUnpaidByMonth;
      bucket.set(entry.month, (bucket.get(entry.month) ?? zero).plus(days));
    }
  }

  const yearNum = new Date(`${input.year}-${FIRST_DAY}-${FIRST_DAY}T00:00:00Z`).getUTCFullYear();
  const yearStart = `${input.year}-${FIRST_DAY}-${FIRST_DAY}`;
  const cutoffMonth = input.asOfMonth ?? `${input.year}-${LAST_MONTH}`;
  const cutoffIdx = CALENDAR_MONTHS.findIndex((m) => `${input.year}-${m}` === cutoffMonth);
  const yearCutoffDate = monthEndIso(yearNum, cutoffIdx, cutoffMonth);
  const clampedEndedOn = endedOn !== null && endedOn >= yearStart ? endedOn : null;
  const ruleLookupDate = clampedEndedOn !== null && clampedEndedOn < yearCutoffDate ? clampedEndedOn : yearCutoffDate;

  const rule = ruleInForce(rules, 'annual_leave', 'default', ruleLookupDate);
  if (rule === undefined) {
    throw new PayrollRefusedError('no_rule_in_force', `no annual_leave rule for default in force on ${ruleLookupDate}`);
  }
  if (!Number.isInteger(rule.value.seniorityYearsStep) || rule.value.seniorityYearsStep <= 0) {
    throw invalid('annual_leave seniorityYearsStep must be a positive integer');
  }

  const halfRatio = toRational(money(rule.value.halfMonthWorkingDaysRatio));
  let allowanceMonthsRemaining = toRational(money(rule.value.approvedUnpaidMonthsAllowance));
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

      const monthStd = input.workingDaysByMonth?.[ym] ?? input.standardWorkingDays;
      const workedExplicit = input.workedDaysByMonth?.[ym];
      const approvedInMonth = approvedUnpaidByMonth.get(ym) ?? zero;
      const unapprovedInMonth = unapprovedUnpaidByMonth.get(ym) ?? zero;
      let effectiveRatio: Rational;

      if (workedExplicit !== undefined) {
        if (monthStd === undefined) {
          throw invalid(`standardWorkingDays or workingDaysByMonth[${ym}] is required when workedDaysByMonth[${ym}] is provided`);
        }
        const totalMonthWork = money(monthStd.trim());
        const { coveredDays, nextAllowance } = consumeApprovedUnpaidAllowance(
          approvedInMonth,
          totalMonthWork,
          allowanceMonthsRemaining,
        );
        allowanceMonthsRemaining = nextAllowance;
        const paidLeaveInMonth = paidLeaveByMonth.get(ym) ?? zero;
        const holidayRaw = input.paidHolidayDaysByMonth?.[ym];
        const paidHolidayInMonth = holidayRaw !== undefined ? money(holidayRaw.trim()) : zero;
        const totalEffectiveWork = addRational(
          toRational(money(workedExplicit.trim()).plus(paidLeaveInMonth).plus(paidHolidayInMonth)),
          coveredDays,
        );
        effectiveRatio = divRational(totalEffectiveWork, toRational(totalMonthWork));
      } else {
        let totalMonthWork: Decimal;
        let activeMonthWork: Rational;
        if (monthStd !== undefined && startDay === 1 && endDay === daysInMonth) {
          totalMonthWork = money(monthStd.trim());
          activeMonthWork = toRational(totalMonthWork);
        } else if (input.workweek !== undefined || monthStd === undefined) {
          // Default to Vietnam's 6-day Mon-Sat schedule when no working-day override or workweek is given,
          // so both partial months and unpaid_leave deductions work out of the box with zero setup.
          const schedule: LeaveWorkweek = input.workweek ?? 'mon_sat';
          const totalWork = countWorkdaysInSpan(yearNum, idx, 1, daysInMonth, schedule);
          const activeWork = countWorkdaysInSpan(yearNum, idx, startDay, endDay, schedule);
          totalMonthWork = monthStd !== undefined ? money(monthStd.trim()) : money(String(totalWork));
          activeMonthWork = toRational(money(String(activeWork)));
        } else {
          totalMonthWork = money(monthStd.trim());
          const monFriTotal = countWorkdaysInSpan(yearNum, idx, 1, daysInMonth, 'mon_fri');
          const monSatTotal = countWorkdaysInSpan(yearNum, idx, 1, daysInMonth, 'mon_sat');
          let activeWork: number;
          if (totalMonthWork.equals(String(monFriTotal))) {
            activeWork = countWorkdaysInSpan(yearNum, idx, startDay, endDay, 'mon_fri');
          } else if (totalMonthWork.equals(String(monSatTotal))) {
            activeWork = countWorkdaysInSpan(yearNum, idx, startDay, endDay, 'mon_sat');
          } else if (totalMonthWork.equals(String(daysInMonth))) {
            activeWork = activeDays;
          } else {
            throw invalid(
              `partial month ${ym} working days (${monthStd}) do not match Mon-Fri (${monFriTotal}), Mon-Sat (${monSatTotal}), or calendar (${daysInMonth}) days; pass workedDaysByMonth[${ym}], workweek, or eligibleMonths`,
            );
          }
          activeMonthWork = toRational(money(String(activeWork)));
        }

        // Decree 145/2020/ND-CP Art. 65(4): employer-approved unpaid leave up to 1 month/year counts as working time.
        const { uncoveredApproved, nextAllowance } = consumeApprovedUnpaidAllowance(
          approvedInMonth,
          totalMonthWork,
          allowanceMonthsRemaining,
        );
        allowanceMonthsRemaining = nextAllowance;
        const effectiveUnpaid = addRational(toRational(unapprovedInMonth), uncoveredApproved);
        const actual = subRational(activeMonthWork, effectiveUnpaid);
        effectiveRatio = actual.num <= ZERO_BI ? ZERO_RATIONAL : divRational(actual, toRational(totalMonthWork));
      }

      if (cmpRational(effectiveRatio, halfRatio) >= 0) {
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
  // Sum rounded components so printed entitlementDays + seniorityDays matches totalEntitlementDays.
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
