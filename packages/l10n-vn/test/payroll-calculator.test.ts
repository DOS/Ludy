// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  PAY_BASES,
  PAYROLL_RULES,
  PayrollRefusedError,
  calculatePayroll,
  defineRule,
  evaluateForeignInsuranceEligibility,
  listRulesUsed,
  sum,
  type PayBasis,
  type PayrollCalculation,
  type PayrollEmployment,
  type PayrollMonthInputs,
  type PayrollRule,
} from '../src/index.ts';

// Golden tests of the payroll calculator (#2529) from invented people: no real name, amount or identifier. Every figure
// was worked by hand from the rules of docs/plan/payroll.md section 5 (and the overtime case by a separate script), not
// read back from the calculator. The accountant's worked examples (#2535) come in their own block at the end.

const employment = (over: Partial<PayrollEmployment> = {}): PayrollEmployment => ({
  region: 'I',
  contract: 'indefinite',
  contractTermMonths: null,
  resident: true,
  insured: true,
  baseWage: '20000000',
  allowances: [],
  ...over,
});

const month = (value: string, over: Partial<PayrollMonthInputs> = {}): PayrollMonthInputs => ({ month: value, standardWorkingDays: '26', ...over });

// The figures a pay sheet shows for the person.
const sheet = (c: PayrollCalculation) => ({
  gross: c.gross,
  employeeInsurance: c.employeeInsurance,
  employerInsurance: c.employerInsurance,
  unionFee: c.unionFee,
  pit: c.pit,
  net: c.net,
  employerCost: c.employerCost,
});

const fund = (c: PayrollCalculation, name: string) => c.breakdown.insurance.funds.find((f) => f.fund === name);

describe('an employee on 20 million with no dependents (August 2026)', () => {
  const c = calculatePayroll(employment(), month('2026-08'));

  it('pays insurance by fund and the tax of the first bracket', () => {
    // Employee 8% + 1% + 1.5% = 2,100,000; employer 14 + 3 + 0.5 + 1 + 3 = 21.5% = 4,300,000; union fee 2% = 400,000.
    // Taxable 20,000,000 - 2,100,000 - 15,500,000 = 2,400,000 at 5% = 120,000.
    expect(sheet(c)).toEqual({ gross: '20000000', employeeInsurance: '2100000', employerInsurance: '4300000', unionFee: '400000', pit: '120000', net: '17780000', employerCost: '24700000' });
    expect(fund(c, 'retirement_death')).toEqual({ fund: 'retirement_death', wage: '20000000', employee: '1600000', employer: '2800000' });
    expect(fund(c, 'unemployment')).toEqual({ fund: 'unemployment', wage: '20000000', employee: '200000', employer: '200000' });
    expect(c.breakdown.tax).toMatchObject({ mode: 'progressive', taxableIncome: '20000000', assessableIncome: '2400000', personalDeduction: '15500000' });
    expect(c.breakdown.tax.slices).toEqual([{ from: '0', to: '10000000', percent: '5', taxed: '2400000', tax: '120000' }]);
  });

  it('lists the rules it used, all still commentary', () => {
    expect(c.rulesUsed.map((r) => r.id)).toEqual([
      'insurance_rate.health@2025-07-01',
      'insurance_rate.retirement_death@2025-07-01',
      'insurance_rate.sickness_maternity@2025-07-01',
      'insurance_rate.unemployment@2026-01-01',
      'insurance_rate.work_accident@2025-07-01',
      'insurance_suspension.unpaid_leave@2025-07-01',
      'insurance_wage_bounds.social@2025-07-01',
      'insurance_wage_bounds.unemployment@2026-01-01',
      'minimum_wage.I@2026-01-01',
      'pit_brackets.resident_monthly@2026-01-01',
      'pit_deduction.personal@2026-01-01',
      'pit_withholding.no_or_short_contract@2026-01-01',
      'reference_level.default@2026-07-01',
      'union_fee.employer@2025-07-01',
    ]);
    const used = listRulesUsed([c]);
    expect(used.blocksApproval).toBe(true);
    expect(used.commentary).toHaveLength(used.used.length);
    expect(used.commentary.map((row) => row.source.cite).every((cite) => cite.length > 0)).toBe(true);
  });
});

describe('dependents', () => {
  it('takes 6.2 million off for each registered dependent, and the rest of the table applies above the cap', () => {
    // Base 60,000,000, one dependent. Social wage capped at 20 x 2,530,000 = 50,600,000; BHTN capped at 20 x 5,310,000 = 106,200,000, so on 60,000,000.
    // Employee: 8% x 50.6M 4,048,000 + 1.5% x 50.6M 759,000 + 1% x 60M 600,000 = 5,407,000.
    // Assessable 60,000,000 - 5,407,000 - 15,500,000 - 6,200,000 = 32,893,000: 500,000 + 2,000,000 + 20% x 2,893,000 = 3,078,600.
    const c = calculatePayroll(employment({ baseWage: '60000000' }), month('2026-08', { dependents: [{ ownMonthlyIncome: '0' }] }));
    expect(sheet(c)).toEqual({ gross: '60000000', employeeInsurance: '5407000', employerInsurance: '10973000', unionFee: '1012000', pit: '3078600', net: '51514400', employerCost: '71985000' });
    expect(c.breakdown.tax).toMatchObject({ dependentsCounted: 1, dependentDeduction: '6200000', assessableIncome: '32893000' });
    expect(c.breakdown.tax.slices.map((s) => s.tax)).toEqual(['500000', '2000000', '578600']);
  });

  it('counts a dependent only while their own income is within the limit', () => {
    const c = calculatePayroll(employment({ baseWage: '40000000' }), month('2026-08', { dependents: [{ ownMonthlyIncome: '3000000' }, { ownMonthlyIncome: '3500000' }, { ownMonthlyIncome: '0' }] }));
    // Employee insurance 4,200,000; assessable 40,000,000 - 4,200,000 - 15,500,000 - 2 x 6,200,000 = 7,900,000 at 5% = 395,000.
    expect(c.breakdown.tax).toMatchObject({ dependentsCounted: 2, dependentDeduction: '12400000', assessableIncome: '7900000' });
    expect(c.pit).toBe('395000');
    expect(c.rulesUsed.map((r) => r.id)).toContain('pit_deduction.dependent_income_limit@2026-01-01');
  });

  it('pays no tax when the deductions exceed the income', () => {
    const c = calculatePayroll(employment({ baseWage: '12000000' }), month('2026-08', { dependents: [{ ownMonthlyIncome: '0' }] }));
    expect(c.pit).toBe('0');
    expect(c.breakdown.tax.assessableIncome).toBe('0');
    expect(c.breakdown.tax.slices).toEqual([]);
  });

  it('takes the voluntary pension off up to its cap', () => {
    const c = calculatePayroll(employment(), month('2026-08', { voluntaryPension: '5000000' }));
    // 20,000,000 - 2,100,000 - 15,500,000 - 3,000,000 (capped) = -600,000, so no tax.
    expect(c.breakdown.tax.pensionDeduction).toBe('3000000');
    expect(c.pit).toBe('0');
  });
});

