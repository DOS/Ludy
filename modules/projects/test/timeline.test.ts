// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for pure project timeline domain logic (#2599):
// date-range validation (Vietnam UTC+7), dependency conflict detection, and critical path calculation.
import { describe, expect, it } from 'vitest';
import {
  computeCriticalPath,
  detectTimelineConflicts,
  isValidScheduleRange,
  taskScheduleSpanDays,
  timelineDaysBetween,
} from '../src/index.ts';

describe('timeline schedule range validation (#2599)', () => {
  it('accepts open-ended schedules and startOn <= vietnamDate(due), rejecting startOn > vietnamDate(due)', () => {
    expect(isValidScheduleRange(null, null)).toBe(true);
    expect(isValidScheduleRange('2026-11-20', null)).toBe(true);
    expect(isValidScheduleRange(null, '2026-11-20T16:59:00.000Z')).toBe(true);
    // 2026-11-20T16:59:00.000Z is 2026-11-20 23:59 +07:00 (Vietnam day 2026-11-20).
    expect(isValidScheduleRange('2026-11-20', '2026-11-20T16:59:00.000Z')).toBe(true);
    // 2026-11-20T17:00:00.000Z is 2026-11-21 00:00 +07:00 (Vietnam day 2026-11-21).
    expect(isValidScheduleRange('2026-11-21', '2026-11-20T17:00:00.000Z')).toBe(true);
    expect(isValidScheduleRange('2026-11-21', '2026-11-20T16:59:00.000Z')).toBe(false);
    expect(isValidScheduleRange('2026-11-25', '2026-11-20T23:59:00+07:00')).toBe(false);
  });

  it('computes inclusive task schedule span days', () => {
    expect(timelineDaysBetween('2026-11-25', '2026-11-20')).toBe(5);
    expect(taskScheduleSpanDays({ startOn: '2026-11-20', due: '2026-11-22T16:59:00.000Z' })).toBe(3);
    expect(taskScheduleSpanDays({ startOn: '2026-11-20', due: '2026-11-20T16:59:00.000Z' })).toBe(1);
    expect(taskScheduleSpanDays({ startOn: '2026-11-20', due: null })).toBe(1);
    expect(taskScheduleSpanDays({ startOn: null, due: null })).toBe(1);
  });
});

describe('timeline conflict detection (#2599)', () => {
  it('flags blocker due > blocked startOn, and falls back to blocked due when startOn is null', () => {
    const tasks = [
      { id: 't1', status: 'todo' as const, startOn: '2026-11-01', due: '2026-11-10T16:59:00.000Z' },
      { id: 't2', status: 'todo' as const, startOn: '2026-11-08', due: '2026-11-12T16:59:00.000Z' },
      { id: 't3', status: 'in_progress' as const, startOn: null, due: '2026-11-09T16:59:00.000Z' },
      { id: 't4', status: 'todo' as const, startOn: '2026-11-10', due: '2026-11-15T16:59:00.000Z' },
      { id: 't5', status: 'todo' as const, startOn: null, due: null },
      { id: 't6', status: 'cancelled' as const, startOn: '2026-11-02', due: '2026-11-03T16:59:00.000Z' },
    ];
    const edges = [
      { id: 'e1', blockerTaskId: 't1', blockedTaskId: 't2' }, // conflict: Nov 10 > startOn Nov 08
      { id: 'e2', blockerTaskId: 't1', blockedTaskId: 't3' }, // conflict: Nov 10 > due Nov 09 (startOn null)
      { id: 'e3', blockerTaskId: 't1', blockedTaskId: 't4' }, // OK: Nov 10 === startOn Nov 10
      { id: 'e4', blockerTaskId: 't1', blockedTaskId: 't5' }, // OK: unscheduled blocked
      { id: 'e5', blockerTaskId: 't5', blockedTaskId: 't2' }, // OK: blocker due is null
      { id: 'e6', blockerTaskId: 't1', blockedTaskId: 't6' }, // skipped: cancelled
    ];

    expect(detectTimelineConflicts(tasks, edges)).toEqual([
      {
        dependencyId: 'e1',
        blockerTaskId: 't1',
        blockedTaskId: 't2',
        blockerDueDate: '2026-11-10',
        blockedTargetDate: '2026-11-08',
        blockedField: 'start_on',
      },
      {
        dependencyId: 'e2',
        blockerTaskId: 't1',
        blockedTaskId: 't3',
        blockerDueDate: '2026-11-10',
        blockedTargetDate: '2026-11-09',
        blockedField: 'due',
      },
    ]);
  });
});

