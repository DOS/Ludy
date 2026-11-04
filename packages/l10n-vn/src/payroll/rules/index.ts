// SPDX-License-Identifier: AGPL-3.0-only
import type { PayrollRule } from '../rule-types.ts';
import { EXEMPT_ALLOWANCE_RULES } from './allowances.ts';
import { INSURANCE_WAGE_BOUND_RULES, REFERENCE_LEVEL_RULES } from './insurance-base.ts';
import { INSURANCE_RULES } from './insurance-rates.ts';
import { LABOR_CODE_RULES } from './labor-code.ts';
import { MINIMUM_WAGE_RULES } from './minimum-wage.ts';
import { PIT_RULES } from './pit.ts';

export { INSURANCE_FUNDS, type InsuranceFund } from './insurance-rates.ts';

/**
 * Every payroll rule in the product, in the order of the plan's section 5. A month cannot be approved while a rule it
 * used is still `commentary` (ADR-0046 point 2): the accountant flips a row to `confirmed` by pull request.
 */
export const PAYROLL_RULES: readonly PayrollRule[] = [
  ...MINIMUM_WAGE_RULES,
  ...REFERENCE_LEVEL_RULES,
  ...INSURANCE_WAGE_BOUND_RULES,
  ...INSURANCE_RULES,
  ...PIT_RULES,
  ...EXEMPT_ALLOWANCE_RULES,
  ...LABOR_CODE_RULES,
];
