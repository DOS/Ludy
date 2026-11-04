// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PAYROLL_RULES, PayrollRefusedError, calculatePayroll, listRulesUsed, defineRule, type PayrollRule, type PayrollCalculation, type PayrollEmployment, type PayrollMonthInputs } from '../src/index.ts';

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

  it('refuses a non-resident with a message', () => {
    const error = refusal(() => calculatePayroll(employment({ resident: false }), month('2026-08')));
    expect(error.code).toBe('non_resident');
    expect(error.message).toMatch(/non-resident/);
  });

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
