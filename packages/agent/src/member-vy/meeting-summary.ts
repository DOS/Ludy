// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy summarizing one meeting (#2580, M6 part B, ADR-0047 point 8, ADR-0049 stage A): from the transcript it proposes a summary, the
// decisions and the action items. The model is asked once, through the member-Vy ports, and what it answers is only a proposal: the checks below are
// code, not the model, and they decide what survives. A figure the transcript does not hold, a sentence that carries a link, an email address or a
// phone number, and a time that points at no moment of the meeting are removed or blanked before anything is stored; the text that is left is still
// the model's, so it stays private to the recorder and tainted until the recorder's own command copies it into a draft and a person edits and
// shares it. Nothing here reads a database, names a table or command, or persists anything (the boundary test pins that).
import { privateText, revealPrivateText, type PrivateText } from '../private-text.ts';
import type { BoundPorts } from './ports.ts';
import { runFeature } from './run-feature.ts';

export const SUMMARY_LIMITS = {
  summaryChars: 8000,
  decisionChars: 500,
  decisions: 50,
  // A4 (#3162): the sections a template asks for. A section's text is cut at the cap so the sections together stay inside summaryChars as one text.
  sectionChars: 1200,
  sections: 8,
  titleChars: 300,
  textChars: 200,
  items: 100,
  // The transcript sent to the model, in UTF-8 bytes (so Vietnamese text counts what it weighs, not by its characters). The caller refuses a longer one before any call (the member waits for the answer, so the call is short);
  // runFeature would cut it silently, which a summary of half a meeting must never do.
  transcriptBytes: 60_000,
} as const;

export interface SummarySegment {
  startSeconds: number;
  endSeconds: number;
  speakerLabel: string;
  text: string;
}
// A minutes template, as the caller (which owns the templates, in code) hands it over: the code that goes back in the body, and the sections to fill (key, the heading in
// Vietnamese, a hint for the model). No sections is the general summary, as before.
export interface SummaryTemplate {
  code: string;
  sections: ReadonlyArray<{ key: string; title: string; hint: string }>;
}
export interface MeetingSummaryInput {
  segments: readonly SummarySegment[];
  language: 'vi' | 'en';
  template?: SummaryTemplate;
}
export interface SummaryItem {
  title: string;
  who: string;
  when: string;
  // The second of the transcript the item rests on, only when it points into a real segment.
  seconds: number | null;
}
export interface MeetingSummaryBody {
  // The template the run was asked for and the sections it filled, in the template's order (empty on the general template). The summary is '' when sections are used.
  template: string;
  sections: Array<{ key: string; text: string }>;
  summary: string;
  decisions: string[];
  items: SummaryItem[];
  // How many lines, items and fields the checks removed or blanked (a count, never the text).
  dropped: number;
}

export type SummaryErrorCode = 'SUMMARY_UNPARSABLE' | 'SUMMARY_EMPTY' | 'SUMMARY_TOO_LONG' | 'SUMMARY_NO_TRANSCRIPT';
export class SummaryError extends Error {
  code: SummaryErrorCode;
  constructor(code: SummaryErrorCode) {
    super(code);
    this.name = 'SummaryError';
    this.code = code;
  }
}

const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
/** The numbers a text writes, as written (NFKC, so full-width digits read as digits). */
export function numbersIn(text: string): string[] {
  return text.normalize('NFKC').match(NUMBER) ?? [];
}

// A link, an email address or a phone-like run of digits, found by linear scans (no backtracking pattern runs on text a model wrote).
function hasEmail(token: string): boolean {
  const parts = token.split('@');
  for (let i = 1; i < parts.length; i += 1) {
    const before = parts[i - 1] as string;
    const after = parts[i] as string;
    const dot = after.indexOf('.', 1);
    if (before.length > 0 && dot > 0 && dot < after.length - 1) return true;
  }
  return false;
}
function hasPhone(text: string): boolean {
  let start = -1;
  let last = -1;
  for (let i = 0; i <= text.length; i += 1) {
    const c = i < text.length ? (text[i] as string) : '';
    const digit = c >= '0' && c <= '9';
    if (digit) {
      if (start < 0) start = i;
      last = i;
    } else if (!(c === ' ' || c === '.' || c === '-')) {
      if (start >= 0 && last - start + 1 >= 9) return true;
      start = -1;
      last = -1;
    }
  }
  return false;
}
/** Whether a text carries a way to reach someone off the page: a link, an email address or a phone number. */
export function hasContact(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('http://') || lower.includes('https://') || lower.includes('www.') || hasPhone(text) || lower.split(/\s+/).some((token) => hasEmail(token));
}