describe('the insurance cap', () => {
  it('stops at the cap when the pay equals it', () => {
    // 20 x 2,530,000 = 50,600,000 for BHXH and BHYT; BHTN on 50,600,000 (cap 106,200,000). Employee 4,048,000 + 759,000 + 506,000 = 5,313,000.
    // Assessable 50,600,000 - 5,313,000 - 15,500,000 = 29,787,000: 500,000 + 10% x 19,787,000 = 2,478,700.
    const c = calculatePayroll(employment({ baseWage: '50600000' }), month('2026-08'));
    expect(c.breakdown.insurance.bounds.find((b) => b.base === 'social')).toEqual({ base: 'social', floor: '2530000', cap: '50600000', wage: '50600000' });
    expect(c.employeeInsurance).toBe('5313000');
    expect(c.pit).toBe('2478700');
    expect(c.net).toBe('42808300');
  });

  it('applies the BHTN cap of the region on the regional minimum wage, which moves on 2027-01-01', () => {
    // 120,000,000 in region I: BHXH and BHYT on 50,600,000 both years; BHTN capped at 20 x 5,310,000 = 106,200,000, then 20 x 5,700,000 = 114,000,000.
    const december = calculatePayroll(employment({ baseWage: '120000000' }), month('2026-12'));
    const january = calculatePayroll(employment({ baseWage: '120000000' }), month('2027-01'));
    expect(fund(december, 'unemployment')).toEqual({ fund: 'unemployment', wage: '106200000', employee: '1062000', employer: '1062000' });
    expect(fund(january, 'unemployment')).toEqual({ fund: 'unemployment', wage: '114000000', employee: '1140000', employer: '1140000' });
    expect(fund(january, 'retirement_death')?.wage).toBe('50600000');
    // January: assessable 120,000,000 - 5,947,000 - 15,500,000 = 98,553,000: 500,000 + 2,000,000 + 6,000,000 + 30% x 38,553,000 = 20,065,900.
    expect(january.pit).toBe('20065900');
    expect(january.net).toBe('93987100');
    expect(january.rulesUsed.map((r) => r.id)).toContain('minimum_wage.I@2027-01-01');
    expect(december.rulesUsed.map((r) => r.id)).toContain('minimum_wage.I@2026-01-01');
  });
});

describe('a change of the reference level between June and July 2026 on the same employee', () => {
  it('moves the cap of an employee above it', () => {
    const person = employment({ baseWage: '55000000' });
    const june = calculatePayroll(person, month('2026-06'));
    const july = calculatePayroll(person, month('2026-07'));
    // June: cap 20 x 2,340,000 = 46,800,000; employee 3,744,000 + 702,000 + 550,000 (BHTN on 55M). Employer 10,144,000, union fee 936,000.
    expect(june.breakdown.insurance.bounds.find((b) => b.base === 'social')?.cap).toBe('46800000');
    expect(june.employeeInsurance).toBe('4996000');
    expect(june.employerInsurance).toBe('10144000');
    expect(june.unionFee).toBe('936000');
    // July: cap 20 x 2,530,000 = 50,600,000; employee 4,048,000 + 759,000 + 550,000. Employer 10,923,000, union fee 1,012,000.
    expect(july.breakdown.insurance.bounds.find((b) => b.base === 'social')?.cap).toBe('50600000');
    expect(july.employeeInsurance).toBe('5357000');
    expect(july.employerInsurance).toBe('10923000');
    expect(july.unionFee).toBe('1012000');
    expect(june.rulesUsed.map((r) => r.id)).toContain('reference_level.default@2024-07-01');
    expect(july.rulesUsed.map((r) => r.id)).toContain('reference_level.default@2026-07-01');
    expect(june.rulesUsed.map((r) => r.id)).not.toContain('reference_level.default@2026-07-01');
  });

  it('moves the floor of an employee below it', () => {
    const person = employment({ region: 'IV', baseWage: '2400000' });
    const june = calculatePayroll(person, month('2026-06'));
    const july = calculatePayroll(person, month('2026-07'));
    // June: 2,400,000 is above the floor 2,340,000, so the pay itself is the wage: 10.5% = 252,000.
    expect(june.employeeInsurance).toBe('252000');
    // July: raised to the floor 2,530,000: 8% 202,400 + 1% 25,300 + 1.5% 37,950 = 265,650.
    expect(july.breakdown.insurance.bounds.find((b) => b.base === 'social')?.wage).toBe('2530000');
    expect(july.breakdown.insurance.bounds.find((b) => b.base === 'unemployment')?.wage).toBe('2530000');
    expect(july.employeeInsurance).toBe('265650');
    // A base wage under the regional minimum is reported, not hidden.
    expect(july.checks).toContainEqual({ id: 'minimum_wage', ok: false, actual: '2400000', limit: '3700000' });
  });
});

