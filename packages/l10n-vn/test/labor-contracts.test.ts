// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  PROBATION_CAPS,
  calculateSeveranceAllowance,
  calculateThirteenthMonthSalary,
  checkLaborContractTerms,
  evaluateContractAlerts,
  isValidCalendarDate,
  parseIsoCalendarDate,
  roundSeveranceQualifyingYears,
  validateLaborContractKind,
} from '../src/index.ts';

describe('pure Gregorian calendar date validation', () => {
  it('accepts real calendar dates including leap years and rejects invalid dates like 2026-02-30', () => {
    expect(isValidCalendarDate('2026-02-28')).toBe(true);
    expect(isValidCalendarDate('2024-02-29')).toBe(true);
    expect(isValidCalendarDate('2000-02-29')).toBe(true);

    expect(isValidCalendarDate('2026-02-29')).toBe(false);
    expect(isValidCalendarDate('2026-02-30')).toBe(false);
    expect(isValidCalendarDate('2026-04-31')).toBe(false);
    expect(isValidCalendarDate('1900-02-29')).toBe(false);
    expect(isValidCalendarDate('2026-13-01')).toBe(false);
    expect(isValidCalendarDate('2026-00-10')).toBe(false);
    expect(isValidCalendarDate('0000-01-01')).toBe(false);
    expect(parseIsoCalendarDate('2026-02-30')).toBeNull();
  });
});

