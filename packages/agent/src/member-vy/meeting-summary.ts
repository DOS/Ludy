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
  // Equals SECTION_TEXT_MAX of the contract (this package cannot import it): the module's schema refuses a longer section.
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

  // A template asked for sections: an answer that gave none in the list shape (a summary only, or an object) lost that text, which the count says.
  if (useSections && !Array.isArray(parsed.sections) && (typeof parsed.summary === 'string' || isRecord(parsed.sections))) dropped += 1;

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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// "Viết lại đầy đủ" (Meetings A5, #3163): the recorder's Vy expands the recorder's own rough notes with the transcript, into the sections of the meeting's template (or one block on the
// general summary). Same family as the summary (the same feature key, meter and budget line, the same private result). The model never writes the recorder's lines: it names a note
// line by its number and CODE puts the original text in, so an own line is verbatim by construction; a line the model leaves out is appended where it belongs, never dropped. A line
// Vy adds must point at a real second of the transcript, and a figure in it must appear in the transcript or in the notes, or the line is removed (and counted). Nothing here reads a
// database or persists anything.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const ENHANCE_LIMITS = {
  // The most lines a note may have, and the longest line Vy may add.
  noteLines: 300,
  addedChars: 300,
  // The whole text of the expansion, own lines included, as one summary text (8000 characters is the database's limit, headings need room).
  totalChars: 7400,
} as const;

export interface EnhanceInput {
  segments: readonly SummarySegment[];
  language: 'vi' | 'en';
  // The recorder's rough notes, as typed.
  notes: string;
  template?: SummaryTemplate;
}
export interface EnhancedLine {
  own: boolean;
  text: string;
  // The second of the transcript an ADDED line rests on (always set for it); null for the recorder's own line.
  seconds: number | null;
}
export interface EnhancedBody {
  template: string;
  // What the summary body holds, empty here, so the one stored shape serves both kinds of run.
  sections: [];
  summary: '';
  decisions: [];
  items: [];
  dropped: number;
  enhanced: { sections: Array<{ key: string | null; lines: EnhancedLine[] }> };
}

/** The recorder's lines: one per non-empty line of the notes, as typed (outer whitespace trimmed), at most noteLines of them. */
export function noteLines(notes: string): string[] {
  return notes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, ENHANCE_LIMITS.noteLines);
}

/**
 * The checks, in code: parse what the model answered and keep only what holds. Returns the sections in the template's order with the recorder's lines verbatim. An answer that is not an object
 * throws SUMMARY_UNPARSABLE; one with no line of Vy's left throws SUMMARY_EMPTY (an expansion that adds nothing the transcript supports is not a result).
 */
export function checkEnhanced(raw: string, segments: readonly SummarySegment[], notes: readonly string[], template: SummaryTemplate = { code: 'general', sections: [] }): EnhancedBody {
  const parsed = jsonObject(raw);
  if (!isRecord(parsed)) throw new SummaryError('SUMMARY_UNPARSABLE');
  // A figure is fine when the transcript or the recorder's own notes hold it.
  const known = new Set([...segments.flatMap((s) => numbersIn(s.text)), ...notes.flatMap((n) => numbersIn(n))]);
  const foreign = (text: string): boolean => numbersIn(text).some((n) => !known.has(n));
  let dropped = 0;
  const keys: Array<string | null> = template.sections.length === 0 ? [null] : template.sections.map((d) => d.key);
  const groups = new Map<string | null, EnhancedLine[]>(keys.map((k) => [k, []]));
  const used = new Set<number>();
  // The recorder's own lines count first, so Vy's additions never push them out of the text's budget.
  const ownTotal = notes.reduce((n, line) => n + line.length + 1, 0);
  let addedTotal = 0;
  if (Array.isArray(parsed.sections)) {
    for (const entry of parsed.sections) {
      if (!isRecord(entry) || !Array.isArray(entry.lines)) {
        dropped += 1;
        continue;
      }
      let key: string | null;
      if (template.sections.length === 0) key = null;
      else if (typeof entry.key === 'string' && keys.includes(entry.key)) key = entry.key;
      else {
        dropped += 1;
        continue;
      }
      for (const line of entry.lines) {
        if (!isRecord(line)) {
          dropped += 1;
          continue;
        }
        if (typeof line.note === 'number') {
          const n = line.note;
          // A note line is named by its number, once; another number or a repeat is not a line.
          if (Number.isInteger(n) && n >= 1 && n <= notes.length && !used.has(n)) {
            used.add(n);
            (groups.get(key) as EnhancedLine[]).push({ own: true, text: notes[n - 1] as string, seconds: null });
          } else dropped += 1;
          continue;
        }
        const text = typeof line.text === 'string' ? oneLine(line.text, ENHANCE_LIMITS.addedChars) : '';
        const seconds = line.seconds;
        if (text === '') {
          dropped += 1;
          continue;
        }
        // Every line Vy adds rests on a real moment of the transcript, has no figure nobody said and no way to reach someone off the page.
        const real = typeof seconds === 'number' && Number.isInteger(seconds) && segments.some((s) => seconds >= Math.floor(s.startSeconds) && seconds <= Math.ceil(s.endSeconds));
        if (!real || foreign(text) || hasContact(text) || addedTotal + text.length + 1 > ENHANCE_LIMITS.totalChars - ownTotal) {
          dropped += 1;
          continue;
        }
        addedTotal += text.length + 1;
        (groups.get(key) as EnhancedLine[]).push({ own: false, text, seconds: seconds as number });
      }
    }
  } else if (parsed.sections !== undefined) dropped += 1;
  const added = [...groups.values()].reduce((n, lines) => n + lines.filter((l) => !l.own).length, 0);
  if (added === 0) throw new SummaryError('SUMMARY_EMPTY');
  // A note line the model did not name is never lost: it goes at the end of the last section that has lines (else the first), in the order it was written.
  const missing = notes.flatMap((text, i) => (used.has(i + 1) ? [] : [{ own: true, text, seconds: null } satisfies EnhancedLine]));
  if (missing.length > 0) {
    const filled = keys.filter((k) => (groups.get(k) as EnhancedLine[]).length > 0);
    (groups.get(filled.length > 0 ? (filled[filled.length - 1] as string | null) : (keys[0] as string | null)) as EnhancedLine[]).push(...missing);
  }
  const sections = keys.flatMap((k) => {
    const lines = groups.get(k) as EnhancedLine[];
    return lines.length > 0 ? [{ key: k, lines }] : [];
  });
  return { template: template.code, sections: [], summary: '', decisions: [], items: [], dropped, enhanced: { sections } };
}

