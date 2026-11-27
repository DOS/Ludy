// SPDX-License-Identifier: AGPL-3.0-only
// Contract shapes for L33 meeting catch-up (#5130): citations, reader items built in code, status and model answer limits.
import { describe, expect, it } from 'vitest';
import {
  CATCH_UP_ESTIMATE,
  CATCH_UP_LINE_MAX,
  CATCH_UP_LINE_MIN,
  CATCH_UP_LINES_MAX,
  CATCH_UP_YOUR_ITEMS_MAX,
  zCatchUpAnswer,
  zCatchUpCitation,
  zCatchUpLine,
  zCatchUpStatus,
  zCatchUpYourItem,
  type CatchUpLine,
} from '../src/meeting-catch-up.ts';

const ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';

describe('meeting catch-up contract (#5130)', () => {
  it('accepts decision and action-item citations while rejecting out-of-range or unknown shapes', () => {
    expect(zCatchUpCitation.safeParse({ kind: 'decision', index: 1 }).success).toBe(true);
    expect(zCatchUpCitation.safeParse({ kind: 'item', itemId: ID }).success).toBe(true);
    expect(zCatchUpCitation.safeParse({ kind: 'decision', index: 0 }).success).toBe(false);
    expect(zCatchUpCitation.safeParse({ kind: 'decision', index: 201 }).success).toBe(false);
    expect(zCatchUpCitation.safeParse({ kind: 'transcript', itemId: ID }).success).toBe(false);
    expect(zCatchUpCitation.safeParse({ kind: 'decision', index: 1, extra: true }).success).toBe(false);
  });

  it('bounds line length, line count, status reasons and yourItems count', () => {
    expect(CATCH_UP_ESTIMATE).toEqual({ inputTokens: 1800, outputTokens: 350 });
    expect(zCatchUpLine.safeParse({ text: 'a'.repeat(CATCH_UP_LINE_MIN), cite: { kind: 'decision', index: 1 } }).success).toBe(true);
    expect(zCatchUpLine.safeParse({ text: 'ab', cite: { kind: 'decision', index: 1 } }).success).toBe(false);
    expect(zCatchUpLine.safeParse({ text: 'a'.repeat(CATCH_UP_LINE_MAX + 1), cite: { kind: 'decision', index: 1 } }).success).toBe(false);

    const yourItem = {
      itemId: ID,
      title: 'Gui bao gia',
      who: 'An',
      when: 'thu sau',
      whenDate: '2026-11-27',
      status: 'suggested' as const,
      taskId: null,
      matchedBy: 'name' as const,
    };
    expect(zCatchUpYourItem.safeParse(yourItem).success).toBe(true);
    expect(zCatchUpYourItem.safeParse({ ...yourItem, status: 'dismissed' }).success).toBe(false);

    const status = {
      meetingId: ID,
      available: true,
      reason: null,
      yourItems: [yourItem],
      estimate: { inputTokens: 1800, outputTokens: 350, cost: '0.0042' },
    };
    expect(zCatchUpStatus.safeParse(status).success).toBe(true);
    expect(zCatchUpStatus.safeParse({ ...status, available: false, reason: 'is_recorder', yourItems: [], estimate: null }).success).toBe(true);
    expect(zCatchUpStatus.safeParse({ ...status, available: false, reason: 'paused', estimate: null }).success).toBe(true);
    expect(zCatchUpStatus.safeParse({ ...status, available: false, reason: 'unknown_reason' }).success).toBe(false);
    expect(
      zCatchUpStatus.safeParse({
        ...status,
        yourItems: Array.from({ length: CATCH_UP_YOUR_ITEMS_MAX + 1 }, () => yourItem),
      }).success,
    ).toBe(false);

    const line: CatchUpLine = { text: 'Chot gia moi cho khach A', cite: { kind: 'item', itemId: ID } };
    expect(
      zCatchUpAnswer.safeParse({
        state: 'written',
        errorCode: null,
        lines: Array.from({ length: CATCH_UP_LINES_MAX }, () => line),
        dropped: 0,
      }).success,
    ).toBe(true);
    expect(
      zCatchUpAnswer.safeParse({
        state: 'written',
        errorCode: null,
        lines: Array.from({ length: CATCH_UP_LINES_MAX + 1 }, () => line),
        dropped: 0,
      }).success,
    ).toBe(false);
    expect(zCatchUpAnswer.safeParse({ state: 'failed', errorCode: 'CATCH_UP_FAILED', lines: [], dropped: 0 }).success).toBe(true);
    expect(zCatchUpAnswer.safeParse({ state: 'failed', errorCode: 'bad-code', lines: [], dropped: 0 }).success).toBe(false);
  });
});
