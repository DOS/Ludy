// SPDX-License-Identifier: AGPL-3.0-only
// The small rules behind highlights on a transcript (#4819): the whole second a line is marked at, the range between two clicks, which lines a mark covers (both ends included, two lines that start in
// the same second together), the caller's own single-line mark, and the text a copy produces.
import { describe, expect, it } from 'vitest';
import { copyText, covers, linesOf, ownSingleAt, rangeBetween, secondOf } from '../src/lib/highlights.ts';

// The page's own clock is in a component that needs the browser; the copy takes any clock, so a plain one stands in.
const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

describe('anchors', () => {
  it('marks a line at the whole second it starts at', () => {
    expect(secondOf(62.8)).toBe(62);
    expect(secondOf(0)).toBe(0);
  });

  it('orders the two ends of a range whichever was clicked first', () => {
    expect(rangeBetween(40, 10)).toEqual({ startSeconds: 10, endSeconds: 40 });
    expect(rangeBetween(10.9, 40.2)).toEqual({ startSeconds: 10, endSeconds: 40 });
    expect(rangeBetween(30, 30)).toEqual({ startSeconds: 30, endSeconds: 30 });
  });

  it('covers a line from the first second to the last second, both included', () => {
    const range = { startSeconds: 20, endSeconds: 40 };
    expect([19.9, 20, 30.5, 40, 40.9, 41].map((s) => covers(range, s))).toEqual([false, true, true, true, true, false]);
  });
});

describe('the lines of a mark', () => {
  const lines = [
    { id: 'a', startSeconds: 10, speakerLabel: 'Lan', text: 'Một' },
    { id: 'b', startSeconds: 20.2, speakerLabel: 'Hùng', text: 'Hai' },
    { id: 'c', startSeconds: 20.7, speakerLabel: 'Lan', text: 'Ba' },
    { id: 'd', startSeconds: 31, speakerLabel: 'Hùng', text: 'Bốn' },
  ];

  it('takes the lines inside the range in the order of the transcript, two lines of one second together', () => {
    expect(linesOf({ startSeconds: 20, endSeconds: 20 }, [...lines].reverse()).map((l) => l.id)).toEqual(['b', 'c']);
    expect(linesOf({ startSeconds: 10, endSeconds: 31 }, lines).map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('takes none when the lines are gone', () => {
    expect(linesOf({ startSeconds: 100, endSeconds: 120 }, lines)).toEqual([]);
    expect(linesOf({ startSeconds: 10, endSeconds: 10 }, [])).toEqual([]);
  });

  it('copies one line of text for each transcript line with its time and speaker', () => {
    expect(copyText(lines.slice(1, 3), clock)).toBe('0:20 Hùng: Hai\n0:20 Lan: Ba');
    expect(copyText([], clock)).toBe('');
  });
});

describe('the caller\'s own single-line mark', () => {
  const marks = [
    { id: '1', startSeconds: 20, endSeconds: 20, mine: false },
    { id: '2', startSeconds: 20, endSeconds: 40, mine: true },
    { id: '3', startSeconds: 20, endSeconds: 20, mine: true },
  ];

  it('is the mark of the caller on exactly that second and no more', () => {
    expect(ownSingleAt(marks, 20.5)?.id).toBe('3');
    expect(ownSingleAt(marks, 21)).toBeUndefined();
    // A range that starts there, and another member's mark, are not it.
    expect(ownSingleAt(marks.slice(0, 2), 20)).toBeUndefined();
  });
});
