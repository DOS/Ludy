// SPDX-License-Identifier: AGPL-3.0-only
// Which key closes the buyer notice confirmation panel (#5257): Escape, and only while no send is under way.
import { describe, expect, it } from 'vitest';
import { closesNoticeConfirm } from '../src/lib/notice-confirm.ts';

describe('closesNoticeConfirm', () => {
  it('closes on Escape when nothing is being sent', () => {
    expect(closesNoticeConfirm('Escape', false)).toBe(true);
  });

  it('stays open on Escape while the send is under way, so its result and error stay in view', () => {
    expect(closesNoticeConfirm('Escape', true)).toBe(false);
  });

  it('ignores every other key', () => {
    for (const key of ['Enter', ' ', 'Tab', 'Esc', 'escape', 'ArrowDown']) expect(closesNoticeConfirm(key, false), key).toBe(false);
  });
});