const oneLine = (value: string, max: number): string => value.replace(/\s+/g, ' ').trim().slice(0, max);

// "[m:ss] Speaker: text", one line per segment.
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
export function transcriptLines(segments: readonly SummarySegment[]): string {
  return segments.map((s) => `[${clock(s.startSeconds)}] ${oneLine(s.speakerLabel, 80)}: ${oneLine(s.text, 4000)}`).join('\n');
}

function jsonObject(raw: string): unknown {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) throw new SummaryError('SUMMARY_UNPARSABLE');
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    throw new SummaryError('SUMMARY_UNPARSABLE');
  }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The checks, in code: parse what the model answered and keep only what holds. A line (a sentence of the summary, a decision, an item) that writes a
 * figure the transcript does not hold, or carries a way to reach someone, is removed; an item's "who" or "when" with a foreign figure is blanked; an
 * item's second that points into no segment is dropped. An answer that is not an object throws SUMMARY_UNPARSABLE, and one with nothing left SUMMARY_EMPTY.
 */
export function checkSummary(raw: string, segments: readonly SummarySegment[], template: SummaryTemplate = { code: 'general', sections: [] }): MeetingSummaryBody {
  const parsed = jsonObject(raw);
  if (!isRecord(parsed)) throw new SummaryError('SUMMARY_UNPARSABLE');
  const known = new Set(segments.flatMap((s) => numbersIn(s.text)));
  const foreign = (text: string): boolean => numbersIn(text).some((n) => !known.has(n));
  const bad = (text: string): boolean => foreign(text) || hasContact(text);
  let dropped = 0;

  const useSections = template.sections.length > 0;
  // A section's text, kept line by line (a list stays a list): a sentence with a figure the transcript lacks or a way to reach someone is removed, and the text is cut
  // at the cap by whole lines. Only the keys the template names are read, the first of a repeated key wins, the order is the template's.
  const sections: Array<{ key: string; text: string }> = [];
  if (useSections && Array.isArray(parsed.sections)) {
    const seen = new Set<string>();
    for (const entry of parsed.sections) {
      if (!isRecord(entry) || typeof entry.key !== 'string' || typeof entry.text !== 'string') continue;
      if (!template.sections.some((d) => d.key === entry.key) || seen.has(entry.key)) {
        dropped += 1;
        continue;
      }
      seen.add(entry.key);
      const kept: string[] = [];
      let length = 0;
      for (const rawLine of entry.text.split('\n')) {
        const pieces: string[] = [];
        for (const piece of rawLine.split(/(?<=[.!?])\s+/)) {
          const sentence = oneLine(piece, SUMMARY_LIMITS.sectionChars);
          if (sentence === '') continue;
          if (bad(sentence)) dropped += 1;
          else pieces.push(sentence);
        }
        const line = pieces.join(' ');
        if (line === '') continue;
        if (length + line.length + 1 > SUMMARY_LIMITS.sectionChars) {
          dropped += 1;
          continue;
        }
        kept.push(line);
        length += line.length + 1;
      }
      if (kept.length > 0) sections.push({ key: entry.key, text: kept.join('\n') });
    }
    sections.sort((a, b) => template.sections.findIndex((d) => d.key === a.key) - template.sections.findIndex((d) => d.key === b.key));
  }

  const sentences: string[] = [];
  if (!useSections && typeof parsed.summary === 'string') {
    for (const piece of parsed.summary.split(/(?<=[.!?])\s+|\n+/)) {
      const line = oneLine(piece, SUMMARY_LIMITS.summaryChars);
      if (line === '') continue;
      if (bad(line)) dropped += 1;
      else sentences.push(line);
    }
  }
  const summary = sentences.join(' ').slice(0, SUMMARY_LIMITS.summaryChars);

  const decisions: string[] = [];
  if (Array.isArray(parsed.decisions)) {
    for (const entry of parsed.decisions) {
      if (typeof entry !== 'string') continue;
      const line = oneLine(entry, SUMMARY_LIMITS.decisionChars);
      if (line === '') continue;
      if (bad(line)) dropped += 1;
      else if (decisions.length < SUMMARY_LIMITS.decisions) decisions.push(line);
    }
  }

  const items: SummaryItem[] = [];
  if (Array.isArray(parsed.items)) {
    for (const entry of parsed.items) {
      if (!isRecord(entry) || typeof entry.title !== 'string') continue;
      const title = oneLine(entry.title, SUMMARY_LIMITS.titleChars);
      // A foreign figure in the title refuses the item; a contact detail does not (it stays, flagged by the module's own check, for a person to read).
      if (title === '' || foreign(title)) {
        dropped += 1;
        continue;
      }
      const field = (value: unknown): string => {
        const text = typeof value === 'string' ? oneLine(value, SUMMARY_LIMITS.textChars) : '';
        // A name or a time that carries a figure the transcript lacks, or a way to reach someone, is blanked: readers see these words beside the item.
        if (text !== '' && bad(text)) {
          dropped += 1;
          return '';
        }
        return text;
      };
      const who = field(entry.who);
      const when = field(entry.when);
      let seconds: number | null = null;
      const claimed = entry.seconds;
      if (typeof claimed === 'number' && Number.isInteger(claimed) && segments.some((s) => claimed >= Math.floor(s.startSeconds) && claimed <= Math.ceil(s.endSeconds))) {
        seconds = claimed;
      } else if (claimed !== undefined && claimed !== null) dropped += 1;
      if (items.length < SUMMARY_LIMITS.items) items.push({ title, who, when, seconds });
    }
  }
  if (summary === '' && sections.length === 0 && decisions.length === 0 && items.length === 0) throw new SummaryError('SUMMARY_EMPTY');
  return { template: template.code, sections, summary, decisions, items, dropped };
}

