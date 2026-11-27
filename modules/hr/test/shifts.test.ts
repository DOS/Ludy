// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 7A (#5216): Pure deterministic unit tests for shift templates, adherence (grace windows),
// Art. 106 break-adjusted night hours, Art. 127 no-late-fine invariant, and coverage conflict analysis.
import { describe, expect, it } from 'vitest';
import {
  HR_DEFAULT_SHIFT_TEMPLATES,
  isValidShiftWindow,
  shiftDurationMinutes,
  zHrPayrollInputs,
  zHrShiftTemplateCreate,
} from '@ludy/kernel-contract';
import { computeEmployeeAttendanceRollup } from '../src/attendance.ts';
import {
  analyzeWeeklyShiftCoverage,
  computeShiftAdherence,
  computeShiftAdjustedNightMinutes,
  type ShiftTemplateWindow,
} from '../src/shifts.ts';

function toShiftWin(over: Partial<ShiftTemplateWindow> = {}): ShiftTemplateWindow {
  return {
    id: 'tpl-1',
    code: 'CA_HC',
    name: 'Ca hành chính',
    startMinute: 8 * 60,
    endMinute: 17 * 60,
    breakMinutes: 60,
    graceLateMinutes: 15,
    graceEarlyMinutes: 15,
    crossesMidnight: false,
    ...over,
  };
}

