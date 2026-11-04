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

export type ContractKind = 'indefinite' | 'fixed_term' | 'none';
export type OvertimeDayKind = 'normal_day' | 'weekly_rest_day' | 'holiday';
export type DeductionKind = 'advance' | 'damage' | 'other';

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
  /** A non-resident is refused (the plan's first slice). */
  resident: boolean;
  /** Compulsory insurance applies (the contract and the person's status, not the month). */
  insured: boolean;
  baseWage: Money;
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
  /** Unpaid leave in working days: reduces pay, and counts toward the rule that suspends insurance. */
  unpaidLeaveDays?: string;
  /** Working days before the hire or after the end date: reduces pay only; the first month of work still pays insurance. */
  daysNotEmployed?: string;
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

export type WithholdingMode = 'progressive' | 'flat' | 'commitment' | 'below_threshold';

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
    hourlyRate: Money | null;
    overtime: OvertimeLine[];
    nightWork: { hours: string; pay: Money } | null;
    bonus: Money;
  };
  insurance: {
    /** The base wage and the allowances named in the contract, before the floor and the cap. */
    insurablePay: Money;
    suspended: 'not_insured' | 'unpaid_leave' | null;
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
    /** Taxable income less the employee's insurance (progressive) or less nothing (flat). */
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

function invalid(what: string): PayrollRefusedError {
  return new PayrollRefusedError('invalid_input', `invalid payroll input: ${what}`);
}

// A non-negative decimal; an absent value is zero.
function amount(name: string, value: string | undefined): Decimal {
  let parsed: Decimal;
  try {
    parsed = money(value ?? '');
  } catch {
    throw invalid(`${name} is not a decimal amount`);
  }
  if (parsed.isNegative()) throw invalid(`${name} is negative`);
  return parsed;
}

const percentOf = (base: Decimal, percent: string): Decimal => base.times(money(percent)).div(PERCENT_SCALE).toDecimalPlaces(0);

// The rules in force on the month, remembering which were looked at.
function ruleBook(rules: readonly PayrollRule[], month: string) {
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
 * non-resident, a malformed input and a month for which a needed rule has no row in force.
 */
export function calculatePayroll(employment: PayrollEmployment, inputs: PayrollMonthInputs, rules: readonly PayrollRule[] = PAYROLL_RULES): PayrollCalculation {
  if (!MONTH.test(inputs.month)) throw invalid('month must be YYYY-MM');
  if (!REGIONS.includes(employment.region)) throw invalid('unknown region');
  if (!employment.resident) throw new PayrollRefusedError('non_resident', 'personal income tax for a non-resident is not calculated yet; enter this payroll by hand');
  const book = ruleBook(rules, inputs.month);
  const zero = money(0);

  // Days and proration.
  const standardDays = amount('standardWorkingDays', inputs.standardWorkingDays);
  if (!standardDays.greaterThan(0)) throw invalid('standardWorkingDays must be above zero');
  const unpaidLeave = amount('unpaidLeaveDays', inputs.unpaidLeaveDays);
  const notEmployed = amount('daysNotEmployed', inputs.daysNotEmployed);
  const paidDays = standardDays.minus(unpaidLeave).minus(notEmployed);
  if (paidDays.isNegative()) throw invalid('unpaid and not employed days exceed the working days of the month');
  const prorate = (full: Decimal): Decimal => full.times(paidDays).div(standardDays).toDecimalPlaces(0);

  // Regular pay.
  const baseWage = amount('baseWage', employment.baseWage);
  const allowances = employment.allowances.map((a) => ({ ...a, value: amount(`allowance ${a.label}`, a.amount) }));
  const otherRegular = amount('otherRegularPay', employment.otherRegularPay);
  const basePaid = prorate(baseWage);
  const allowancesPaid = allowances.map((a) => prorate(a.value));
  const otherPaid = prorate(otherRegular);
  const regularFull = baseWage.plus(allowances.reduce((s, a) => s.plus(a.value), zero)).plus(otherRegular);
  const regularPaid = basePaid.plus(allowancesPaid.reduce((s, v) => s.plus(v), zero)).plus(otherPaid);
  const unpaidReduction = regularFull.minus(regularPaid);

  // The insurable pay and, from it, the hourly rate of overtime and night work (Labor Code Art. 98).
  const insurablePay = baseWage.plus(allowances.filter((a) => a.namedInContract).reduce((s, a) => s.plus(a.value), zero));
  const hourlyCache: { rate: Decimal | null } = { rate: null };
  const hourlyRate = (): Decimal => {
    hourlyCache.rate ??= insurablePay.div(standardDays.times(money(book.get('standard_hours', 'default').perDay)));
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
      if (!(entry.dayKind in multiples)) throw invalid(`unknown overtime day kind ${entry.dayKind}`);
      const hours = amount('overtime hours', entry.hours);
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

  const nightHours = amount('nightHours', inputs.nightHours);
  let nightPay = zero;
  if (nightHours.greaterThan(0)) nightPay = nightHours.times(hourlyRate()).times(money(book.get('night_premium', 'default').nightWork)).toDecimalPlaces(0);

  const bonus = amount('bonus', inputs.bonus);
  const gross = regularPaid.plus(overtimePay).plus(nightPay).plus(bonus);

  // Insurance: the wage clamped to the floor and the cap, by base.
  const suspended: 'not_insured' | 'unpaid_leave' | null = !employment.insured
    ? 'not_insured'
    : unpaidLeave.greaterThanOrEqualTo(money(book.get('insurance_suspension', 'unpaid_leave').unpaidWorkingDays))
      ? 'unpaid_leave'
      : null;
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
    for (const fund of INSURANCE_FUNDS) {
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
  const withholding = book.get('pit_withholding', 'no_or_short_contract');
  let progressive: boolean;
  if (employment.contract === 'indefinite') progressive = true;
  else if (employment.contract === 'none') progressive = false;
  else if (employment.contractTermMonths === null || !Number.isInteger(employment.contractTermMonths) || employment.contractTermMonths < 0) throw invalid('a fixed-term contract needs its term in months');
  else progressive = employment.contractTermMonths >= withholding.progressiveFromContractMonths;

  let exemptMeal = zero;
  const mealPaid = allowances.reduce((s, a, i) => (a.type === 'meal_cash' ? s.plus(allowancesPaid[i] ?? zero) : s), zero);
  if (mealPaid.greaterThan(0)) {
    const cap = money(book.get('pit_meal_cash_cap', 'default').monthly);
    exemptMeal = mealPaid.lessThan(cap) ? mealPaid : cap;
  }
  const exemptNight = nightPay;
  const taxableIncome = gross.minus(exemptMeal).minus(exemptOvertime).minus(exemptNight);

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
  if (progressive) {
    mode = 'progressive';
    incomeAfterInsurance = taxableIncome.minus(employeeInsurance);
    personalDeduction = money(book.get('pit_deduction', 'personal').monthly);
    const dependents = inputs.dependents ?? [];
    if (dependents.length > 0) {
      const limit = money(book.get('pit_deduction', 'dependent_income_limit').monthly);
      dependentsCounted = dependents.filter((d) => amount('dependent income', d.ownMonthlyIncome).lessThanOrEqualTo(limit)).length;
      if (dependentsCounted > 0) dependentDeduction = money(book.get('pit_deduction', 'dependent').monthly).times(dependentsCounted);
    }
    const pension = amount('voluntaryPension', inputs.voluntaryPension);
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
    flatPercent = withholding.percent;
    incomeAfterInsurance = taxableIncome.minus(employeeInsurance);
    assessable = incomeAfterInsurance.isNegative() ? zero : incomeAfterInsurance;
    if (employment.commitment === true) mode = 'commitment';
    else if (assessable.greaterThanOrEqualTo(money(withholding.paymentThreshold)) || inputs.withholdingRequested === true) {
      mode = 'flat';
      pit = percentOf(assessable, withholding.percent);
    } else mode = 'below_threshold';
  }

  // Deductions and the checks of the Labor Code.
  const deductionTotals = { advance: zero, damage: zero, other: zero };
  for (const d of inputs.deductions ?? []) {
    if (!(d.kind in deductionTotals)) throw invalid(`unknown deduction kind ${d.kind}`);
    deductionTotals[d.kind] = deductionTotals[d.kind].plus(amount(`deduction ${d.label}`, d.amount));
  }
  const deductionsTotal = deductionTotals.advance.plus(deductionTotals.damage).plus(deductionTotals.other);
  const net = gross.minus(employeeInsurance).minus(pit).minus(deductionsTotal);

  const checks: PayrollCheck[] = [];
  const minimumWage = money(book.get('minimum_wage', employment.region).monthly);
  checks.push({ id: 'minimum_wage', ok: baseWage.greaterThanOrEqualTo(minimumWage), actual: toMoney(baseWage), limit: toMoney(minimumWage) });
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