const INSTRUCTION = (language: 'vi' | 'en', template: SummaryTemplate): string =>
  [
    'You summarize one meeting from its transcript for the person who recorded it.',
    `Write in ${language === 'vi' ? 'Vietnamese' : 'English'}.`,
    template.sections.length === 0
      ? 'Answer with one JSON object only, no other text: {"summary": string, "decisions": string[], "items": [{"title": string, "who": string, "when": string, "seconds": number}]}.'
      : 'Answer with one JSON object only, no other text: {"sections": [{"key": string, "text": string}], "decisions": string[], "items": [{"title": string, "who": string, "when": string, "seconds": number}]}.',
    template.sections.length === 0
      ? '"summary" is a few plain sentences of what was discussed.'
      : [
          'The minutes have these sections; write one entry in "sections" for each section the transcript says something about, with its "key" exactly as given, and leave out a section the transcript says nothing about:',
          ...template.sections.map((d) => `- key "${d.key}" (${d.title}): ${d.hint}`),
          'Each "text" is a few plain sentences or short lines of what was said for that section, at most about 1000 characters.',
        ].join('\n'),
    '"decisions" are things the meeting decided. "items" are things someone said they would do:',
    '"title" is what to do, "who" and "when" are exactly as said in the transcript (empty when not said), and "seconds" is the second of the transcript line the item comes from.',
    'Use only numbers, names and dates that appear in the transcript. Never write a link, an email address or a phone number. Add nothing the transcript does not say.',
  ].join('\n');

export interface MeetingSummaryResult {
  // The checked body as JSON text, private to the recorder like the transcript it came from.
  body: PrivateText;
  parsed: MeetingSummaryBody;
  usage: { inputTokens: number; outputTokens: number };
}

/** One run of the recorder's Vy over a transcript: the model is asked once, the checks above decide what is kept. */
export async function summarizeMeeting(input: MeetingSummaryInput, ports: BoundPorts): Promise<MeetingSummaryResult> {
  const text = transcriptLines(input.segments);
  const template: SummaryTemplate = input.template ?? { code: 'general', sections: [] };
  // Refused before any call, never cut: a summary of half a meeting would read as the whole.
  if (input.segments.length === 0) throw new SummaryError('SUMMARY_NO_TRANSCRIPT');
  if (new TextEncoder().encode(text).length > SUMMARY_LIMITS.transcriptBytes) throw new SummaryError('SUMMARY_TOO_LONG');
  const out = await runFeature(
    { instruction: INSTRUCTION(input.language, template), subject: privateText(text), maxSubjectChars: SUMMARY_LIMITS.transcriptBytes },
    ports,
  );
  const parsed = checkSummary(revealPrivateText(out.text), input.segments, template);
  return { body: privateText(JSON.stringify(parsed)), parsed, usage: out.usage };
}
