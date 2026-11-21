// SPDX-License-Identifier: AGPL-3.0-only
import { money, toMoney, type Money } from '../money.ts';
import { INSURANCE_FUNDS, PAYROLL_RULES, type InsuranceFund } from './rules/index.ts';
import { REGIONS, ruleInForce, type InsuranceWageBase, type PayrollRule, type Region, type RuleKind, type RuleRow, type RuleStatus, type WageBound } from './rule-types.ts';

type Decimal = ReturnType<typeof money>;

// The calculator of docs/plan/payroll.md section 6.2: a pure function of one employment row, the month's inputs and the
// rules in force on the month. Every rate, threshold, cap and multiple comes from the rule data (`rules/`), never from a
// constant here; the only literal below is the scale that turns a percent into a fraction. Money is a decimal string in
// and out, and decimal.js inside. An amount is rounded to the dong where it is paid or withheld: each prorated pay
// component, each overtime payment, each fund's contribution, the union fee and the tax.

/** Turns a percent into a fraction. Not a rate. */
const PERCENT_SCALE = 100;

export const PAY_BASES = ['monthly', 'hourly', 'piece_rate'] as const;
export type PayBasis = (typeof PAY_BASES)[number];
export type ContractKind = 'indefinite' | 'fixed_term' | 'none';
export type OvertimeDayKind = 'normal_day' | 'weekly_rest_day' | 'holiday';
export type DeductionKind = 'advance' | 'damage' | 'other';
export type InsuranceSuspensionReason = 'not_insured' | 'unpaid_leave' | 'sickness_leave' | 'maternity_leave';

export interface PayrollAllowance {
  label: string;
  amount: Money;
  /** `meal_cash` is taxed only above the cash meal cap; any other allowance is taxed in full. */
  type: 'meal_cash' | 'other';
  /** Named in the contract with an amount: only such an allowance counts in the insurance wage (Decree 158/2025 Art. 7). */
  namedInContract: boolean;
}

/** The employment row in force on the month (the plan's 6.1): what the contract says, not what the month changed. */
export interface PayrollEmployment {
  /** The employer's place of operation, which sets the regional minimum wage. */
  region: Region;
  contract: ContractKind;
  /** Months of a `fixed_term` contract; null for the other kinds. */
  contractTermMonths: number | null;
  /** Tax residency status: residents use progressive or short-contract rules; non-residents pay 20% flat PIT. */
  resident: boolean;
  /** Compulsory insurance applies (the contract and the person's status, not the month). */
  insured: boolean;
  /** How regular pay is calculated: `'monthly'` (default), `'hourly'`, or `'piece_rate'`. */
  payBasis?: PayBasis;
  /** Contractual monthly wage (or fallback rate when `hourlyRate` / `pieceRate` is omitted on non-monthly bases). */
  baseWage: Money;
  /** Hourly wage rate when `payBasis === 'hourly'` (defaults to `baseWage` if omitted). */
  hourlyRate?: Money;
  /** Per-unit piece rate when `payBasis === 'piece_rate'` (defaults to `baseWage` if omitted). */
  pieceRate?: Money;
  /** Foreign worker status: when `true` and insured, exempt funds (BHTN) are skipped under `foreign_insurance`. */
  isForeign?: boolean;
  allowances: readonly PayrollAllowance[];
  /** Other regular pay: taxable, not in the insurance wage. */
  otherRegularPay?: Money;
  /** A commitment form on file (08/CK-TNCN): no withholding on a 10% payment. */
  commitment?: boolean;
}

export interface OvertimeEntry {
  dayKind: OvertimeDayKind;
  night: boolean;
  hours: string;
}

export interface PayrollDependent {
  /** The dependent's own income that month; above the rule's limit the person is not counted. */
  ownMonthlyIncome: Money;
}

export interface PayrollDeduction {
  label: string;
  /** Only `damage` falls under the cap on deductions of the Labor Code. */
  kind: DeductionKind;
  amount: Money;
}