describe('an unpaid fortnight', () => {
  const person = employment({ baseWage: '12000000' });

  it('takes no insurance, no union fee and pays only the days worked in the month of 14 unpaid working days', () => {
    // 12,000,000 x 12 / 26 = 5,538,461.54, to the dong 5,538,462.
    const c = calculatePayroll(person, month('2026-08', { unpaidLeaveDays: '14' }));
    expect(sheet(c)).toEqual({ gross: '5538462', employeeInsurance: '0', employerInsurance: '0', unionFee: '0', pit: '0', net: '5538462', employerCost: '5538462' });
    expect(c.breakdown.insurance).toMatchObject({ suspended: 'unpaid_leave', funds: [], unionFee: '0' });
    expect(c.breakdown.pay.unpaidReduction).toBe('6461538');
  });

  it('still takes insurance, on the contract wage, at 13 unpaid days', () => {
    const c = calculatePayroll(person, month('2026-08', { unpaidLeaveDays: '13' }));
    expect(c.gross).toBe('6000000');
    expect(c.breakdown.insurance.suspended).toBeNull();
    expect(c.employeeInsurance).toBe('1260000');
    expect(c.unionFee).toBe('240000');
  });
});

describe('overtime and night work', () => {
  // Base 25,000,000 over 26 days of 8 hours: 120,192.3077 an hour.
  const c = calculatePayroll(
    employment({ baseWage: '25000000' }),
    month('2026-08', {
      overtime: [
        { dayKind: 'normal_day', night: false, hours: '10' },
        { dayKind: 'holiday', night: false, hours: '4' },
        { dayKind: 'normal_day', night: true, hours: '2' },
      ],
      nightHours: '6',
    }),
  );

  it('pays the rate of Labor Code Art. 98 on the hourly rate, to the dong', () => {
    expect(c.breakdown.pay.hourlyRate).toBe('120192.3077');
    // 10h x 150%, 4h x 300%, 2h night overtime x (150% + 30% + 20% x 150% = 210%); 6h of night work at the 30% premium.
    expect(c.breakdown.pay.overtime.map((l) => [l.multiple, l.pay])).toEqual([
      ['1.5', '1802885'],
      ['3', '1442308'],
      ['2.1', '504808'],
    ]);
    expect(c.breakdown.pay.nightWork).toEqual({ hours: '6', pay: '216346' });
    expect(c.gross).toBe('28966347');
  });

  it('exempts the premium over normal pay and the night premium from tax, and keeps overtime out of the insurance wage', () => {
    // Exempt: (1,802,885 - 1,201,923) + (1,442,308 - 480,769) + (504,808 - 240,385) + 216,346 = 2,043,270.
    expect(c.breakdown.tax).toMatchObject({ exemptOvertime: '1826924', exemptNightWork: '216346', taxableIncome: '26923077' });
    expect(c.breakdown.insurance.insurablePay).toBe('25000000');
    // Insurance 10.5% of 25,000,000 = 2,625,000; assessable 26,923,077 - 2,625,000 - 15,500,000 = 8,798,077 at 5% = 439,904.
    expect(c.employeeInsurance).toBe('2625000');
    expect(c.pit).toBe('439904');
    expect(c.net).toBe('25901443');
  });

  it('exempts the whole overtime pay under the other reading of the rule once a row says so', () => {
    const whole = withWholeOvertime();
    const d = calculatePayroll(employment({ baseWage: '25000000' }), month('2026-08', { overtime: [{ dayKind: 'normal_day', night: false, hours: '10' }] }), whole);
    expect(d.breakdown.tax.exemptOvertime).toBe('1802885');
    expect(d.rulesUsed.map((r) => r.id)).toContain('pit_overtime_exemption.default@2026-08-01');
  });
});

// The rule set with a later row that reads the overtime exemption as the whole pay: a rule change is a new dated row.
function withWholeOvertime(): PayrollRule[] {
  return [
    ...PAYROLL_RULES,
    defineRule({ kind: 'pit_overtime_exemption', key: 'default', effectiveFrom: '2026-08-01', status: 'confirmed', source: { cite: 'A test row: the accountant reads the whole overtime pay as exempt', confidence: 'primary' }, value: { mode: 'whole_pay' } }),
  ];
}

describe('overtime on a weekly rest day', () => {
  it('pays 200%, and 270% at night (200% + 30% + 20% of 200%)', () => {
    const c = calculatePayroll(employment({ baseWage: '25000000' }), month('2026-08', { overtime: [{ dayKind: 'weekly_rest_day', night: false, hours: '5' }, { dayKind: 'weekly_rest_day', night: true, hours: '2' }] }));
    expect(c.breakdown.pay.overtime.map((l) => [l.multiple, l.pay])).toEqual([
      ['2', '1201923'],
      ['2.7', '649038'],
    ]);
  });
});

describe('ordinary night work without overtime', () => {
  it('adds the 30% premium, exempts it, and lists the exemption row the month relied on', () => {
    const c = calculatePayroll(employment({ baseWage: '25000000' }), month('2026-08', { nightHours: '6' }));
    expect(c.breakdown.pay.nightWork).toEqual({ hours: '6', pay: '216346' });
    expect(c.gross).toBe('25216346');
    expect(c.taxableIncome).toBe('25000000');
    expect(c.rulesUsed.map((r) => r.id)).toContain('pit_overtime_exemption.default@2026-01-01');
  });
});

describe('the top of the PIT table', () => {
  it('taxes the part above 100 million at 35%', () => {
    // 150,000,000 in region I: employee 4,048,000 + 759,000 + 1,062,000 (BHTN capped at 106,200,000) = 5,869,000.
    // Assessable 150,000,000 - 5,869,000 - 15,500,000 = 128,631,000: 500,000 + 2,000,000 + 6,000,000 + 12,000,000 + 35% x 28,631,000 = 30,520,850.
    const c = calculatePayroll(employment({ baseWage: '150000000' }), month('2026-08'));
    expect(c.employeeInsurance).toBe('5869000');
    expect(c.breakdown.tax.slices.map((s) => s.tax)).toEqual(['500000', '2000000', '6000000', '12000000', '10020850']);
    expect(c.pit).toBe('30520850');
  });

  it('stays in the lower bracket when the assessable income is exactly on its edge', () => {
    // Not insured, so assessable = pay - 15,500,000: exactly 10,000,000 and exactly 30,000,000.
    const edge10 = calculatePayroll(employment({ insured: false, baseWage: '25500000' }), month('2026-08'));
    expect(edge10.breakdown.tax.assessableIncome).toBe('10000000');
    expect(edge10.breakdown.tax.slices.map((s) => s.percent)).toEqual(['5']);
    expect(edge10.pit).toBe('500000');
    const edge30 = calculatePayroll(employment({ insured: false, baseWage: '45500000' }), month('2026-08'));
    expect(edge30.breakdown.tax.slices.map((s) => s.percent)).toEqual(['5', '10']);
    expect(edge30.pit).toBe('2500000');
  });
});

