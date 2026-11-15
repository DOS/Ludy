// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HR_LINE_FLAGS, zHrCheck, zHrRunImportTimekeeping } from '@crove/kernel-contract';
import { hrCommands } from '../src/index.ts';
import { runImportTimekeeping } from '../src/payroll-run.ts';

describe('hr.payroll.run.import_timekeeping contract and command (#3371)', () => {
  it('registers the command in hrCommands with manager-only R1 access and table writes', () => {
    expect(runImportTimekeeping.name).toBe('hr.payroll.run.import_timekeeping');
    expect(runImportTimekeeping.risk).toBe('R1');
    expect(runImportTimekeeping.sideEffect).toBe('internal');
    expect(runImportTimekeeping.access).toEqual(['owner', 'admin']);
    expect(runImportTimekeeping.permission).toBe('hr.payroll.run');
    expect(hrCommands.some((c) => c.name === 'hr.payroll.run.import_timekeeping')).toBe(true);
    expect(HR_LINE_FLAGS).toContain('check_overtime_cap');
    expect(zHrCheck.parse({ id: 'overtime_cap', ok: false, actual: '45', limit: '40' })).toEqual({
      id: 'overtime_cap',
      ok: false,
      actual: '45',
      limit: '40',
    });
  });

  it('validates row bounds, decimal strings, and rejects duplicate lineIds', () => {
    const runId = randomUUID();
    const lineA = randomUUID();
    const lineB = randomUUID();

    const ok = zHrRunImportTimekeeping.parse({
      runId,
      rows: [
        {
          lineId: lineA,
          unpaidLeaveDays: '1.5',
          daysNotEmployed: '0',
          nightHours: '6.25',
          overtime: [{ dayKind: 'normal_day', night: false, hours: '12' }],
        },
        {
          lineId: lineB,
          unpaidLeaveDays: '0',
          daysNotEmployed: '2',
          nightHours: '0',
        },
      ],
    });
    expect(ok.rows[1]?.overtime).toEqual([]);

    expect(zHrRunImportTimekeeping.safeParse({ runId, rows: [] }).success).toBe(false);
    expect(
      zHrRunImportTimekeeping.safeParse({
        runId,
        rows: [
          { lineId: lineA, unpaidLeaveDays: '0', daysNotEmployed: '0', nightHours: '0' },
          { lineId: lineA, unpaidLeaveDays: '1', daysNotEmployed: '0', nightHours: '0' },
        ],
      }).success,
    ).toBe(false);
    expect(
      zHrRunImportTimekeeping.safeParse({
        runId,
        rows: [{ lineId: lineA, unpaidLeaveDays: '1.25', daysNotEmployed: '0', nightHours: '0' }],
      }).success,
    ).toBe(false);
  });
});