export interface PayrollMonthInputs {
  /** The pay month, YYYY-MM. The rules in force on its first day apply. */
  month: string;
  /** Working days of the month under the contract (26, 22, ...), the divisor of unpaid days. */
  standardWorkingDays: string;
  /** Unpaid leave in working days: reduces pay on monthly basis, and counts toward the rule that suspends insurance. */
  unpaidLeaveDays?: string;
  /** Working days before the hire or after the end date: reduces pay only; the first month of work still pays insurance. */
  daysNotEmployed?: string;
  /** Working days on BHXH sickness regime leave: reduces monthly salary and counts toward 14-day insurance suspension. */
  sicknessBhxhDays?: string;
  /** Working days on BHXH maternity regime leave: reduces monthly salary and counts toward 14-day insurance suspension. */
  maternityBhxhDays?: string;
  /** Actual hours worked in the month for `payBasis === 'hourly'` (or hour basis for `piece_rate` OT/night rate). */
  workedHours?: string;
  /** Completed units in the month for `payBasis === 'piece_rate'`. */
  pieceCount?: string;
  overtime?: readonly OvertimeEntry[];
  /** Hours of ordinary night work (the premium on top of the pay already in the base wage). */
  nightHours?: string;
  bonus?: Money;
  /** Registered dependents on the month. */
  dependents?: readonly PayrollDependent[];
  /** Voluntary pension or life insurance paid by employer and employee together, before the rule's cap. */
  voluntaryPension?: Money;
  deductions?: readonly PayrollDeduction[];
  /** The person asked for withholding on a payment below the 10% threshold. */
  withholdingRequested?: boolean;
}

export type PayrollRefusalCode = 'invalid_input' | 'non_resident' | 'no_rule_in_force';

/** The calculator refuses what it does not model or cannot compute; a pay sheet shows the message for that person. */
export class PayrollRefusedError extends Error {
  code: PayrollRefusalCode;
  constructor(code: PayrollRefusalCode, message: string) {
    super(message);
    this.name = 'PayrollRefusedError';
    this.code = code;
  }
}

/** The rule a calculation used, as stored on the line. Status is the status at the time of the calculation. */
export interface RuleRef {
  id: string;
  kind: RuleKind;
  key: string;
  effectiveFrom: string;
  status: RuleStatus;
}

export interface InsuranceFundLine {
  fund: InsuranceFund;
  wage: Money;
  employee: Money;
  employer: Money;
}

export interface WageBounds {
  base: InsuranceWageBase;
  floor: Money;
  cap: Money;
  wage: Money;
}

export interface OvertimeLine {
  dayKind: OvertimeDayKind;
  night: boolean;
  hours: string;
  /** The multiple of the hourly rate, normal pay included. */
  multiple: string;
  pay: Money;
  /** The part exempt from personal income tax under the rule in force. */
  exempt: Money;
}

export interface PitSlice {
  from: Money;
  to: Money | null;
  percent: string;
  taxed: Money;
  tax: Money;
}

export type WithholdingMode = 'progressive' | 'flat' | 'commitment' | 'below_threshold' | 'non_resident_flat';

export interface PayrollCheck {
  id: 'minimum_wage' | 'deduction_cap';
  ok: boolean;
  actual: Money;
  limit: Money;
}

export interface PayrollBreakdown {
  pay: {
    baseWage: Money;
    allowances: { label: string; paid: Money }[];
    otherRegularPay: Money;
    /** Regular pay lost to unpaid leave and days not employed. */
    unpaidReduction: Money;
    /** Regular pay reduced for days on BHXH sickness regime leave. */
    sicknessBhxhReduction: Money;
    /** Regular pay reduced for days on BHXH maternity regime leave. */
    maternityBhxhReduction: Money;
    hourlyRate: Money | null;
    overtime: OvertimeLine[];
    nightWork: { hours: string; pay: Money } | null;
    bonus: Money;
  };
  insurance: {
    /** The base wage (or earned hourly/piece pay) and the allowances named in the contract, before the floor and the cap. */
    insurablePay: Money;
    suspended: InsuranceSuspensionReason | null;
    bounds: WageBounds[];
    funds: InsuranceFundLine[];
    unionFee: Money;
  };
  tax: {
    mode: WithholdingMode;
    exemptMealCash: Money;
    exemptOvertime: Money;
    exemptNightWork: Money;
    taxableIncome: Money;
    /** Taxable income less the employee's insurance (progressive) or less nothing (flat / non_resident_flat). */
    incomeAfterInsurance: Money;
    personalDeduction: Money;
    dependentsCounted: number;
    dependentDeduction: Money;
    pensionDeduction: Money;
    assessableIncome: Money;
    slices: PitSlice[];
    flatPercent: string | null;
  };
  deductions: { advance: Money; damage: Money; other: Money; total: Money };
}

