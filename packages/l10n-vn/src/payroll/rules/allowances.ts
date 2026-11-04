// SPDX-License-Identifier: AGPL-3.0-only
import { defineRule, type PayrollRule } from '../rule-types.ts';

// Parts of pay exempt from personal income tax (plan section 5, row 13). Only the two that move a monthly figure are
// modelled; the others (uniform, phone and travel within the corporate-tax limits, housing, severance, pay for unused
// leave) are not, and a payment of that kind is entered as other pay and taxed in full.

export const EXEMPT_ALLOWANCE_RULES: readonly PayrollRule[] = [
  defineRule({
    kind: 'pit_meal_cash_cap',
    key: 'default',
    effectiveFrom: '2026-07-01',
    status: 'commentary',
    source: {
      cite: 'Cash meal allowance is taxable only above 1,200,000 per person per month, from 2026-07-01 (commentary); meals in kind or by voucher are excluded in full and are not pay here. No row exists before 2026-07-01, so a cash meal allowance in January to June 2026 is refused until a row for the old limit is added',
      confidence: 'commentary',
    },
    value: { monthly: '1200000' },
  }),
  defineRule({
    kind: 'pit_overtime_exemption',
    key: 'default',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: {
      cite: 'Overtime and night-work pay are exempt, but the survey found sources saying the whole pay is exempt and one saying only the part above the normal-day pay: unverified. This row takes the narrower reading (premium only, the higher tax); the other reading is the mode whole_pay in a new row once the accountant confirms it',
      confidence: 'unverified',
    },
    value: { mode: 'premium_only' },
  }),
];
