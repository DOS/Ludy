// SPDX-License-Identifier: AGPL-3.0-only
// Contract and definition boundary checks for projects.tasks_from_note commands and queries (#2598).
import { describe, expect, it } from 'vitest';
import {
  tasksFromNoteConfirm,
  tasksFromNoteSeats,
  tasksFromNoteStart,
  tasksFromNoteStatus,
} from '../src/index.ts';

const VALID_ID = '11111111-1111-4111-8111-111111111111';

describe('projects.tasks_from_note module definitions', () => {
  it('enforces writer/member access and leaves runsWhenOff unset for ADR-0053 gating', () => {
    expect(tasksFromNoteStatus.access).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(tasksFromNoteSeats.access).toEqual(['owner', 'admin', 'member']);
    expect(tasksFromNoteStart.access).toEqual(['owner', 'admin', 'member']);
    expect(tasksFromNoteConfirm.access).toEqual(['owner', 'admin', 'member']);

    expect(tasksFromNoteStart.risk).toBe('R1');
    expect(tasksFromNoteConfirm.risk).toBe('R1');
    expect(tasksFromNoteStatus.runsWhenOff).toBeUndefined();
    expect(tasksFromNoteSeats.runsWhenOff).toBeUndefined();
    expect(tasksFromNoteStart.runsWhenOff).toBeUndefined();
    expect(tasksFromNoteConfirm.runsWhenOff).toBeUndefined();
  });

  it('validates confirmation batch schema boundaries and real calendar dates', () => {
    const ok = tasksFromNoteConfirm.input.safeParse({
      noteId: VALID_ID,
      projectId: VALID_ID,
      confirmed: true,
      items: [{ title: 'Follow up quote', assigneePositionId: null, dueOn: '2026-11-20' }],
    });
    expect(ok.success).toBe(true);

    expect(
      tasksFromNoteConfirm.input.safeParse({
        noteId: VALID_ID,
        projectId: VALID_ID,
        confirmed: false,
        items: [{ title: 'x', assigneePositionId: null, dueOn: null }],
      }).success,
    ).toBe(false);

    expect(
      tasksFromNoteConfirm.input.safeParse({
        noteId: VALID_ID,
        projectId: VALID_ID,
        confirmed: true,
        items: [],
      }).success,
    ).toBe(false);

    expect(
      tasksFromNoteConfirm.input.safeParse({
        noteId: VALID_ID,
        projectId: VALID_ID,
        confirmed: true,
        items: [{ title: 'Bad date', assigneePositionId: null, dueOn: '2026-02-31' }],
      }).success,
    ).toBe(false);

    expect(
      tasksFromNoteConfirm.input.safeParse({
        noteId: VALID_ID,
        projectId: VALID_ID,
        confirmed: true,
        items: [{ title: '   ', assigneePositionId: null, dueOn: null }],
      }).success,
    ).toBe(false);
  });
});
