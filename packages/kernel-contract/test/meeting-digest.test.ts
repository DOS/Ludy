// SPDX-License-Identifier: AGPL-3.0-only
// The numbered facts of the weekly digest (#3949): a fixed order (meeting by meeting as given, a meeting's decisions then its open items), numbers from 1 with no gaps, one line per fact with its meeting, text flattened
// to one line, and never more than the cap. The same numbers are what the card shows and what a sentence of Vy cites.
import { describe, expect, it } from 'vitest';
import { DIGEST_LINES_MAX, digestLines, zDigestAsk, zDigestFacts, type DigestFacts } from '../src/index.ts';

const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, who: 'Lan', whoUserId: null, assigneeSeat: null, when: 'thứ sáu', whenDate: null, assigned: false, taskStatus: null, due: null, ...over });
const M1 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5d';
const M2 = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5e';
const facts = (): DigestFacts =>
  zDigestFacts.parse({
    days: 7,
    meetings: [
      { meetingId: M1, title: 'Giao ban\n tuần', startedAt: '2026-11-17T02:00:00.000Z', decisions: ['Chốt giá\u0000 15.000.000 đồng'], items: [item('0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a01', 'Gửi báo giá', { assigned: true, taskStatus: 'in_progress', due: '2026-11-19T17:00:00.000Z' }), item('0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a02', 'Chưa ai nhận', { who: '' })] },
      { meetingId: M2, title: 'Họp khách', startedAt: '2026-11-16T02:00:00.000Z', decisions: ['Hẹn ký hợp đồng'], items: [] },
    ],
    cut: false,
    empty: false,
  });

describe('digestLines', () => {
  it('numbers the facts from 1 in order: a meeting\'s decisions, its open items, then the next meeting', () => {
    const lines = digestLines(facts());
    expect(lines.map((l) => [l.n, l.kind, l.meetingId])).toEqual([
      [1, 'decision', M1],
      [2, 'item', M1],
      [3, 'item', M1],
      [4, 'decision', M2],
    ]);
  });

  it('writes each fact as one line with its meeting and day, the Vietnam day of a due instant, and no control character', () => {
    const lines = digestLines(facts());
    expect(lines[0]?.text).toBe('Decision of "Giao ban tuần" on 2026-11-17: Chốt giá 15.000.000 đồng');
    // 17:00 UTC on the 19th is 00:00 on the 20th in Vietnam.
    expect(lines[1]?.text).toBe('Open item of "Giao ban tuần" on 2026-11-17: Gửi báo giá (accepted as a task; owner: Lan; due: 2026-11-20; status: in progress)');
    expect(lines[2]?.text).toBe('Open item of "Giao ban tuần" on 2026-11-17: Chưa ai nhận (not given to anyone yet)');
    for (const line of lines) expect(line.text).not.toMatch(/\p{Cc}/u);
  });

  it('never gives more lines than the cap, and none for no meeting', () => {
    const many = zDigestFacts.parse({
      days: 30,
      meetings: Array.from({ length: 4 }, (_, i) => ({ meetingId: M1, title: `Họp ${i}`, startedAt: '2026-11-16T02:00:00.000Z', decisions: Array.from({ length: 15 }, (_, d) => `Quyết định ${d}`), items: [] })),
      cut: true,
      empty: false,
    });
    expect(many.meetings.flatMap((m) => m.decisions)).toHaveLength(60);
    expect(digestLines(many)).toHaveLength(DIGEST_LINES_MAX);
    expect(digestLines(zDigestFacts.parse({ days: 7, meetings: [], cut: false, empty: true }))).toEqual([]);
  });
});

describe('zDigestAsk', () => {
  it('takes 7, 14 or 30 days and defaults to 7, and nothing else', () => {
    expect(zDigestAsk.parse({})).toEqual({ days: 7 });
    expect(zDigestAsk.parse({ days: 30 })).toEqual({ days: 30 });
    for (const days of [0, 1, 8, 31, '7', null]) expect(zDigestAsk.safeParse({ days }).success, String(days)).toBe(false);
    expect(zDigestAsk.safeParse({ days: 7, extra: 1 }).success).toBe(false);
  });
});
