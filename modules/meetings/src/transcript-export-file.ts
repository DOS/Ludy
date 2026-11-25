// SPDX-License-Identifier: AGPL-3.0-only
// The files of a transcript export (#4817): plain text and SRT, made from lines already read under the caller's row security. Pure functions: no database, no clock. A line's text and speaker are
// untrusted (a person or a model wrote them): hidden and bidirectional characters are removed, a line break inside a line becomes a space (an SRT cue ends at an empty line, so a cue text can hold none),
// and a line with no text left makes no entry.
import { INVISIBLE_PATTERN, TRANSCRIPT_EXPORT_NAME_MAX, type TranscriptExportFormat } from '@ludy/kernel-contract';

export interface ExportLine {
  startSeconds: number;
  endSeconds: number;
  speakerLabel: string;
  text: string;
}

const HIDDEN = new RegExp(INVISIBLE_PATTERN, 'gu');
// A lone surrogate (half of a pair) cannot be written as UTF-8: Buffer would turn it into U+FFFD, so it is dropped.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;

/** One line as the file may hold it: a break or tab is a space, no other hidden character, no lone surrogate, whitespace runs one space. */
export function cleanLine(raw: string): string {
  return raw
    .replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/gu, ' ')
    .replace(HIDDEN, '')
    .replace(LONE_SURROGATE, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** "HH:MM:SS" for plain text. */
export function clockText(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${pad(Math.floor(total / 3600), 2)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

const wholeMs = (seconds: number): number => Math.max(0, Math.floor(seconds * 1000 + 1e-6));

/** "HH:MM:SS,mmm" as SRT writes a time (cut, not rounded, so it agrees with the plain text's clock). */
export function srtTime(seconds: number): string {
  const ms = wholeMs(seconds);
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))},${pad(ms % 1000, 3)}`;
}

interface CleanLine {
  start: number;
  end: number;
  who: string;
  text: string;
}
function cleaned(lines: readonly ExportLine[]): CleanLine[] {
  const out: CleanLine[] = [];
  for (const line of lines) {
    const text = cleanLine(line.text);
    if (text === '') continue;
    // A cue never ends before it starts: a line with no usable end is shown for two seconds.
    const end = wholeMs(line.endSeconds) > wholeMs(line.startSeconds) ? line.endSeconds : line.startSeconds + 2;
    out.push({ start: line.startSeconds, end, who: cleanLine(line.speakerLabel), text });
  }
  return out;
}

/** The number of lines that make an entry (the ones with some text). */
export const exportableCount = (lines: readonly ExportLine[]): number => cleaned(lines).length;

/** Plain text: one entry per line, "[HH:MM:SS] Speaker: text". A line break ends each entry, and the file ends with one. */
export function transcriptText(lines: readonly ExportLine[]): string {
  return cleaned(lines)
    .map((l) => `[${clockText(l.start)}] ${l.who === '' ? '' : `${l.who}: `}${l.text}\n`)
    .join('');
}

/** SRT: numbered cues from 1, "HH:MM:SS,mmm --> HH:MM:SS,mmm", then "Speaker: text", a blank line after each. */
export function transcriptSrt(lines: readonly ExportLine[]): string {
  return cleaned(lines)
    .map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.who === '' ? '' : `${l.who}: `}${l.text}\n\n`)
    .join('');
}

export function transcriptFile(format: TranscriptExportFormat, lines: readonly ExportLine[]): string {
  return format === 'txt' ? transcriptText(lines) : transcriptSrt(lines);
}

/**
 * The file name: "Bản ghi - <title> - <YYYY-MM-DD>.<ext>", the title cut to fit and stripped of what a file name cannot hold on Windows, macOS or Linux (path separators, : * ? " < > |, controls,
 * the invisible characters), a title with nothing left named "cuộc họp". The budget is in UTF-16 units (what the answer's schema counts) and a character is never cut in two.
 */
export function transcriptFilename(title: string, day: string, format: TranscriptExportFormat): string {
  const clean = cleanLine(title)
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, '');
  const budget = TRANSCRIPT_EXPORT_NAME_MAX - 'Bản ghi -  - 0000-00-00'.length;
  let cut = '';
  for (const ch of Array.from(clean === '' ? 'cuộc họp' : clean)) {
    if (cut.length + ch.length > budget) break;
    cut += ch;
  }
  return `Bản ghi - ${cut.trim()} - ${day}.${format}`;
}
