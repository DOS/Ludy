// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for modules/projects/src/today.ts (#2596): deterministic projection rules, deduplication,
// Vietnam calendar day boundaries, vacant vs unassigned seat semantics, and TODAY_ITEMS_MAX capping.
import { describe, expect, it } from 'vitest';
import { TODAY_ITEMS_MAX, todayCoworkerKey, zTodayItems } from '@ludy/kernel-contract';
import { projectsTodayItemsOf, STUCK_WAITING_DAYS, type ProjectTodayRow } from '../src/today.ts';

const ME = '0190c4a1-0000-7000-8000-000000000001';
const OTHER = '0190c4a1-0000-7000-8000-000000000002';
const AGENT = '0190c4a1-0000-7000-8000-000000000003';
const PROJECT_ID = '0190c4a1-0000-7000-8000-000000000100';
const SEAT_ME = '0190c4a1-0000-7000-8000-000000000201';
const SEAT_VACANT = '0190c4a1-0000-7000-8000-000000000202';
const SEAT_AGENT = '0190c4a1-0000-7000-8000-000000000203';

// 2026-11-10 10:00:00+07:00
const NOW = new Date('2026-11-10T03:00:00.000Z');
const taskId = (n: number) => `0190c4a1-0000-7000-8000-${String(n).padStart(12, '0')}`;

const row = (over: Partial<ProjectTodayRow> = {}): ProjectTodayRow => ({
  taskId: taskId(1),
  projectId: PROJECT_ID,
  ownerUserId: OTHER,
  status: 'todo',
  due: null,
  updatedAt: new Date(NOW.getTime() - 3_600_000),
  createdAt: new Date(NOW.getTime() - 86_400_000),
  assigneePositionId: SEAT_ME,
  holderUserId: ME,
  holderAgentId: null,
  positionStatus: 'active',
  ...over,
});

