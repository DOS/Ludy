// SPDX-License-Identifier: AGPL-3.0-only
// The member-Vy feature table of packages/agent (pure data) is the one the kernel's commands check; apps/kernel/test/member-vy-features.test.ts
// pins the same literal on the kernel's side (ADR-0049, issue #2782).
import { describe, expect, it } from 'vitest';
import { MEMBER_VY_FEATURE_TABLE } from '../src/member-vy/features.ts';

describe('member-Vy features (agent side)', () => {
  it('are the table both sides pin', () => {
    expect(MEMBER_VY_FEATURE_TABLE).toEqual({
      'notes.summary': { module: 'notes', expiryMinutes: 30 },
      'notes.todo_suggest': { module: 'notes', expiryMinutes: 30 },
      'meetings.transcribe': { module: 'meetings', expiryMinutes: 240 },
      'meetings.summary': { module: 'meetings', expiryMinutes: 30 },
      'meetings.live_notes': { module: 'meetings', expiryMinutes: 30 },
      'meetings.live_summary': { module: 'meetings', expiryMinutes: 30 },
      'meetings.translate': { module: 'meetings', expiryMinutes: 30 },
      'meetings.ask': { module: 'meetings', expiryMinutes: 30 },
      'meetings.brief': { module: 'meetings', expiryMinutes: 30 },
      'meetings.chapters': { module: 'meetings', expiryMinutes: 30 },
      'meetings.digest': { module: 'meetings', expiryMinutes: 30 },
      'meetings.assignee': { module: 'meetings', expiryMinutes: 30 },
      'meetings.adherence': { module: 'meetings', expiryMinutes: 30 },
      'projects.tasks_from_note': { module: 'projects', expiryMinutes: 30 },
      'projects.tasks_from_source': { module: 'projects', expiryMinutes: 30 },
    });
  });
});
