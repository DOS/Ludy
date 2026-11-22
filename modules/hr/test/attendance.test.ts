// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { zHrPayrollInputs } from '@ludy/kernel-contract';
import { parseTimekeepingSheet } from '@ludy/l10n-vn';
import {
  computeEmployeeAttendanceRollup,
  detectAttendanceAnomalies,
  hashAttendanceQrSecret,
  nightOverlapMinutes,
  normalizeAttendanceQrToken,
} from '../src/attendance.ts';

describe('HR Stage 5C attendance deterministic helpers (#4447)', () => {
  it('extracts QR secrets cleanly from raw tokens or check-in URLs and hashes deterministically', () => {
    expect(normalizeAttendanceQrToken('  abc123token  ')).toBe('abc123token');
    expect(normalizeAttendanceQrToken('https://app.ludy.vn/o/demo/hr/my?qr=xyz-token-1')).toBe('xyz-token-1');
    expect(normalizeAttendanceQrToken('/o/demo/hr/my?foo=1&qr=my%2Btok')).toBe('my+tok');

    const h1 = hashAttendanceQrSecret('org-1', 'le-1', 'https://app.ludy.vn/o/demo/hr/my?qr=secret99');
    const h2 = hashAttendanceQrSecret('org-1', 'le-1', 'secret99');
    const h3 = hashAttendanceQrSecret('org-1', 'le-2', 'secret99');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(h3).not.toBe(h1);
  });

  it('detects all deterministic anomaly kinds without LLM calls', () => {
    const today = '2026-11-23';

    // Prior day open shift -> missing_checkout
    expect(
      detectAttendanceAnomalies({
        workDate: '2026-11-20',
        today,
        checkedInAt: new Date('2026-11-20T01:30:00Z'),
        checkedOutAt: null,
        workedMinutes: null,
        status: 'missing_checkout',
      }),
    ).toEqual(['missing_checkout']);

    // Today open shift is NOT falsely flagged as missing_checkout mid-shift
    expect(
      detectAttendanceAnomalies({
        workDate: today,
        today,
        checkedInAt: new Date('2026-11-23T01:30:00Z'),
        checkedOutAt: null,
        workedMinutes: null,
        status: 'missing_checkout',
      }),
    ).toEqual([]);

    // Short shift (< 4h = 240m)
    expect(
      detectAttendanceAnomalies({
        workDate: '2026-11-19',
        today,
        checkedInAt: new Date('2026-11-19T01:00:00Z'),
        checkedOutAt: new Date('2026-11-19T03:00:00Z'),
        workedMinutes: 120,
        status: 'half_day',
      }),
    ).toEqual(['short_day']);

    // Long shift (> 10h = 600m)
    expect(
      detectAttendanceAnomalies({
        workDate: '2026-11-18',
        today,
        checkedInAt: new Date('2026-11-18T01:00:00Z'),
        checkedOutAt: new Date('2026-11-18T12:30:00Z'),
        workedMinutes: 690,
        status: 'present',
      }),
    ).toEqual(['long_day']);

    // Sunday rest day (2026-11-22 is Sunday)
    expect(
      detectAttendanceAnomalies({
        workDate: '2026-11-22',
        today,
        checkedInAt: new Date('2026-11-22T01:30:00Z'),
        checkedOutAt: new Date('2026-11-22T09:30:00Z'),
        workedMinutes: 480,
        status: 'present',
      }),
    ).toEqual(['weekend_work']);

    // Vietnam National Day (2026-09-02) takes precedence as holiday_work
    expect(
      detectAttendanceAnomalies({
        workDate: '2026-09-02',
        today: '2026-09-03',
        checkedInAt: new Date('2026-09-02T01:30:00Z'),
        checkedOutAt: new Date('2026-09-02T09:30:00Z'),
        workedMinutes: 480,
        status: 'present',
      }),
    ).toEqual(['holiday_work']);
  });

  it('computes exact Vietnam (+07:00) night shift overlap minutes', () => {
    // 22:00 ICT -> 06:00 next day ICT (15:00Z -> 23:00Z) = 480 minutes night work
    expect(
      nightOverlapMinutes(new Date('2026-11-18T15:00:00Z'), new Date('2026-11-18T23:00:00Z')),
    ).toBe(480);

    // 14:00 ICT -> 00:00 next day ICT (07:00Z -> 17:00Z) = 120 night minutes (22:00-00:00)
    expect(
      nightOverlapMinutes(new Date('2026-11-18T07:00:00Z'), new Date('2026-11-18T17:00:00Z')),
    ).toBe(120);

    // Daytime 08:30 ICT -> 17:30 ICT (01:30Z -> 10:30Z) = 0 night minutes
    expect(
      nightOverlapMinutes(new Date('2026-11-18T01:30:00Z'), new Date('2026-11-18T10:30:00Z')),
    ).toBe(0);
  });

  it('rolls monthly attendance logs via decimal.js with 100% parity to timekeeping CSV import', () => {
    const baseInputs = zHrPayrollInputs.parse({ daysNotEmployed: '0' });

    // In 2026-09 (26 regular Mon-Sat working days, excluding Sundays 06/13/20/27 and holiday 09-02):
    // Take 22 regular Mon-Sat days (08:30-17:30 = 540m), 1 half-day (240m), 1 long shift with night work & OT (660m),
    // 1 Sunday (2026-09-27, 4h weekly_rest_day OT), and 1 holiday (2026-09-02, 4h holiday OT)
    // Plus 1.5 paid leave -> 23.5 worked + 1.5 paid = 25 out of 26 working days -> 1 unpaid day.
    const regularWeekdays = [
      '2026-09-01', '2026-09-03', '2026-09-04', '2026-09-05',
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12',
      '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19',
      '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26',
    ];
    const cleanEntries = [
      ...regularWeekdays.map((d) => ({
        workDate: d,
        checkedInAt: new Date(`${d}T01:30:00Z`),
        checkedOutAt: new Date(`${d}T10:30:00Z`),
        workedMinutes: 540,
        status: 'present' as const,
      })),
      {
        workDate: '2026-09-28',
        checkedInAt: new Date('2026-09-28T01:30:00Z'),
        checkedOutAt: new Date('2026-09-28T05:30:00Z'),
        workedMinutes: 240,
        status: 'half_day' as const,
      },
      {
        workDate: '2026-09-29',
        // 14:00 ICT (07:00Z) to 01:00 ICT next day (18:00Z) = 660m: 9h regular (1h night 22:00-23:00), 2h night OT (23:00-01:00)
        checkedInAt: new Date('2026-09-29T07:00:00Z'),
        checkedOutAt: new Date('2026-09-29T18:00:00Z'),
        workedMinutes: 660,
        status: 'present' as const,
      },
      {
        // Sunday 2026-09-27
        workDate: '2026-09-27',
        checkedInAt: new Date('2026-09-27T01:30:00Z'),
        checkedOutAt: new Date('2026-09-27T05:30:00Z'),
        workedMinutes: 240,
        status: 'present' as const,
      },
      {
        // National Day 2026-09-02
        workDate: '2026-09-02',
        checkedInAt: new Date('2026-09-02T01:30:00Z'),
        checkedOutAt: new Date('2026-09-02T05:30:00Z'),
        workedMinutes: 240,
        status: 'present' as const,
      },
    ];
    const rollup = computeEmployeeAttendanceRollup({
      workingDays: '26',
      payBasis: 'monthly',
      existingInputs: baseInputs,
      paidLeaveDays: '1.5',
      entries: cleanEntries,
    });

    expect(rollup.workedDays).toBe('23.5');
    expect(rollup.paidLeaveDays).toBe('1.5');
    expect(rollup.unpaidLeaveDays).toBe('1');
    expect(rollup.workedHours).toBeNull();
    expect(rollup.nightHours).toBe('1');
    expect(rollup.overtimeHours).toBe('10');
    expect(rollup.overtime).toEqual([
      { dayKind: 'weekly_rest_day', night: false, hours: '4' },
      { dayKind: 'holiday', night: false, hours: '4' },
      { dayKind: 'normal_day', night: true, hours: '2' },
    ]);

    // Verify 100% parity against CSV timekeeping parser output format
    const csv = [
      'Employee Code\tUnpaid Leave\tNormal Night OT\tWeekly Rest OT\tHoliday OT\tNight Hours',
      'NV001\t1\t2\t4\t4\t1',
    ].join('\n');
    const parsedCsv = parseTimekeepingSheet(csv, { month: '2026-09' });
    expect(parsedCsv.errors).toEqual([]);
    const csvInputs = parsedCsv.rows[0]!.payrollInputs;
    expect(rollup.unpaidLeaveDays).toBe(csvInputs.unpaidLeaveDays);
    expect(rollup.nightHours).toBe(csvInputs.nightHours);
    expect(rollup.overtime).toEqual(csvInputs.overtime);
  });

  it('computes workedHours for hourly payBasis cleanly via decimal.js', () => {
    const baseInputs = zHrPayrollInputs.parse({});
    const rollup = computeEmployeeAttendanceRollup({
      workingDays: '26',
      payBasis: 'hourly',
      existingInputs: baseInputs,
      paidLeaveDays: '0',
      entries: [
        {
          workDate: '2026-11-16',
          checkedInAt: new Date('2026-11-16T01:00:00Z'),
          checkedOutAt: new Date('2026-11-16T05:30:00Z'),
          workedMinutes: 270, // 4.5 hours
          status: 'half_day',
        },
        {
          workDate: '2026-11-17',
          checkedInAt: new Date('2026-11-17T01:00:00Z'),
          checkedOutAt: new Date('2026-11-17T09:00:00Z'),
          workedMinutes: 480, // 8 hours
          status: 'present',
        },
      ],
    });
    expect(rollup.workedHours).toBe('12.5');
    expect(rollup.overtimeHours).toBe('0');
  });
});