describe('HR Stage 7A deterministic shift & coverage logic (#5216)', () => {
  it('validates default SME shift presets, overnight windows, and break < duration bounds', () => {
    expect(HR_DEFAULT_SHIFT_TEMPLATES.map((t) => t.code)).toEqual(['CA_HC', 'CA_SANG', 'CA_CHIEU', 'CA_DEM']);
    for (const preset of HR_DEFAULT_SHIFT_TEMPLATES) {
      expect(isValidShiftWindow(preset.startMinute, preset.endMinute, preset.breakMinutes, preset.crossesMidnight)).toBe(
        true,
      );
    }

    expect(shiftDurationMinutes(22 * 60, 6 * 60, true)).toBe(480);
    expect(isValidShiftWindow(17 * 60, 8 * 60, 60, false)).toBe(false);
    expect(isValidShiftWindow(8 * 60, 12 * 60, 240, false)).toBe(false);
    expect(zHrShiftTemplateCreate.safeParse({ code: 'ca_dem', name: 'Ca đêm', startMinute: 1320, endMinute: 360, breakMinutes: 0, crossesMidnight: true }).success).toBe(true);
    expect(zHrShiftTemplateCreate.safeParse({ code: 'bad', name: 'Invalid', startMinute: 1320, endMinute: 360, breakMinutes: 0, crossesMidnight: false }).success).toBe(false);
  });

  it('computes per-log lateMinutes and earlyLeaveMinutes respecting grace thresholds', () => {
    const officeShift = toShiftWin();

    // Arrives 08:15 (within 15m grace) and leaves 16:45 (within 15m grace) -> 0 late, 0 early.
    expect(
      computeShiftAdherence({
        workDate: '2027-04-05',
        checkedInAt: new Date('2027-04-05T08:15:00+07:00'),
        checkedOutAt: new Date('2027-04-05T16:45:00+07:00'),
        status: 'present',
        shift: officeShift,
      }),
    ).toEqual({ lateMinutes: 0, earlyLeaveMinutes: 0 });

    // Arrives 08:16 (past 15m grace) and leaves 16:40 (20m early, past 15m grace).
    expect(
      computeShiftAdherence({
        workDate: '2027-04-05',
        checkedInAt: new Date('2027-04-05T08:16:00+07:00'),
        checkedOutAt: new Date('2027-04-05T16:40:00+07:00'),
        status: 'present',
        shift: officeShift,
      }),
    ).toEqual({ lateMinutes: 16, earlyLeaveMinutes: 20 });

    // Missing checkout does not emit earlyLeaveMinutes.
    expect(
      computeShiftAdherence({
        workDate: '2027-04-05',
        checkedInAt: new Date('2027-04-05T08:30:00+07:00'),
        checkedOutAt: null,
        status: 'missing_checkout',
        shift: officeShift,
      }),
    ).toEqual({ lateMinutes: 30, earlyLeaveMinutes: 0 });

    // Overnight CA_DEM 22:00-06:00 exact clock -> 0 late, 0 early.
    const nightShift = toShiftWin({
      code: 'CA_DEM',
      name: 'Ca đêm',
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      breakMinutes: 0,
      crossesMidnight: true,
    });
    expect(
      computeShiftAdherence({
        workDate: '2027-04-05',
        checkedInAt: new Date('2027-04-05T22:05:00+07:00'),
        checkedOutAt: new Date('2027-04-06T05:55:00+07:00'),
        status: 'present',
        shift: nightShift,
      }),
    ).toEqual({ lateMinutes: 0, earlyLeaveMinutes: 0 });
  });

  it('calculates Art. 106 night hours (including Art. 109(1) paid breaks) via decimal.js without Art. 127 late fines', () => {
    const nightWith60mBreak = toShiftWin({
      code: 'CA_DEM_NGHI',
      name: 'Ca đêm có nghỉ',
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      breakMinutes: 60,
      crossesMidnight: true,
    });
    const splitShift60mBreak = toShiftWin({
      code: 'CA_TOI_60',
      name: 'Ca tối nửa đêm',
      startMinute: 18 * 60,
      endMinute: 2 * 60,
      breakMinutes: 60,
      crossesMidnight: true,
    });

    // Pure night helper checks (Art. 106 22:00-06:00 raw overlap without deducting Art. 109(1) paid breaks):
    expect(
      computeShiftAdjustedNightMinutes(
        new Date('2027-04-05T22:00:00+07:00'),
        new Date('2027-04-06T06:00:00+07:00'),
        480,
      ),
    ).toBe(480);
    expect(
      computeShiftAdjustedNightMinutes(
        new Date('2027-04-05T18:00:00+07:00'),
        new Date('2027-04-06T02:00:00+07:00'),
        480,
      ),
    ).toBe(240);
    // Respects worked-minutes cap when shift span exceeds regular cap
    expect(
      computeShiftAdjustedNightMinutes(
        new Date('2027-04-05T22:00:00+07:00'),
        new Date('2027-04-06T06:00:00+07:00'),
        300,
      ),
    ).toBe(300);

    // Rollup keeps existing inputs intact, credits raw Art. 106 nightHours (Art. 109(1) break included in paid time), and creates 0 late wage deductions (Art. 127).
    const existingInputs = zHrPayrollInputs.parse({ deductions: [] });
    const splitRollup = computeEmployeeAttendanceRollup({
      month: '2027-04',
      workingDays: '26',
      payBasis: 'monthly',
      existingInputs,
      paidLeaveDays: '0',
      entries: [
        {
          workDate: '2027-04-05',
          checkedInAt: new Date('2027-04-05T18:30:00+07:00'), // 30m late
          checkedOutAt: new Date('2027-04-06T02:00:00+07:00'),
          workedMinutes: 450,
          status: 'present',
          shift: splitShift60mBreak,
        },
      ],
    });
    expect(splitRollup.nightHours).toBe('4'); // raw 22:00-02:00 overlap = 240m -> 4h (breaks not subtracted under Art. 109(1))
    expect(splitRollup.workedDays).toBe('1');
    expect(existingInputs.deductions).toEqual([]);

    const fullNightRollup = computeEmployeeAttendanceRollup({
      month: '2027-04',
      workingDays: '26',
      payBasis: 'monthly',
      existingInputs,
      paidLeaveDays: '0',
      entries: [
        {
          workDate: '2027-04-06',
          checkedInAt: new Date('2027-04-06T22:00:00+07:00'),
          checkedOutAt: new Date('2027-04-07T06:00:00+07:00'),
          workedMinutes: 480,
          status: 'present',
          shift: nightWith60mBreak,
        },
      ],
    });
    expect(fullNightRollup.nightHours).toBe('8');
  });

  it('detects leave, trip, holiday, and < 12h short-rest conflicts and ranks clean replacement candidates', () => {
    const analysis = analyzeWeeklyShiftCoverage({
      weekStart: '2027-04-26',
      weekEnd: '2027-05-02',
      employees: [
        { id: 'e1', displayName: 'Nguyễn Văn A', departmentId: 'd1', departmentName: 'Kho' },
        { id: 'e2', displayName: 'Trần Thị B', departmentId: 'd1', departmentName: 'Kho' },
        { id: 'e3', displayName: 'Lê Văn C', departmentId: 'd2', departmentName: 'Bán hàng' },
        { id: 'e4', displayName: 'Phạm Thị D', departmentId: 'd1', departmentName: 'Kho' },
      ],
      assignmentsInExtendedWindow: [
        // e1 has CA_CHIEU on 2027-04-27 (ends 22:00) AND CA_SANG on 2027-04-28 (starts 06:00 -> 8h rest < 12h)
        // AND has approved leave on 2027-04-28
        {
          id: 'a1',
          employeeId: 'e1',
          employeeName: 'Nguyễn Văn A',
          departmentId: 'd1',
          departmentName: 'Kho',
          shiftTemplateId: 't-chieu',
          shiftCode: 'CA_CHIEU',
          shiftName: 'Ca chiều',
          startMinute: 14 * 60,
          endMinute: 22 * 60,
          crossesMidnight: false,
          workDate: '2027-04-27',
        },
        {
          id: 'a2',
          employeeId: 'e1',
          employeeName: 'Nguyễn Văn A',
          departmentId: 'd1',
          departmentName: 'Kho',
          shiftTemplateId: 't-sang',
          shiftCode: 'CA_SANG',
          shiftName: 'Ca sáng',
          startMinute: 6 * 60,
          endMinute: 14 * 60,
          crossesMidnight: false,
          workDate: '2027-04-28',
        },
        // e2 is scheduled on 2027-04-29 with approved business trip and 2027-04-30 VN public holiday
        {
          id: 'a3',
          employeeId: 'e2',
          employeeName: 'Trần Thị B',
          departmentId: 'd1',
          departmentName: 'Kho',
          shiftTemplateId: 't-hc',
          shiftCode: 'CA_HC',
          shiftName: 'Ca hành chính',
          startMinute: 8 * 60,
          endMinute: 17 * 60,
          crossesMidnight: false,
          workDate: '2027-04-29',
        },
        {
          id: 'a4',
          employeeId: 'e2',
          employeeName: 'Trần Thị B',
          departmentId: 'd1',
          departmentName: 'Kho',
          shiftTemplateId: 't-hc',
          shiftCode: 'CA_HC',
          shiftName: 'Ca hành chính',
          startMinute: 8 * 60,
          endMinute: 17 * 60,
          crossesMidnight: false,
          workDate: '2027-04-30',
        },
        // e4 has CA_DEM on 2027-04-27 ending 06:00 on 2027-04-28 -> putting e4 on CA_SANG 06:00 on 2027-04-28 is 0h rest (< 12h), so e4 must be excluded as candidate for a2!
        {
          id: 'a5',
          employeeId: 'e4',
          employeeName: 'Phạm Thị D',
          departmentId: 'd1',
          departmentName: 'Kho',
          shiftTemplateId: 't-dem',
          shiftCode: 'CA_DEM',
          shiftName: 'Ca đêm',
          startMinute: 22 * 60,
          endMinute: 6 * 60,
          crossesMidnight: true,
          workDate: '2027-04-27',
        },
      ],
      unavailabilities: [
        { employeeId: 'e1', source: 'leave', startOn: '2027-04-28', endOn: '2027-04-28' },
        { employeeId: 'e2', source: 'trip', startOn: '2027-04-29', endOn: '2027-04-29' },
      ],
    });

    expect(analysis.conflicts.map((c) => c.kind)).toEqual(
      expect.arrayContaining(['approved_leave', 'short_rest', 'approved_trip', 'public_holiday']),
    );

    const apr28Gap = analysis.gaps.find((g) => g.date === '2027-04-28' && g.shiftCode === 'CA_SANG');
    expect(apr28Gap).toBeDefined();
    // e4 ended night shift at 06:00 on 2027-04-28 (0h rest before 06:00 CA_SANG) so e4 is excluded; e2 is free on 04-28 (and same dept d1) ahead of e3 (dept d2).
    const candIds = apr28Gap?.candidates.map((c) => c.employeeId) ?? [];
    expect(candIds).not.toContain('e1');
    expect(candIds).not.toContain('e4');
    expect(candIds[0]).toBe('e2');
  });
});
