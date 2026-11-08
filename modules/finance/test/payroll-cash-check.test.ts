// SPDX-License-Identifier: AGPL-3.0-only
// The cash flag of a pay run's net pay (#2532): a count of people at the 5 million limit, never a name or a figure.
import { describe, expect, it } from 'vitest';
import { zCheck } from '@crove/kernel-contract';
import { payrollCashCheck } from '../src/domain/anomaly.ts';

describe('payrollCashCheck', () => {
  it('raises nothing without a person at the limit, and not for a count that is no count', () => {
    expect(payrollCashCheck(0)).toBeNull();
    expect(payrollCashCheck(-1)).toBeNull();
    expect(payrollCashCheck(1.5)).toBeNull();
    expect(payrollCashCheck(Number.NaN)).toBeNull();
  });

  it('warns once with the count, in the anomaly family, and fits the stored check schema', () => {
    const check = payrollCashCheck(2);
    expect(check).toMatchObject({ id: 'anomaly_cash', status: 'warn', code: 'anomaly_cash.payroll_limit', params: { count: '2' } });
    expect(zCheck.safeParse(check).success).toBe(true);
    // The id starts with `anomaly`, so the proposal that carries it is approved one by one.
    expect(check?.id.startsWith('anomaly')).toBe(true);
  });
});
