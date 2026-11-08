// SPDX-License-Identifier: AGPL-3.0-only
// The member-Vy feature table lives twice, as pure data in packages/agent (what a feature module reads) and in the kernel (what its
// commands check). Each side pins the same literal (packages/agent/test/member-vy-features.test.ts is the other), so the two cannot differ
// without one of the tests failing (ADR-0049, issue #2782).
import { describe, expect, it } from 'vitest';
import { MEMBER_VY_FEATURES } from '@crove/kernel';

describe('member-Vy features (kernel side)', () => {
  it('are the table both sides pin', () => {
    expect(MEMBER_VY_FEATURES).toEqual({
      'notes.summary': { module: 'notes', expiryMinutes: 30 },
      'notes.todo_suggest': { module: 'notes', expiryMinutes: 30 },
      'meetings.transcribe': { module: 'meetings', expiryMinutes: 240 },
    });
  });
});
