// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for project cycles & story points contract schemas and deterministic burndown calculation (#4361).
import { describe, expect, it } from 'vitest';
import {
  zProjectCycleCompleteInput,
  zProjectCycleCreateInput,
  zProjectTaskSetPointsInput,
  zProjectUpdate,
} from '@ludy/kernel-contract';
import { computeCycleBurndown } from '../src/cycles.ts';

describe('@ludy/mod-projects cycles (#4361)', () => {
  it('validates cycle duration (1..4 weeks), story points (0..100), and carryover union', () => {
    expect(
      zProjectUpdate.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        cyclesEnabled: true,
        cycleDurationWeeks: 2,
        pointsEnabled: true,
      }).success,
    ).toBe(true);
    expect(
      zProjectUpdate.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        cycleDurationWeeks: 5,
      }).success,
    ).toBe(false);

    expect(
      zProjectTaskSetPointsInput.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        taskId: '00000000-0000-4000-8000-000000000002',
        storyPoints: 0,
      }).success,
    ).toBe(true);
    expect(
      zProjectTaskSetPointsInput.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        taskId: '00000000-0000-4000-8000-000000000002',
        storyPoints: 100,
      }).success,
    ).toBe(true);
    expect(
      zProjectTaskSetPointsInput.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        taskId: '00000000-0000-4000-8000-000000000002',
        storyPoints: 101,
      }).success,
    ).toBe(false);

    expect(
      zProjectCycleCreateInput.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        name: '  Sprint 1  ',
      }).data?.name,
    ).toBe('Sprint 1');

    expect(
      zProjectCycleCompleteInput.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        cycleId: '00000000-0000-4000-8000-000000000002',
        carryover: { mode: 'backlog' },
      }).success,
    ).toBe(true);
    expect(
      zProjectCycleCompleteInput.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        cycleId: '00000000-0000-4000-8000-000000000002',
        carryover: { mode: 'cycle', targetCycleId: '00000000-0000-4000-8000-000000000003' },
      }).success,
    ).toBe(true);
  });

  it('computes deterministic daily burndown excluding cancelled tasks and future active days', () => {
    const tasks = [
      // Created day 1, done day 2 (8 pts)
      {
        status: 'done',
        storyPoints: 8,
        createdAt: '2027-02-01T02:00:00Z',
        updatedAt: '2027-02-02T04:00:00Z',
      },
      // Created day 1, still in progress (5 pts)
      {
        status: 'in_progress',
        storyPoints: 5,
        createdAt: '2027-02-01T02:00:00Z',
        updatedAt: '2027-02-02T05:00:00Z',
      },
      // Added day 3 (2 pts)
      {
        status: 'todo',
        storyPoints: 2,
        createdAt: '2027-02-03T02:00:00Z',
        updatedAt: '2027-02-03T02:00:00Z',
      },
      // Cancelled task ignored from committed scope (13 pts)
      {
        status: 'cancelled',
        storyPoints: 13,
        createdAt: '2027-02-01T02:00:00Z',
        updatedAt: '2027-02-02T03:00:00Z',
      },
    ];

    const series = computeCycleBurndown(
      tasks,
      '2027-02-01',
      '2027-02-05',
      'active',
      null,
      '2027-02-03T10:00:00Z', // 17:00 VN on 2027-02-03
    );

    expect(series).toHaveLength(5);
    expect(series[0]).toEqual({
      date: '2027-02-01',
      idealRemainingTasks: 3,
      idealRemainingPoints: 15,
      remainingTasks: 2,
      remainingPoints: 13,
    });
    expect(series[1]).toEqual({
      date: '2027-02-02',
      idealRemainingTasks: 2.3,
      idealRemainingPoints: 11.3,
      remainingTasks: 1,
      remainingPoints: 5,
    });
    expect(series[2]).toEqual({
      date: '2027-02-03',
      idealRemainingTasks: 1.5,
      idealRemainingPoints: 7.5,
      remainingTasks: 2,
      remainingPoints: 7,
    });
    // Future active days leave remaining values null while preserving ideal guideline.
    expect(series[3]).toEqual({
      date: '2027-02-04',
      idealRemainingTasks: 0.8,
      idealRemainingPoints: 3.8,
      remainingTasks: null,
      remainingPoints: null,
    });
    expect(series[4]).toEqual({
      date: '2027-02-05',
      idealRemainingTasks: 0,
      idealRemainingPoints: 0,
      remainingTasks: null,
      remainingPoints: null,
    });
  });

  it('keeps upcoming cycle actual remaining values null', () => {
    const series = computeCycleBurndown(
      [{ status: 'todo', storyPoints: 3, createdAt: '2027-02-01T02:00:00Z', updatedAt: '2027-02-01T02:00:00Z' }],
      '2027-02-10',
      '2027-02-12',
      'upcoming',
      null,
      '2027-02-01T02:00:00Z',
    );
    expect(series.every((d) => d.remainingTasks === null && d.remainingPoints === null)).toBe(true);
    expect(series[0]?.idealRemainingPoints).toBe(3);
    expect(series[2]?.idealRemainingPoints).toBe(0);
  });
});