describe('critical path calculation (#2599)', () => {
  it('returns empty when no open dependency edges exist', () => {
    expect(
      computeCriticalPath(
        [
          { id: 'a', status: 'todo', startOn: '2026-11-01', due: '2026-11-03T16:59:00.000Z' },
          { id: 'b', status: 'done', startOn: '2026-11-01', due: '2026-11-05T16:59:00.000Z' },
          { id: 'c', status: 'todo', startOn: null, due: null },
        ],
        [{ blockerTaskId: 'b', blockedTaskId: 'c' }],
      ),
    ).toEqual({
      criticalPathTaskIds: [],
      criticalPathLength: 0,
      criticalPathSpanDays: 0,
    });
  });

  it('finds the longest open dependency chain and breaks equal-length ties by span days then ID order', () => {
    const tasks = [
      { id: 'a', status: 'todo' as const, startOn: '2026-11-01', due: '2026-11-02T16:59:00.000Z' }, // 2d
      { id: 'b', status: 'in_progress' as const, startOn: '2026-11-03', due: '2026-11-03T16:59:00.000Z' }, // 1d
      { id: 'c', status: 'waiting' as const, startOn: '2026-11-04', due: '2026-11-08T16:59:00.000Z' }, // 5d
      { id: 'd', status: 'todo' as const, startOn: '2026-11-04', due: '2026-11-05T16:59:00.000Z' }, // 2d
      { id: 'e', status: 'todo' as const, startOn: '2026-11-09', due: '2026-11-10T16:59:00.000Z' }, // 2d
      { id: 'z', status: 'done' as const, startOn: '2026-11-01', due: '2026-11-20T16:59:00.000Z' }, // excluded
    ];
    // Diamond + tail:
    // a -> b -> c -> e (4 tasks, 2+1+5+2 = 10d)
    // a -> b -> d -> e (4 tasks, 2+1+2+2 = 7d)
    // z -> a (ignored because z is done)
    const edges = [
      { blockerTaskId: 'z', blockedTaskId: 'a' },
      { blockerTaskId: 'a', blockedTaskId: 'b' },
      { blockerTaskId: 'b', blockedTaskId: 'c' },
      { blockerTaskId: 'b', blockedTaskId: 'd' },
      { blockerTaskId: 'c', blockedTaskId: 'e' },
      { blockerTaskId: 'd', blockedTaskId: 'e' },
    ];

    expect(computeCriticalPath(tasks, edges)).toEqual({
      criticalPathTaskIds: ['a', 'b', 'c', 'e'],
      criticalPathLength: 4,
      criticalPathSpanDays: 10,
    });
  });

  it('handles equal-length & equal-span ties deterministically and guards against cycles', () => {
    const tasks = [
      { id: 't2', status: 'todo' as const, startOn: null, due: null },
      { id: 't1', status: 'todo' as const, startOn: null, due: null },
      { id: 't3', status: 'todo' as const, startOn: null, due: null },
      { id: 't4', status: 'todo' as const, startOn: null, due: null },
    ];
    // Two disjoint 2-task chains: (t1 -> t3) vs (t2 -> t4). Lexicographically t1,t3 < t2,t4.
    const res = computeCriticalPath(tasks, [
      { blockerTaskId: 't2', blockedTaskId: 't4' },
      { blockerTaskId: 't1', blockedTaskId: 't3' },
    ]);
    expect(res).toEqual({
      criticalPathTaskIds: ['t1', 't3'],
      criticalPathLength: 2,
      criticalPathSpanDays: 2,
    });

    // Defensive cycle guard does not hang if corrupted cycle data is passed.
    const cyclic = computeCriticalPath(tasks.slice(0, 2), [
      { blockerTaskId: 't1', blockedTaskId: 't2' },
      { blockerTaskId: 't2', blockedTaskId: 't1' },
    ]);
    expect(cyclic.criticalPathLength).toBe(2);
    expect(cyclic.criticalPathTaskIds).toEqual(['t1', 't2']);
  });
});
