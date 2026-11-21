// SPDX-License-Identifier: AGPL-3.0-only
import { INSURANCE_FUNDS, defineRule, type InsuranceFund, type PayrollRule, type RuleRow } from '../rule-types.ts';

// Insurance rates by fund, in percent of the contribution wage (plan section 5, rows 2, 7 and 8). No rate changed in 2026
// in any source read; the draft decree that would reduce the work accident rate to 0.3% until 2027-12-31 is unverified
// and not encoded (a new rate would be a new row).

export { INSURANCE_FUNDS, type InsuranceFund };

const SOCIAL_LAW = 'Law 41/2024/QH15 on Social Insurance (in force 2025-07-01; consolidated 19/VBHN-VPQH)';

export const INSURANCE_RATE_RULES: readonly RuleRow<'insurance_rate'>[] = [
  defineRule({
    kind: 'insurance_rate',
    key: 'retirement_death',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: { cite: `${SOCIAL_LAW}: retirement and death fund, employer 14%, employee 8%`, confidence: 'primary' },
    value: { employerPercent: '14', employeePercent: '8', wageBase: 'social' },
  }),
  defineRule({
    kind: 'insurance_rate',
    key: 'sickness_maternity',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: { cite: `${SOCIAL_LAW}: sickness and maternity fund, employer 3%, employee 0%`, confidence: 'primary' },
    value: { employerPercent: '3', employeePercent: '0', wageBase: 'social' },
  }),
  defineRule({
    kind: 'insurance_rate',
    key: 'work_accident',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: {
      cite: 'Decree 58/2020/ND-CP Art. 4: work accident and occupational disease fund, employer 0.5% (the normal rate), employee 0%; a reduced 0.3% under a draft decree is unverified',
      confidence: 'commentary',
    },
    value: { employerPercent: '0.5', employeePercent: '0', wageBase: 'social' },
  }),
  defineRule({
    kind: 'insurance_rate',
    key: 'health',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: { cite: 'Health Insurance Law 51/2024/QH15 and Decree 188/2025/ND-CP: health insurance, employer 3%, employee 1.5% (the split is from commentary)', confidence: 'commentary' },
    value: { employerPercent: '3', employeePercent: '1.5', wageBase: 'social' },
  }),
  defineRule({
    kind: 'insurance_rate',
    key: 'unemployment',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: { cite: 'Employment Law 74/2025/QH15 (in force 2026-01-01) and Decree 374/2025/ND-CP: unemployment insurance, employer 1%, employee 1%, on the BHTN wage base', confidence: 'commentary' },
    value: { employerPercent: '1', employeePercent: '1', wageBase: 'unemployment' },
  }),
];

export const UNION_FEE_RULES: readonly RuleRow<'union_fee'>[] = [
  defineRule({
    kind: 'union_fee',
    key: 'employer',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: {
      cite: 'Trade Union Law 2024 Art. 29 and Decree 105/2026/ND-CP: 2% of the payroll used for compulsory insurance, paid by the employer on top; reductions and suspensions exist under Decree 105/2026, and its start date, base and exemptions are unverified',
      confidence: 'commentary',
    },
    value: { employerPercent: '2', wageBase: 'social' },
  }),
];

export const INSURANCE_SUSPENSION_RULES: readonly RuleRow<'insurance_suspension'>[] = [
  defineRule({
    kind: 'insurance_suspension',
    key: 'unpaid_leave',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: {
      cite: 'Law 41/2024/QH15 Arts. 33(5), 33(6), 34(3) and 52(8): a month with 14 or more working days of unpaid leave has no contribution from either side (unless both agree to pay on the previous month\'s base); the first month of work or of return still pays',
      confidence: 'primary',
    },
    value: { unpaidWorkingDays: '14' },
  }),
  defineRule({
    kind: 'insurance_suspension',
    key: 'sickness_leave',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: {
      cite: `${SOCIAL_LAW} Art. 33(5): a month with 14 or more working days of sickness leave under the social insurance regime has no compulsory insurance contribution from either side; pending accountant confirmation (#2535)`,
      confidence: 'primary',
    },
    value: { unpaidWorkingDays: '14' },
  }),
  defineRule({
    kind: 'insurance_suspension',
    key: 'maternity_leave',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: {
      cite: `${SOCIAL_LAW} Arts. 33(5) and 34(3): a month with 14 or more working days of maternity leave has no compulsory insurance contribution from either side and still counts as social insurance contribution time; pending accountant confirmation (#2535)`,
      confidence: 'primary',
    },
    value: { unpaidWorkingDays: '14' },
  }),
];

export const FOREIGN_INSURANCE_RULES: readonly RuleRow<'foreign_insurance'>[] = [
  defineRule({
    kind: 'foreign_insurance',
    key: 'default',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: {
      cite: `Decree 143/2018/ND-CP and ${SOCIAL_LAW} Art. 2(2) (plan section 5, row 7): foreign employees working in Vietnam with a work permit or practice certificate on an indefinite or >= 12-month contract participate in compulsory BHXH and BHYT, exempt from unemployment insurance (BHTN); intra-company transferees and employees at or above retirement age are exempt; pending accountant confirmation (#2535)`,
      confidence: 'commentary',
    },
    value: { minContractMonths: 12, exemptFunds: ['unemployment'] },
  }),
];

export const INSURANCE_RULES: readonly PayrollRule[] = [
  ...INSURANCE_RATE_RULES,
  ...UNION_FEE_RULES,
  ...INSURANCE_SUSPENSION_RULES,
  ...FOREIGN_INSURANCE_RULES,
];