const ENHANCE_INSTRUCTION = (language: 'vi' | 'en', template: SummaryTemplate): string =>
  [
    "You expand a person's rough meeting notes using the transcript of the same meeting.",
    `Write in ${language === 'vi' ? 'Vietnamese' : 'English'}.`,
    'Below the data you get NOTES (numbered lines the person typed) and the TRANSCRIPT.',
    'Answer with one JSON object only, no other text: {"sections": [{"key": string, "lines": [{"note": number} or {"text": string, "seconds": number}]}]}.',
    'Refer to a note line only by its number, {"note": 3}; never copy or reword it, and use every note line once, in the section where it belongs.',
    'Add a line {"text": string, "seconds": number} only for something the transcript says that the notes do not: "text" is one short plain sentence and "seconds" is the second of the transcript line it comes from.',
    template.sections.length === 0
      ? 'There is one section: use the key "all".'
      : ['The sections are these; use their keys exactly as given and leave out a section with nothing for it:', ...template.sections.map((d) => `- key "${d.key}" (${d.title}): ${d.hint}`)].join('\n'),
    'Use only numbers, names and dates that appear in the transcript or the notes. Never write a link, an email address or a phone number. Add nothing the transcript does not say.',
  ].join('\n');

export interface EnhanceResult {
  // The checked body as JSON text, private to the recorder like the transcript and the notes it came from.
  body: PrivateText;
  parsed: EnhancedBody;
  usage: { inputTokens: number; outputTokens: number };
}

/** One run of the recorder's Vy over their rough notes and the transcript: the model is asked once, the checks above decide what is kept. */
export async function enhanceNotes(input: EnhanceInput, ports: BoundPorts): Promise<EnhanceResult> {
  const template: SummaryTemplate = input.template ?? { code: 'general', sections: [] };
  const notes = noteLines(input.notes);
  if (input.segments.length === 0) throw new SummaryError('SUMMARY_NO_TRANSCRIPT');
  if (notes.length === 0) throw new SummaryError('SUMMARY_EMPTY');
  const text = `NOTES:\n${notes.map((line, i) => `${i + 1}: ${oneLine(line, 6000)}`).join('\n')}\n\nTRANSCRIPT:\n${transcriptLines(input.segments)}`;
  if (new TextEncoder().encode(text).length > SUMMARY_LIMITS.transcriptBytes) throw new SummaryError('SUMMARY_TOO_LONG');
  const out = await runFeature({ instruction: ENHANCE_INSTRUCTION(input.language, template), subject: privateText(text), maxSubjectChars: SUMMARY_LIMITS.transcriptBytes }, ports);
  const parsed = checkEnhanced(revealPrivateText(out.text), input.segments, notes, template);
  return { body: privateText(JSON.stringify(parsed)), parsed, usage: out.usage };
}