describe('projects.today pure projection (#2596)', () => {
  it('routes app "projects" to Vy ("gm") with zero model usage', () => {
    expect(todayCoworkerKey('projects')).toBe('gm');
    expect(STUCK_WAITING_DAYS).toBe(3);
  });

  it('emits warn flags for overdue tasks on the member seat and deduplicates when also project owner', () => {
    const twoDaysLate = new Date(NOW.getTime() - 2 * 86_400_000 - 3_600_000);
    const twoHoursLate = new Date(NOW.getTime() - 2 * 3_600_000);
    const items = projectsTodayItemsOf(
      [
        row({ taskId: taskId(1), due: twoDaysLate, ownerUserId: ME }),
        row({ taskId: taskId(2), due: twoHoursLate, ownerUserId: OTHER }),
      ],
      { userId: ME, role: 'member', now: NOW },
    );

    expect(items).toEqual([
      {
        kind: 'flag',
        app: 'projects',
        id: `overdue:${taskId(1)}`,
        title: { key: 'projects.taskOverdueDays', params: { days: 2 } },
        severity: 'warn',
        dueAt: twoDaysLate.toISOString(),
        href: `/projects/${PROJECT_ID}`,
      },
      {
        kind: 'flag',
        app: 'projects',
        id: `overdue:${taskId(2)}`,
        title: { key: 'projects.taskOverdue', params: {} },
        severity: 'warn',
        dueAt: twoHoursLate.toISOString(),
        href: `/projects/${PROJECT_ID}`,
      },
    ]);
    expect(zTodayItems.safeParse(items).success).toBe(true);
  });

  it('emits deadlines for due-today tasks using Vietnam calendar day (UTC+7)', () => {
    // 2026-11-10 02:00:00+07:00 = 2026-11-09 19:00:00 UTC (differs in UTC, same VN day)
    const vnMorning = new Date('2026-11-09T19:00:00.000Z');
    // 2026-11-10 23:30:00+07:00 = 2026-11-10 16:30:00 UTC
    const dueTonightVn = new Date('2026-11-10T16:30:00.000Z');
    // 2026-11-11 08:00:00+07:00 (tomorrow in VN)
    const dueTomorrowVn = new Date('2026-11-11T01:00:00.000Z');

    const memberItems = projectsTodayItemsOf(
      [
        row({ taskId: taskId(1), due: dueTonightVn }),
        row({ taskId: taskId(2), due: dueTomorrowVn }),
        // Unassigned root task owned by a member project owner is not on a member seat -> not a member deadline
        row({
          taskId: taskId(3),
          ownerUserId: ME,
          assigneePositionId: null,
          holderUserId: null,
          positionStatus: null,
          due: dueTonightVn,
        }),
      ],
      { userId: ME, role: 'member', now: vnMorning },
    );

    expect(memberItems).toEqual([
      {
        kind: 'deadline',
        app: 'projects',
        id: `due:${taskId(1)}`,
        title: { key: 'projects.taskDueToday', params: {} },
        dueAt: dueTonightVn.toISOString(),
        href: `/projects/${PROJECT_ID}`,
      },
    ]);

    // Solo org owner with no seats sees unassigned due-today tasks without triggering vacantSeat.
    const soloOwnerItems = projectsTodayItemsOf(
      [
        row({
          taskId: taskId(3),
          ownerUserId: ME,
          assigneePositionId: null,
          holderUserId: null,
          positionStatus: null,
          due: dueTonightVn,
        }),
      ],
      { userId: ME, role: 'owner', now: vnMorning },
    );

    expect(soloOwnerItems).toEqual([
      {
        kind: 'deadline',
        app: 'projects',
        id: `due:${taskId(3)}`,
        title: { key: 'projects.taskDueToday', params: {} },
        dueAt: dueTonightVn.toISOString(),
        href: `/projects/${PROJECT_ID}`,
      },
    ]);
  });

  it('emits owner flags for overdue, vacant seat, and 3-day waiting without counting unassigned or agent-held seats', () => {
    const waiting3Days = new Date(NOW.getTime() - 3 * 86_400_000);
    const waitingUnder3Days = new Date(NOW.getTime() - 3 * 86_400_000 + 60_000);
    const lateOther = new Date(NOW.getTime() - 86_400_000);

    const items = projectsTodayItemsOf(
      [
        // Owner's overdue task held by someone else
        row({ taskId: taskId(1), ownerUserId: ME, assigneePositionId: SEAT_AGENT, holderUserId: OTHER, due: lateOther }),
        // Owner's task waiting exactly 3 days
        row({
          taskId: taskId(2),
          ownerUserId: ME,
          status: 'waiting',
          updatedAt: waiting3Days,
          assigneePositionId: SEAT_AGENT,
          holderUserId: OTHER,
        }),
        // Owner's task waiting 2 days 23h59m -> NOT included
        row({
          taskId: taskId(3),
          ownerUserId: ME,
          status: 'waiting',
          updatedAt: waitingUnder3Days,
          assigneePositionId: SEAT_AGENT,
          holderUserId: OTHER,
        }),
        // Vacant seat -> included
        row({
          taskId: taskId(4),
          ownerUserId: ME,
          assigneePositionId: SEAT_VACANT,
          holderUserId: null,
          holderAgentId: null,
        }),
        // Agent-held seat -> NOT vacant
        row({
          taskId: taskId(5),
          ownerUserId: ME,
          assigneePositionId: SEAT_AGENT,
          holderUserId: null,
          holderAgentId: AGENT,
        }),
        // Unassigned solo-owner task (assignee_position_id IS NULL) -> NOT vacant
        row({
          taskId: taskId(6),
          ownerUserId: ME,
          assigneePositionId: null,
          holderUserId: null,
          holderAgentId: null,
          positionStatus: null,
        }),
        // Closed task -> excluded
        row({
          taskId: taskId(7),
          ownerUserId: ME,
          status: 'done',
          assigneePositionId: SEAT_VACANT,
          holderUserId: null,
          holderAgentId: null,
        }),
        // Archived seat held by user -> excluded for member seat check
        row({
          taskId: taskId(8),
          ownerUserId: OTHER,
          positionStatus: 'archived',
          due: lateOther,
        }),
        // Archived unheld seat -> NOT a vacant seat
        row({
          taskId: taskId(9),
          ownerUserId: ME,
          assigneePositionId: SEAT_VACANT,
          holderUserId: null,
          holderAgentId: null,
          positionStatus: 'archived',
        }),
      ],
      { userId: ME, role: 'member', now: NOW },
    );

    expect(items.map((i) => `${i.id}:${i.title.key}`)).toEqual([
      `overdue:${taskId(1)}:projects.ownerTaskOverdueDays`,
      `waiting:${taskId(2)}:projects.waitingStuck`,
      `vacant:${taskId(4)}:projects.vacantSeat`,
    ]);
    expect(items.find((i) => i.id === `waiting:${taskId(2)}`)?.title.params).toEqual({ days: 3 });
  });

  it('falls back to org owners when project owner_user_id is null and returns [] for viewers', () => {
    const late = new Date(NOW.getTime() - 2 * 86_400_000);
    const waiting3Days = new Date(NOW.getTime() - 3 * 86_400_000);
    const orphanedRows = [
      row({
        taskId: taskId(1),
        ownerUserId: null,
        assigneePositionId: SEAT_AGENT,
        holderUserId: OTHER,
        due: late,
      }),
      row({
        taskId: taskId(2),
        ownerUserId: null,
        status: 'waiting',
        updatedAt: waiting3Days,
        assigneePositionId: SEAT_AGENT,
        holderUserId: OTHER,
      }),
      row({
        taskId: taskId(3),
        ownerUserId: null,
        assigneePositionId: SEAT_VACANT,
        holderUserId: null,
        holderAgentId: null,
      }),
    ];

    expect(projectsTodayItemsOf(orphanedRows, { userId: ME, role: 'owner', now: NOW }).map((i) => i.id)).toEqual([
      `overdue:${taskId(1)}`,
      `waiting:${taskId(2)}`,
      `vacant:${taskId(3)}`,
    ]);
    expect(projectsTodayItemsOf(orphanedRows, { userId: ME, role: 'admin', now: NOW })).toEqual([]);
    expect(projectsTodayItemsOf(orphanedRows, { userId: ME, role: 'member', now: NOW })).toEqual([]);

    // Even if a demoted viewer still owns a project or holds a seat, projects.today emits nothing actionable.
    const viewerRows = [
      row({ taskId: taskId(4), ownerUserId: ME, due: late }),
      row({ taskId: taskId(5), ownerUserId: ME, status: 'waiting', updatedAt: waiting3Days }),
    ];
    expect(projectsTodayItemsOf(viewerRows, { userId: ME, role: 'viewer', now: NOW })).toEqual([]);
  });

  it('emits at most one highest-urgency item per task and caps at TODAY_ITEMS_MAX with exact task count in projects.more', () => {
    const late = new Date(NOW.getTime() - 2 * 86_400_000);
    const waiting4Days = new Date(NOW.getTime() - 4 * 86_400_000);
    const dueTonightVn = new Date('2026-11-10T16:30:00.000Z'); // 23:30+07:00

    // A single task meeting all flag conditions yields one item (overdue > waiting > vacant > dueToday).
    const multiFlagItems = projectsTodayItemsOf(
      [
        row({
          taskId: taskId(1),
          ownerUserId: ME,
          status: 'waiting',
          due: late,
          updatedAt: waiting4Days,
          assigneePositionId: SEAT_VACANT,
          holderUserId: null,
          holderAgentId: null,
        }),
        row({
          taskId: taskId(2),
          ownerUserId: ME,
          status: 'waiting',
          due: dueTonightVn,
          updatedAt: waiting4Days,
          assigneePositionId: SEAT_VACANT,
          holderUserId: null,
          holderAgentId: null,
        }),
        // Duplicate taskId across two projects emits once.
        row({ taskId: taskId(3), projectId: '0190c4a1-0000-7000-8000-000000000101', ownerUserId: ME, due: late }),
        row({ taskId: taskId(3), projectId: '0190c4a1-0000-7000-8000-000000000102', ownerUserId: ME, due: late }),
      ],
      { userId: ME, role: 'member', now: NOW },
    );
    expect(multiFlagItems.map((i) => i.id)).toEqual([
      `overdue:${taskId(1)}`,
      `overdue:${taskId(3)}`,
      `waiting:${taskId(2)}`,
    ]);

    // 100 multi-flag tasks must stay 100 items without overflowing into a spurious projects.more row.
    const hundredMultiFlag = Array.from({ length: 100 }, (_, idx) =>
      row({
        taskId: taskId(idx + 1),
        ownerUserId: ME,
        status: 'waiting',
        due: new Date(NOW.getTime() - (idx + 1) * 3_600_000),
        updatedAt: waiting4Days,
        assigneePositionId: SEAT_VACANT,
        holderUserId: null,
        holderAgentId: null,
      }),
    );
    expect(projectsTodayItemsOf(hundredMultiFlag, { userId: ME, role: 'member', now: NOW })).toHaveLength(100);

    // TODAY_ITEMS_MAX + 5 multi-flag tasks still report exactly 6 remaining tasks in projects.more.
    const overflowRows = Array.from({ length: TODAY_ITEMS_MAX + 5 }, (_, idx) =>
      row({
        taskId: taskId(idx + 1),
        ownerUserId: ME,
        status: 'waiting',
        due: new Date(NOW.getTime() - (idx + 1) * 3_600_000),
        updatedAt: waiting4Days,
        assigneePositionId: SEAT_VACANT,
        holderUserId: null,
        holderAgentId: null,
      }),
    );

    const items = projectsTodayItemsOf(overflowRows, { userId: ME, role: 'member', now: NOW });
    expect(items).toHaveLength(TODAY_ITEMS_MAX);
    expect(items.at(-1)).toEqual({
      kind: 'flag',
      app: 'projects',
      id: 'more',
      title: { key: 'projects.more', params: { count: 6 } },
      count: 6,
      severity: 'warn',
      href: '/projects',
    });
    expect(zTodayItems.safeParse(items).success).toBe(true);

    // When SQL caps candidate rows at 500 out of 600 matching tasks, totalCount drives the true remaining count (600 - 199 = 401).
    const cappedItems = projectsTodayItemsOf(overflowRows, {
      userId: ME,
      role: 'member',
      now: NOW,
      totalCount: 600,
    });
    expect(cappedItems).toHaveLength(TODAY_ITEMS_MAX);
    expect(cappedItems.at(-1)).toEqual({
      kind: 'flag',
      app: 'projects',
      id: 'more',
      title: { key: 'projects.more', params: { count: 600 - (TODAY_ITEMS_MAX - 1) } },
      count: 600 - (TODAY_ITEMS_MAX - 1),
      severity: 'warn',
      href: '/projects',
    });
  });

  it('surfaces open bottleneck blockers sorted by descending blockedCount after overdue (#2601)', () => {
    const overdueDue = new Date(NOW.getTime() - 86_400_000);
    const items = projectsTodayItemsOf(
      [
        row({ taskId: taskId(1), status: 'in_progress', blockedCount: 1 }),
        row({ taskId: taskId(2), status: 'todo', blockedCount: 4 }),
        row({ taskId: taskId(3), status: 'todo', due: overdueDue }),
      ],
      { userId: ME, role: 'member', now: NOW },
    );
    expect(items.map((i) => i.id)).toEqual([
      `overdue:${taskId(3)}`,
      `bottleneck:${taskId(2)}`,
      `bottleneck:${taskId(1)}`,
    ]);
    expect(items[1]).toMatchObject({
      kind: 'flag',
      app: 'projects',
      id: `bottleneck:${taskId(2)}`,
      title: { key: 'projects.blockingTasks', params: { count: 4 } },
      severity: 'warn',
    });
  });
});
