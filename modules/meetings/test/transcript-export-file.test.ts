// SPDX-License-Identifier: AGPL-3.0-only
// The files of a transcript export (#4817): the plain text and the SRT, the times, the cleaning of untrusted text, and the file name.
import { describe, expect, it } from 'vitest';
import { cleanLine, clockText, exportableCount, srtTime, transcriptFilename, transcriptSrt, transcriptText } from '../src/transcript-export-file.ts';

const line = (startSeconds: number, endSeconds: number, speakerLabel: string, text: string) => ({ startSeconds, endSeconds, speakerLabel, text });

describe('times', () => {
  it('writes "HH:MM:SS" for text and "HH:MM:SS,mmm" for SRT', () => {
    expect(clockText(0)).toBe('00:00:00');
    expect(clockText(754.9)).toBe('00:12:34');
    expect(clockText(3661)).toBe('01:01:01');
    expect(clockText(-5)).toBe('00:00:00');
    expect(srtTime(754)).toBe('00:12:34,000');
    expect(srtTime(3661.0505)).toBe('01:01:01,050');
    // Cut, not rounded: the same second as the plain text's clock.
    expect(srtTime(754.9)).toBe('00:12:34,900');
    expect(srtTime(0.9996)).toBe('00:00:00,999');
    expect(srtTime(1.001)).toBe('00:00:01,001');
  });
});

describe('cleaning', () => {
  it('turns a break into a space and drops hidden, bidirectional and lone-surrogate characters', () => {
    expect(cleanLine('a\n\nb\tc\r\nd')).toBe('a b c d');
    expect(cleanLine('a\u000bb\u000cc\u0085d')).toBe('a b c d');
    expect(cleanLine('x\u202ey\u200bz\u2060 w')).toBe('xyz w');
    expect(cleanLine('ok\ud800 bad')).toBe('ok bad');
    expect(cleanLine('  \u200b  ')).toBe('');
    expect(cleanLine('Tiếng Việt 🎉')).toBe('Tiếng Việt 🎉');
  });
});

describe('the plain text', () => {
  it('has one "[time] Speaker: text" entry per line, in the order given, and ends with a break', () => {
    const text = transcriptText([line(5, 9, 'Minh', 'Chào mọi người'), line(754, 760, 'Hà', 'Khách A đồng ý 8%')]);
    expect(text).toBe('[00:00:05] Minh: Chào mọi người\n[00:12:34] Hà: Khách A đồng ý 8%\n');
  });

  it('skips a line with no text and leaves out the colon for a speaker with no name', () => {
    expect(transcriptText([line(1, 2, 'Hà', '\u200b'), line(3, 4, '\u200b', 'Không tên')])).toBe('[00:00:03] Không tên\n');
    expect(transcriptText([])).toBe('');
    expect(exportableCount([line(1, 2, 'Hà', ' '), line(3, 4, 'Hà', 'x')])).toBe(1);
  });
});

describe('the SRT', () => {
  it('numbers the cues from 1 with "start --> end" and a blank line after each', () => {
    expect(transcriptSrt([line(5, 9, 'Minh', 'Chào'), line(754, 760.5, 'Hà', 'Dạ')])).toBe('1\n00:00:05,000 --> 00:00:09,000\nMinh: Chào\n\n2\n00:12:34,000 --> 00:12:40,500\nHà: Dạ\n\n');
  });

  it('shows a line that ends where it starts (or before) for two seconds, and numbers only the cues that exist', () => {
    const srt = transcriptSrt([line(10, 10, 'Hà', 'a'), line(12, 11, 'Hà', ''), line(20, 25, 'Hà', 'b')]);
    expect(srt).toBe('1\n00:00:10,000 --> 00:00:12,000\nHà: a\n\n2\n00:00:20,000 --> 00:00:25,000\nHà: b\n\n');
  });

  it('gives a line that ends within the same millisecond as it starts two seconds', () => {
    expect(transcriptSrt([line(10.0001, 10.0004, 'Hà', 'a')])).toBe('1\n00:00:10,000 --> 00:00:12,000\nHà: a\n\n');
  });

  it('cannot be made to start a second cue from inside a text', () => {
    const srt = transcriptSrt([line(1, 2, 'Hà', 'một\n\n2\n00:00:00,000 --> 00:00:01,000\nhai')]);
    expect(srt.split('\n\n').filter((c) => c !== '')).toHaveLength(1);
  });
});

describe('the file name', () => {
  it('is "Bản ghi - <title> - <day>.<ext>" with what a file name cannot hold removed', () => {
    expect(transcriptFilename('Họp giao ban', '2026-11-15', 'txt')).toBe('Bản ghi - Họp giao ban - 2026-11-15.txt');
    expect(transcriptFilename('a/b\\c:d*e?f"g<h>i|j', '2026-11-15', 'srt')).toBe('Bản ghi - a b c d e f g h i j - 2026-11-15.srt');
    expect(transcriptFilename('\u202e', '2026-11-15', 'txt')).toBe('Bản ghi - cuộc họp - 2026-11-15.txt');
    expect(transcriptFilename('..hidden..', '2026-11-15', 'txt')).toBe('Bản ghi - hidden - 2026-11-15.txt');
  });

  it('is cut to fit and never inside a character', () => {
    const long = transcriptFilename('🎉'.repeat(200), '2026-11-15', 'txt');
    expect(long.length).toBeLessThanOrEqual(128);
    expect(long).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
    expect(long.endsWith(' - 2026-11-15.txt')).toBe(true);
  });
});
