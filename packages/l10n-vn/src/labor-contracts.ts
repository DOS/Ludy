// SPDX-License-Identifier: AGPL-3.0-only
// SME labor contract & probation validation, statutory severance allowance, and 13th-month salary proration
// (issue #2541 slice 2a / #3359; docs/plan/payroll.md section 5 rows 3, 11, 13, 17 and section 7).
//
// Pure domain helpers: decimal strings in and out via decimal.js (`money()`), pure Gregorian calendar arithmetic
// (never JS Date rollovers), and explicit `rulesUsed` attribution separating primary Labor Code text from
// commentary rows pending accountant confirmation (#2535).

import { Decimal, money, sum, toMoney, type Money } from './money.ts';

type DecimalValue = ReturnType<typeof money>;

// ---------------------------------------------------------------------------------------------------------------------
// Rule attribution metadata
// ---------------------------------------------------------------------------------------------------------------------

export interface LaborRuleRef {
  id: string;
  planRow: number;
  status: 'confirmed' | 'commentary';
  confidence: 'primary' | 'gov' | 'commentary' | 'unverified';
  cite: string;
}

const RULE_CONTRACT_TERMS: LaborRuleRef = {
  id: 'labor_contract.terms@2021-01-01',
  planRow: 17,
  status: 'commentary',
  confidence: 'primary',
  cite: 'Labor Code 2019 Arts. 14, 20, 24-27, 35, 36 (plan row 17, primary text; pending accountant review #2535)',
};

const RULE_SEVERANCE_LABOR_CODE: LaborRuleRef = {
  id: 'severance.labor_code_art46@2021-01-01',
  planRow: 17,
  status: 'commentary',
  confidence: 'primary',
  cite: 'Labor Code 2019 Art. 46 (plan row 17, primary text; pending accountant review #2535): 0.5 month wage per qualifying year for >= 12 months worked',
};

const RULE_SEVERANCE_DECREE_145: LaborRuleRef = {
  id: 'severance.decree145_art8@2021-02-01',
  planRow: 17,
  status: 'commentary',
  confidence: 'commentary',
  cite: 'Decree 145/2020/ND-CP Art. 8 (plan row 17, commentary; pending accountant confirmation #2535): qualifying months exclude unemployment-insured and settled months, rounded to 0.5 or 1 year',
};

const RULE_SEVERANCE_PIT_EXEMPTION: LaborRuleRef = {
  id: 'severance.pit_exemption@2026-01-01',
  planRow: 13,
  status: 'commentary',
  confidence: 'commentary',
  cite: 'Payroll plan section 5 row 13 (commentary; pending accountant confirmation #2535): statutory severance is PIT-exempt; excess above statutory level is treated as taxable until confirmed',
};

const RULE_JOB_LOSS_LABOR_CODE: LaborRuleRef = {
  id: 'job_loss.labor_code_art47@2021-01-01',
  planRow: 17,
  status: 'commentary',
  confidence: 'primary',
  cite: "Labor Code 2019 Arts. 42, 43, 47 (plan row 17, primary text; pending accountant review #2535): 1 month wage per qualifying year for >= 12 months worked, minimum 2 months' wage floor",
};

const RULE_JOB_LOSS_DECREE_145: LaborRuleRef = {
  id: 'job_loss.decree145_art8@2021-02-01',
  planRow: 17,
  status: 'commentary',
  confidence: 'commentary',
  cite: 'Decree 145/2020/ND-CP Art. 8 (plan row 17, commentary; pending accountant confirmation #2535): qualifying months exclude unemployment-insured and settled months, rounded to 0.5 or 1 year',
};

const RULE_THIRTEENTH_MONTH: LaborRuleRef = {
  id: 'thirteenth_month.proration@2026-01-01',
  planRow: 3,
  status: 'commentary',
  confidence: 'commentary',
  cite: 'Payroll plan section 5 rows 3 & 11 and section 7 (commentary; pending accountant confirmation #2535): 13th-month bonus is prorated across 12 months, taxable in payment month, and excluded from compulsory insurance wage',
};

// ---------------------------------------------------------------------------------------------------------------------
// Pure Gregorian calendar date arithmetic (zero JS Date rollover bugs)
// ---------------------------------------------------------------------------------------------------------------------

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInCalendarMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

/** Parses an ISO `YYYY-MM-DD` string using strict Gregorian calendar bounds; returns `null` for e.g. `2026-02-30`. */
export function parseIsoCalendarDate(value: string): CalendarDate | null {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return null;
  const maxDay = daysInCalendarMonth(year, month);
  if (day < 1 || day > maxDay) return null;
  return { year, month, day };
}

export function isValidCalendarDate(value: string): boolean {
  return parseIsoCalendarDate(value) !== null;
}

/** Howard Hinnant civil-to-days algorithm: days since 1970-01-01 without `Date`. */
function toCivilDayNumber(date: CalendarDate): number {
  const y = date.year - (date.month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (date.month + (date.month > 2 ? -3 : 9)) + 2) / 5) + date.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse Howard Hinnant days-to-civil conversion without `Date`. */
function civilFromDayNumber(daysSinceEpoch: number): CalendarDate {
  const shifted = daysSinceEpoch + 719468;
  const era = Math.floor((shifted >= 0 ? shifted : shifted - 146096) / 146097);
  const doe = shifted - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = y + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  return civilFromDayNumber(toCivilDayNumber(date) + days);
}

export function formatIsoCalendarDate(date: CalendarDate): string {
  const year = String(date.year).padStart(4, '0');
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function diffCalendarDays(from: CalendarDate, to: CalendarDate): number {
  return toCivilDayNumber(to) - toCivilDayNumber(from);
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return diffCalendarDays(b, a);
}

export function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
  const totalMonths = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const day = Math.min(date.day, daysInCalendarMonth(year, month));
  return { year, month, day };
}

export function deriveFixedTermEndDate(start: CalendarDate, termMonths: number): CalendarDate {
  return addCalendarDays(addCalendarMonths(start, termMonths), -1);
}

/** Derives the inclusive end date (`YYYY-MM-DD`) for a 1..36 month fixed-term contract starting on `startDate`. */
export function deriveFixedTermEndDateIso(startDate: string, termMonths: number): string | null {
  const start = parseIsoCalendarDate(startDate);
  if (start === null || !Number.isInteger(termMonths) || termMonths < 1 || termMonths > FIXED_TERM_MAX_MONTHS) {
    return null;
  }
  return formatIsoCalendarDate(deriveFixedTermEndDate(start, termMonths));
}

function requireIsoCalendarDate(label: string, value: string): CalendarDate {
  const parsed = parseIsoCalendarDate(value);
  if (parsed === null) throw new Error(`Invalid ${label} calendar date: ${value}`);
  return parsed;
}

function formatWholeDong(value: DecimalValue): Money {
  const rounded = value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return rounded.isZero() ? '0' : rounded.toFixed();
}

function parseNonNegativeMoney(label: string, raw: string): DecimalValue {
  let parsed: DecimalValue;
  try {
    if (raw.trim() === '') throw new Error('empty');
    parsed = money(raw);
  } catch {
    throw new Error(`Invalid decimal amount for ${label}: ${raw}`);
  }
  if (parsed.isNegative()) throw new Error(`Amount for ${label} cannot be negative: ${raw}`);
  return parsed;
}