describe('a mid-month hire', () => {
  it('pays the days worked and still takes insurance on the contract wage in the first month', () => {
    // Hired on the 16th: 10 of 26 days not employed. 10,000,000 x 16 / 26 = 6,153,846.15, to the dong 6,153,846.
    const c = calculatePayroll(employment({ region: 'II', baseWage: '10000000' }), month('2026-09', { daysNotEmployed: '10' }));
    expect(sheet(c)).toEqual({ gross: '6153846', employeeInsurance: '1050000', employerInsurance: '2150000', unionFee: '200000', pit: '0', net: '5103846', employerCost: '8503846' });
    expect(c.breakdown.insurance.suspended).toBeNull();
  });
});

describe('a bonus', () => {
  it('is taxed in the month and is not in the insurance wage', () => {
    // Base 18,000,000 + bonus 6,000,000, one dependent. Employee insurance 10.5% of 18,000,000 = 1,890,000.
    // Assessable 24,000,000 - 1,890,000 - 15,500,000 - 6,200,000 = 410,000 at 5% = 20,500.
    const c = calculatePayroll(employment({ baseWage: '18000000' }), month('2026-10', { bonus: '6000000', dependents: [{ ownMonthlyIncome: '0' }] }));
    expect(sheet(c)).toEqual({ gross: '24000000', employeeInsurance: '1890000', employerInsurance: '3870000', unionFee: '360000', pit: '20500', net: '22089500', employerCost: '28230000' });
    expect(c.breakdown.insurance.insurablePay).toBe('18000000');
  });
});

describe('allowances', () => {
  it('counts only the allowances named in the contract in the insurance wage and taxes the cash meal allowance above its cap', () => {
    // 20,000,000 + 5,000,000 position allowance (named) + 1,500,000 cash meal (not named). Insurable 25,000,000: employee 2,625,000.
    // Taxable 26,500,000 - 1,200,000 (meal cap) = 25,300,000; assessable 25,300,000 - 2,625,000 - 15,500,000 = 7,175,000 at 5% = 358,750.
    const c = calculatePayroll(
      employment({
        allowances: [
          { label: 'Position', amount: '5000000', type: 'other', namedInContract: true },
          { label: 'Meals', amount: '1500000', type: 'meal_cash', namedInContract: false },
        ],
      }),
      month('2026-08'),
    );
    expect(sheet(c)).toEqual({ gross: '26500000', employeeInsurance: '2625000', employerInsurance: '5375000', unionFee: '500000', pit: '358750', net: '23516250', employerCost: '32375000' });
    expect(c.breakdown.tax).toMatchObject({ exemptMealCash: '1200000', taxableIncome: '25300000' });
    expect(c.breakdown.pay.allowances).toEqual([
      { label: 'Position', paid: '5000000' },
      { label: 'Meals', paid: '1500000' },
    ]);
  });

  it('exempts a cash meal allowance below the cap in full', () => {
    const c = calculatePayroll(employment({ allowances: [{ label: 'Meals', amount: '1000000', type: 'meal_cash', namedInContract: false }] }), month('2026-08'));
    expect(c.breakdown.tax.exemptMealCash).toBe('1000000');
    expect(c.taxableIncome).toBe('20000000');
  });

  it('refuses a cash meal allowance in a month before the cap has a row, rather than guess it', () => {
    const input = employment({ allowances: [{ label: 'Meals', amount: '1500000', type: 'meal_cash', namedInContract: false }] });
    expect(() => calculatePayroll(input, month('2026-03'))).toThrow(/pit_meal_cash_cap/);
  });
});

describe('withholding at 10% on a payment', () => {
  const casual = (over: Partial<PayrollEmployment> = {}) => employment({ region: 'III', contract: 'none', insured: false, baseWage: '8000000', ...over });

  it('takes 10% of a payment of 5 million or more with no contract', () => {
    const c = calculatePayroll(casual(), month('2026-08'));
    expect(sheet(c)).toEqual({ gross: '8000000', employeeInsurance: '0', employerInsurance: '0', unionFee: '0', pit: '800000', net: '7200000', employerCost: '8000000' });
    expect(c.breakdown.tax).toMatchObject({ mode: 'flat', flatPercent: '10', slices: [] });
    expect(c.breakdown.insurance.suspended).toBe('not_insured');
  });

  it('takes the same on a fixed-term contract under 3 months, and the progressive table from 3 months', () => {
    expect(calculatePayroll(casual({ contract: 'fixed_term', contractTermMonths: 2 }), month('2026-08')).pit).toBe('800000');
    const threeMonths = calculatePayroll(casual({ contract: 'fixed_term', contractTermMonths: 3 }), month('2026-08'));
    expect(threeMonths.breakdown.tax.mode).toBe('progressive');
    expect(threeMonths.pit).toBe('0');
  });

  it('applies the threshold and the 10% to the whole payment of an insured short contract, insurance not deducted', () => {
    // 5,200,000 on a 2-month contract, insured: employee insurance 546,000 is taken from the net, not from the base of the 10%.
    const c = calculatePayroll(casual({ contract: 'fixed_term', contractTermMonths: 2, insured: true, baseWage: '5200000' }), month('2026-08'));
    expect(c.employeeInsurance).toBe('546000');
    expect(c.pit).toBe('520000');
    expect(c.net).toBe('4134000');
  });

  it('takes nothing below 5 million unless the person asks', () => {
    const below = calculatePayroll(casual({ baseWage: '4500000' }), month('2026-08'));
    expect(below.pit).toBe('0');
    expect(below.breakdown.tax.mode).toBe('below_threshold');
    expect(calculatePayroll(casual({ baseWage: '4500000' }), month('2026-08', { withholdingRequested: true })).pit).toBe('450000');
  });

  it('takes nothing with a commitment on file', () => {
    const c = calculatePayroll(casual({ commitment: true }), month('2026-08'));
    expect(c.pit).toBe('0');
    expect(c.breakdown.tax.mode).toBe('commitment');
  });
});

