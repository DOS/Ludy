// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for Stage 6B finance.payroll_flag anomalies (large salary advances & retro/offset adjustments),
// pseudonymization (E1..En), promptLeaks protection, and AI-off parity (#4527).
import { describe, expect, it } from 'vitest';
import {
  diffFactsText,
  explainFactsText,
  findAnomalies,
  payrollFiguresOf,
  promptLeaks,
  pseudonymizePayrollDiff,
  pseudonymizeSheet,
  restoreAliases,
  type PayrollFigures,
  type PayrollSheetLine,
} from '../src/index.ts';

const zero = (): PayrollFigures => ({
  base_wage: '0',
  allowances: '0',
  other_regular_pay: '0',
  overtime: '0',
  night_work: '0',
  bonus: '0',
  unpaid_reduction: '0',
  sickness_bhxh_reduction: '0',
  maternity_bhxh_reduction: '0',
  gross: '0',
  employee_insurance: '0',
  pit: '0',
  deductions: '0',
  net: '0',
});

const quiet = {
  minimumWageFailed: false,
  deductionCapFailed: false,
  overtimeCapFailed: false,
  netBelowMinimum: false,
  insuredAboveCap: false,
  cashPaymentOverLimit: false,
  annualLeaveExceeded: false,
};
const calm = { startsInMonth: false, probationEndsInMonth: false, endsInMonth: false, severanceCheckSuggested: false };

function makeLine(id: string, over: Partial<PayrollSheetLine> = {}): PayrollSheetLine {
  return {
    employeeId: id,
    figures: { ...zero(), base_wage: '10000000', gross: '10000000', net: '8950000' },
    previous: { ...zero(), base_wage: '10000000', gross: '10000000', net: '8950000' },
    contract: calm,
    overtimeMonthsInRow: 0,
    dependentsWithoutRegistration: 0,
    checks: quiet,
    ...over,
  };
}

describe('payroll-coworker Stage 6B large advance & adjustment anomalies (#4527)', () => {
  it('flags large salary advances and large retro/offset adjustments deterministically without leaking names or free text', () => {
    const raw = {
      ...makeLine('emp-1', {
        advanceAmount: '6000000',
        retroPayAmount: '2500000',
        offsetDeductionAmount: '1000000',
        checks: { ...quiet, largeSalaryAdvance: true, largePayrollAdjustment: true },
      }),
      employeeName: 'Nguyễn Văn Bí Mật',
      reason: 'Private emergency loan note',
    } as PayrollSheetLine;

    const { sheet, aliases } = pseudonymizeSheet([raw], { language: 'vi', blockingRules: 0, random: () => 0 });
    const serialized = JSON.stringify(sheet);
    expect(serialized).not.toContain('Nguyễn Văn Bí Mật');
    expect(serialized).not.toContain('Private emergency loan note');
    expect(serialized).not.toContain('emp-1');

    const anomalies = findAnomalies(sheet);
    const kinds = anomalies.map((a) => a.kind);
    expect(kinds).toContain('large_salary_advance');
    expect(kinds).toContain('large_payroll_adjustment');

    for (const item of anomalies) {
      expect(promptLeaks(item.facts, ['Nguyễn Văn Bí Mật', 'Private emergency loan note'])).toEqual([]);
      expect(item.facts).toContain('E1');
      const restored = restoreAliases(item.facts, new Map([['E1', 'Nguyễn Văn Bí Mật']]));
      expect(restored).toContain('Nguyễn Văn Bí Mật');
    }
    expect(aliases.get('E1')).toBe('emp-1');
  });

  it('produces English facts deterministically with exact numbers matching base wage and adjustment totals', () => {
    const { sheet } = pseudonymizeSheet(
      [
        makeLine('emp-2', {
          advanceAmount: '7000000',
          retroPayAmount: '4000000',
          offsetDeductionAmount: '500000',
          checks: { ...quiet, largeSalaryAdvance: true, largePayrollAdjustment: true },
        }),
      ],
      { language: 'en', blockingRules: 0, random: () => 0 },
    );

    const anomalies = findAnomalies(sheet);
    const adv = anomalies.find((a) => a.kind === 'large_salary_advance');
    const adj = anomalies.find((a) => a.kind === 'large_payroll_adjustment');
    expect(adv?.facts).toContain('E1');
    expect(adv?.facts).toContain('7,000,000');
    expect(adv?.facts).toContain('10,000,000');
    expect(adj?.facts).toContain('4,500,000');
    expect(adj?.facts).toContain('10,000,000');
  });

  it('extracts retroPay into payrollFiguresOf and formats retro_pay / offset_deduction in explain & diff facts (#4597)', () => {
    const figures = payrollFiguresOf(
      { gross: '11300000', employeeInsurance: '1050000', pit: '0', net: '10050000' },
      {
        pay: {
          baseWage: '10000000',
          allowances: [],
          otherRegularPay: '0',
          overtime: [],
          nightWork: '0',
          bonus: '500000',
          retroPay: '800000',
          unpaidReduction: '0',
          sicknessBhxhReduction: '0',
          maternityBhxhReduction: '0',
          gross: '11300000',
        },
        insurance: { employee: { total: '1050000' } },
        pit: { tax: '0' },
        deductions: { total: '200000' },
        net: '10050000',
      },
    );
    expect(figures.bonus).toBe('500000');
    expect(figures.retro_pay).toBe('800000');

    const viExplain = explainFactsText({ language: 'vi', figures, dependentsCounted: 0 });
    expect(viExplain).toContain('Truy lĩnh: 800.000');
    expect(viExplain).toContain('Thưởng: 500.000');

    const enExplain = explainFactsText({ language: 'en', figures, dependentsCounted: 0 });
    expect(enExplain).toContain('Retro pay: 800,000');
    expect(enExplain).toContain('Bonus: 500,000');

    const { sheet: viDiff } = pseudonymizePayrollDiff(
      {
        language: 'vi',
        hasPrior: true,
        headcount: 1,
        priorHeadcount: 1,
        headcountDelta: 0,
        grossDelta: '800000',
        employeeDeductionDelta: '200000',
        netDelta: '600000',
        employerStatutoryDelta: '0',
        employerCostDelta: '800000',
        rows: [
          {
            employeeId: 'emp-1',
            reasons: ['retro_pay', 'offset_deduction'],
            grossDelta: '800000',
            employeeDeductionDelta: '200000',
            netDelta: '600000',
            employerStatutoryDelta: '0',
            employerCostDelta: '800000',
            priorLeaveDays: '0',
            currentLeaveDays: '0',
            hasRefused: false,
            hasFlags: false,
          },
        ],
      },
      { random: () => 0 },
    );
    const viDiffText = diffFactsText(viDiff);
    expect(viDiffText).toContain('truy lĩnh');
    expect(viDiffText).toContain('bù trừ hoặc truy thu');

    const enDiffText = diffFactsText({ ...viDiff, language: 'en' });
    expect(enDiffText).toContain('retroactive pay');
    expect(enDiffText).toContain('offset deduction');
  });
});
