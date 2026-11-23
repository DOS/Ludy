// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy writing the table of contents of one meeting (#3844, ADR-0049 stage A): from the transcript it proposes chapters, each a short title and the second of the
// transcript line it starts at. The model is asked once, through the member-Vy ports, and what it answers is only a proposal: the checks below are code, not the model, and they
// decide what survives. A chapter that starts at no real line of the transcript is dropped (a chapter without a place is useless), a title that carries a link, an email address, a
// phone number, a run of digits or a figure the transcript does not hold is dropped, and the title is cleaned of control, bidi and zero-width characters first. What is left is still
// the model's text, so it stays private to the recorder and tainted until the recorder's own command copies it into a draft and a person reviews and publishes it. Nothing here reads a
// database, names a table or command, or persists anything (the boundary test pins that).
import { privateText, revealPrivateText, type PrivateText } from '../private-text.ts';
import { GLOSSARY_LINE, glossaryData, glossaryTerms, spellGlossary } from './glossary.ts';
import type { BoundPorts } from './ports.ts';
import { runFeature } from './run-feature.ts';
import { hasContact, numbersIn, SUMMARY_LIMITS, transcriptLines, type SummarySegment } from './meeting-summary.ts';

export const CHAPTER_LIMITS = {
  // Equal to CHAPTERS_MAX and CHAPTER_TITLE_MAX of the contract (this package cannot import it): the module's schema refuses more.
  chapters: 20,
  titleChars: 80,
  // The transcript sent to the model, in UTF-8 bytes: the summary's cap, refused and never cut (a table of contents of half a meeting would read as the whole).
  transcriptBytes: SUMMARY_LIMITS.transcriptBytes,
} as const;

export type ChaptersErrorCode = 'CHAPTERS_UNPARSABLE' | 'CHAPTERS_EMPTY' | 'CHAPTERS_TOO_LONG' | 'CHAPTERS_NO_TRANSCRIPT';
export class ChaptersError extends Error {
  code: ChaptersErrorCode;
  constructor(code: ChaptersErrorCode) {
    super(code);
    this.name = 'ChaptersError';
    this.code = code;
  }
}

export interface MeetingChaptersInput {
  segments: readonly SummarySegment[];
  language: 'vi' | 'en';
  // The organization's glossary (#4043), as the caller read it for the recorder: data beside the transcript, and the titles are spelled its way by code. Absent or empty: the run is what it was.
  glossary?: readonly string[];
}
export interface ChapterProposal {
  title: string;
  // The whole second of a real transcript line.
  startSeconds: number;
}
export interface MeetingChaptersBody {
  chapters: ChapterProposal[];
  // How many proposed chapters the checks removed (a count, never the text).
  dropped: number;
}
export interface MeetingChaptersResult {
  // The checked body as JSON text, private to the recorder like the transcript it came from.
  body: PrivateText;
  parsed: MeetingChaptersBody;
  usage: { inputTokens: number; outputTokens: number };
}

// The characters a title never holds: the same class as the minutes templates' CHECK (supabase/migrations/20270109090000) and the contract's `cleanTemplateText`: controls, soft hyphen, the
// invisible fillers, zero-width and directional marks, line and paragraph separators, bidi isolates, the Braille blank, the byte order mark, interlinear annotation and tag characters.
// The combining grapheme joiner is outside the class: a combining mark inside one is a lint warning (no-misleading-character-class).
// oxlint-disable-next-line no-control-regex
const STRIP = /[\u0001-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]|\u034f/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// oxlint-disable-next-line no-control-regex
const NUL = /\u0000/g;

/** A title as the model wrote it, one line, before any cut: the characters above removed (a line break, a tab, a vertical tab or a form feed becomes a space, as the rename's cleanTemplateText does), lone surrogates and NUL dropped, spaces folded, trimmed. */
export function foldTitleText(raw: string): string {
  const spaced = raw.replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ').replace(NUL, '').replace(LONE_SURROGATE, '').replace(STRIP, '');
  return spaced.replace(/\s+/g, ' ').trim();
}

/** A title as the model wrote it, one line: folded (see foldTitleText), then cut at the limit without splitting a pair. */
export function cleanChapterTitle(raw: string): string {
  const folded = foldTitleText(raw);
  // At the limit in UTF-16 units (what the contract and the database count), never through a pair.
  let out = '';
  for (const char of folded) {
    if (out.length + char.length > CHAPTER_LIMITS.titleChars) break;
    out += char;
  }
  return out.trim();
}

const wholeSecond = (seconds: number): number => Math.max(0, Math.floor(seconds));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function jsonObject(raw: string): unknown {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) throw new ChaptersError('CHAPTERS_UNPARSABLE');
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    throw new ChaptersError('CHAPTERS_UNPARSABLE');
  }
}