describe('the checks of the Labor Code', () => {
  const person = employment({ baseWage: '10000000' });

  it('allows deductions for damage up to 30% of the pay left after insurance and tax, and advances are not counted', () => {
    // Gross 10,000,000 - insurance 1,050,000 - tax 0 = 8,950,000; 30% = 2,685,000.
    const ok = calculatePayroll(person, month('2026-08', { deductions: [{ label: 'Damage', kind: 'damage', amount: '2685000' }, { label: 'Advance', kind: 'advance', amount: '5000000' }] }));
    expect(ok.checks).toContainEqual({ id: 'deduction_cap', ok: true, actual: '2685000', limit: '2685000' });
    expect(ok.net).toBe('1265000');
    expect(ok.breakdown.deductions).toEqual({ advance: '5000000', damage: '2685000', other: '0', total: '7685000' });
    const over = calculatePayroll(person, month('2026-08', { deductions: [{ label: 'Damage', kind: 'damage', amount: '2700000' }] }));
    expect(over.checks).toContainEqual({ id: 'deduction_cap', ok: false, actual: '2700000', limit: '2685000' });
  });

  it('checks the base wage against the regional minimum wage', () => {
    expect(calculatePayroll(person, month('2026-08')).checks).toEqual([{ id: 'minimum_wage', ok: true, actual: '10000000', limit: '5310000' }]);
  });
});

describe('refusals', () => {
  const refusal = (fn: () => unknown): PayrollRefusedError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof PayrollRefusedError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('refuses a month before the rules start, and names the missing rule', () => {
    const error = refusal(() => calculatePayroll(employment(), month('2025-12')));
    expect(error.code).toBe('no_rule_in_force');
    expect(error.message).toMatch(/insurance_rate/);
  });

  it('refuses malformed input', () => {
    expect(refusal(() => calculatePayroll(employment(), month('2026-8'))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ baseWage: '20 million' }), month('2026-08'))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment(), month('2026-08', { unpaidLeaveDays: '30' }))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ contract: 'fixed_term' }), month('2026-08'))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment(), month('2026-08', { bonus: '-1' }))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ baseWage: '' }), month('2026-08'))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment(), month('2026-08', { overtime: [{ dayKind: 'constructor' as 'holiday', night: false, hours: '1' }] }))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment(), month('2026-08', { deductions: [{ label: 'x', kind: 'toString' as 'other', amount: '1' }] }))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ payBasis: 'weekly' as PayBasis }), month('2026-08'))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ payBasis: 'hourly', hourlyRate: '0', baseWage: '0' }), month('2026-08'))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ payBasis: 'hourly', hourlyRate: '-100' }), month('2026-08'))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ payBasis: 'hourly', hourlyRate: '50000' }), month('2026-08', { workedHours: '-1' }))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ payBasis: 'piece_rate', pieceRate: '0', baseWage: '0' }), month('2026-08'))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ payBasis: 'piece_rate', pieceRate: '10000' }), month('2026-08', { pieceCount: '-2' }))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment(), month('2026-08', { sicknessBhxhDays: '-1' }))).code).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment(), month('2026-08', { maternityBhxhDays: '-0.5' }))).code).toBe('invalid_input');
    expect(
      refusal(() =>
        calculatePayroll(employment(), month('2026-08', { unpaidLeaveDays: '10', daysNotEmployed: '5', sicknessBhxhDays: '8', maternityBhxhDays: '4' })),
      ).code,
    ).toBe('invalid_input');
    expect(refusal(() => calculatePayroll(employment({ resident: false }), month('2025-12'))).code).toBe('no_rule_in_force');
  });

  it('keeps money as exact decimals', () => {
    const c = calculatePayroll(employment({ baseWage: '10000000.55' }), month('2026-08'));
    expect(c.gross).toBe('10000001');
    expect(typeof c.net).toBe('string');
    expect(calculatePayroll(employment(), month('2026-08', { bonus: '1000.5' })).gross).toBe('20001001');
  });
});

// The accountant's worked examples (#2535) go here, each as an entry of this list with the figures to the dong from the
// accountant, and the test below checks the calculator against them. Until they arrive these are the cases the issue
// asks for; nothing in this block is a figure from the accountant.
interface WorkedExample {
  name: string;
  employment: PayrollEmployment;
  inputs: PayrollMonthInputs;
  expected: ReturnType<typeof sheet>;
}
const ACCOUNTANT_WORKED_EXAMPLES: readonly WorkedExample[] = [];

describe('the accountant worked examples (#2535)', () => {
  for (const example of ACCOUNTANT_WORKED_EXAMPLES) {
    it(example.name, () => {
      expect(sheet(calculatePayroll(example.employment, example.inputs))).toEqual(example.expected);
    });
  }
  it.todo('a single employee without dependents');
  it.todo('a single employee with dependents');
  it.todo('pay at and above the insurance cap');
  it.todo('an unpaid fortnight');
  it.todo('overtime');
  it.todo('a new hire in the middle of the month');
  it.todo('a bonus');
  it.todo('a payment withheld at 10%');
});