function requireNonNegativeInteger(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Expected non-negative integer for ${label}: ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Contract & probation validation and expiry alerts (Labor Code 2019 Arts. 14, 20, 24-27, 35, 36)
// ---------------------------------------------------------------------------------------------------------------------

export const LABOR_CONTRACT_KINDS = ['indefinite', 'fixed_term', 'under_one_month'] as const;
export type LaborContractKind = (typeof LABOR_CONTRACT_KINDS)[number];

export const REJECTED_LEGACY_CONTRACT_KINDS = ['seasonal', 'seasonal_or_task', 'task_based', 'thoi_vu', 'vu_viec'] as const;

export const LABOR_CONTRACT_FORMS = ['written', 'electronic', 'oral'] as const;
export type LaborContractForm = (typeof LABOR_CONTRACT_FORMS)[number];

export const PROBATION_ROLE_TIERS = ['enterprise_manager', 'college_or_above', 'intermediate_technical', 'other'] as const;
export type ProbationRoleTier = (typeof PROBATION_ROLE_TIERS)[number];

export const PROBATION_DAY_UNITS = ['calendar_days', 'working_days'] as const;
export type ProbationDayUnit = (typeof PROBATION_DAY_UNITS)[number];

export const FIXED_TERM_MAX_MONTHS = 36;
export const FIXED_TERM_MAX_SEQUENCE = 2;
export const PROBATION_MIN_WAGE_PERCENT = '85';

export const PROBATION_CAPS: Readonly<Record<ProbationRoleTier, { maxDays: number; unit: ProbationDayUnit; cite: string }>> = {
  enterprise_manager: { maxDays: 180, unit: 'calendar_days', cite: 'Labor Code 2019 Art. 25(1)' },
  college_or_above: { maxDays: 60, unit: 'calendar_days', cite: 'Labor Code 2019 Art. 25(2)' },
  intermediate_technical: { maxDays: 30, unit: 'calendar_days', cite: 'Labor Code 2019 Art. 25(3)' },
  other: { maxDays: 6, unit: 'working_days', cite: 'Labor Code 2019 Art. 25(4)' },
};

export function isLaborContractKind(value: string): value is LaborContractKind {
  return (LABOR_CONTRACT_KINDS as readonly string[]).includes(value);
}

export type ContractKindValidation =
  | { ok: true; kind: LaborContractKind }
  | { ok: false; code: 'seasonal_contract_abolished' | 'unsupported_contract_kind'; message: string };

/** Rejects abolished seasonal/task-based contract types (Labor Code 2019 Art. 20) and unrecognized kinds cleanly. */
export function validateLaborContractKind(value: string): ContractKindValidation {
  if (isLaborContractKind(value)) return { ok: true, kind: value };
  const normalized = value.trim().toLowerCase();
  if ((REJECTED_LEGACY_CONTRACT_KINDS as readonly string[]).includes(normalized) || normalized.includes('seasonal') || normalized.includes('task')) {
    return {
      ok: false,
      code: 'seasonal_contract_abolished',
      message: `Contract kind "${value}" is abolished under Labor Code 2019 Art. 20; use "indefinite", "fixed_term", or "under_one_month".`,
    };
  }
  return {
    ok: false,
    code: 'unsupported_contract_kind',
    message: `Unsupported contract kind "${value}"; expected "indefinite", "fixed_term", or "under_one_month".`,
  };
}

export interface ProbationTermsInput {
  roleTier: ProbationRoleTier | (string & {});
  startDate?: string | null;
  endDate?: string | null;
  /** Duration in the tier's unit (calendar days for manager/college/intermediate; working days for `other`). */
  durationDays?: number | null;
  wage?: Money | null;
}

export interface LaborContractTermsInput {
  contractKind: LaborContractKind | (string & {});
  form?: LaborContractForm | (string & {});
  startDate: string;
  endDate?: string | null;
  termMonths?: number | null;
  /** 1 for initial fixed-term contract, 2 for the sole permitted renewal; > 2 violates Art. 20(2). */
  fixedTermSequence?: number | null;
  contractWage?: Money | null;
  probation?: ProbationTermsInput | null;
}

export type LaborContractFindingSeverity = 'error' | 'warning';

export type LaborContractFindingCode =
  | 'seasonal_contract_abolished'
  | 'unsupported_contract_kind'
  | 'invalid_contract_form'
  | 'oral_contract_not_allowed'
  | 'invalid_date'
  | 'contract_end_before_start'
  | 'missing_fixed_term_duration'
  | 'invalid_fixed_term_duration'
  | 'fixed_term_duration_mismatch'
  | 'fixed_term_exceeds_36_months'
  | 'indefinite_has_term_months'
  | 'indefinite_has_end_date'
  | 'missing_under_one_month_duration'
  | 'under_one_month_exceeds_limit'
  | 'invalid_fixed_term_sequence'
  | 'must_convert_to_indefinite'
  | 'final_fixed_term_renewal'
  | 'probation_not_allowed_under_one_month'
  | 'unknown_probation_role_tier'
  | 'probation_end_before_start'
  | 'invalid_probation_duration'
  | 'probation_duration_mismatch'
  | 'probation_exceeds_cap'
  | 'probation_working_days_unverified'
  | 'probation_outside_contract'
  | 'invalid_wage'
  | 'missing_contract_wage_for_probation'
  | 'probation_wage_below_85_percent';

export interface LaborContractFinding {
  code: LaborContractFindingCode;
  severity: LaborContractFindingSeverity;
  field: string;
  message: string;
  cite: string;
}

export interface LaborContractCheckResult {
  ok: boolean;
  findings: LaborContractFinding[];
  rulesUsed: readonly LaborRuleRef[];
}

function isProbationRoleTier(value: string): value is ProbationRoleTier {
  return (PROBATION_ROLE_TIERS as readonly string[]).includes(value);
}

function isLaborContractForm(value: string): value is LaborContractForm {
  return (LABOR_CONTRACT_FORMS as readonly string[]).includes(value);
}

function exceedsOneMonthSpan(start: CalendarDate, end: CalendarDate): boolean {
  // Inclusive [start, end] reaches 1 calendar month once end >= (start + 1 month) - 1 day
  // (e.g. 2026-01-01..2026-01-31, 2026-01-15..2026-02-14, 2026-02-01..2026-02-28).
  return compareCalendarDates(end, deriveFixedTermEndDate(start, 1)) >= 0;
}

function checkRenewalSequence(fixedTermSequence: number | null | undefined, findings: LaborContractFinding[]): void {
  if (fixedTermSequence === undefined || fixedTermSequence === null) return;
  if (!Number.isInteger(fixedTermSequence) || fixedTermSequence < 1) {
    findings.push({
      code: 'invalid_fixed_term_sequence',
      severity: 'error',
      field: 'fixedTermSequence',
      message: 'fixedTermSequence must be a positive integer (1 for initial contract, 2 for first renewal).',
      cite: 'Labor Code 2019 Art. 20(2)',
    });
  } else if (fixedTermSequence > FIXED_TERM_MAX_SEQUENCE) {
    findings.push({
      code: 'must_convert_to_indefinite',
      severity: 'error',
      field: 'fixedTermSequence',
      message: 'A definite-term contract may be renewed at most once; subsequent renewal must convert to an indefinite-term contract.',
      cite: 'Labor Code 2019 Art. 20(2)',
    });
  } else if (fixedTermSequence === FIXED_TERM_MAX_SEQUENCE) {
    findings.push({
      code: 'final_fixed_term_renewal',
      severity: 'warning',
      field: 'fixedTermSequence',
      message: 'This is the second definite-term contract (final permitted renewal); any further continuation converts to indefinite term.',
      cite: 'Labor Code 2019 Art. 20(2)',
    });
  }
}

function checkFixedTermEndMatchesMonths(
  startDate: CalendarDate,
  endDate: CalendarDate,
  termMonths: number,
): string | null {
  const expectedEnd = deriveFixedTermEndDate(startDate, termMonths);
  return compareCalendarDates(endDate, expectedEnd) === 0 ? null : formatIsoCalendarDate(expectedEnd);
}

function checkCalendarProbationMatchesDays(
  startDate: CalendarDate,
  endDate: CalendarDate,
  durationDays: number,
): string | null {
  const expectedEnd = addCalendarDays(startDate, durationDays - 1);
  return compareCalendarDates(endDate, expectedEnd) === 0 ? null : formatIsoCalendarDate(expectedEnd);
}

function checkKindSpecificTerms(
  terms: LaborContractTermsInput,
  contractKind: LaborContractKind,
  parsedStart: CalendarDate | null,
  parsedEnd: CalendarDate | null,
  findings: LaborContractFinding[],
): void {
  if (contractKind === 'fixed_term') {
    const hasValidTermMonths =
      terms.termMonths !== undefined &&
      terms.termMonths !== null &&
      Number.isInteger(terms.termMonths) &&
      terms.termMonths >= 1 &&
      terms.termMonths <= FIXED_TERM_MAX_MONTHS;

    if (terms.termMonths !== undefined && terms.termMonths !== null) {
      if (!Number.isInteger(terms.termMonths) || terms.termMonths < 1) {
        findings.push({
          code: 'invalid_fixed_term_duration',
          severity: 'error',
          field: 'termMonths',
          message: 'Fixed-term contract duration must be a positive integer number of months (1 to 36).',
          cite: 'Labor Code 2019 Art. 20(1)(b)',
        });
      } else if (terms.termMonths > FIXED_TERM_MAX_MONTHS) {
        findings.push({
          code: 'fixed_term_exceeds_36_months',
          severity: 'error',
          field: 'termMonths',
          message: `Fixed-term contract duration (${terms.termMonths} months) exceeds the 36-month statutory cap.`,
          cite: 'Labor Code 2019 Art. 20(1)(b)',
        });
      }
    } else if (terms.endDate === undefined || terms.endDate === null) {
      findings.push({
        code: 'missing_fixed_term_duration',
        severity: 'error',
        field: 'termMonths',
        message: 'Fixed-term contract requires either termMonths (1 to 36) or an endDate.',
        cite: 'Labor Code 2019 Art. 20(1)(b)',
      });
    }

    if (parsedStart && parsedEnd) {
      if (compareCalendarDates(parsedEnd, deriveFixedTermEndDate(parsedStart, FIXED_TERM_MAX_MONTHS)) > 0) {
        findings.push({
          code: 'fixed_term_exceeds_36_months',
          severity: 'error',
          field: 'endDate',
          message: 'Fixed-term contract endDate exceeds 36 inclusive months from startDate.',
          cite: 'Labor Code 2019 Art. 20(1)(b)',
        });
      }
      if (hasValidTermMonths && diffCalendarDays(parsedStart, parsedEnd) >= 0) {
        const expectedEndIso = checkFixedTermEndMatchesMonths(parsedStart, parsedEnd, terms.termMonths as number);
        if (expectedEndIso !== null) {
          findings.push({
            code: 'fixed_term_duration_mismatch',
            severity: 'error',
            field: 'endDate',
            message: `Fixed-term contract endDate (${terms.endDate}) does not match termMonths (${terms.termMonths}; expected ${expectedEndIso}).`,
            cite: 'Labor Code 2019 Art. 20(1)(b)',
          });
        }
      }
    }

    checkRenewalSequence(terms.fixedTermSequence, findings);
    return;
  }

  if (contractKind === 'indefinite') {
    if (terms.termMonths !== undefined && terms.termMonths !== null) {
      findings.push({
        code: 'indefinite_has_term_months',
        severity: 'error',
        field: 'termMonths',
        message: 'An indefinite-term contract must not specify termMonths.',
        cite: 'Labor Code 2019 Art. 20(1)(a)',
      });
    }
    if (terms.endDate !== undefined && terms.endDate !== null) {
      findings.push({
        code: 'indefinite_has_end_date',
        severity: 'error',
        field: 'endDate',
        message: 'An indefinite-term contract must not specify endDate.',
        cite: 'Labor Code 2019 Art. 20(1)(a)',
      });
    }
    return;
  }

  // under_one_month (still an Art. 20(1)(b) definite-term contract subject to Art. 20(2) renewal limits)
  const hasTermMonths = terms.termMonths !== undefined && terms.termMonths !== null;
  const hasEndDate = terms.endDate !== undefined && terms.endDate !== null;
  if (!hasEndDate) {
    findings.push({
      code: 'missing_under_one_month_duration',
      severity: 'error',
      field: 'endDate',
      message: 'An under-one-month contract requires endDate to verify duration and track expiry alerts.',
      cite: 'Labor Code 2019 Art. 14(2) & Art. 20(1)(b)',
    });
  }
  if (hasTermMonths) {
    if (typeof terms.termMonths !== 'number' || !Number.isFinite(terms.termMonths) || terms.termMonths <= 0 || terms.termMonths >= 1) {
      findings.push({
        code: 'under_one_month_exceeds_limit',
        severity: 'error',
        field: 'termMonths',
        message: 'An under-one-month contract must have duration strictly below 1 month.',
        cite: 'Labor Code 2019 Art. 14(2) & Art. 24(3)',
      });
    }
  }
  if (parsedStart && parsedEnd && exceedsOneMonthSpan(parsedStart, parsedEnd)) {
    findings.push({
      code: 'under_one_month_exceeds_limit',
      severity: 'error',
      field: 'endDate',
      message: 'Contract dates span 1 month or more; use a fixed_term contract.',
      cite: 'Labor Code 2019 Art. 14(2) & Art. 20(1)(b)',
    });
  }
  checkRenewalSequence(terms.fixedTermSequence, findings);
}

function isEffectiveDurationUnderOneMonth(
  contractKind: LaborContractKind | null,
  termMonths: number | null | undefined,
  parsedStart: CalendarDate | null,
  effectiveEnd: CalendarDate | null,
): boolean {
  if (contractKind === 'under_one_month') return true;
  if (contractKind !== 'fixed_term') return false;
  if (parsedStart && effectiveEnd && diffCalendarDays(parsedStart, effectiveEnd) >= 0 && !exceedsOneMonthSpan(parsedStart, effectiveEnd)) {
    return true;
  }
  return typeof termMonths === 'number' && Number.isFinite(termMonths) && termMonths > 0 && termMonths < 1;
}

function checkProbationTerms(
  probation: ProbationTermsInput,
  contractKind: LaborContractKind | null,
  contractTermMonths: number | null | undefined,
  parsedContractStart: CalendarDate | null,
  parsedContractEnd: CalendarDate | null,
  jobWage: DecimalValue | null,
  hasContractWageField: boolean,
  findings: LaborContractFinding[],
): void {
  if (isEffectiveDurationUnderOneMonth(contractKind, contractTermMonths, parsedContractStart, parsedContractEnd)) {
    findings.push({
      code: 'probation_not_allowed_under_one_month',
      severity: 'error',
      field: 'probation',
      message: 'Probation is prohibited on labor contracts with a term under 1 month.',
      cite: 'Labor Code 2019 Art. 24(3)',
    });
  }

  const tier = isProbationRoleTier(probation.roleTier) ? probation.roleTier : null;
  if (tier === null) {
    findings.push({
      code: 'unknown_probation_role_tier',
      severity: 'error',
      field: 'probation.roleTier',
      message: `Unknown probation roleTier "${probation.roleTier}".`,
      cite: 'Labor Code 2019 Art. 25',
    });
  }

  let pStart: CalendarDate | null = null;
  let pEnd: CalendarDate | null = null;
  if (probation.startDate !== undefined && probation.startDate !== null) {
    pStart = parseIsoCalendarDate(probation.startDate);
    if (pStart === null) {
      findings.push({
        code: 'invalid_date',
        severity: 'error',
        field: 'probation.startDate',
        message: `Invalid calendar date for probation.startDate: ${probation.startDate}`,
        cite: 'Labor Code 2019 Art. 24',
      });
    }
  }
  if (probation.endDate !== undefined && probation.endDate !== null) {
    pEnd = parseIsoCalendarDate(probation.endDate);
    if (pEnd === null) {
      findings.push({
        code: 'invalid_date',
        severity: 'error',
        field: 'probation.endDate',
        message: `Invalid calendar date for probation.endDate: ${probation.endDate}`,
        cite: 'Labor Code 2019 Art. 24',
      });
    }
  }
  if (pStart && pEnd && diffCalendarDays(pStart, pEnd) < 0) {
    findings.push({
      code: 'probation_end_before_start',
      severity: 'error',
      field: 'probation.endDate',
      message: 'Probation endDate cannot be earlier than probation startDate.',
      cite: 'Labor Code 2019 Art. 25',
    });
  }
  const capForEffectiveEnd = tier !== null ? PROBATION_CAPS[tier] : null;
  const effectiveProbEnd =
    pEnd !== null
      ? pEnd
      : pStart !== null &&
          capForEffectiveEnd?.unit === 'calendar_days' &&
          probation.durationDays !== undefined &&
          probation.durationDays !== null &&
          Number.isInteger(probation.durationDays) &&
          probation.durationDays >= 1
        ? addCalendarDays(pStart, probation.durationDays - 1)
        : null;
  if ((pStart && parsedContractStart && compareCalendarDates(pStart, parsedContractStart) < 0) || (effectiveProbEnd && parsedContractEnd && compareCalendarDates(effectiveProbEnd, parsedContractEnd) > 0)) {
    findings.push({
      code: 'probation_outside_contract',
      severity: 'warning',
      field: 'probation',
      message: 'Probation dates extend outside the labor contract start/end dates.',
      cite: 'Labor Code 2019 Art. 24',
    });
  }

  if (probation.durationDays !== undefined && probation.durationDays !== null) {
    if (!Number.isInteger(probation.durationDays) || probation.durationDays < 1) {
      findings.push({
        code: 'invalid_probation_duration',
        severity: 'error',
        field: 'probation.durationDays',
        message: 'Probation durationDays must be a positive integer.',
        cite: 'Labor Code 2019 Art. 25',
      });
    } else if (tier !== null) {
      const cap = PROBATION_CAPS[tier];
      if (probation.durationDays > cap.maxDays) {
        findings.push({
          code: 'probation_exceeds_cap',
          severity: 'error',
          field: 'probation.durationDays',
          message: `Probation duration (${probation.durationDays} ${cap.unit === 'calendar_days' ? 'calendar' : 'working'} days) exceeds the ${cap.maxDays}-day limit for ${tier}.`,
          cite: cap.cite,
        });
      }
    }
  }

  if (tier !== null && pStart && pEnd && diffCalendarDays(pStart, pEnd) >= 0) {
    const cap = PROBATION_CAPS[tier];
    const inclusiveDays = diffCalendarDays(pStart, pEnd) + 1;
    const hasValidDurationDays =
      probation.durationDays !== undefined &&
      probation.durationDays !== null &&
      Number.isInteger(probation.durationDays) &&
      probation.durationDays >= 1;

    if (cap.unit === 'calendar_days') {
      if (inclusiveDays > cap.maxDays) {
        findings.push({
          code: 'probation_exceeds_cap',
          severity: 'error',
          field: 'probation.endDate',
          message: `Probation span (${inclusiveDays} calendar days) exceeds the ${cap.maxDays}-calendar-day limit for ${tier}.`,
          cite: cap.cite,
        });
      }
      if (hasValidDurationDays) {
        const expectedProbEndIso = checkCalendarProbationMatchesDays(pStart, pEnd, probation.durationDays as number);
        if (expectedProbEndIso !== null) {
          findings.push({
            code: 'probation_duration_mismatch',
            severity: 'error',
            field: 'probation.endDate',
            message: `Probation endDate (${probation.endDate}) does not match durationDays (${probation.durationDays}; expected ${expectedProbEndIso}).`,
            cite: cap.cite,
          });
        }
      }
    } else if (hasValidDurationDays && inclusiveDays < (probation.durationDays as number)) {
      findings.push({
        code: 'probation_duration_mismatch',
        severity: 'error',
        field: 'probation.endDate',
        message: `Probation span (${inclusiveDays} calendar day(s)) cannot contain ${probation.durationDays} working day(s).`,
        cite: cap.cite,
      });
    } else if (cap.unit === 'working_days' && inclusiveDays > cap.maxDays && (probation.durationDays === undefined || probation.durationDays === null)) {
      findings.push({
        code: 'probation_working_days_unverified',
        severity: 'warning',
        field: 'probation.durationDays',
        message: `Probation span covers ${inclusiveDays} calendar days for tier "other" (cap 6 working days); provide durationDays to verify working-day count.`,
        cite: cap.cite,
      });
    }
  }

  if (probation.wage !== undefined && probation.wage !== null) {
    let probWage: DecimalValue | null = null;
    try {
      probWage = parseNonNegativeMoney('probation.wage', probation.wage);
    } catch {
      findings.push({
        code: 'invalid_wage',
        severity: 'error',
        field: 'probation.wage',
        message: `Invalid probation wage: ${probation.wage}`,
        cite: 'Labor Code 2019 Art. 26',
      });
    }
    if (probWage !== null) {
      if (!hasContractWageField) {
        findings.push({
          code: 'missing_contract_wage_for_probation',
          severity: 'error',
          field: 'contractWage',
          message: 'contractWage is required to verify the 85% probation wage floor.',
          cite: 'Labor Code 2019 Art. 26',
        });
      } else if (jobWage !== null && probWage.times(100).lessThan(jobWage.times(PROBATION_MIN_WAGE_PERCENT))) {
        const minProbWage = jobWage.times(PROBATION_MIN_WAGE_PERCENT).dividedBy(100).toFixed();
        findings.push({
          code: 'probation_wage_below_85_percent',
          severity: 'error',
          field: 'probation.wage',
          message: `Probation wage (${probWage.toFixed()}) is below 85% of contractual job wage (minimum ${minProbWage}).`,
          cite: 'Labor Code 2019 Art. 26',
        });
      }
    }
  }
}

/** Validates labor contract and probation terms against Labor Code 2019 Arts. 14, 20, 24-27. */
export function checkLaborContractTerms(terms: LaborContractTermsInput): LaborContractCheckResult {
  const findings: LaborContractFinding[] = [];

  const kindCheck = validateLaborContractKind(terms.contractKind);
  const validKind = kindCheck.ok ? kindCheck.kind : null;
  if (!kindCheck.ok) {
    findings.push({
      code: kindCheck.code,
      severity: 'error',
      field: 'contractKind',
      message: kindCheck.message,
      cite: 'Labor Code 2019 Art. 20',
    });
  }

  const parsedStart = parseIsoCalendarDate(terms.startDate);
  if (parsedStart === null) {
    findings.push({
      code: 'invalid_date',
      severity: 'error',
      field: 'startDate',
      message: `Invalid calendar date for startDate: ${terms.startDate}`,
      cite: 'Labor Code 2019 Art. 21',
    });
  }

  let parsedEnd: CalendarDate | null = null;
  if (terms.endDate !== undefined && terms.endDate !== null) {
    parsedEnd = parseIsoCalendarDate(terms.endDate);
    if (parsedEnd === null) {
      findings.push({
        code: 'invalid_date',
        severity: 'error',
        field: 'endDate',
        message: `Invalid calendar date for endDate: ${terms.endDate}`,
        cite: 'Labor Code 2019 Art. 21',
      });
    } else if (parsedStart && diffCalendarDays(parsedStart, parsedEnd) < 0) {
      findings.push({
        code: 'contract_end_before_start',
        severity: 'error',
        field: 'endDate',
        message: 'Contract endDate cannot be earlier than startDate.',
        cite: 'Labor Code 2019 Art. 20',
      });
    }
  }

  const derivedEnd =
    parsedEnd === null &&
    validKind === 'fixed_term' &&
    parsedStart !== null &&
    terms.termMonths !== undefined &&
    terms.termMonths !== null &&
    Number.isInteger(terms.termMonths) &&
    terms.termMonths >= 1
      ? deriveFixedTermEndDate(parsedStart, terms.termMonths)
      : parsedEnd;

  const form = terms.form ?? 'written';
  if (!isLaborContractForm(form)) {
    findings.push({
      code: 'invalid_contract_form',
      severity: 'error',
      field: 'form',
      message: `Invalid contract form "${form}"; expected "written", "electronic", or "oral".`,
      cite: 'Labor Code 2019 Art. 14',
    });
  } else if (form === 'oral' && !isEffectiveDurationUnderOneMonth(validKind, terms.termMonths, parsedStart, derivedEnd)) {
    findings.push({
      code: 'oral_contract_not_allowed',
      severity: 'error',
      field: 'form',
      message: 'Oral labor contracts are only allowed for contracts with a term under 1 month.',
      cite: 'Labor Code 2019 Art. 14(2)',
    });
  }

  let jobWage: DecimalValue | null = null;
  const hasContractWageField = terms.contractWage !== undefined && terms.contractWage !== null;
  if (hasContractWageField) {
    try {
      jobWage = parseNonNegativeMoney('contractWage', terms.contractWage as Money);
    } catch {
      findings.push({
        code: 'invalid_wage',
        severity: 'error',
        field: 'contractWage',
        message: `Invalid contractWage: ${String(terms.contractWage)}`,
        cite: 'Labor Code 2019 Art. 21',
      });
    }
  }

  if (validKind !== null) {
    checkKindSpecificTerms(terms, validKind, parsedStart, parsedEnd, findings);
  }

  if (terms.probation !== undefined && terms.probation !== null) {
    checkProbationTerms(terms.probation, validKind, terms.termMonths, parsedStart, derivedEnd, jobWage, hasContractWageField, findings);
  }

  return {
    ok: findings.every((f) => f.severity !== 'error'),
    findings,
    rulesUsed: [RULE_CONTRACT_TERMS],
  };
}

export type ContractAlertCode =
  | 'contract_expired'
  | 'contract_expiring_soon'
  | 'probation_ending_soon'
  | 'final_fixed_term_renewal'
  | 'must_convert_to_indefinite';

export interface ContractAlert {
  code: ContractAlertCode;
  severity: 'error' | 'warning';
  targetDate: string | null;
  daysRemaining: number | null;
  message: string;
  cite: string;
}

export interface EvaluateContractAlertsOptions {
  asOf: string;
  noticeDays?: number;
}

export interface ContractAlertsResult {
  asOf: string;
  noticeDays: number;
  alerts: ContractAlert[];
  rulesUsed: readonly LaborRuleRef[];
}

const ALERT_ORDER: Readonly<Record<ContractAlertCode, number>> = {
  contract_expired: 0,
  must_convert_to_indefinite: 1,
  contract_expiring_soon: 2,
  probation_ending_soon: 3,
  final_fixed_term_renewal: 4,
};

/** Evaluates deterministic contract expiry, probation end, and renewal ceiling alerts as of a calendar date. */
export function evaluateContractAlerts(terms: LaborContractTermsInput, options: EvaluateContractAlertsOptions): ContractAlertsResult {
  const asOfDate = requireIsoCalendarDate('asOf', options.asOf);
  const noticeDays = options.noticeDays ?? 30;
  requireNonNegativeInteger('noticeDays', noticeDays);

  const kindCheck = validateLaborContractKind(terms.contractKind);
  if (!kindCheck.ok) throw new Error(kindCheck.message);

  const startDate = requireIsoCalendarDate('startDate', terms.startDate);
  let endDate: CalendarDate | null = null;
  let endIso: string | null = null;
  if (terms.endDate !== undefined && terms.endDate !== null) {
    endDate = requireIsoCalendarDate('endDate', terms.endDate);
    endIso = terms.endDate;
    if (diffCalendarDays(startDate, endDate) < 0) {
      throw new Error(`Contract endDate (${terms.endDate}) cannot be earlier than startDate (${terms.startDate})`);
    }
  }
  if (kindCheck.kind === 'fixed_term' && terms.termMonths !== undefined && terms.termMonths !== null) {
    if (!Number.isInteger(terms.termMonths) || terms.termMonths < 1 || terms.termMonths > FIXED_TERM_MAX_MONTHS) {
      throw new Error(`Invalid fixed_term termMonths: ${String(terms.termMonths)}`);
    }
    if (endDate !== null) {
      const expectedEndIso = checkFixedTermEndMatchesMonths(startDate, endDate, terms.termMonths);
      if (expectedEndIso !== null) {
        throw new Error(
          `Fixed-term contract endDate (${terms.endDate}) does not match termMonths (${terms.termMonths}; expected ${expectedEndIso})`,
        );
      }
    } else {
      endDate = deriveFixedTermEndDate(startDate, terms.termMonths);
      endIso = formatIsoCalendarDate(endDate);
    }
  }

  const probStart =
    terms.probation?.startDate !== undefined && terms.probation.startDate !== null
      ? requireIsoCalendarDate('probation.startDate', terms.probation.startDate)
      : null;
  let probEnd =
    terms.probation?.endDate !== undefined && terms.probation.endDate !== null
      ? requireIsoCalendarDate('probation.endDate', terms.probation.endDate)
      : null;
  let probEndIso: string | null = terms.probation?.endDate ?? null;
  if (probStart && probEnd && diffCalendarDays(probStart, probEnd) < 0) {
    throw new Error(`Probation endDate (${terms.probation?.endDate}) cannot be earlier than startDate (${terms.probation?.startDate})`);
  }
  if (
    probStart !== null &&
    terms.probation?.durationDays !== undefined &&
    terms.probation.durationDays !== null &&
    isProbationRoleTier(terms.probation.roleTier)
  ) {
    if (!Number.isInteger(terms.probation.durationDays) || terms.probation.durationDays < 1) {
      throw new Error(`Invalid probation.durationDays: ${String(terms.probation.durationDays)}`);
    }
    const probCap = PROBATION_CAPS[terms.probation.roleTier];
    if (probCap.unit === 'calendar_days') {
      if (probEnd !== null) {
        const expectedProbEndIso = checkCalendarProbationMatchesDays(probStart, probEnd, terms.probation.durationDays);
        if (expectedProbEndIso !== null) {
          throw new Error(
            `Probation endDate (${terms.probation.endDate}) does not match durationDays (${terms.probation.durationDays}; expected ${expectedProbEndIso})`,
          );
        }
      } else {
        probEnd = addCalendarDays(probStart, terms.probation.durationDays - 1);
        probEndIso = formatIsoCalendarDate(probEnd);
      }
    } else if (probEnd !== null && diffCalendarDays(probStart, probEnd) + 1 < terms.probation.durationDays) {
      throw new Error(
        `Probation span (${diffCalendarDays(probStart, probEnd) + 1} calendar day(s)) cannot contain ${terms.probation.durationDays} working day(s)`,
      );
    }
  }

  const alerts: ContractAlert[] = [];
  const contractDaysRemaining = endDate ? diffCalendarDays(asOfDate, endDate) : null;

  if (endDate && endIso && contractDaysRemaining !== null && kindCheck.kind !== 'indefinite') {
    if (contractDaysRemaining < 0) {
      alerts.push({
        code: 'contract_expired',
        severity: 'error',
        targetDate: endIso,
        daysRemaining: contractDaysRemaining,
        message: `Contract expired ${Math.abs(contractDaysRemaining)} day(s) ago on ${endIso}; renew or conclude within 30 days under Art. 20(2).`,
        cite: 'Labor Code 2019 Art. 20(2) & Art. 34(1)',
      });
    } else if (contractDaysRemaining <= noticeDays) {
      alerts.push({
        code: 'contract_expiring_soon',
        severity: 'warning',
        targetDate: endIso,
        daysRemaining: contractDaysRemaining,
        message: `Contract expires in ${contractDaysRemaining} day(s) on ${endIso}.`,
        cite: 'Labor Code 2019 Art. 20(2) & Art. 35/36',
      });
    }
  }

  if (probEnd && probEndIso) {
    const probDaysRemaining = diffCalendarDays(asOfDate, probEnd);
    if (probDaysRemaining >= 0 && probDaysRemaining <= noticeDays) {
      alerts.push({
        code: 'probation_ending_soon',
        severity: 'warning',
        targetDate: probEndIso,
        daysRemaining: probDaysRemaining,
        message: `Probation ends in ${probDaysRemaining} day(s) on ${probEndIso}; notify the result under Art. 27.`,
        cite: 'Labor Code 2019 Art. 27',
      });
    }
  }

  if (kindCheck.kind !== 'indefinite' && terms.fixedTermSequence !== undefined && terms.fixedTermSequence !== null) {
    if (!Number.isInteger(terms.fixedTermSequence) || terms.fixedTermSequence < 1) {
      throw new Error(`Invalid fixedTermSequence: ${String(terms.fixedTermSequence)}`);
    }
    if (terms.fixedTermSequence > FIXED_TERM_MAX_SEQUENCE) {
      alerts.push({
        code: 'must_convert_to_indefinite',
        severity: 'error',
        targetDate: endIso,
        daysRemaining: contractDaysRemaining,
        message: 'Definite-term renewal ceiling exceeded; this contract must be converted to an indefinite-term contract.',
        cite: 'Labor Code 2019 Art. 20(2)',
      });
    } else if (terms.fixedTermSequence === FIXED_TERM_MAX_SEQUENCE) {
      alerts.push({
        code: 'final_fixed_term_renewal',
        severity: 'warning',
        targetDate: endIso,
        daysRemaining: contractDaysRemaining,
        message: 'Contract is on its second (final) definite-term renewal; the next renewal must be indefinite term.',
        cite: 'Labor Code 2019 Art. 20(2)',
      });
    }
  }

  alerts.sort((a, b) => ALERT_ORDER[a.code] - ALERT_ORDER[b.code]);

  return {
    asOf: options.asOf,
    noticeDays,
    alerts,
    rulesUsed: [RULE_CONTRACT_TERMS],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Statutory severance allowance (Labor Code 2019 Art. 46 & Decree 145/2020/ND-CP Art. 8; plan rows 13 & 17)
// ---------------------------------------------------------------------------------------------------------------------

export const SEVERANCE_TERMINATION_REASONS = [
  'contract_expired',
  'task_completed',
  'mutual_agreement',
  'lawful_unilateral',
  'other_eligible',
  'retirement_pension',
  'disciplinary_dismissal',
  'unlawful_resignation',
  'job_loss_redundancy',
] as const;
export type SeveranceTerminationReason = (typeof SEVERANCE_TERMINATION_REASONS)[number];

const INELIGIBLE_TERMINATION_REASONS = new Set<SeveranceTerminationReason>([
  'retirement_pension',
  'disciplinary_dismissal',
  'unlawful_resignation',
  'job_loss_redundancy',
]);

export type SeveranceIneligibleReason =
  | 'worked_under_12_months'
  | 'retirement_pension'
  | 'disciplinary_dismissal'
  | 'unlawful_resignation'
  | 'job_loss_redundancy';

export interface SeveranceAllowanceInput {
  totalWorkedMonths: number;
  unemploymentInsuredMonths?: number;
  priorSettledMonths?: number;
  /** Contractual salaries over the 6 consecutive months preceding termination. */
  sixMonthWages: readonly Money[];
  /** Optional actual amount paid by the employer, for PIT-exempt / taxable excess split. */
  paidAmount?: Money;
  terminationReason?: SeveranceTerminationReason;
}

export interface SeveranceAllowanceResult {
  eligible: boolean;
  reason: SeveranceIneligibleReason | null;
  qualifyingMonths: number;
  qualifyingYears: string;
  averageWage: Money;
  amount: Money;
  paidAmount: Money | null;
  pitExemptAmount: Money;
  taxableExcess: Money;
  rulesUsed: readonly LaborRuleRef[];
}

/** Counts completed calendar months in `[hireDate, endedOn]` inclusive (1 month = `(hireDate + 1 month) - 1 day`). */
export function countCompletedCalendarMonths(hireDateStr: string, endedOnStr: string): number {
  const start = requireIsoCalendarDate('hireDate', hireDateStr);
  const end = requireIsoCalendarDate('endedOn', endedOnStr);
  if (diffCalendarDays(start, end) < 0) return 0;
  const endPlusOne = addCalendarDays(end, 1);
  let months = Math.max(0, (end.year - start.year) * 12 + (end.month - start.month) + 1);
  while (months > 0 && compareCalendarDates(addCalendarMonths(start, months), endPlusOne) > 0) {
    months -= 1;
  }
  return months;
}

/** Rounds qualifying months to half-year / full-year units (`0` -> `0`, `1..6` -> `0.5`, `7..12` -> `1`, `> 12` similarly). */
export function roundSeveranceQualifyingYears(qualifyingMonths: number): string {
  requireNonNegativeInteger('qualifyingMonths', qualifyingMonths);
  if (qualifyingMonths === 0) return '0';
  if (qualifyingMonths <= 6) return '0.5';
  if (qualifyingMonths <= 12) return '1';
  const wholeYears = Math.floor(qualifyingMonths / 12);
  const remainder = qualifyingMonths % 12;
  if (remainder === 0) return String(wholeYears);
  if (remainder <= 6) return `${wholeYears}.5`;
  return String(wholeYears + 1);
}

interface PreparedTerminationAllowanceBase {
  totalWorkedMonths: number;
  rawQualifyingMonths: number;
  averageWageDecimal: DecimalValue;
  averageWage: Money;
  paidDecimal: DecimalValue | null;
  formattedPaid: Money | null;
}

function prepareTerminationAllowanceBase(input: {
  totalWorkedMonths: number;
  unemploymentInsuredMonths?: number;
  priorSettledMonths?: number;
  sixMonthWages: readonly Money[];
  paidAmount?: Money;
}): PreparedTerminationAllowanceBase {
  const totalWorkedMonths = requireNonNegativeInteger('totalWorkedMonths', input.totalWorkedMonths);
  const unemploymentInsuredMonths = requireNonNegativeInteger('unemploymentInsuredMonths', input.unemploymentInsuredMonths ?? 0);
  const priorSettledMonths = requireNonNegativeInteger('priorSettledMonths', input.priorSettledMonths ?? 0);

  if (totalWorkedMonths >= 6) {
    if (input.sixMonthWages.length !== 6) {
      throw new Error('sixMonthWages must contain all 6 consecutive prior monthly wages when totalWorkedMonths >= 6');
    }
  } else if (input.sixMonthWages.length === 0 || input.sixMonthWages.length > 6) {
    throw new Error('sixMonthWages must contain between 1 and 6 monthly wages when totalWorkedMonths < 6');
  }
  const parsedWages = input.sixMonthWages.map((wage, index) => parseNonNegativeMoney(`sixMonthWages[${index}]`, wage));
  const averageWageDecimal = sum(parsedWages).dividedBy(parsedWages.length);
  const averageWage = toMoney(averageWageDecimal);

  const paidDecimal = input.paidAmount !== undefined ? parseNonNegativeMoney('paidAmount', input.paidAmount) : null;
  const formattedPaid = paidDecimal === null ? null : toMoney(paidDecimal);
  const rawQualifyingMonths = Math.max(0, totalWorkedMonths - unemploymentInsuredMonths - priorSettledMonths);

  return {
    totalWorkedMonths,
    rawQualifyingMonths,
    averageWageDecimal,
    averageWage,
    paidDecimal,
    formattedPaid,
  };
}

function splitAllowancePit(
  statutoryDecimal: DecimalValue,
  paidDecimal: DecimalValue | null,
): { pitExemptAmount: Money; taxableExcess: Money } {
  const effectivePaid = paidDecimal ?? statutoryDecimal;
  const exemptDecimal = Decimal.min(effectivePaid, statutoryDecimal);
  const excessDecimal = Decimal.max(money(0), effectivePaid.minus(statutoryDecimal));
  return {
    pitExemptAmount: exemptDecimal.isZero() ? '0' : toMoney(exemptDecimal),
    taxableExcess: excessDecimal.isZero() ? '0' : toMoney(excessDecimal),
  };
}

/** Computes statutory severance allowance (trợ cấp thôi việc) under Labor Code 2019 Art. 46 and Decree 145 Art. 8. */
export function calculateSeveranceAllowance(input: SeveranceAllowanceInput): SeveranceAllowanceResult {
  const base = prepareTerminationAllowanceBase(input);
  const terminationReason = input.terminationReason ?? 'contract_expired';
  if (!(SEVERANCE_TERMINATION_REASONS as readonly string[]).includes(terminationReason)) {
    throw new Error(`Unknown terminationReason: ${terminationReason}`);
  }

  const rulesUsed: readonly LaborRuleRef[] = [RULE_SEVERANCE_LABOR_CODE, RULE_SEVERANCE_DECREE_145, RULE_SEVERANCE_PIT_EXEMPTION];

  let ineligibleReason: SeveranceIneligibleReason | null = null;
  if (INELIGIBLE_TERMINATION_REASONS.has(terminationReason)) {
    ineligibleReason = terminationReason as SeveranceIneligibleReason;
  } else if (base.totalWorkedMonths < 12) {
    ineligibleReason = 'worked_under_12_months';
  }

  if (ineligibleReason !== null) {
    return {
      eligible: false,
      reason: ineligibleReason,
      qualifyingMonths: base.rawQualifyingMonths,
      qualifyingYears: '0',
      averageWage: base.averageWage,
      amount: '0',
      paidAmount: base.formattedPaid,
      ...splitAllowancePit(money(0), base.paidDecimal),
      rulesUsed,
    };
  }

  const qualifyingYears = roundSeveranceQualifyingYears(base.rawQualifyingMonths);
  const statutoryDecimal = money('0.5').times(qualifyingYears).times(base.averageWageDecimal).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const amount = formatWholeDong(statutoryDecimal);

  return {
    eligible: true,
    reason: null,
    qualifyingMonths: base.rawQualifyingMonths,
    qualifyingYears,
    averageWage: base.averageWage,
    amount,
    paidAmount: base.formattedPaid,
    ...splitAllowancePit(statutoryDecimal, base.paidDecimal),
    rulesUsed,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2b. Statutory job-loss allowance (Labor Code 2019 Arts. 42, 43, 47 & Decree 145/2020/ND-CP Art. 8; plan row 17)
// ---------------------------------------------------------------------------------------------------------------------

export const JOB_LOSS_TERMINATION_REASONS = [
  'organizational_restructuring',
  'economic_reasons',
  'merger_division_transfer',
  'other_non_art42_art43',
] as const;
export type JobLossTerminationReason = (typeof JOB_LOSS_TERMINATION_REASONS)[number];

export type JobLossIneligibleReason = 'worked_under_12_months' | 'not_job_loss_reason';

export interface JobLossAllowanceInput {
  totalWorkedMonths: number;
  unemploymentInsuredMonths?: number;
  priorSettledMonths?: number;
  /** Contractual salaries over the 6 consecutive months preceding termination. */
  sixMonthWages: readonly Money[];
  /** Optional actual amount paid by the employer, for PIT-exempt / taxable excess split. */
  paidAmount?: Money;
  terminationReason?: JobLossTerminationReason;
}

export interface JobLossAllowanceResult {
  eligible: boolean;
  reason: JobLossIneligibleReason | null;
  qualifyingMonths: number;
  qualifyingYears: string;
  averageWage: Money;
  amount: Money;
  minimumFloorApplied: boolean;
  paidAmount: Money | null;
  pitExemptAmount: Money;
  taxableExcess: Money;
  rulesUsed: readonly LaborRuleRef[];
}

/** Computes statutory job-loss allowance (trợ cấp mất việc làm) under Labor Code 2019 Arts. 42, 43, 47 and Decree 145 Art. 8. */
export function calculateJobLossAllowance(input: JobLossAllowanceInput): JobLossAllowanceResult {
  const base = prepareTerminationAllowanceBase(input);
  const terminationReason = input.terminationReason ?? 'organizational_restructuring';
  if (!(JOB_LOSS_TERMINATION_REASONS as readonly string[]).includes(terminationReason)) {
    throw new Error(`Unknown terminationReason: ${terminationReason}`);
  }

  const rulesUsed: readonly LaborRuleRef[] = [RULE_JOB_LOSS_LABOR_CODE, RULE_JOB_LOSS_DECREE_145, RULE_SEVERANCE_PIT_EXEMPTION];

  let ineligibleReason: JobLossIneligibleReason | null = null;
  if (terminationReason === 'other_non_art42_art43') {
    ineligibleReason = 'not_job_loss_reason';
  } else if (base.totalWorkedMonths < 12) {
    ineligibleReason = 'worked_under_12_months';
  }

  if (ineligibleReason !== null) {
    return {
      eligible: false,
      reason: ineligibleReason,
      qualifyingMonths: base.rawQualifyingMonths,
      qualifyingYears: '0',
      averageWage: base.averageWage,
      amount: '0',
      minimumFloorApplied: false,
      paidAmount: base.formattedPaid,
      ...splitAllowancePit(money(0), base.paidDecimal),
      rulesUsed,
    };
  }

  const qualifyingYears = roundSeveranceQualifyingYears(base.rawQualifyingMonths);
  const rawAmount = formatWholeDong(money(qualifyingYears).times(base.averageWageDecimal));
  const twoMonthFloor = formatWholeDong(base.averageWageDecimal.times(2));
  const minimumFloorApplied = money(rawAmount).lessThan(twoMonthFloor);
  const amount = minimumFloorApplied ? twoMonthFloor : rawAmount;

  return {
    eligible: true,
    reason: null,
    qualifyingMonths: base.rawQualifyingMonths,
    qualifyingYears,
    averageWage: base.averageWage,
    amount,
    minimumFloorApplied,
    paidAmount: base.formattedPaid,
    ...splitAllowancePit(money(amount), base.paidDecimal),
    rulesUsed,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. 13th-month salary proration (plan section 7 & rows 3, 11)
// ---------------------------------------------------------------------------------------------------------------------

export type ThirteenthMonthInput =
  | { baseWage: Money; workedMonths: string | number }
  | { baseWage: Money; year: number; hireDate: string; endDate?: string | null; minDaysForMonth?: number };

export interface ThirteenthMonthResult {
  amount: Money;
  baseWage: Money;
  workedMonths: string;
  taxableInPaymentMonth: true;
  includedInCompulsoryInsurance: false;
  rulesUsed: readonly LaborRuleRef[];
}

function countWorkedMonthsInYear(year: number, hireDateStr: string, endDateStr: string | null | undefined, minDaysForMonth: number): number {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new Error(`Invalid year for 13th-month calculation: ${String(year)}`);
  }
  if (!Number.isInteger(minDaysForMonth) || minDaysForMonth < 1 || minDaysForMonth > 31) {
    throw new Error(`minDaysForMonth must be an integer between 1 and 31: ${String(minDaysForMonth)}`);
  }
  const hireDate = requireIsoCalendarDate('hireDate', hireDateStr);
  const endDate = endDateStr !== undefined && endDateStr !== null ? requireIsoCalendarDate('endDate', endDateStr) : null;
  if (endDate && diffCalendarDays(hireDate, endDate) < 0) {
    throw new Error(`endDate (${endDateStr}) cannot be earlier than hireDate (${hireDateStr})`);
  }

  let count = 0;
  for (let month = 1; month <= 12; month += 1) {
    const monthStart: CalendarDate = { year, month, day: 1 };
    const monthEnd: CalendarDate = { year, month, day: daysInCalendarMonth(year, month) };
    const activeStart = compareCalendarDates(hireDate, monthStart) > 0 ? hireDate : monthStart;
    const activeEnd = endDate && compareCalendarDates(endDate, monthEnd) < 0 ? endDate : monthEnd;
    if (compareCalendarDates(activeEnd, activeStart) < 0) continue;
    const activeDays = diffCalendarDays(activeStart, activeEnd) + 1;
    if (activeDays >= minDaysForMonth) count += 1;
  }
  return count;
}

/** Prorates 13th-month salary across 12 months, rounded half-up to integer VND. */
export function calculateThirteenthMonthSalary(input: ThirteenthMonthInput): ThirteenthMonthResult {
  const baseWageDecimal = parseNonNegativeMoney('baseWage', input.baseWage);
  const hasWorkedMonths = 'workedMonths' in input && input.workedMonths !== undefined;
  const hasDateRange = 'year' in input && input.year !== undefined;

  if (hasWorkedMonths && hasDateRange) {
    throw new Error('Provide either workedMonths or { year, hireDate, ... }, not both');
  }

  let workedMonthsDecimal: DecimalValue;
  if (hasWorkedMonths) {
    const raw = input.workedMonths;
    if (typeof raw === 'number' && !Number.isFinite(raw)) {
      throw new Error(`Invalid workedMonths: ${String(raw)}`);
    }
    workedMonthsDecimal = parseNonNegativeMoney('workedMonths', typeof raw === 'number' ? String(raw) : raw);
    if (workedMonthsDecimal.greaterThan(12)) {
      throw new Error(`workedMonths cannot exceed 12: ${workedMonthsDecimal.toFixed()}`);
    }
  } else if (hasDateRange) {
    const counted = countWorkedMonthsInYear(input.year, input.hireDate, input.endDate, input.minDaysForMonth ?? 15);
    workedMonthsDecimal = money(counted);
  } else {
    throw new Error('Either workedMonths or { year, hireDate } must be provided');
  }

  const prorated = baseWageDecimal.times(workedMonthsDecimal).dividedBy(12);
  const amount = formatWholeDong(prorated);

  return {
    amount,
    baseWage: toMoney(baseWageDecimal),
    workedMonths: workedMonthsDecimal.isZero() ? '0' : workedMonthsDecimal.toFixed(),
    taxableInPaymentMonth: true,
    includedInCompulsoryInsurance: false,
    rulesUsed: [RULE_THIRTEENTH_MONTH],
  };
}
