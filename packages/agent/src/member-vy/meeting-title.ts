// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy suggesting a title for one meeting from its transcript (#3947, ADR-0049 stage A): up to three candidates, shown to the recorder who picks one or none. The model is asked once, through
// the member-Vy ports, and what it answers is only a proposal: the checks below are code, not the model, and they decide what survives. A candidate is dropped when it is empty after cleaning, shorter than 3 or longer
// than 80 characters, carries a link, an email address, a phone number, a run of 8 or more digits or a figure the transcript does not hold, or repeats another. The characters are cleaned first, with the class the
// chapters' titles and the minutes templates' titles use (controls, bidi, zero-width and separators). Nothing here reads a database, names a table or command, or persists anything (the boundary test pins that):
// the candidates go back to the recorder's browser as plain text and are not stored; the recorder's own click on one runs the rename command.
import { privateText, revealPrivateText } from '../private-text.ts';
import { GLOSSARY_LINE, glossaryData, glossaryTerms, spellGlossary } from './glossary.ts';
import { foldTitleText } from './meeting-chapters.ts';
import type { BoundPorts } from './ports.ts';
import { runFeature } from './run-feature.ts';
import { hasContact, numbersIn, SUMMARY_LIMITS, transcriptLines, type SummarySegment } from './meeting-summary.ts';

export const TITLE_LIMITS = {
  candidates: 3,
  minChars: 3,
  maxChars: 80,
  // The transcript sent to the model, in UTF-8 bytes: the summary's cap, refused and never cut (a title from half a meeting would read as the whole).
  transcriptBytes: SUMMARY_LIMITS.transcriptBytes,
} as const;

export type TitleErrorCode = 'TITLE_UNPARSABLE' | 'TITLE_EMPTY' | 'TITLE_TOO_LONG' | 'TITLE_NO_TRANSCRIPT';
export class TitleError extends Error {
  code: TitleErrorCode;
  constructor(code: TitleErrorCode) {
    super(code);
    this.name = 'TitleError';
    this.code = code;
  }
}

export interface MeetingTitleInput {
  segments: readonly SummarySegment[];
  language: 'vi' | 'en';
  // The organization's glossary (#4043), as the caller read it for the recorder: data beside the transcript, and the candidates are spelled its way by code. Absent or empty: the run is what it was.
  glossary?: readonly string[];
}
export interface MeetingTitleAnswer {
  // The candidates that passed the checks, in the order the model wrote them, at most TITLE_LIMITS.candidates.
  titles: string[];
  // How many candidates the checks removed (a count, never the text).
  dropped: number;
}
export interface MeetingTitleResult {
  answer: MeetingTitleAnswer;
  usage: { inputTokens: number; outputTokens: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function jsonObject(raw: string): unknown {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) throw new TitleError('TITLE_UNPARSABLE');
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    throw new TitleError('TITLE_UNPARSABLE');
  }
}

/**
 * The checks. `raw` is the model's text; the answer is what survives, in the model's order, at most three. No candidate left is TITLE_EMPTY. A candidate is dropped (and counted) when it is not a string,
 * is empty after cleaning, is not 3 to 80 characters (counted in UTF-16 units, like the contract and the database; never cut to fit), carries a way to reach someone off the page, a run of 8 or more digits or a
 * figure the transcript does not write, or repeats an earlier candidate (compared without case and after NFKC).
 */
export function checkTitles(raw: string, segments: readonly SummarySegment[]): MeetingTitleAnswer {
  const root = jsonObject(raw);
  if (!isRecord(root) || !Array.isArray(root.titles)) throw new TitleError('TITLE_UNPARSABLE');
  // The figures the meeting says (the speakers' words, not the clock of the lines).
  const known = new Set(numbersIn(segments.map((s) => s.text).join('\n')));
  const seen = new Set<string>();
  const titles: string[] = [];
  let dropped = 0;
  for (const entry of root.titles as unknown[]) {
    if (typeof entry !== 'string') {
      dropped += 1;
      continue;
    }
    const title = foldTitleText(entry);
    const key = title.normalize('NFKC').toLowerCase();
    const digits = title.normalize('NFKC').replace(/[^\p{Nd}]/gu, '').length;
    if (
      title.length < TITLE_LIMITS.minChars ||
      title.length > TITLE_LIMITS.maxChars ||
      hasContact(title) ||
      title.includes('@') ||
      digits >= 8 ||
      numbersIn(title).some((n) => !known.has(n)) ||
      seen.has(key) ||
      titles.length >= TITLE_LIMITS.candidates
    ) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    titles.push(title);
  }
  if (titles.length === 0) throw new TitleError('TITLE_EMPTY');
  return { titles, dropped };
}

const INSTRUCTION = (language: 'vi' | 'en', glossary: readonly string[] = []): string =>
  [
    'You suggest a title for one meeting from its transcript, for the person who recorded it.',
    `Write the titles in ${language === 'vi' ? 'Vietnamese' : 'English'}.`,
    'Answer with one JSON object only, no other text: {"titles": [string]}.',
    'Write 3 different titles, best first. Each is a short plain phrase of 3 to 60 characters on one line that says what the meeting was about, like a subject line.',
    'Use only numbers, names and dates that appear in the transcript. Never write a link, an email address or a phone number. Add nothing the transcript does not say.',
    ...(glossary.length === 0 ? [] : [GLOSSARY_LINE]),
  ].join('\n');

/** One run of the recorder's Vy over a transcript: the model is asked once, the checks above decide what is kept. */
export async function suggestMeetingTitles(input: MeetingTitleInput, ports: BoundPorts): Promise<MeetingTitleResult> {
  const text = transcriptLines(input.segments);
  // Refused before any call, never cut.
  if (input.segments.length === 0) throw new TitleError('TITLE_NO_TRANSCRIPT');
  if (new TextEncoder().encode(text).length > TITLE_LIMITS.transcriptBytes) throw new TitleError('TITLE_TOO_LONG');
  const glossary = glossaryTerms(input.glossary);
  const block = glossary.length === 0 ? '' : `${glossaryData(glossary)}TRANSCRIPT:\n`;
  const out = await runFeature(
    { instruction: INSTRUCTION(input.language, glossary), subject: privateText(block + text), maxSubjectChars: TITLE_LIMITS.transcriptBytes + block.length, feature: 'meetings.title' },
    ports,
  );
  const answer = checkTitles(revealPrivateText(out.text), input.segments);
  // The organization's spelling of a term in a candidate (case or spacing only), by code, after the checks.
  return { answer: glossary.length === 0 ? answer : { ...answer, titles: answer.titles.map((title) => spellGlossary(title, glossary)) }, usage: out.usage };
}