describe('hourly pay basis (Stage 4B)', () => {
  it('computes fractional workedHours * hourlyRate, uses hourlyRate for OT/night and minimum_wage.hourly check', () => {
    expect(PAY_BASES).toEqual(['monthly', 'hourly', 'piece_rate']);
    // 160.5h * 50,000 = 8,025,000; employee insurance 8% (642,000) + 1.5% (120,375) + 1% (80,250) = 842,625;
    // employer insurance 14% (1,123,500) + 3% (240,750) + 0.5% (40,125) + 3% (240,750) + 1% (80,250) = 1,725,375; union 2% = 160,500.
    // Assessable 8,025,000 - 842,625 - 15,500,000 < 0 -> PIT = 0; net = 7,182,375.
    const c = calculatePayroll(
      employment({ payBasis: 'hourly', hourlyRate: '50000', baseWage: '0' }),
      month('2026-08', { workedHours: '160.5' }),
    );
    expect(sheet(c)).toEqual({
      gross: '8025000',
      employeeInsurance: '842625',
      employerInsurance: '1725375',
      unionFee: '160500',
      pit: '0',
      net: '7182375',
      employerCost: '9910875',
    });
    expect(c.breakdown.pay).toMatchObject({
      baseWage: '8025000',
      hourlyRate: '50000',
      unpaidReduction: '0',
      sicknessBhxhReduction: '0',
      maternityBhxhReduction: '0',
    });
    expect(c.breakdown.insurance.insurablePay).toBe('8025000');
    expect(c.checks).toEqual([{ id: 'minimum_wage', ok: true, actual: '50000', limit: '25500' }]);
  });

  it('defaults hourlyRate to baseWage when omitted, handles ROUND_HALF_UP and fractional OT/night hours', () => {
    // Fallback rate 60,000/h * 160h = 9,600,000; 2.5h normal OT at 150% = 225,000 (exempt 75,000);
    // 4h night work at 30% = 72,000 (exempt 72,000); gross = 9,897,000; taxable = 9,750,000.
    const otNight = calculatePayroll(
      employment({ payBasis: 'hourly', baseWage: '60000', insured: false }),
      month('2026-08', {
        workedHours: '160',
        overtime: [{ dayKind: 'normal_day', night: false, hours: '2.5' }],
        nightHours: '4',
      }),
    );
    expect(otNight.gross).toBe('9897000');
    expect(otNight.taxableIncome).toBe('9750000');
    expect(otNight.breakdown.pay.hourlyRate).toBe('60000');

    // 33,333 * 100.5 = 3,349,966.5 -> ROUND_HALF_UP to 3,349,967.
    const rounded = calculatePayroll(
      employment({ payBasis: 'hourly', hourlyRate: '33333', baseWage: '0', insured: false }),
      month('2026-08', { workedHours: '100.5' }),
    );
    expect(rounded.gross).toBe('3349967');

    // Minimum wage check compares hourlyRate against minimum_wage[region].hourly (25,000 < 25,500 in region I).
    const belowMin = calculatePayroll(
      employment({ payBasis: 'hourly', hourlyRate: '25000', baseWage: '0', insured: false }),
      month('2026-08', { workedHours: '160' }),
    );
    expect(belowMin.checks).toEqual([{ id: 'minimum_wage', ok: false, actual: '25000', limit: '25500' }]);
  });

  it('does not subtract daily reduction from workedHours * hourlyRate on leave days, while still counting >= 14 days for BHXH suspension', () => {
    // 80h * 50,000 = 4,000,000; 14 sicknessBhxhDays suspends insurance without shrinking 4,000,000.
    const suspended = calculatePayroll(
      employment({ payBasis: 'hourly', hourlyRate: '50000', baseWage: '0' }),
      month('2026-08', { workedHours: '80', sicknessBhxhDays: '14' }),
    );
    expect(suspended.gross).toBe('4000000');
    expect(suspended.employeeInsurance).toBe('0');
    expect(suspended.breakdown.insurance.suspended).toBe('sickness_leave');
    expect(suspended.breakdown.pay).toMatchObject({ unpaidReduction: '0', sicknessBhxhReduction: '0', maternityBhxhReduction: '0' });
  });
});

describe('piece-rate pay basis (Stage 4B)', () => {
  it('computes pieceCount * pieceRate, derives hourlyRate from workedHours when > 0, and checks monthly minimum wage', () => {
    // 420.5 * 25,000 = 10,512,500; workedHours = 175 -> hourlyRate = 10,512,500 / 175 = 60,071.42857... ('60071.4286').
    // 5h normal OT at 150%: pay = 5 * (10,512,500 / 175) * 1.5 = 450,535.714... -> 450,536; normal = 300,357; exempt = 150,179.
    // Gross = 10,512,500 + 450,536 = 10,963,036; insurable = 10,512,500 -> employee insurance = 841,000 + 157,688 + 105,125 = 1,103,813.
    const c = calculatePayroll(
      employment({ payBasis: 'piece_rate', pieceRate: '25000', baseWage: '0' }),
      month('2026-08', {
        pieceCount: '420.5',
        workedHours: '175',
        overtime: [{ dayKind: 'normal_day', night: false, hours: '5' }],
      }),
    );
    expect(c.breakdown.pay.baseWage).toBe('10512500');
    expect(c.breakdown.pay.hourlyRate).toBe('60071.4286');
    expect(c.breakdown.pay.overtime).toEqual([
      { dayKind: 'normal_day', night: false, hours: '5', multiple: '1.5', pay: '450536', exempt: '150179' },
    ]);
    expect(c.gross).toBe('10963036');
    expect(c.employeeInsurance).toBe('1103813');
    expect(c.checks).toEqual([{ id: 'minimum_wage', ok: true, actual: '10512500', limit: '5310000' }]);
  });

  it('falls back to baseWage when pieceRate is omitted and derives OT rate from standardHours when workedHours is absent', () => {
    // 1,040 * 10,000 = 10,400,000; hourlyRate = 10,400,000 / (26 * 8) = 50,000; 4h weekly_rest_day OT (2x) = 400,000.
    const c = calculatePayroll(
      employment({ payBasis: 'piece_rate', baseWage: '10000', insured: false }),
      month('2026-08', {
        pieceCount: '1040',
        overtime: [{ dayKind: 'weekly_rest_day', night: false, hours: '4' }],
      }),
    );
    expect(c.breakdown.pay.hourlyRate).toBe('50000');
    expect(c.gross).toBe('10800000');
    expect(c.rulesUsed.map((r) => r.id)).toContain('standard_hours.default@2021-01-01');
  });

  it('checks piece-rate minimum wage against full or pro-rated regional minimum and suspends BHXH on maternity leave', () => {
    const belowFull = calculatePayroll(
      employment({ payBasis: 'piece_rate', pieceRate: '20000', baseWage: '0', insured: false }),
      month('2026-08', { pieceCount: '200' }),
    );
    expect(belowFull.checks).toEqual([{ id: 'minimum_wage', ok: false, actual: '4000000', limit: '5310000' }]);

    // 13 unpaid days (13/26 worked): limit pro-rates to 2,655,000; earned 3,000,000 passes.
    const proRatedPass = calculatePayroll(
      employment({ payBasis: 'piece_rate', pieceRate: '20000', baseWage: '0', insured: false }),
      month('2026-08', { pieceCount: '150', unpaidLeaveDays: '13' }),
    );
    expect(proRatedPass.checks).toEqual([{ id: 'minimum_wage', ok: true, actual: '3000000', limit: '2655000' }]);

    const matSuspended = calculatePayroll(
      employment({ payBasis: 'piece_rate', pieceRate: '30000', baseWage: '0' }),
      month('2026-08', { pieceCount: '150', maternityBhxhDays: '14' }),
    );
    expect(matSuspended.gross).toBe('4500000');
    expect(matSuspended.employeeInsurance).toBe('0');
    expect(matSuspended.breakdown.insurance.suspended).toBe('maternity_leave');
    expect(matSuspended.breakdown.pay.maternityBhxhReduction).toBe('0');
  });
});

