// SPDX-License-Identifier: AGPL-3.0-only
// What a transcription run stores in its result and what the recorder's copy accepts (#2578, M4b). A result is data nobody trusts: the copy validates it as the
// draft store does.
import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_RESULT_MAX, decodeTranscriptResult, encodeTranscriptResult } from '../src/index.ts';

const segment = (startSeconds: number, text: string) => ({ startSeconds, endSeconds: startSeconds + 3, speakerLabel: 'Người nói 1', text });

describe('the transcription result', () => {
  it('round trips the segments in order', () => {
    const segments = [segment(0, 'xin chào'), segment(3, 'tạm biệt')];
    expect(decodeTranscriptResult(encodeTranscriptResult(segments))).toEqual(segments);
  });

  it('holds an hour of speech in one result row with room to spare, and not three', () => {
    // A line of 80 characters every 5 seconds (about 190 words a minute, brisker than a meeting).
    const hour = Array.from({ length: 720 }, (_, i) => segment(i * 5, 'a'.repeat(80)));
    expect(encodeTranscriptResult(hour).length).toBeLessThan(TRANSCRIPT_RESULT_MAX * 0.7);
    const three = Array.from({ length: 2160 }, (_, i) => segment(i * 5, 'a'.repeat(80)));
    expect(encodeTranscriptResult(three).length).toBeGreaterThan(TRANSCRIPT_RESULT_MAX);
  });

  it('refuses a body that is not exactly the format, and a segment the draft store would refuse', () => {
    const refused = (body: string) => {
      try {
        decodeTranscriptResult(body);
        return null;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(refused('not json')).toBe('TRANSCRIPT_RESULT_INVALID');
    expect(refused('{"v":2,"s":[]}')).toBe('TRANSCRIPT_RESULT_INVALID');
    expect(refused('{"v":1,"p":["x"],"s":[[0,3,0]]}')).toBe('TRANSCRIPT_RESULT_INVALID');
    expect(refused('{"v":1,"p":[],"s":[],"extra":1}')).toBe('TRANSCRIPT_RESULT_INVALID');
    expect(refused('{"v":1,"p":[""],"s":[[0,3,0,"text"]]}')).toBe('TRANSCRIPT_RESULT_INVALID');
    expect(refused('{"v":1,"p":["x"],"s":[[0,3,5,"text"]]}')).toBe('TRANSCRIPT_RESULT_INVALID');
    expect(refused(`{"v":1,"p":["x"],"s":[[0,3,0,"${'a'.repeat(4001)}"]]}`)).toBe('TRANSCRIPT_RESULT_INVALID');
    expect(refused('{"v":1,"p":["x"],"s":[[0,90000,0,"late"]]}')).toBe('TRANSCRIPT_RESULT_INVALID');
  });
});
