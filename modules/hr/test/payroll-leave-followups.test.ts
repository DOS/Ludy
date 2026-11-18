// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  HR_RECURRING_INPUTS,
  zHrLeaveBalanceAsk,
  zHrLeaveSet,
  zHrLineInputsSet,
  zHrPayrollInputs,
} from '@crove/kernel-contract';
import { computeAnnualLeaveBalance, hrManifest } from '../src/index.ts';

const EMP_ID = '00000000-0000-7000-8000-000000000001';
const LINE_ID = '00000000-0000-7000-8000-000000000002';

describe('HR annual leave ledger follow-ups (#3411)', () => {
  it('keeps payroll_leave_entry columns internal while payroll_line.inputs stays sensitive', () => {
    const leaveCols = hrManifest.tables.crove_hr.payroll_leave_entry;
    expect(leaveCols.days).toBe('internal');
    expect(Object.values(leaveCols).every((cls) => cls === 'internal')).toBe(true);
    expect(hrManifest.tables.crove_hr.payroll_line.inputs).toBe('sensitive');
  });

  it('rejects 2-decimal unpaid_leave at write time while allowing 2-decimal opening_balance carry-over', () => {
    expect(
      zHrLeaveSet.safeParse({
        employeeId: EMP_ID,
        month: '2026-11',
        kind: 'unpaid_leave',
        days: '1.25',
      }).success,
    ).toBe(false);

    for (const validDays of ['0', '0.5', '1', '2.5', '2.50', '1.00']) {
      expect(
        zHrLeaveSet.safeParse({
          employeeId: EMP_ID,
          month: '2026-11',
          kind: 'unpaid_leave',
          days: validDays,
        }).success,
        validDays,
      ).toBe(true);
    }

    expect(
      zHrLeaveSet.safeParse({
        employeeId: EMP_ID,
        month: '2026-01',
        kind: 'opening_balance',
        days: '5.83',
      }).success,
    ).toBe(true);
  });

  it('carries leaveCategory and standardAnnualDays as recurring pay-line inputs while keeping unpaidLeaveFromLedger monthly', () => {
    expect(HR_RECURRING_INPUTS).toContain('leaveCategory');
    expect(HR_RECURRING_INPUTS).toContain('standardAnnualDays');
    expect(HR_RECURRING_INPUTS).not.toContain('unpaidLeaveFromLedger');

    const defaults = zHrPayrollInputs.parse({});
    expect(defaults).toMatchObject({
      leaveCategory: 'standard',
      standardAnnualDays: null,
      unpaidLeaveDays: '0',
      unpaidLeaveFromLedger: null,
    });

    expect(
      zHrPayrollInputs.safeParse({ leaveCategory: 'heavy', standardAnnualDays: '13' }).success,
    ).toBe(false);
    expect(
      zHrPayrollInputs.safeParse({ leaveCategory: 'heavy', standardAnnualDays: '15' }).success,
    ).toBe(true);
    expect(
      zHrLineInputsSet.safeParse({ lineId: LINE_ID, inputs: { bonus: '500000' } }).success,
    ).toBe(true);
    expect(
      zHrLeaveBalanceAsk.safeParse({ employeeId: EMP_ID, year: '2026', category: 'special_heavy', standardAnnualDays: '14' }).success,
    ).toBe(false);
  });

  it('evaluates computeAnnualLeaveBalance with heavy, special_heavy, and custom standardAnnualDays without false exceedance', () => {
    const entries = [{ kind: 'annual_leave' as const, month: '2026-11', days: '13.5', approved: true }];

    const standard = computeAnnualLeaveBalance({
      year: '2026',
      category: 'standard',
      hireDate: '2025-01-01',
      asOfMonth: '2026-11',
      entries,
    });
    expect(standard.exceededAnnualDays).toBe('2.5');

    const heavy = computeAnnualLeaveBalance({
      year: '2026',
      category: 'heavy',
      hireDate: '2025-01-01',
      asOfMonth: '2026-12',
      entries,
    });
    expect(heavy).toMatchObject({
      entitlementDays: '14',
      remainingAnnualDays: '0.5',
      exceededAnnualDays: '0',
    });

    const specialHeavy = computeAnnualLeaveBalance({
      year: '2026',
      category: 'special_heavy',
      hireDate: '2025-01-01',
      asOfMonth: '2026-11',
      entries,
    });
    expect(specialHeavy).toMatchObject({
      entitlementDays: '14.6667',
      remainingAnnualDays: '1.1667',
      exceededAnnualDays: '0',
    });

    const customBaseline = computeAnnualLeaveBalance({
      year: '2026',
      category: 'standard',
      standardAnnualDays: '16',
      hireDate: '2025-01-01',
      asOfMonth: '2026-11',
      entries,
    });
    expect(customBaseline).toMatchObject({
      entitlementDays: '14.6667',
      remainingAnnualDays: '1.1667',
      exceededAnnualDays: '0',
    });
  });
});
