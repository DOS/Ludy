// SPDX-License-Identifier: AGPL-3.0-only
// The files of a transcript export (#4817): the plain text and the SRT, the times, the cleaning of untrusted text, and the file name.
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { cleanLine, clockText, exportableCount, srtTime, transcriptDocx, transcriptFile, transcriptFilename, transcriptSrt, transcriptText } from '../src/transcript-export-file.ts';

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

// The parts of a .docx read back: the zip's central directory, each entry inflated (the writer of the minutes' own test reads its files the same way).
function docxParts(bytes: Uint8Array): Map<string, string> {
  const buf = Buffer.from(bytes);
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const out = new Map<string, string>();
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const packed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'), inflateRawSync(buf.subarray(start, start + packed)).toString('utf8'));
    at += 46 + nameLength;
  }
  return out;
}
const wordTexts = (bytes: Uint8Array): string[] => [...(docxParts(bytes).get('word/document.xml') ?? '').matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/gu)].map((m) => (m[1] as string).replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&apos;/gu, "'").replace(/&quot;/gu, '"'));

describe('the Word file', () => {
  const meta = { title: 'Họp giao ban', day: '2026-11-15' };

  it('is a zip of the five parts of a .docx, with a heading, the title and day, and one paragraph a line in order', () => {
    const bytes = transcriptDocx([line(5, 9, 'Minh', 'Chào mọi người'), line(754, 760, 'Hà', 'Khách A đồng ý 8%')], meta);
    expect([...docxParts(bytes).keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml']);
    expect(wordTexts(bytes)).toEqual(['BẢN GHI LỜI CUỘC HỌP', 'Họp giao ban', 'Ngày 15/11/2026', '[00:00:05] Minh: ', 'Chào mọi người', '[00:12:34] Hà: ', 'Khách A đồng ý 8%']);
  });

  it('is the same bytes for the same input, and goes through transcriptFile for the docx format', () => {
    const lines = [line(1, 2, 'Hà', 'a')];
    expect(Buffer.from(transcriptDocx(lines, meta)).equals(Buffer.from(transcriptDocx(lines, meta)))).toBe(true);
    expect(Buffer.from(transcriptFile('docx', lines, meta)).equals(Buffer.from(transcriptDocx(lines, meta)))).toBe(true);
    expect(new TextDecoder().decode(transcriptFile('txt', lines, meta))).toBe('[00:00:01] Hà: a\n');
  });

  it('cannot carry markup, a hidden or bidirectional character or a break out of a line: the text is cleaned and escaped', () => {
    const bytes = transcriptDocx([line(1, 3, 'Hà‮', '<w:p>&"x"</w:p>​\n\nhai'), line(4, 5, 'Nam', '​')], { title: 'Họp <script>', day: '2026-11-15' });
    const xml = docxParts(bytes).get('word/document.xml') ?? '';
    expect(xml).not.toMatch(/[‮​]/u);
    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain('<w:p>&"x"');
    expect(wordTexts(bytes)).toEqual(['BẢN GHI LỜI CUỘC HỌP', 'Họp <script>', 'Ngày 15/11/2026', '[00:00:01] Hà: ', '<w:p>&"x"</w:p> hai']);
  });

  it('names the file with the .docx extension', () => {
    expect(transcriptFilename('Họp giao ban', '2026-11-15', 'docx')).toBe('Bản ghi - Họp giao ban - 2026-11-15.docx');
  });
});