describe('checkLaborContractTerms (Labor Code 2019 Arts. 14, 20, 24-27)', () => {
  it('rejects abolished seasonal/task-based contracts cleanly', () => {
    expect(validateLaborContractKind('seasonal')).toMatchObject({ ok: false, code: 'seasonal_contract_abolished' });
    expect(validateLaborContractKind('seasonal_or_task')).toMatchObject({ ok: false, code: 'seasonal_contract_abolished' });
    expect(validateLaborContractKind('task_based')).toMatchObject({ ok: false, code: 'seasonal_contract_abolished' });
    expect(validateLaborContractKind('freelance')).toMatchObject({ ok: false, code: 'unsupported_contract_kind' });

    const check = checkLaborContractTerms({
      contractKind: 'seasonal',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
    expect(check.ok).toBe(false);
    expect(check.findings.map((f) => f.code)).toContain('seasonal_contract_abolished');
    expect(check.rulesUsed[0]?.confidence).toBe('primary');
  });

  it('allows oral form only for under_one_month and forbids probation on under_one_month', () => {
    const validOral = checkLaborContractTerms({
      contractKind: 'under_one_month',
      form: 'oral',
      startDate: '2026-08-01',
      endDate: '2026-08-20',
      contractWage: '8000000',
    });
    expect(validOral.ok).toBe(true);

    const invalidOral = checkLaborContractTerms({
      contractKind: 'fixed_term',
      form: 'oral',
      startDate: '2026-08-01',
      termMonths: 12,
      contractWage: '12000000',
    });
    expect(invalidOral.ok).toBe(false);
    expect(invalidOral.findings.map((f) => f.code)).toContain('oral_contract_not_allowed');

    const oneMonthContract = checkLaborContractTerms({
      contractKind: 'under_one_month',
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    expect(oneMonthContract.ok).toBe(false);
    expect(oneMonthContract.findings.map((f) => f.code)).toContain('under_one_month_exceeds_limit');

    const withProbation = checkLaborContractTerms({
      contractKind: 'under_one_month',
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      contractWage: '8000000',
      probation: { roleTier: 'other', durationDays: 3, wage: '7000000' },
    });
    expect(withProbation.ok).toBe(false);
    expect(withProbation.findings.map((f) => f.code)).toContain('probation_not_allowed_under_one_month');
  });

  it('enforces fixed_term 1..36 months and max 1 renewal (fixedTermSequence > 2 -> must_convert_to_indefinite)', () => {
    const validFirst = checkLaborContractTerms({
      contractKind: 'fixed_term',
      form: 'electronic',
      startDate: '2026-01-01',
      endDate: '2028-12-31',
      termMonths: 36,
      fixedTermSequence: 1,
      contractWage: '15000000',
    });
    expect(validFirst.ok).toBe(true);
    expect(validFirst.findings).toEqual([]);

    const secondRenewal = checkLaborContractTerms({
      contractKind: 'fixed_term',
      startDate: '2026-01-01',
      termMonths: 12,
      fixedTermSequence: 2,
    });
    expect(secondRenewal.ok).toBe(true);
    expect(secondRenewal.findings).toMatchObject([{ code: 'final_fixed_term_renewal', severity: 'warning' }]);

    const thirdFixed = checkLaborContractTerms({
      contractKind: 'fixed_term',
      startDate: '2026-01-01',
      termMonths: 12,
      fixedTermSequence: 3,
    });
    expect(thirdFixed.ok).toBe(false);
    expect(thirdFixed.findings.map((f) => f.code)).toContain('must_convert_to_indefinite');

    const over36 = checkLaborContractTerms({
      contractKind: 'fixed_term',
      startDate: '2026-01-01',
      endDate: '2029-01-02',
      termMonths: 37,
    });
    expect(over36.ok).toBe(false);
    expect(over36.findings.filter((f) => f.code === 'fixed_term_exceeds_36_months').length).toBeGreaterThanOrEqual(1);
  });

  it('enforces probation caps by role tier and exact 85% wage floor without float rounding', () => {
    expect(PROBATION_CAPS.enterprise_manager.maxDays).toBe(180);
    expect(PROBATION_CAPS.college_or_above.maxDays).toBe(60);
    expect(PROBATION_CAPS.intermediate_technical.maxDays).toBe(30);
    expect(PROBATION_CAPS.other).toMatchObject({ maxDays: 6, unit: 'working_days' });

    // 2026-01-01..2026-03-01 in non-leap 2026 is 31 + 28 + 1 = 60 calendar days (passes college_or_above).
    const collegeOk = checkLaborContractTerms({
      contractKind: 'fixed_term',
      startDate: '2026-01-01',
      termMonths: 12,
      contractWage: '10000001',
      probation: {
        roleTier: 'college_or_above',
        startDate: '2026-01-01',
        endDate: '2026-03-01',
        wage: '8500000.85',
      },
    });
    expect(collegeOk.ok).toBe(true);

    // 2026-01-01..2026-03-02 is 61 calendar days -> exceeds 60; wage 8500000 < 8500000.85 -> fails 85%.
    const collegeFail = checkLaborContractTerms({
      contractKind: 'fixed_term',
      startDate: '2026-01-01',
      termMonths: 12,
      contractWage: '10000001',
      probation: {
        roleTier: 'college_or_above',
        startDate: '2026-01-01',
        endDate: '2026-03-02',
        wage: '8500000',
      },
    });
    expect(collegeFail.ok).toBe(false);
    expect(collegeFail.findings.map((f) => f.code)).toEqual(['probation_exceeds_cap', 'probation_wage_below_85_percent']);

    const managerOk = checkLaborContractTerms({
      contractKind: 'indefinite',
      startDate: '2026-01-01',
      contractWage: '50000000',
      probation: { roleTier: 'enterprise_manager', durationDays: 180, wage: '42500000' },
    });
    expect(managerOk.ok).toBe(true);

    const managerTooLong = checkLaborContractTerms({
      contractKind: 'indefinite',
      startDate: '2026-01-01',
      contractWage: '50000000',
      probation: { roleTier: 'enterprise_manager', durationDays: 181, wage: '42500000' },
    });
    expect(managerTooLong.ok).toBe(false);
    expect(managerTooLong.findings.map((f) => f.code)).toContain('probation_exceeds_cap');

    const intermediateFail = checkLaborContractTerms({
      contractKind: 'indefinite',
      startDate: '2026-01-01',
      contractWage: '12000000',
      probation: { roleTier: 'intermediate_technical', startDate: '2026-01-01', endDate: '2026-01-31', wage: '10200000' },
    });
    expect(intermediateFail.ok).toBe(false);
    expect(intermediateFail.findings.map((f) => f.code)).toContain('probation_exceeds_cap');

    const otherOk = checkLaborContractTerms({
      contractKind: 'fixed_term',
      startDate: '2026-05-01',
      termMonths: 12,
      contractWage: '10000000',
      probation: { roleTier: 'other', durationDays: 6, wage: '8500000' },
    });
    expect(otherOk.ok).toBe(true);

    const otherFail = checkLaborContractTerms({
      contractKind: 'fixed_term',
      startDate: '2026-05-01',
      termMonths: 12,
      contractWage: '10000000',
      probation: { roleTier: 'other', durationDays: 7, wage: '8500000' },
    });
    expect(otherFail.ok).toBe(false);
    expect(otherFail.findings.map((f) => f.code)).toContain('probation_exceeds_cap');
  });

  it('rejects invalid calendar dates like 2026-02-30 inside contract terms', () => {
    const res = checkLaborContractTerms({
      contractKind: 'fixed_term',
      startDate: '2026-02-30',
      endDate: '2026-04-31',
      termMonths: 12,
    });
    expect(res.ok).toBe(false);
    expect(res.findings.filter((f) => f.code === 'invalid_date')).toHaveLength(2);
  });
});

describe('evaluateContractAlerts', () => {
  it('emits expiring soon, probation ending soon, and final fixed-term renewal alerts deterministically', () => {
    const terms = {
      contractKind: 'fixed_term' as const,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      termMonths: 12,
      fixedTermSequence: 2,
      probation: {
        roleTier: 'college_or_above' as const,
        startDate: '2026-01-01',
        endDate: '2026-02-28',
      },
    };

    const duringProbationEnd = evaluateContractAlerts(terms, { asOf: '2026-02-15' });
    expect(duringProbationEnd.alerts.map((a) => [a.code, a.daysRemaining])).toEqual([
      ['probation_ending_soon', 13],
      ['final_fixed_term_renewal', 319],
    ]);

    const expiringSoon = evaluateContractAlerts(terms, { asOf: '2026-12-01' });
    expect(expiringSoon.alerts.map((a) => [a.code, a.daysRemaining])).toEqual([
      ['contract_expiring_soon', 30],
      ['final_fixed_term_renewal', 30],
    ]);

    const customNotice = evaluateContractAlerts(terms, { asOf: '2026-12-01', noticeDays: 15 });
    expect(customNotice.alerts.map((a) => a.code)).toEqual(['final_fixed_term_renewal']);

    const expired = evaluateContractAlerts(terms, { asOf: '2027-01-05' });
    expect(expired.alerts.map((a) => [a.code, a.daysRemaining])).toEqual([
      ['contract_expired', -5],
      ['final_fixed_term_renewal', -5],
    ]);
  });

  it('fails cleanly on invalid ISO calendar dates such as 2026-02-30', () => {
    expect(() =>
      evaluateContractAlerts(
        { contractKind: 'fixed_term', startDate: '2026-01-01', endDate: '2026-12-31', termMonths: 12 },
        { asOf: '2026-02-30' },
      ),
    ).toThrow(/Invalid asOf calendar date/);

    expect(() =>
      evaluateContractAlerts(
        { contractKind: 'fixed_term', startDate: '2026-02-30', endDate: '2026-12-31', termMonths: 12 },
        { asOf: '2026-08-01' },
      ),
    ).toThrow(/Invalid startDate calendar date/);
  });
});

describe('calculateSeveranceAllowance (Labor Code 2019 Art. 46 & Decree 145 Art. 8)', () => {
  it('applies half-year rounding accurately across all month boundaries', () => {
    expect(roundSeveranceQualifyingYears(0)).toBe('0');
    expect(roundSeveranceQualifyingYears(1)).toBe('0.5');
    expect(roundSeveranceQualifyingYears(6)).toBe('0.5');
    expect(roundSeveranceQualifyingYears(7)).toBe('1');
    expect(roundSeveranceQualifyingYears(12)).toBe('1');
    expect(roundSeveranceQualifyingYears(13)).toBe('1.5');
    expect(roundSeveranceQualifyingYears(18)).toBe('1.5');
    expect(roundSeveranceQualifyingYears(19)).toBe('2');
    expect(roundSeveranceQualifyingYears(23)).toBe('2');
    expect(roundSeveranceQualifyingYears(24)).toBe('2');
    expect(roundSeveranceQualifyingYears(25)).toBe('2.5');
  });

  it('returns ineligible when totalWorkedMonths < 12 or termination reason is excluded', () => {
    const under12 = calculateSeveranceAllowance({
      totalWorkedMonths: 11,
      sixMonthWages: ['10000000', '10000000', '10000000', '10000000', '10000000', '10000000'],
      paidAmount: '5000000',
    });
    expect(under12).toMatchObject({
      eligible: false,
      reason: 'worked_under_12_months',
      qualifyingYears: '0',
      amount: '0',
      pitExemptAmount: '0',
      taxableExcess: '5000000',
    });

    const dismissed = calculateSeveranceAllowance({
      totalWorkedMonths: 36,
      sixMonthWages: ['12000000', '12000000', '12000000', '12000000', '12000000', '12000000'],
      terminationReason: 'disciplinary_dismissal',
    });
    expect(dismissed).toMatchObject({
      eligible: false,
      reason: 'disciplinary_dismissal',
      amount: '0',
      qualifyingYears: '0',
    });
  });

  it('computes qualifying months, ROUND_HALF_UP statutory amount, PIT exempt/excess split, and rulesUsed attribution', () => {
    // Worked 40 months, 20 BHTN months, 2 prior settled months -> 18 qualifying months -> 1.5 years.
    // Avg wage = (10M * 5 + 10,000,001) / 6 = 10,000,000.16666...
    // Statutory = 0.5 * 1.5 * 10,000,000.16666... = 7,500,000.125 -> 7500000.
    const res = calculateSeveranceAllowance({
      totalWorkedMonths: 40,
      unemploymentInsuredMonths: 20,
      priorSettledMonths: 2,
      sixMonthWages: ['10000000', '10000000', '10000000', '10000000', '10000000', '10000001'],
      paidAmount: '10000000',
    });
    expect(res.eligible).toBe(true);
    expect(res.qualifyingMonths).toBe(18);
    expect(res.qualifyingYears).toBe('1.5');
    expect(res.amount).toBe('7500000');
    expect(res.pitExemptAmount).toBe('7500000');
    expect(res.taxableExcess).toBe('2500000');
    expect(res.rulesUsed.map((r) => [r.id, r.confidence, r.status])).toEqual([
      ['severance.labor_code_art46@2021-01-01', 'primary', 'commentary'],
      ['severance.decree145_art8@2021-02-01', 'commentary', 'commentary'],
      ['severance.pit_exemption@2026-01-01', 'commentary', 'commentary'],
    ]);
    expect(res.rulesUsed.some((r) => r.cite.includes('#2535'))).toBe(true);

    // Paying less than statutory keeps full paid amount exempt and taxableExcess = 0.
    const underPaid = calculateSeveranceAllowance({
      totalWorkedMonths: 24,
      unemploymentInsuredMonths: 0,
      sixMonthWages: ['10000000', '10000000', '10000000', '10000000', '10000000', '10000000'],
      paidAmount: '6000000',
    });
    expect(underPaid.amount).toBe('10000000');
    expect(underPaid.pitExemptAmount).toBe('6000000');
    expect(underPaid.taxableExcess).toBe('0');

    // Worked >= 12 months but fully covered by unemployment insurance -> eligible with 0 amount.
    const allInsured = calculateSeveranceAllowance({
      totalWorkedMonths: 24,
      unemploymentInsuredMonths: 24,
      sixMonthWages: ['10000000'],
    });
    expect(allInsured).toMatchObject({
      eligible: true,
      qualifyingMonths: 0,
      qualifyingYears: '0',
      amount: '0',
      pitExemptAmount: '0',
      taxableExcess: '0',
    });
  });

  it('rejects invalid month counts or empty wages', () => {
    expect(() =>
      calculateSeveranceAllowance({ totalWorkedMonths: -1, sixMonthWages: ['10000000'] }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      calculateSeveranceAllowance({ totalWorkedMonths: 12.5, sixMonthWages: ['10000000'] }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      calculateSeveranceAllowance({ totalWorkedMonths: 12, sixMonthWages: [] }),
    ).toThrow(/at least one/);
  });
});

describe('calculateThirteenthMonthSalary (plan section 7 & rows 3, 11)', () => {
  it('prorates explicit workedMonths with ROUND_HALF_UP and sets tax/insurance flags', () => {
    const full = calculateThirteenthMonthSalary({ baseWage: '18000000', workedMonths: 12 });
    expect(full).toMatchObject({
      amount: '18000000',
      workedMonths: '12',
      taxableInPaymentMonth: true,
      includedInCompulsoryInsurance: false,
    });
    expect(full.rulesUsed[0]).toMatchObject({ planRow: 3, status: 'commentary' });
    expect(full.rulesUsed[0]?.cite).toContain('#2535');

    // 10,000,002 * 6.5 / 12 = 5,416,667.75 -> 5416668 (ROUND_HALF_UP); check exact .5 case: 10000002 * 1 / 12 = 833333.5 -> 833334.
    const halfUp = calculateThirteenthMonthSalary({ baseWage: '10000002', workedMonths: '1' });
    expect(halfUp.amount).toBe('833334');

    const fractional = calculateThirteenthMonthSalary({ baseWage: '12000000', workedMonths: '6.5' });
    expect(fractional.amount).toBe('6500000');
  });

  it('counts calendar months in year meeting minDaysForMonth (default 15)', () => {
    // 2026-01-17..2026-01-31 = 15 days -> Jan counts (12 months).
    const jan15Days = calculateThirteenthMonthSalary({ baseWage: '24000000', year: 2026, hireDate: '2026-01-17' });
    expect(jan15Days.workedMonths).toBe('12');
    expect(jan15Days.amount).toBe('24000000');

    // 2026-01-18..2026-01-31 = 14 days -> Jan skipped (11 months).
    const jan14Days = calculateThirteenthMonthSalary({ baseWage: '24000000', year: 2026, hireDate: '2026-01-18' });
    expect(jan14Days.workedMonths).toBe('11');
    expect(jan14Days.amount).toBe('22000000');

    // Leap-year February 2024 has 29 days: 2024-02-15..2024-02-29 = 15 days -> Feb counts!
    const leapFeb = calculateThirteenthMonthSalary({
      baseWage: '12000000',
      year: 2024,
      hireDate: '2024-02-15',
      endDate: '2024-06-14',
    });
    // Feb (15), Mar (31), Apr (30), May (31) = 4 months; Jun 1..14 = 14 days (skipped).
    expect(leapFeb.workedMonths).toBe('4');
    expect(leapFeb.amount).toBe('4000000');

    // Custom minDaysForMonth = 20.
    const customThreshold = calculateThirteenthMonthSalary({
      baseWage: '12000000',
      year: 2026,
      hireDate: '2026-01-15',
      minDaysForMonth: 20,
    });
    // Jan 15..31 = 17 days (< 20), Feb..Dec = 11 months.
    expect(customThreshold.workedMonths).toBe('11');
  });

  it('rejects invalid dates and out-of-range inputs', () => {
    expect(() =>
      calculateThirteenthMonthSalary({ baseWage: '12000000', year: 2026, hireDate: '2026-02-30' }),
    ).toThrow(/Invalid hireDate calendar date/);
    expect(() =>
      calculateThirteenthMonthSalary({ baseWage: '12000000', year: 2026, hireDate: '2026-06-01', endDate: '2026-05-31' }),
    ).toThrow(/cannot be earlier than hireDate/);
    expect(() =>
      calculateThirteenthMonthSalary({ baseWage: '12000000', workedMonths: '13' }),
    ).toThrow(/cannot exceed 12/);
  });
});
