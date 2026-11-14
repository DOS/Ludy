// SPDX-License-Identifier: AGPL-3.0-only
// Which lines go to the model for a question (Meetings A3, #3161): the lines holding most of the question's words first, one line once, at most 40 lines from at most 8 meetings.
import { describe, expect, it } from 'vitest';
import { ASK_LINES_MAX, ASK_MEETINGS_MAX, type MeetingSearchHit } from '@crove/kernel-contract';
import { pickLines } from '../src/ask.ts';

const hit = (n: number, meeting: number, text: string): MeetingSearchHit => ({
  meetingId: `00000000-0000-4000-8000-${String(meeting).padStart(12, '0')}`,
  meetingTitle: `Họp ${meeting}`,
  heldAt: '2026-11-14T05:31:00.000Z',
  segmentId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  startSeconds: n,
  speakerLabel: 'Lan',
  text,
  stage: 'published',
});

describe('pickLines', () => {
  it('puts the lines holding the most words first and keeps the search order among equals', () => {
    const picked = pickLines([hit(1, 1, 'giao hàng'), hit(2, 1, 'chiết khấu giao hàng'), hit(3, 2, 'chiết khấu'), hit(4, 2, 'không liên quan')], ['chiết', 'khấu', 'giao']);
    expect(picked.map((h) => h.startSeconds)).toEqual([2, 3, 1, 4]);
  });

  it('ignores case and Vietnamese marks when it counts the words', () => {
    const picked = pickLines([hit(1, 1, 'CHIET KHAU'), hit(2, 1, 'chiết khấu giao hàng')], ['chiết', 'khấu', 'giao']);
    expect(picked.map((h) => h.startSeconds)).toEqual([2, 1]);
  });

  it('takes at most 40 lines', () => {
    const many = Array.from({ length: 60 }, (_, i) => hit(i + 1, 1, 'chiết khấu'));
    expect(pickLines(many, ['chiết'])).toHaveLength(ASK_LINES_MAX);
  });

  it('takes lines from at most 8 meetings, leaving out a ninth meeting\'s lines but not more lines of the earlier ones', () => {
    const lines = [...Array.from({ length: 9 }, (_, i) => hit(i + 1, i + 1, 'chiết khấu')), hit(100, 1, 'chiết khấu'), hit(101, 9, 'chiết khấu')];
    const picked = pickLines(lines, ['chiết']);
    expect(new Set(picked.map((h) => h.meetingId)).size).toBe(ASK_MEETINGS_MAX);
    expect(picked.map((h) => h.startSeconds)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 100]);
  });

  it('gives nothing for nothing', () => {
    expect(pickLines([], ['chiết'])).toEqual([]);
  });
});
