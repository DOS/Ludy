// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy listing what each speaker of one meeting said they would do or said was decided (#3954, ADR-0049 stage A): grouped by speaker, each line a commitment or a decision with the
// second of the transcript line it rests on. The model is asked once, through the member-Vy ports, and what it answers is only a proposal: the checks below are code, not the model, and they decide
// what survives. A speaker is whoever the transcript says (the label or attendee name already on its lines), matched exactly and written back as the transcript spells it: the model never names a person.
// A line is dropped, never repaired or moved to someone else, when its speaker is not one of the transcript's, its second is not the whole start second of a real line spoken by that same speaker, its
// kind is not a commitment or a decision, or its text is empty after cleaning, longer than 200 characters, carries a link, an email address, a phone number, a run of 8 or more digits or a figure the
// cited transcript line does not say, or repeats an earlier line of that speaker. The answer has no field for talk time, tone or any judgment of a person. Nothing here reads a database, names a table or command,
// or persists anything (the boundary test pins that); the lines go back to the recorder's browser as plain text and are not stored.
import {
  hasAutonomousActionDirective,
  hasObfuscatedContactOrLink,
  hasPromptMarkupLeak,
  hasUngroundedMoneyOrScaleWords,
} from '../injection-guards.ts';
import { privateText, revealPrivateText } from '../private-text.ts';
import { foldTitleText } from './meeting-chapters.ts';
import type { BoundPorts } from './ports.ts';
import { runFeature } from './run-feature.ts';
import { hasContact, numbersIn, SUMMARY_LIMITS, transcriptLines, type SummarySegment } from './meeting-summary.ts';

export const COMMITMENT_LIMITS = {
  // Equal to COMMITMENT_SPEAKERS_MAX, COMMITMENT_LINES_MAX and COMMITMENT_TEXT_MAX of the contract (this package cannot import it).
  speakers: 20,
  linesPerSpeaker: 5,
  minChars: 3,
  textChars: 200,
  // The transcript sent to the model, in UTF-8 bytes: the summary's cap, refused and never cut (what each person said, from half a meeting, would read as the whole).
  transcriptBytes: SUMMARY_LIMITS.transcriptBytes,
} as const;

export const COMMITMENT_KINDS = ['commitment', 'decision'] as const;
// Equal to CHAPTER_SECOND_MAX of the contract: a second past a day is no line of a meeting, and the contract would refuse it.
const COMMITMENT_SECOND_MAX = 86_400;
// The most `dropped` counts, equal to the contract's cap: a degenerate answer cannot push the count past what the contract accepts.
const DROPPED_MAX = 1000;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

export type CommitmentsErrorCode = 'COMMITMENTS_UNPARSABLE' | 'COMMITMENTS_EMPTY' | 'COMMITMENTS_TOO_LONG' | 'COMMITMENTS_NO_TRANSCRIPT';
export class CommitmentsError extends Error {
  code: CommitmentsErrorCode;
  constructor(code: CommitmentsErrorCode) {
    super(code);
    this.name = 'CommitmentsError';
    this.code = code;
  }
}

export interface MeetingCommitmentsInput {
  segments: readonly SummarySegment[];
  language: 'vi' | 'en';
}
export interface CommitmentLine {
  kind: CommitmentKind;
  text: string;
  // The whole start second of a real transcript line spoken by this speaker.
  seconds: number;
}
export interface SpeakerCommitments {
  // The speaker as the transcript spells it, never the model's spelling.
  label: string;
  lines: CommitmentLine[];
}
export interface MeetingCommitmentsAnswer {
  // The speakers that have a line left, in the order they first speak, each line in order of time.
  speakers: SpeakerCommitments[];
  // How many proposed lines the checks removed (a count, never the text).
  dropped: number;
}
export interface MeetingCommitmentsResult {
  answer: MeetingCommitmentsAnswer;
  usage: { inputTokens: number; outputTokens: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const wholeSecond = (seconds: number): number => Math.max(0, Math.floor(seconds));
// A label as the transcript text writes it (transcriptLines folds spaces and keeps 80 characters): the form a speaker is matched in.
const labelOf = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 80);

function jsonObject(raw: string): unknown {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) throw new CommitmentsError('COMMITMENTS_UNPARSABLE');
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    throw new CommitmentsError('COMMITMENTS_UNPARSABLE');
  }
}

/**
 * The checks. `raw` is the model's text; the answer is what survives: the speakers the transcript has, in the order they first speak, each with at most five lines in order of time. A line is dropped
 * (and counted) for any reason in the file's header. Nothing left is COMMITMENTS_EMPTY.
 */
