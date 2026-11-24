// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for project cycles & story points contract schemas and deterministic burndown calculation (#4361).
import { describe, expect, it } from 'vitest';
import {
  zProjectCycleCompleteInput,
  zProjectCycleCreateInput,
  zProjectTaskSetPointsInput,
  zProjectUpdate,
} from '@ludy/kernel-contract';
import { assertTaskLeaseFree, computeCycleBurndown } from '../src/cycles.ts';

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
        carryover: { mode: 'none' },
      }).success,
    ).toBe(true);
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

  it('does not clamp tasks created after endsOn backward into Day-1 burndown scope', () => {
    const series = computeCycleBurndown(
      [
        { status: 'todo', storyPoints: 3, createdAt: '2027-02-01T02:00:00Z', updatedAt: '2027-02-01T02:00:00Z' },
        { status: 'todo', storyPoints: 8, createdAt: '2027-02-10T02:00:00Z', updatedAt: '2027-02-10T02:00:00Z' },
      ],
      '2027-02-01',
      '2027-02-05',
      'active',
      null,
      '2027-02-05T10:00:00Z',
    );
    expect(series).toHaveLength(5);
    expect(series.every((d) => d.remainingTasks === 1 && d.remainingPoints === 3)).toBe(true);
  });

  it('keeps actual remaining null for all days when a cycle was completed before its startsOn date', () => {
    const series = computeCycleBurndown(
      [{ status: 'done', storyPoints: 5, createdAt: '2027-02-01T02:00:00Z', updatedAt: '2027-02-01T03:00:00Z' }],
      '2027-02-10',
      '2027-02-12',
      'completed',
      '2027-02-05T10:00:00Z',
      '2027-02-15T10:00:00Z',
    );
    expect(series).toHaveLength(3);
    expect(series.every((d) => d.remainingTasks === null && d.remainingPoints === null)).toBe(true);
    expect(series[0]?.idealRemainingPoints).toBe(5);
    expect(series[2]?.idealRemainingPoints).toBe(0);
  });

  it('refuses cycle or points mutations with 409 TASK_CHECKED_OUT while an active agent lease holds the task', () => {
    const now = new Date('2027-02-01T10:00:00.000Z');
    expect(() =>
      assertTaskLeaseFree('00000000-0000-4000-8000-000000000010', '2027-02-01T10:15:00.000Z', now),
    ).toThrowError(expect.objectContaining({ code: 'TASK_CHECKED_OUT', status: 409 }));
    expect(() =>
      assertTaskLeaseFree('00000000-0000-4000-8000-000000000010', '2027-02-01T10:00:00.000Z', now),
    ).not.toThrow();
    expect(() => assertTaskLeaseFree(null, null, now)).not.toThrow();
  });

  it('attributes completion strictly by doneAt rather than later updatedAt edits, and clears on reopen', () => {
    const series = computeCycleBurndown(
      [
        // Done on day 2, edited on day 4 (updatedAt shifted forward, doneAt stayed day 2)
        {
          status: 'done',
          storyPoints: 5,
          createdAt: '2027-02-01T02:00:00Z',
          updatedAt: '2027-02-04T09:00:00Z',
          doneAt: '2027-02-02T03:00:00Z',
        },
        // Reopened task (doneAt cleared, updatedAt recent) stays remaining
        {
          status: 'todo',
          storyPoints: 3,
          createdAt: '2027-02-01T02:00:00Z',
          updatedAt: '2027-02-03T08:00:00Z',
          doneAt: null,
        },
      ],
      '2027-02-01',
      '2027-02-04',
      'active',
      null,
      '2027-02-04T10:00:00Z',
    );
    expect(series.map((d) => [d.remainingTasks, d.remainingPoints])).toEqual([
      [2, 8],
      [1, 3],
      [1, 3],
      [1, 3],
    ]);
  });

  it('preserves historical cycle membership, mid-sprint removals, re-entries, and carryover on close day', () => {
    const series = computeCycleBurndown(
      [
        // Finished Day 2, remained in cycle snapshot
        {
          status: 'done',
          storyPoints: 5,
          createdAt: '2027-02-01T02:00:00Z',
          updatedAt: '2027-02-03T10:00:00Z',
          doneAt: '2027-02-02T03:00:00Z',
          inCommittedScope: true,
          intervals: [{ joinedAt: '2027-02-01T02:00:00Z', leftAt: null, leftReason: null, storyPoints: 5 }],
        },
        // Carried over on close Day 3: still counts on Day 3 (closedOn)
        {
          status: 'in_progress',
          storyPoints: 8,
          createdAt: '2027-02-01T02:00:00Z',
          updatedAt: '2027-02-03T10:00:00Z',
          doneAt: null,
          inCommittedScope: true,
          intervals: [
            {
              joinedAt: '2027-02-01T02:00:00Z',
              leftAt: '2027-02-03T09:00:00Z',
              leftReason: 'carryover',
              storyPoints: 8,
            },
          ],
        },
        // Reassigned out on Day 3: active on Day 1..2, excluded from Day 3 and ideal baseline
        {
          status: 'todo',
          storyPoints: 3,
          createdAt: '2027-02-01T02:00:00Z',
          updatedAt: '2027-02-03T02:00:00Z',
          doneAt: null,
          inCommittedScope: false,
          intervals: [
            {
              joinedAt: '2027-02-01T02:00:00Z',
              leftAt: '2027-02-03T02:00:00Z',
              leftReason: 'reassigned',
              storyPoints: 3,
            },
          ],
        },
        // Backlog task created Jan 15, added Day 2, removed Day 3, re-added Day 3
        {
          status: 'todo',
          storyPoints: 4,
          createdAt: '2027-01-15T02:00:00Z',
          updatedAt: '2027-02-03T05:00:00Z',
          doneAt: null,
          inCommittedScope: true,
          intervals: [
            {
              joinedAt: '2027-02-02T02:00:00Z',
              leftAt: '2027-02-03T01:00:00Z',
              leftReason: 'removed_from_project',
              storyPoints: 4,
            },
            {
              joinedAt: '2027-02-03T05:00:00Z',
              leftAt: null,
              leftReason: null,
              storyPoints: 4,
            },
          ],
        },
      ],
      '2027-02-01',
      '2027-02-05',
      'completed',
      '2027-02-03T09:00:00Z',
      '2027-02-05T10:00:00Z',
    );

    // Ideal baseline uses committed scope: 5 + 8 + 4 = 17 points (3 tasks)
    expect(series[0]?.idealRemainingPoints).toBe(17);
    expect(series[0]?.idealRemainingTasks).toBe(3);
    // Day 1: 5 + 8 + 3 = 16 (Day 2 backlog joiner not yet in cycle)
    expect(series[0]?.remainingTasks).toBe(3);
    expect(series[0]?.remainingPoints).toBe(16);
    // Day 2: 5 burned down; 8 + 3 + 4 = 15
    expect(series[1]?.remainingTasks).toBe(3);
    expect(series[1]?.remainingPoints).toBe(15);
    // Day 3 (closedOn): reassigned 3 pts dropped; carryover 8 pts + re-added 4 pts = 12
    expect(series[2]?.remainingTasks).toBe(2);
    expect(series[2]?.remainingPoints).toBe(12);
    // Days 4..5 after closedOn stay null
    expect(series[3]?.remainingPoints).toBeNull();
    expect(series[4]?.remainingPoints).toBeNull();
  });

  it('keeps post-completion removed_from_project tasks active through closedOn', () => {
    const series = computeCycleBurndown(
      [
        {
          status: 'todo',
          storyPoints: 5,
          createdAt: '2027-02-01T02:00:00Z',
          updatedAt: '2027-02-03T10:00:00Z',
          doneAt: null,
          inCommittedScope: true,
          intervals: [
            {
              joinedAt: '2027-02-01T02:00:00Z',
              leftAt: '2027-02-03T11:00:00Z',
              leftReason: 'removed_from_project',
              storyPoints: 5,
            },
          ],
        },
      ],
      '2027-02-01',
      '2027-02-04',
      'completed',
      '2027-02-03T09:00:00Z',
      '2027-02-04T10:00:00Z',
    );
    expect(series.map((p) => p.remainingPoints)).toEqual([5, 5, 5, null]);
  });
});