/** The second of each line of the transcript, once: the places a chapter may start at. */
export function anchorSeconds(segments: readonly SummarySegment[]): Set<number> {
  return new Set(segments.map((s) => wholeSecond(s.startSeconds)));
}

/**
 * The checks. `raw` is the model's text; the answer is what survives: sorted by second, one chapter a second, at most the cap. A chapter is dropped (and counted) when its second is not an
 * integer equal to the whole second of a real line, its title is empty after cleaning, it carries a way to reach someone off the page, a run of 8 or more digits, or a figure the transcript does not write.
 * No chapter left is CHAPTERS_EMPTY.
 */
export function checkChapters(raw: string, segments: readonly SummarySegment[], glossary: readonly string[] = []): MeetingChaptersBody {
  const root = jsonObject(raw);
  if (!isRecord(root) || !Array.isArray(root.chapters)) throw new ChaptersError('CHAPTERS_UNPARSABLE');
  const anchors = anchorSeconds(segments);
  // The figures the meeting says (the speakers' words, not the clock of the lines).
  const known = new Set(numbersIn(segments.map((s) => s.text).join('\n')));
  const bySecond = new Map<number, string>();
  let dropped = 0;
  for (const entry of root.chapters as unknown[]) {
    if (!isRecord(entry) || typeof entry.title !== 'string' || typeof entry.startSecond !== 'number') {
      dropped += 1;
      continue;
    }
    const second = entry.startSecond;
    const baseTitle = cleanChapterTitle(entry.title);
    const title = glossary.length === 0 ? baseTitle : cleanChapterTitle(spellGlossary(baseTitle, glossary));
    const figures = numbersIn(title);
    const digits = title.normalize('NFKC').replace(/[^\p{Nd}]/gu, '').length;
    if (
      !Number.isInteger(second) ||
      !anchors.has(second) ||
      title === '' ||
      hasContact(title) ||
      title.includes('@') ||
      digits >= 8 ||
      figures.some((n) => !known.has(n)) ||
      bySecond.has(second)
    ) {
      dropped += 1;
      continue;
    }
    bySecond.set(second, title);
  }
  const ordered = [...bySecond.entries()].sort((a, b) => a[0] - b[0]);
  dropped += Math.max(0, ordered.length - CHAPTER_LIMITS.chapters);
  const chapters = ordered.slice(0, CHAPTER_LIMITS.chapters).map(([startSeconds, title]) => ({ title, startSeconds }));
  if (chapters.length === 0) throw new ChaptersError('CHAPTERS_EMPTY');
  return { chapters, dropped };
}

const INSTRUCTION = (language: 'vi' | 'en', glossary: readonly string[] = []): string =>
  [
    'You write the table of contents of one meeting from its transcript, for the person who recorded it.',
    `Write the titles in ${language === 'vi' ? 'Vietnamese' : 'English'}.`,
    'Answer with one JSON object only, no other text: {"chapters": [{"title": string, "startSecond": number}]}.',
    'A chapter is one topic of the meeting. "title" is a short plain phrase of at most 60 characters on one line. "startSecond" is the whole second written in the brackets of the first transcript line of that topic, as a number (for [1:05] it is 65).',
    'Write 3 to 12 chapters, in order of time, the first at the start of the meeting. Never write two chapters at the same second.',
    'Use only numbers, names and dates that appear in the transcript. Never write a link, an email address or a phone number. Add nothing the transcript does not say.',
    ...(glossary.length === 0 ? [] : [GLOSSARY_LINE]),
  ].join('\n');

/** One run of the recorder's Vy over a transcript: the model is asked once, the checks above decide what is kept. */
export async function chapterMeeting(input: MeetingChaptersInput, ports: BoundPorts): Promise<MeetingChaptersResult> {
  const text = transcriptLines(input.segments);
  // Refused before any call, never cut.
  if (input.segments.length === 0) throw new ChaptersError('CHAPTERS_NO_TRANSCRIPT');
  if (new TextEncoder().encode(text).length > CHAPTER_LIMITS.transcriptBytes) throw new ChaptersError('CHAPTERS_TOO_LONG');
  const glossary = glossaryTerms(input.glossary);
  const block = glossary.length === 0 ? '' : `${glossaryData(glossary)}TRANSCRIPT:\n`;
  const out = await runFeature(
    { instruction: INSTRUCTION(input.language, glossary), subject: privateText(block + text), maxSubjectChars: CHAPTER_LIMITS.transcriptBytes + block.length, feature: 'meetings.chapters' },
    ports,
  );
  const parsed = checkChapters(revealPrivateText(out.text), input.segments, glossary);
  return { body: privateText(JSON.stringify(parsed)), parsed, usage: out.usage };
}