export function checkCommitments(raw: string, segments: readonly SummarySegment[]): MeetingCommitmentsAnswer {
  const root = jsonObject(raw);
  if (!isRecord(root) || !Array.isArray(root.speakers)) throw new CommitmentsError('COMMITMENTS_UNPARSABLE');
  // Who speaks which whole second, and the order speakers first appear in. A speaker's lines are only those that rest on a second this very speaker has, and a figure in a line must be one that
  // very transcript line says (the line the reader opens), not one said anywhere in the meeting.
  const secondsOf = new Map<string, Map<number, Set<string>>>();
  for (const s of segments) {
    const label = labelOf(s.speakerLabel);
    if (label === '') continue;
    const bySecond = secondsOf.get(label) ?? new Map<number, Set<string>>();
    const second = wholeSecond(s.startSeconds);
    const figures = bySecond.get(second) ?? new Set<string>();
    for (const n of numbersIn(s.text)) figures.add(n);
    bySecond.set(second, figures);
    secondsOf.set(label, bySecond);
  }
  const transcriptHasMoneyScaleWords = hasUngroundedMoneyOrScaleWords(segments.map((s) => s.text).join('\n'));
  const kept = new Map<string, { lines: CommitmentLine[]; seen: Set<string> }>();
  let dropped = 0;
  const drop = () => {
    dropped += 1;
  };
  for (const entry of root.speakers as unknown[]) {
    if (!isRecord(entry) || typeof entry.label !== 'string' || !Array.isArray(entry.lines)) {
      dropped += isRecord(entry) && Array.isArray(entry.lines) ? entry.lines.length : 1;
      continue;
    }
    const label = labelOf(entry.label);
    const bySecond = secondsOf.get(label);
    for (const line of entry.lines as unknown[]) {
      if (!bySecond || !isRecord(line) || typeof line.text !== 'string' || typeof line.second !== 'number' || typeof line.kind !== 'string') {
        drop();
        continue;
      }
      const kind = (COMMITMENT_KINDS as readonly string[]).includes(line.kind) ? (line.kind as CommitmentKind) : null;
      const text = foldTitleText(line.text);
      const key = text.normalize('NFKC').toLowerCase();
      const into = kept.get(label) ?? { lines: [], seen: new Set<string>() };
      if (
        kind === null ||
        !Number.isInteger(line.second) ||
        line.second > COMMITMENT_SECOND_MAX ||
        !bySecond.has(line.second) ||
        text.length < COMMITMENT_LIMITS.minChars ||
        text.length > COMMITMENT_LIMITS.textChars ||
        hasContact(text) ||
        hasObfuscatedContactOrLink(text) ||
        hasPromptMarkupLeak(line.text) ||
        hasPromptMarkupLeak(text) ||
        hasAutonomousActionDirective(text) ||
        (!transcriptHasMoneyScaleWords && hasUngroundedMoneyOrScaleWords(text)) ||
        text.includes('@') ||
        /\p{Nd}{8}/u.test(text.normalize('NFKC')) ||
        numbersIn(text).some((n) => !bySecond.get(line.second as number)?.has(n)) ||
        into.seen.has(key) ||
        into.lines.length >= COMMITMENT_LIMITS.linesPerSpeaker
      ) {
        drop();
        continue;
      }
      into.seen.add(key);
      into.lines.push({ kind, text, seconds: line.second });
      kept.set(label, into);
    }
  }
  const speakers: SpeakerCommitments[] = [];
  for (const label of secondsOf.keys()) {
    const into = kept.get(label);
    if (!into || into.lines.length === 0) continue;
    if (speakers.length >= COMMITMENT_LIMITS.speakers) {
      dropped += into.lines.length;
      continue;
    }
    speakers.push({ label, lines: [...into.lines].sort((a, b) => a.seconds - b.seconds) });
  }
  if (speakers.length === 0) throw new CommitmentsError('COMMITMENTS_EMPTY');
  return { speakers, dropped: Math.min(dropped, DROPPED_MAX) };
}

const INSTRUCTION = (language: 'vi' | 'en'): string =>
  [
    'You list what each speaker of one meeting said they would do, and what each said was decided, from its transcript, for the person who recorded it.',
    `Write the lines in ${language === 'vi' ? 'Vietnamese' : 'English'}.`,
    'Answer with one JSON object only, no other text: {"speakers": [{"label": string, "lines": [{"kind": "commitment" | "decision", "text": string, "second": number}]}]}.',
    '"label" is the speaker exactly as written before the colon of a transcript line. Never invent, merge or rename a speaker.',
    'A "commitment" is something that speaker said they themselves will do. A "decision" is something that speaker said was decided. "text" is one short plain sentence of at most 160 characters on one line, in your own words.',
    '"second" is the whole second of the transcript line of that same speaker the line rests on, as a number (for [1:05] it is 65). Write at most 5 lines per speaker. Leave a speaker out if they committed to nothing.',
    'Write only commitments and decisions. Never write how long or how much anyone spoke, anyone\'s tone, mood or attitude, or an opinion of a person. Use only numbers, names and dates that appear in the transcript. Never write a link, an email address or a phone number. Add nothing the transcript does not say.',
  ].join('\n');

/** One run of the recorder's Vy over a transcript: the model is asked once, the checks above decide what is kept. */
export async function listCommitments(input: MeetingCommitmentsInput, ports: BoundPorts): Promise<MeetingCommitmentsResult> {
  const text = transcriptLines(input.segments);
  // Refused before any call, never cut.
  if (input.segments.length === 0) throw new CommitmentsError('COMMITMENTS_NO_TRANSCRIPT');
  if (new TextEncoder().encode(text).length > COMMITMENT_LIMITS.transcriptBytes) throw new CommitmentsError('COMMITMENTS_TOO_LONG');
  const out = await runFeature({ instruction: INSTRUCTION(input.language), subject: privateText(text), maxSubjectChars: COMMITMENT_LIMITS.transcriptBytes, feature: 'meetings.commitments' }, ports);
  return { answer: checkCommitments(revealPrivateText(out.text), input.segments), usage: out.usage };
}