export interface PayrollCalculation {
  month: string;
  gross: Money;
  employeeInsurance: Money;
  employerInsurance: Money;
  unionFee: Money;
  /** Gross less the exempt parts, before insurance and the family deductions. */
  taxableIncome: Money;
  pit: Money;
  net: Money;
  /** Gross + the employer's insurance + the union fee. */
  employerCost: Money;
  breakdown: PayrollBreakdown;
  checks: PayrollCheck[];
  /** Every rule the calculation looked at, sorted by id; see `listRulesUsed`. */
  rulesUsed: RuleRef[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE = new RegExp('^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$');

function invalid(what: string): PayrollRefusedError {
  return new PayrollRefusedError('invalid_input', `invalid payroll input: ${what}`);
}

// A non-negative decimal keeping full precision; an absent optional value is zero, an absent required one is refused.
function decimal(name: string, value: string | undefined, required = false): Decimal {
  if (required && (value === undefined || value.trim() === '')) throw invalid(`${name} is required`);
  let parsed: Decimal;
  try {
    parsed = money(value ?? '');
  } catch {
    throw invalid(`${name} is not a decimal amount`);
  }
  if (parsed.isNegative()) throw invalid(`${name} is negative`);
  return parsed;
}

// A non-negative decimal, rounded to the dong where it enters; an absent optional value is zero, an absent required one is refused.
function amount(name: string, value: string | undefined, required = false): Decimal {
  return decimal(name, value, required).toDecimalPlaces(0);
}

const percentOf = (base: Decimal, percent: string): Decimal => base.times(money(percent)).div(PERCENT_SCALE).toDecimalPlaces(0);

// The rules in force on the month, remembering which were looked at.
function ruleBook(rules: readonly PayrollRule[], month: string) {
  // The rules in force on the first day of the pay month. A row that starts mid-month applies from the next month, and a
  // rule dated by the time of payment (the BHTN cap) follows the pay month, not the day the money moves.
  const onDate = `${month}-01`;
  const used = new Map<string, RuleRef>();
  return {
    get<K extends RuleKind>(kind: K, key: string): RuleRow<K>['value'] {
      const row = ruleInForce(rules, kind, key, onDate);
      if (row === undefined) throw new PayrollRefusedError('no_rule_in_force', `no ${kind} rule for ${key} in force in ${month}`);
      used.set(row.id, { id: row.id, kind: row.kind, key: row.key, effectiveFrom: row.effectiveFrom, status: row.status });
      return row.value;
    },
    used: (): RuleRef[] => [...used.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/**
 * One person's month. Pure: the same row, inputs and rules give the same figures. Refuses (`PayrollRefusedError`) a
 * malformed input or a month for which a needed rule has no row in force.
 */
export function calculatePayroll(employment: PayrollEmployment, inputs: PayrollMonthInputs, rules: readonly PayrollRule[] = PAYROLL_RULES): PayrollCalculation {
  if (!MONTH.test(inputs.month)) throw invalid('month must be YYYY-MM');
  if (!REGIONS.includes(employment.region)) throw invalid('unknown region');
  if (employment.contract !== 'indefinite' && employment.contract !== 'fixed_term' && employment.contract !== 'none') {
    throw invalid('unknown contract kind');
  }
  const payBasis: PayBasis = employment.payBasis ?? 'monthly';
  if (!PAY_BASES.includes(payBasis)) throw invalid(`unknown payBasis ${String(payBasis)}`);
  const book = ruleBook(rules, inputs.month);
  const zero = money(0);

  // Days and proration.
  const standardDays = amount('standardWorkingDays', inputs.standardWorkingDays, true);
  if (!standardDays.greaterThan(0)) throw invalid('standardWorkingDays must be above zero');
  const unpaidLeave = amount('unpaidLeaveDays', inputs.unpaidLeaveDays);
  const notEmployed = amount('daysNotEmployed', inputs.daysNotEmployed);
  const sicknessBhxh = decimal('sicknessBhxhDays', inputs.sicknessBhxhDays);
  const maternityBhxh = decimal('maternityBhxhDays', inputs.maternityBhxhDays);
  const paidDays = standardDays.minus(unpaidLeave).minus(notEmployed).minus(sicknessBhxh).minus(maternityBhxh);
  if (paidDays.isNegative()) throw invalid('unpaid, sickness, maternity and not employed days exceed the working days of the month');
  const prorate = (full: Decimal): Decimal => full.times(paidDays).div(standardDays).toDecimalPlaces(0);

  // Validate contract term and basis-specific rates/quantities up front.
  if (
    employment.contract === 'fixed_term' &&
    (employment.contractTermMonths === null || !Number.isInteger(employment.contractTermMonths) || employment.contractTermMonths < 0)
  ) {
    throw invalid('a fixed-term contract needs its term in months');
  }
  const baseWage = amount('baseWage', employment.baseWage, true);
  let effectiveHourlyRate: Decimal | null = null;
  if (payBasis === 'hourly') {
    effectiveHourlyRate = decimal('hourlyRate', employment.hourlyRate ?? employment.baseWage, true);
    if (!effectiveHourlyRate.greaterThan(0)) throw invalid('hourlyRate must be above zero');
  } else if (employment.hourlyRate !== undefined) {
    decimal('hourlyRate', employment.hourlyRate);
  }
  let effectivePieceRate: Decimal | null = null;
  if (payBasis === 'piece_rate') {
    effectivePieceRate = decimal('pieceRate', employment.pieceRate ?? employment.baseWage, true);
    if (!effectivePieceRate.greaterThan(0)) throw invalid('pieceRate must be above zero');
  } else if (employment.pieceRate !== undefined) {
    decimal('pieceRate', employment.pieceRate);
  }
  const workedHours = decimal('workedHours', inputs.workedHours);
  const pieceCount = decimal('pieceCount', inputs.pieceCount);

  // Regular pay.
  const allowances = employment.allowances.map((a) => ({ ...a, value: amount(`allowance ${a.label}`, a.amount) }));
  const otherRegular = amount('otherRegularPay', employment.otherRegularPay);
  const namedAllowances = allowances.filter((a) => a.namedInContract).reduce((s, a) => s.plus(a.value), zero);

  let basePaid: Decimal;
  let allowancesPaid: Decimal[];
  let otherPaid: Decimal;
  let regularPaid: Decimal;
  let unpaidReduction = zero;
  let sicknessBhxhReduction = zero;
  let maternityBhxhReduction = zero;
  let insurablePay: Decimal;

  if (payBasis === 'monthly') {
    basePaid = prorate(baseWage);
    allowancesPaid = allowances.map((a) => prorate(a.value));
    otherPaid = prorate(otherRegular);
    const regularFull = baseWage.plus(allowances.reduce((s, a) => s.plus(a.value), zero)).plus(otherRegular);
    regularPaid = basePaid.plus(allowancesPaid.reduce((s, v) => s.plus(v), zero)).plus(otherPaid);
    const totalReduction = regularFull.minus(regularPaid);
    // Split total daily reduction across unpaid/not-employed, sickness BHXH, and maternity BHXH so their sum equals totalReduction exactly.
    let remainingReduction = totalReduction;
    const takeReduction = (days: Decimal, isLastNonZero: boolean): Decimal => {
      if (days.isZero() || remainingReduction.isZero()) return zero;
      if (isLastNonZero) {
        const taken = remainingReduction;
        remainingReduction = zero;
        return taken;
      }
      const share = regularFull.times(days).div(standardDays).toDecimalPlaces(0);
      const taken = share.greaterThan(remainingReduction) ? remainingReduction : share;
      remainingReduction = remainingReduction.minus(taken);
      return taken;
    };
    const unpaidDays = unpaidLeave.plus(notEmployed);
    unpaidReduction = takeReduction(unpaidDays, sicknessBhxh.isZero() && maternityBhxh.isZero());
    sicknessBhxhReduction = takeReduction(sicknessBhxh, maternityBhxh.isZero());
    maternityBhxhReduction = takeReduction(maternityBhxh, true);
    insurablePay = baseWage.plus(namedAllowances);
  } else if (payBasis === 'hourly') {
    // Hourly pay comes directly from actual workedHours * hourlyRate without daily salary proration.
    basePaid = workedHours.times(effectiveHourlyRate!).toDecimalPlaces(0);
    allowancesPaid = allowances.map((a) => a.value);
    otherPaid = otherRegular;
    regularPaid = basePaid.plus(allowancesPaid.reduce((s, v) => s.plus(v), zero)).plus(otherPaid);
    // Law 41/2024 Art. 31(1)(b), plan row 3: hourly/unit pay uses actual monthly earned base plus contract-named allowances.
    insurablePay = basePaid.plus(namedAllowances);
  } else {
    // Piece-rate pay comes directly from pieceCount * pieceRate without daily salary proration.
    basePaid = pieceCount.times(effectivePieceRate!).toDecimalPlaces(0);
    allowancesPaid = allowances.map((a) => a.value);
    otherPaid = otherRegular;
    regularPaid = basePaid.plus(allowancesPaid.reduce((s, v) => s.plus(v), zero)).plus(otherPaid);
    insurablePay = basePaid.plus(namedAllowances);
  }

  // Hourly rate for overtime and night work (Labor Code Art. 98):
  // - monthly: (baseWage + contract-named allowances) / (standardWorkingDays * standard_hours.perDay)
  // - hourly: contractual hourlyRate directly
  // - piece_rate: earned piece pay / workedHours when workedHours > 0, else earned piece pay / (standardWorkingDays * standard_hours.perDay)
  const hourlyCache: { rate: Decimal | null } = {
    rate:
      payBasis === 'hourly'
        ? effectiveHourlyRate
        : payBasis === 'piece_rate' && workedHours.greaterThan(0)
          ? basePaid.div(workedHours)
          : null,
  };
  const hourlyRate = (): Decimal => {
    if (hourlyCache.rate === null) {
      const rateBase = payBasis === 'piece_rate' ? basePaid : insurablePay;
      hourlyCache.rate = rateBase.div(standardDays.times(money(book.get('standard_hours', 'default').perDay)));
    }
    return hourlyCache.rate;
  };

  const overtimeInputs = inputs.overtime ?? [];
  const overtimeLines: OvertimeLine[] = [];
  let overtimePay = zero;
  let exemptOvertime = zero;
  if (overtimeInputs.length > 0) {
    const multiples = book.get('overtime_multiples', 'default');
    const night = book.get('night_premium', 'default');
    const exemption = book.get('pit_overtime_exemption', 'default');
    for (const entry of overtimeInputs) {
      if (!Object.hasOwn(multiples, entry.dayKind)) throw invalid(`unknown overtime day kind ${entry.dayKind}`);
      const hours = decimal('overtime hours', entry.hours);
      const dayMultiple = money(multiples[entry.dayKind]);
      const multiple = entry.night ? dayMultiple.plus(money(night.nightWork)).plus(money(night.nightOvertimeExtra).times(dayMultiple)) : dayMultiple;
      const pay = hours.times(hourlyRate()).times(multiple).toDecimalPlaces(0);
      const normalPay = hours.times(hourlyRate()).toDecimalPlaces(0);
      const exempt = exemption.mode === 'whole_pay' ? pay : pay.minus(normalPay);
      overtimeLines.push({ dayKind: entry.dayKind, night: entry.night, hours: entry.hours, multiple: multiple.toFixed(), pay: toMoney(pay), exempt: toMoney(exempt) });
      overtimePay = overtimePay.plus(pay);
      exemptOvertime = exemptOvertime.plus(exempt);
    }
  }

  const nightHours = decimal('nightHours', inputs.nightHours);
  let nightPay = zero;
  if (nightHours.greaterThan(0)) nightPay = nightHours.times(hourlyRate()).times(money(book.get('night_premium', 'default').nightWork)).toDecimalPlaces(0);

  const bonus = amount('bonus', inputs.bonus);
  const gross = regularPaid.plus(overtimePay).plus(nightPay).plus(bonus);

  // Insurance: suspension check (unpaid leave + BHXH sickness + BHXH maternity >= 14 working days), then bounds and funds.
  let suspended: InsuranceSuspensionReason | null = null;
  if (!employment.insured) {
    suspended = 'not_insured';
  } else {
    const unpaidThreshold = money(book.get('insurance_suspension', 'unpaid_leave').unpaidWorkingDays);
    const sicknessThreshold = sicknessBhxh.greaterThan(0) ? money(book.get('insurance_suspension', 'sickness_leave').unpaidWorkingDays) : null;
    const maternityThreshold = maternityBhxh.greaterThan(0) ? money(book.get('insurance_suspension', 'maternity_leave').unpaidWorkingDays) : null;
    const totalSuspensionDays = unpaidLeave.plus(sicknessBhxh).plus(maternityBhxh);
    let candidate: InsuranceSuspensionReason = 'unpaid_leave';
    let threshold = unpaidThreshold;
    if (maternityBhxh.greaterThan(0) && maternityBhxh.greaterThanOrEqualTo(sicknessBhxh) && maternityBhxh.greaterThanOrEqualTo(unpaidLeave)) {
      candidate = 'maternity_leave';
      threshold = maternityThreshold!;
    } else if (sicknessBhxh.greaterThan(0) && sicknessBhxh.greaterThanOrEqualTo(unpaidLeave)) {
      candidate = 'sickness_leave';
      threshold = sicknessThreshold!;
    }
    if (totalSuspensionDays.greaterThanOrEqualTo(threshold)) suspended = candidate;
  }
  const bounds = new Map<InsuranceWageBase, { floor: Decimal; cap: Decimal; wage: Decimal }>();
  const boundAmount = (bound: WageBound): Decimal =>
    bound.basis === 'reference_level'
      ? money(book.get('reference_level', 'default').amount).times(money(bound.multiple))
      : money(book.get('minimum_wage', employment.region).monthly).times(money(bound.multiple));
  const wageFor = (base: InsuranceWageBase): Decimal => {
    let entry = bounds.get(base);
    if (entry === undefined) {
      const rule = book.get('insurance_wage_bounds', base);
      const floor = boundAmount(rule.floor);
      const cap = boundAmount(rule.cap);
      const clamped = insurablePay.lessThan(floor) ? floor : insurablePay.greaterThan(cap) ? cap : insurablePay;
      entry = { floor, cap, wage: clamped };
      bounds.set(base, entry);
    }
    return entry.wage;
  };
  let employeeInsurance = zero;
  let employerInsurance = zero;
  let unionFee = zero;
  const fundLines: InsuranceFundLine[] = [];
  if (suspended === null) {
    const exemptFunds = employment.isForeign === true ? new Set<InsuranceFund>(book.get('foreign_insurance', 'default').exemptFunds) : new Set<InsuranceFund>();
    for (const fund of INSURANCE_FUNDS) {
      if (exemptFunds.has(fund)) {
        fundLines.push({ fund, wage: '0', employee: '0', employer: '0' });
        continue;
      }
      const rate = book.get('insurance_rate', fund);
      const wage = wageFor(rate.wageBase);
      const employee = percentOf(wage, rate.employeePercent);
      const employer = percentOf(wage, rate.employerPercent);
      fundLines.push({ fund, wage: toMoney(wage), employee: toMoney(employee), employer: toMoney(employer) });
      employeeInsurance = employeeInsurance.plus(employee);
      employerInsurance = employerInsurance.plus(employer);
    }
    const union = book.get('union_fee', 'employer');
    unionFee = percentOf(wageFor(union.wageBase), union.employerPercent);
  }

  // Personal income tax.
  let exemptMeal = zero;
  const mealPaid = allowances.reduce((s, a, i) => (a.type === 'meal_cash' ? s.plus(allowancesPaid[i] ?? zero) : s), zero);
  if (mealPaid.greaterThan(0)) {
    const cap = money(book.get('pit_meal_cash_cap', 'default').monthly);
    exemptMeal = mealPaid.lessThan(cap) ? mealPaid : cap;
  }
  // Night-work pay here is the premium alone, exempt under either reading; the row is still consulted so the month lists it.
  if (nightPay.greaterThan(0)) book.get('pit_overtime_exemption', 'default');
  const exemptNight = nightPay;
  const taxableIncome = gross.minus(exemptMeal).minus(exemptOvertime).minus(exemptNight);

  const dependents = inputs.dependents ?? [];
  const pension = amount('voluntaryPension', inputs.voluntaryPension);

  let mode: WithholdingMode;
  let pit = zero;
  let incomeAfterInsurance = taxableIncome;
  let personalDeduction = zero;
  let dependentDeduction = zero;
  let dependentsCounted = 0;
  let pensionDeduction = zero;
  let assessable = zero;
  const slices: PitSlice[] = [];
  let flatPercent: string | null = null;

  if (!employment.resident) {
    for (const d of dependents) amount('dependent income', d.ownMonthlyIncome);
    const nonResident = book.get('pit_non_resident', 'default');
    mode = 'non_resident_flat';
    flatPercent = nonResident.percent;
    assessable = taxableIncome;
    pit = percentOf(taxableIncome, nonResident.percent);
  } else {
    const withholding = book.get('pit_withholding', 'no_or_short_contract');
    let progressive: boolean;
    if (employment.contract === 'indefinite') progressive = true;
    else if (employment.contract === 'none') progressive = false;
    else progressive = (employment.contractTermMonths as number) >= withholding.progressiveFromContractMonths;

    if (progressive) {
      mode = 'progressive';
      incomeAfterInsurance = taxableIncome.minus(employeeInsurance);
      personalDeduction = money(book.get('pit_deduction', 'personal').monthly);
      if (dependents.length > 0) {
        const limit = money(book.get('pit_deduction', 'dependent_income_limit').monthly);
        dependentsCounted = dependents.filter((d) => amount('dependent income', d.ownMonthlyIncome).lessThanOrEqualTo(limit)).length;
        if (dependentsCounted > 0) dependentDeduction = money(book.get('pit_deduction', 'dependent').monthly).times(dependentsCounted);
      }
      if (pension.greaterThan(0)) {
        const cap = money(book.get('pit_deduction', 'voluntary_pension_cap').monthly);
        pensionDeduction = pension.lessThan(cap) ? pension : cap;
      }
      assessable = incomeAfterInsurance.minus(personalDeduction).minus(dependentDeduction).minus(pensionDeduction);
      if (assessable.isNegative()) assessable = zero;
      let lower = zero;
      let tax = zero;
      for (const bracket of book.get('pit_brackets', 'resident_monthly').brackets) {
        const upper = bracket.upTo === null ? null : money(bracket.upTo);
        if (assessable.greaterThan(lower)) {
          const top = upper === null || assessable.lessThan(upper) ? assessable : upper;
          const taxed = top.minus(lower);
          const sliceTax = taxed.times(money(bracket.percent)).div(PERCENT_SCALE);
          slices.push({ from: toMoney(lower), to: upper === null ? null : toMoney(upper), percent: bracket.percent, taxed: toMoney(taxed), tax: toMoney(sliceTax) });
          tax = tax.plus(sliceTax);
        }
        if (upper === null || assessable.lessThanOrEqualTo(upper)) break;
        lower = upper;
      }
      pit = tax.toDecimalPlaces(0);
    } else {
      for (const d of dependents) amount('dependent income', d.ownMonthlyIncome);
      flatPercent = withholding.percent;
      // The payment is the taxable income before any insurance: the threshold and the 10% both apply to it.
      assessable = taxableIncome;
      if (employment.commitment === true) mode = 'commitment';
      else if (taxableIncome.greaterThanOrEqualTo(money(withholding.paymentThreshold)) || inputs.withholdingRequested === true) {
        mode = 'flat';
        pit = percentOf(taxableIncome, withholding.percent);
      } else mode = 'below_threshold';
    }
  }

  // Deductions and the checks of the Labor Code.
  const deductionTotals = { advance: zero, damage: zero, other: zero };
  for (const d of inputs.deductions ?? []) {
    if (!Object.hasOwn(deductionTotals, d.kind)) throw invalid(`unknown deduction kind ${d.kind}`);
    deductionTotals[d.kind] = deductionTotals[d.kind].plus(amount(`deduction ${d.label}`, d.amount));
  }
  const deductionsTotal = deductionTotals.advance.plus(deductionTotals.damage).plus(deductionTotals.other);
  const net = gross.minus(employeeInsurance).minus(pit).minus(deductionsTotal);

  const checks: PayrollCheck[] = [];
  const minWageRule = book.get('minimum_wage', employment.region);
  if (payBasis === 'hourly') {
    const minimumHourly = money(minWageRule.hourly);
    checks.push({
      id: 'minimum_wage',
      ok: effectiveHourlyRate!.greaterThanOrEqualTo(minimumHourly),
      actual: toMoney(effectiveHourlyRate!),
      limit: toMoney(minimumHourly),
    });
  } else if (payBasis === 'piece_rate') {
    const minimumMonthly = money(minWageRule.monthly);
    const limit = paidDays.equals(standardDays) ? minimumMonthly : minimumMonthly.times(paidDays).div(standardDays).toDecimalPlaces(0);
    checks.push({ id: 'minimum_wage', ok: basePaid.greaterThanOrEqualTo(limit), actual: toMoney(basePaid), limit: toMoney(limit) });
  } else {
    const minimumMonthly = money(minWageRule.monthly);
    checks.push({ id: 'minimum_wage', ok: baseWage.greaterThanOrEqualTo(minimumMonthly), actual: toMoney(baseWage), limit: toMoney(minimumMonthly) });
  }
  if (deductionTotals.damage.greaterThan(0)) {
    const limit = gross.minus(employeeInsurance).minus(pit).times(money(book.get('deduction_cap', 'default').percent)).div(PERCENT_SCALE);
    checks.push({ id: 'deduction_cap', ok: deductionTotals.damage.lessThanOrEqualTo(limit), actual: toMoney(deductionTotals.damage), limit: toMoney(limit.toDecimalPlaces(0)) });
  }

  const breakdown: PayrollBreakdown = {
    pay: {
      baseWage: toMoney(basePaid),
      allowances: allowances.map((a, i) => ({ label: a.label, paid: toMoney(allowancesPaid[i] ?? zero) })),
      otherRegularPay: toMoney(otherPaid),
      unpaidReduction: toMoney(unpaidReduction),
      sicknessBhxhReduction: toMoney(sicknessBhxhReduction),
      maternityBhxhReduction: toMoney(maternityBhxhReduction),
      hourlyRate: hourlyCache.rate === null ? null : toMoney(hourlyCache.rate),
      overtime: overtimeLines,
      nightWork: nightHours.greaterThan(0) ? { hours: nightHours.toFixed(), pay: toMoney(nightPay) } : null,
      bonus: toMoney(bonus),
    },
    insurance: {
      insurablePay: toMoney(insurablePay),
      suspended,
      bounds: [...bounds].map(([base, b]) => ({ base, floor: toMoney(b.floor), cap: toMoney(b.cap), wage: toMoney(b.wage) })),
      funds: fundLines,
      unionFee: toMoney(unionFee),
    },
    tax: {
      mode,
      exemptMealCash: toMoney(exemptMeal),
      exemptOvertime: toMoney(exemptOvertime),
      exemptNightWork: toMoney(exemptNight),
      taxableIncome: toMoney(taxableIncome),
      incomeAfterInsurance: toMoney(incomeAfterInsurance),
      personalDeduction: toMoney(personalDeduction),
      dependentsCounted,
      dependentDeduction: toMoney(dependentDeduction),
      pensionDeduction: toMoney(pensionDeduction),
      assessableIncome: toMoney(assessable),
      slices,
      flatPercent,
    },
    deductions: { advance: toMoney(deductionTotals.advance), damage: toMoney(deductionTotals.damage), other: toMoney(deductionTotals.other), total: toMoney(deductionsTotal) },
  };

  return {
    month: inputs.month,
    gross: toMoney(gross),
    employeeInsurance: toMoney(employeeInsurance),
    employerInsurance: toMoney(employerInsurance),
    unionFee: toMoney(unionFee),
    taxableIncome: toMoney(taxableIncome),
    pit: toMoney(pit),
    net: toMoney(net),
    employerCost: toMoney(gross.plus(employerInsurance).plus(unionFee)),
    breakdown,
    checks,
    rulesUsed: book.used(),
  };
}

export interface ForeignInsuranceEligibilityInput {
  hasWorkPermitOrPracticeCert: boolean;
  isInternalTransferee: boolean;
  atOrAboveRetirementAge: boolean;
  contract: ContractKind;
  contractTermMonths: number | null;
}

export interface ForeignInsuranceEligibilityResult {
  bhxhBhtnEligible: boolean;
  bhxhBhytEligible: boolean;
  exemptReason: string | null;
  rulesUsed: RuleRef[];
}

/**
 * Evaluates statutory compulsory insurance eligibility for a foreign employee in Vietnam under
 * Decree 143/2018/ND-CP and Social Insurance Law 41/2024/QH15 Art. 2(2).
 */
export function evaluateForeignInsuranceEligibility(
  input: ForeignInsuranceEligibilityInput,
  onDate: string,
  rules: readonly PayrollRule[] = PAYROLL_RULES,
): ForeignInsuranceEligibilityResult {
  let lookupDate: string;
  if (ISO_DATE.test(onDate)) {
    const parsed = new Date(`${onDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(onDate)) {
      throw invalid('onDate is not a real calendar date');
    }
    lookupDate = onDate;
  } else if (MONTH.test(onDate)) {
    lookupDate = `${onDate}-01`;
  } else {
    throw invalid('onDate must be YYYY-MM-DD or YYYY-MM');
  }
  if (input.contract !== 'indefinite' && input.contract !== 'fixed_term' && input.contract !== 'none') {
    throw invalid('unknown contract kind');
  }
  if (input.contractTermMonths !== null && (!Number.isInteger(input.contractTermMonths) || input.contractTermMonths < 0)) {
    throw invalid('contractTermMonths must be a non-negative integer or null');
  }

  const row = ruleInForce(rules, 'foreign_insurance', 'default', lookupDate);
  if (row === undefined) {
    throw new PayrollRefusedError('no_rule_in_force', `no foreign_insurance rule for default in force on ${lookupDate}`);
  }
  const rulesUsed: RuleRef[] = [{ id: row.id, kind: row.kind, key: row.key, effectiveFrom: row.effectiveFrom, status: row.status }];
  const contractQualifies =
    input.contract === 'indefinite' ||
    (input.contract === 'fixed_term' && input.contractTermMonths !== null && input.contractTermMonths >= row.value.minContractMonths);

  let exemptReason: string | null = null;
  if (!input.hasWorkPermitOrPracticeCert) exemptReason = 'no_work_permit_or_practice_cert';
  else if (input.isInternalTransferee) exemptReason = 'internal_transferee';
  else if (input.atOrAboveRetirementAge) exemptReason = 'at_or_above_retirement_age';
  else if (!contractQualifies) exemptReason = 'contract_below_minimum_term';

  const exemptSet = new Set<InsuranceFund>(row.value.exemptFunds);
  const bhxhExempt = exemptSet.has('retirement_death') && exemptSet.has('sickness_maternity') && exemptSet.has('work_accident');
  const bhytExempt = exemptSet.has('health');
  const bhtnExempt = exemptSet.has('unemployment');
  const bhxhBhytEligible = exemptReason === null && !bhxhExempt && !bhytExempt;
  const bhxhBhtnEligible = exemptReason === null && !bhxhExempt && !bhtnExempt;

  return {
    bhxhBhtnEligible,
    bhxhBhytEligible,
    exemptReason,
    rulesUsed,
  };
}