describe('non-resident 20% flat PIT (Stage 4B)', () => {
  it('applies 20% flat PIT on taxableIncome with zero insurance, personal, dependent, or pension deductions', () => {
    // 20,000,000 insured non-resident: insurance 2,100,000 is withheld from net, NOT deducted from PIT base.
    // PIT = 20% * 20,000,000 = 4,000,000; net = 20,000,000 - 2,100,000 - 4,000,000 = 13,900,000.
    const c = calculatePayroll(
      employment({ resident: false, insured: true, baseWage: '20000000' }),
      month('2026-08', { dependents: [{ ownMonthlyIncome: '0' }], voluntaryPension: '3000000' }),
    );
    expect(sheet(c)).toEqual({
      gross: '20000000',
      employeeInsurance: '2100000',
      employerInsurance: '4300000',
      unionFee: '400000',
      pit: '4000000',
      net: '13900000',
      employerCost: '24700000',
    });
    expect(c.breakdown.tax).toEqual({
      mode: 'non_resident_flat',
      exemptMealCash: '0',
      exemptOvertime: '0',
      exemptNightWork: '0',
      taxableIncome: '20000000',
      incomeAfterInsurance: '20000000',
      personalDeduction: '0',
      dependentsCounted: 0,
      dependentDeduction: '0',
      pensionDeduction: '0',
      assessableIncome: '20000000',
      slices: [],
      flatPercent: '20',
    });
    expect(c.rulesUsed.map((r) => r.id)).toContain('pit_non_resident.default@2026-01-01');
    expect(c.rulesUsed.some((r) => r.kind === 'pit_brackets' || r.kind === 'pit_deduction' || r.kind === 'pit_withholding')).toBe(false);
  });

  it('applies 20% flat PIT even on contract=none with commitment, while preserving meal/OT exemptions', () => {
    const casualNonRes = calculatePayroll(
      employment({ resident: false, contract: 'none', insured: false, commitment: true, baseWage: '3000000' }),
      month('2026-08'),
    );
    expect(casualNonRes.breakdown.tax.mode).toBe('non_resident_flat');
    expect(casualNonRes.pit).toBe('600000');

    // 26,000,000 + 1,500,000 meal cash (1,200,000 exempt) + 10h normal OT at 125,000/h * 1.5 = 1,875,000 (625,000 exempt).
    // Gross = 29,375,000; taxableIncome = 27,550,000; PIT 20% = 5,510,000.
    const withExemptions = calculatePayroll(
      employment({
        resident: false,
        insured: false,
        baseWage: '26000000',
        allowances: [{ label: 'Meals', amount: '1500000', type: 'meal_cash', namedInContract: false }],
      }),
      month('2026-08', { overtime: [{ dayKind: 'normal_day', night: false, hours: '10' }] }),
    );
    expect(withExemptions.gross).toBe('29375000');
    expect(withExemptions.taxableIncome).toBe('27550000');
    expect(withExemptions.pit).toBe('5510000');
  });
});

