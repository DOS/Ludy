// SPDX-License-Identifier: AGPL-3.0-only
// The lines of a platform's transcript, read again by the import route (meetings C2, #3174, follow-up #4000): a line that ends before it starts, or holds a NUL byte, is refused with a clean validation error.
import { describe, expect, it } from 'vitest';
import { zMeetingTranscriptImport, zTranscriptDraftStore } from '../src/meetings.ts';

const meetingId = '00000000-0000-4000-8000-000000000009';
const line = (over: Record<string, unknown> = {}) => ({ startSeconds: 5, endSeconds: 9, speakerLabel: 'Lan', text: 'Xin chào.', ...over });
const parse = (segments: unknown[]) => zMeetingTranscriptImport.safeParse({ meetingId, segments });

describe('zMeetingTranscriptImport', () => {
  it('takes a normal line, one of zero length and one that ends at the same second it starts', () => {
    expect(parse([line()]).success).toBe(true);
    expect(parse([line({ startSeconds: 9, endSeconds: 9 })]).success).toBe(true);
    expect(parse([line({ startSeconds: 0, endSeconds: 86_400 })]).success).toBe(true);
  });

  it('refuses a line that ends before it starts, and says which field', () => {
    const result = parse([line(), line({ startSeconds: 10, endSeconds: 9 })]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('segments.1.endSeconds');
  });

  it('refuses a NUL byte in the text or the speaker, even among other characters', () => {
    const paths = (segments: unknown[]) => {
      const result = parse(segments);
      return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
    };
    expect(paths([line({ text: 'ab\u0000cd' })])).toEqual(['segments.0.text']);
    expect(paths([line({ speakerLabel: 'La\u0000n' })])).toEqual(['segments.0.speakerLabel']);
    // Other control characters and plain Vietnamese text are not this check's business.
    expect(parse([line({ text: 'Dòng một\tvà dòng hai', speakerLabel: 'Người nói 1' })]).success).toBe(true);
  });

  it('keeps the other rules: at least one line, at most 5000, no unknown field', () => {
    expect(parse([]).success).toBe(false);
    expect(parse(Array.from({ length: 5001 }, () => line())).success).toBe(false);
    expect(parse([{ ...line(), extra: 1 }]).success).toBe(false);
  });

  it('is the platform import only: the draft transcript of a recording keeps its own rules', () => {
    expect(zTranscriptDraftStore.safeParse({ meetingId, segments: [line({ startSeconds: 10, endSeconds: 9 })] }).success).toBe(true);
  });
});
