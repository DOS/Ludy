// SPDX-License-Identifier: AGPL-3.0-only
// Unit checks for Decimal billable money precision, CSV formula neutralization, and contract bounds (#2600).
import { describe, expect, it } from 'vitest';
import {
  zProjectTimeHourlyRate,
  zProjectTimeLogInput,
  zProjectTimeSummaryInput,
  zProjectTimeUpdateInput,
  zonedInstant,
} from '@ludy/kernel-contract';
import {
  computeTimeBillableAmount,
  computeTimeHoursString,
  normalizeHourlyRateInput,
  projectTimeCsvCell,
  resolveLogTimestamps,
  resolveUpdatedCompletedTimestamps,
  sumTimeBillableAmounts,
  validateEndedAndDuration,
} from '../src/index.ts';

describe('@ludy/mod-projects time tracking helpers (#2600)', () => {
  it('computes billable amounts with decimal precision and avoids IEEE-754 float drift', () => {
    // 20 minutes at 100,000.00 VND/hr -> 33,333.33 VND (rounded half-up to 2 decimal places).
    expect(computeTimeBillableAmount(20, '100000.00', true)).toBe('33333.33');
    // 40 minutes at 100,000.00 VND/hr -> 66,666.67 VND.
    expect(computeTimeBillableAmount(40, '100000.00', true)).toBe('66666.67');
    // 1 minute at 30.00 -> 0.50; 3 minutes at 10.00 -> 0.50.
    expect(computeTimeBillableAmount(1, '30.00', true)).toBe('0.50');
    // Large NUMERIC(18, 2) rate without precision loss (120 minutes = 2h).
    expect(computeTimeBillableAmount(120, '999999999999999.99', true)).toBe('1999999999999999.98');
    // Non-billable or missing rate/duration always returns null.
    expect(computeTimeBillableAmount(60, '500000.00', false)).toBeNull();
    expect(computeTimeBillableAmount(60, null, true)).toBeNull();
    expect(computeTimeBillableAmount(null, '500000.00', true)).toBeNull();

    expect(computeTimeHoursString(90)).toBe('1.50');
    expect(computeTimeHoursString(0)).toBe('0.00');
    expect(sumTimeBillableAmounts(['33333.33', '66666.67', null, undefined])).toBe('100000.00');
    expect(sumTimeBillableAmounts([])).toBe('0.00');
    expect(normalizeHourlyRateInput('150000')).toBe('150000.00');
    expect(normalizeHourlyRateInput(null)).toBeNull();
    expect(() => normalizeHourlyRateInput('-100')).toThrow();
  });

  it('neutralizes CSV spreadsheet formula injection prefixes and escapes quotes/commas', () => {
    expect(projectTimeCsvCell('=CMD("calc")')).toBe('"\'=CMD(""calc"")"');
    expect(projectTimeCsvCell('+1+2')).toBe("'+1+2");
    expect(projectTimeCsvCell('-SUM(A1:A2)')).toBe("'-SUM(A1:A2)");
    expect(projectTimeCsvCell('@IMPORTXML')).toBe("'@IMPORTXML");
    expect(projectTimeCsvCell('\t=2+2')).toBe("'\t=2+2");
    expect(projectTimeCsvCell('  =1+1')).toBe("'  =1+1");
    expect(projectTimeCsvCell('\r=1+1')).toBe('"\'\r=1+1"');
    expect(projectTimeCsvCell('Ghi chú, có dấu "ngoặc"')).toBe('"Ghi chú, có dấu ""ngoặc"""');
    expect(projectTimeCsvCell(null)).toBe('');
  });

  it('validates hourly rates, durations, and timestamp intervals at contract level', () => {
    const pid = '01900000-0000-7000-8000-000000000001';
    const eid = '01900000-0000-7000-8000-000000000002';

    expect(zProjectTimeHourlyRate.safeParse('0').success).toBe(true);
    expect(zProjectTimeHourlyRate.safeParse('500000.5').success).toBe(true);
    expect(zProjectTimeHourlyRate.safeParse('500000.50').success).toBe(true);
    expect(zProjectTimeHourlyRate.safeParse('-100').success).toBe(false);
    expect(zProjectTimeHourlyRate.safeParse('12.345').success).toBe(false);

    expect(
      zProjectTimeLogInput.safeParse({
        projectId: pid,
        startedAt: '2026-11-22T08:00:00Z',
        durationMinutes: 60,
        billable: true,
        hourlyRate: '200000',
      }).success,
    ).toBe(true);

    expect(
      zProjectTimeLogInput.safeParse({
        projectId: pid,
        startedAt: '2026-11-22T08:00:00Z',
        endedAt: '2026-11-22T07:59:00Z',
      }).success,
    ).toBe(false);

    expect(
      zProjectTimeLogInput.safeParse({
        projectId: pid,
        startedAt: '2026-11-22T08:00:00Z',
        durationMinutes: 14401,
      }).success,
    ).toBe(false);

    expect(
      zProjectTimeUpdateInput.safeParse({
        entryId: eid,
        startedAt: '2026-11-22T09:00:00Z',
        endedAt: '2026-11-22T08:00:00Z',
      }).success,
    ).toBe(false);

    expect(
      zProjectTimeSummaryInput.safeParse({
        projectId: pid,
        from: '2026-11-10',
        to: '2026-11-01',
      }).success,
    ).toBe(false);

    // Server interval consistency checks reject mismatched endedAt + durationMinutes or > 14,400m span.
    const start = new Date('2026-11-22T01:00:00.000Z');
    const end60 = new Date('2026-11-22T02:00:00.000Z');
    const endOverMax = new Date('2026-12-03T01:01:00.000Z');
    expect(validateEndedAndDuration(start, end60, 60)).toBe(60);
    expect(() => validateEndedAndDuration(start, end60, 15)).toThrow();
    expect(() => validateEndedAndDuration(start, endOverMax, 15)).toThrow();
    expect(() =>
      resolveLogTimestamps('2026-11-22T01:00:00.000Z', '2026-11-22T02:00:00.000Z', 15),
    ).toThrow();
    expect(
      resolveUpdatedCompletedTimestamps(start, end60, 60, { startedAt: '2026-11-22T02:00:00.000Z' }).endedAt.toISOString(),
    ).toBe('2026-11-22T03:00:00.000Z');
    expect(new Date(zonedInstant('+07:00', '2026-11-22', 0)).toISOString()).toBe('2026-11-21T17:00:00.000Z');
  });
});