describe('foreign worker BHXH & eligibility helper (Stage 4B)', () => {
  it('exempts BHTN (unemployment) for insured foreign workers while computing BHXH, BHYT, and union fee', () => {
    // 20,000,000 foreign resident: employee 8% (1,600,000) + 1.5% (300,000) = 1,900,000; BHTN = 0.
    // Employer 14% + 3% + 0.5% + 3% = 20.5% = 4,100,000; union fee 2% = 400,000.
    // Assessable 20,000,000 - 1,900,000 - 15,500,000 = 2,600,000 -> 5% = 130,000; net = 17,970,000.
    const c = calculatePayroll(employment({ isForeign: true, baseWage: '20000000' }), month('2026-08'));
    expect(sheet(c)).toEqual({
      gross: '20000000',
      employeeInsurance: '1900000',
      employerInsurance: '4100000',
      unionFee: '400000',
      pit: '130000',
      net: '17970000',
      employerCost: '24500000',
    });
    expect(fund(c, 'unemployment')).toEqual({ fund: 'unemployment', wage: '0', employee: '0', employer: '0' });
    expect(c.rulesUsed.map((r) => r.id)).toContain('foreign_insurance.default@2025-07-01');
    expect(c.rulesUsed.map((r) => r.id)).not.toContain('insurance_rate.unemployment@2026-01-01');

    // Foreign non-resident: insurance 1,900,000 + 20% flat PIT 4,000,000 -> net 14,100,000.
    const nonRes = calculatePayroll(employment({ isForeign: true, resident: false, baseWage: '20000000' }), month('2026-08'));
    expect(nonRes.employeeInsurance).toBe('1900000');
    expect(nonRes.pit).toBe('4000000');
    expect(nonRes.net).toBe('14100000');
  });

  it('evaluates statutory foreign insurance eligibility under Decree 143/2018 & Law 41/2024', () => {
    const base = {
      hasWorkPermitOrPracticeCert: true,
      isInternalTransferee: false,
      atOrAboveRetirementAge: false,
      contract: 'fixed_term' as const,
      contractTermMonths: 12,
    };
    const eligibleFixed = evaluateForeignInsuranceEligibility(base, '2026-08-01');
    expect(eligibleFixed).toEqual({
      bhxhBhtnEligible: false,
      bhxhBhytEligible: true,
      exemptReason: null,
      rulesUsed: [
        {
          id: 'foreign_insurance.default@2025-07-01',
          kind: 'foreign_insurance',
          key: 'default',
          effectiveFrom: '2025-07-01',
          status: 'commentary',
        },
      ],
    });
    expect(evaluateForeignInsuranceEligibility({ ...base, contract: 'indefinite', contractTermMonths: null }, '2026-08')).toMatchObject({
      bhxhBhytEligible: true,
      bhxhBhtnEligible: false,
      exemptReason: null,
    });

    expect(evaluateForeignInsuranceEligibility({ ...base, hasWorkPermitOrPracticeCert: false }, '2026-08-01')).toMatchObject({
      bhxhBhytEligible: false,
      bhxhBhtnEligible: false,
      exemptReason: 'no_work_permit_or_practice_cert',
    });
    expect(evaluateForeignInsuranceEligibility({ ...base, isInternalTransferee: true }, '2026-08-01')).toMatchObject({
      bhxhBhytEligible: false,
      exemptReason: 'internal_transferee',
    });
    expect(evaluateForeignInsuranceEligibility({ ...base, atOrAboveRetirementAge: true }, '2026-08-01')).toMatchObject({
      bhxhBhytEligible: false,
      exemptReason: 'at_or_above_retirement_age',
    });
    expect(evaluateForeignInsuranceEligibility({ ...base, contractTermMonths: 11 }, '2026-08-01')).toMatchObject({
      bhxhBhytEligible: false,
      exemptReason: 'contract_below_minimum_term',
    });
    expect(evaluateForeignInsuranceEligibility({ ...base, contract: 'none', contractTermMonths: null }, '2026-08-01')).toMatchObject({
      bhxhBhytEligible: false,
      exemptReason: 'contract_below_minimum_term',
    });

    expect(() => evaluateForeignInsuranceEligibility(base, '2025-06-30')).toThrow(PayrollRefusedError);
    expect(() => evaluateForeignInsuranceEligibility(base, '2026-02-30')).toThrow(PayrollRefusedError);
  });
});

describe('sickness and maternity BHXH leave in monthly payroll (Stage 4B)', () => {
  it('deducts sicknessBhxhDays and maternityBhxhDays from monthly pay and suspends insurance at >= 14 combined days', () => {
    const sick = calculatePayroll(employment({ baseWage: '26000000' }), month('2026-08', { sicknessBhxhDays: '14' }));
    expect(sheet(sick)).toEqual({
      gross: '12000000',
      employeeInsurance: '0',
      employerInsurance: '0',
      unionFee: '0',
      pit: '0',
      net: '12000000',
      employerCost: '12000000',
    });
    expect(sick.breakdown.pay).toMatchObject({
      baseWage: '12000000',
      unpaidReduction: '0',
      sicknessBhxhReduction: '14000000',
      maternityBhxhReduction: '0',
    });
    expect(sick.breakdown.insurance.suspended).toBe('sickness_leave');
    expect(sick.rulesUsed.map((r) => r.id)).toContain('insurance_suspension.sickness_leave@2025-07-01');

    const mat = calculatePayroll(employment({ baseWage: '26000000' }), month('2026-08', { maternityBhxhDays: '14' }));
    expect(mat.breakdown.pay).toMatchObject({
      baseWage: '12000000',
      unpaidReduction: '0',
      sicknessBhxhReduction: '0',
      maternityBhxhReduction: '14000000',
    });
    expect(mat.breakdown.insurance.suspended).toBe('maternity_leave');
    expect(mat.rulesUsed.map((r) => r.id)).toContain('insurance_suspension.maternity_leave@2025-07-01');

    // Combined 5 unpaid + 5 sickness + 4 maternity = 14 -> suspended ('sickness_leave'), exact reductions 5M + 5M + 4M.
    const mixed = calculatePayroll(
      employment({ baseWage: '26000000' }),
      month('2026-08', { unpaidLeaveDays: '5', sicknessBhxhDays: '5', maternityBhxhDays: '4' }),
    );
    expect(mixed.gross).toBe('12000000');
    expect(mixed.breakdown.pay).toMatchObject({
      unpaidReduction: '5000000',
      sicknessBhxhReduction: '5000000',
      maternityBhxhReduction: '4000000',
    });
    expect(mixed.breakdown.insurance.suspended).toBe('sickness_leave');

    // Fractional 13.5 sickness days: < 14, so insurance stays active! 12,000,000 * 12.5 / 26 = 5,769,231.
    const underFourteen = calculatePayroll(employment({ baseWage: '12000000' }), month('2026-08', { sicknessBhxhDays: '13.5' }));
    expect(underFourteen.gross).toBe('5769231');
    expect(underFourteen.breakdown.pay.sicknessBhxhReduction).toBe('6230769');
    expect(underFourteen.breakdown.insurance.suspended).toBeNull();
    expect(underFourteen.employeeInsurance).toBe('1260000');

    // 13.5 sickness + 0.5 maternity = 14 -> suspended ('sickness_leave'), reductions sum to total 6,461,538.
    const fractionalFourteen = calculatePayroll(
      employment({ baseWage: '12000000' }),
      month('2026-08', { sicknessBhxhDays: '13.5', maternityBhxhDays: '0.5' }),
    );
    expect(fractionalFourteen.gross).toBe('5538462');
    expect(fractionalFourteen.breakdown.insurance.suspended).toBe('sickness_leave');
    expect(
      sum([
        fractionalFourteen.breakdown.pay.sicknessBhxhReduction,
        fractionalFourteen.breakdown.pay.maternityBhxhReduction,
      ]).toFixed(),
    ).toBe('6461538');
  });
});
