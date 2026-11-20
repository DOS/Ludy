// SPDX-License-Identifier: AGPL-3.0-only
// A jump to a transcript line: by the whole second, and by the speaker when the jump names one, so two people who start in the same second are not mixed up (#3960 review follow-up).
import { describe, expect, it } from 'vitest';
import { focusedSegment } from '../src/lib/transcript-focus.ts';

const segments = [
  { id: 'a', startSeconds: 10.2, speakerLabel: 'Hà' },
  { id: 'b', startSeconds: 10.8, speakerLabel: 'Nam' },
  { id: 'c', startSeconds: 20, speakerLabel: '  Hà   Linh ' },
];

describe('focusedSegment', () => {
  it('takes the first line of the second when the jump names no speaker', () => {
    expect(focusedSegment(segments, { second: 10, token: 1 })?.id).toBe('a');
  });

  it('takes the line of the named speaker when two people start in the same second', () => {
    expect(focusedSegment(segments, { second: 10, speaker: 'Nam', token: 1 })?.id).toBe('b');
    expect(focusedSegment(segments, { second: 10, speaker: 'Hà', token: 2 })?.id).toBe('a');
  });

  it('matches a speaker label with folded spaces, and falls back to the second when no one matches', () => {
    expect(focusedSegment(segments, { second: 20, speaker: 'Hà Linh', token: 1 })?.id).toBe('c');
    expect(focusedSegment(segments, { second: 10, speaker: 'Lan', token: 1 })?.id).toBe('a');
  });

  it('is undefined when no line starts at the second', () => {
    expect(focusedSegment(segments, { second: 99, speaker: 'Hà', token: 1 })).toBeUndefined();
  });
});
