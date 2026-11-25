// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy listing what one meeting left open (#4768, ADR-0049 stage A): the questions that were asked and not answered, and the topics where a decision was raised and not taken, each with the second of
// the transcript line it rests on. The model is asked once, through the member-Vy ports, and what it answers is only a proposal: the checks below are code, not the model, and they decide what survives. What code
// can check is the citation and the text: a point is dropped, never repaired or moved, when its kind is not a question or a decision, its second is not the whole start second of a real transcript line, its text is empty
// after cleaning, longer than 200 characters, carries a link, an email address, a phone number, a run of 8 or more digits or a figure the cited line does not say, or repeats an earlier point of its kind. Whether a question
// really went unanswered is the model's reading and is not something code can prove: the recorder reads the cited line, and the wording of the list says "chưa thấy trả lời" (not heard answered), never that nobody answered.
// The answer has no field for a person, tone or judgment. Nothing here reads a database, names a table or command, or persists anything (the boundary test pins that); the lines go back to the recorder's browser as plain
// text and are not stored.
import { hasAutonomousActionDirective, hasObfuscatedContactOrLink, hasPromptMarkupLeak, hasUngroundedMoneyOrScaleWords } from '../injection-guards.ts';
import { privateText, revealPrivateText } from '../private-text.ts';
import { foldTitleText } from './meeting-chapters.ts';
import type { BoundPorts } from './ports.ts';
import { runFeature } from './run-feature.ts';
import { hasContact, numbersIn, SUMMARY_LIMITS, transcriptLines, type SummarySegment } from './meeting-summary.ts';

export const OPEN_POINT_LIMITS = {
  // Equal to OPEN_POINTS_PER_KIND_MAX, OPEN_POINT_TEXT_MIN and OPEN_POINT_TEXT_MAX of the contract (this package cannot import it).
  perKind: 5,
  minChars: 3,
  textChars: 200,
  // The transcript sent to the model, in UTF-8 bytes: the summary's cap, refused and never cut (what a meeting left open, read from half of it, would read as the whole).
  transcriptBytes: SUMMARY_LIMITS.transcriptBytes,
} as const;

export const OPEN_POINT_KINDS = ['question', 'decision'] as const;
export type OpenPointKind = (typeof OPEN_POINT_KINDS)[number];
// Equal to CHAPTER_SECOND_MAX of the contract: a second past a day is no line of a meeting, and the contract would refuse it.
const OPEN_POINT_SECOND_MAX = 86_400;
// The most `dropped` counts, equal to the contract's cap.
const DROPPED_MAX = 1000;

export type OpenPointsErrorCode = 'OPEN_POINTS_UNPARSABLE' | 'OPEN_POINTS_EMPTY' | 'OPEN_POINTS_TOO_LONG' | 'OPEN_POINTS_NO_TRANSCRIPT';
export class OpenPointsError extends Error {
  code: OpenPointsErrorCode;
  constructor(code: OpenPointsErrorCode) {
    super(code);
    this.name = 'OpenPointsError';
    this.code = code;
  }
}

export interface MeetingOpenPointsInput {
  segments: readonly SummarySegment[];
  language: 'vi' | 'en';
}
export interface OpenPointLine {
  text: string;
  // The whole start second of a real transcript line.
  seconds: number;
}
export interface MeetingOpenPointsAnswer {
  questions: OpenPointLine[];
  decisions: OpenPointLine[];
  // How many proposed lines the checks removed (a count, never the text).
  dropped: number;
}
export interface MeetingOpenPointsResult {
  answer: MeetingOpenPointsAnswer;
  usage: { inputTokens: number; outputTokens: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const wholeSecond = (seconds: number): number => Math.max(0, Math.floor(seconds));

function jsonObject(raw: string): unknown {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) throw new OpenPointsError('OPEN_POINTS_UNPARSABLE');
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    throw new OpenPointsError('OPEN_POINTS_UNPARSABLE');
  }
}

/**
 * The checks. `raw` is the model's text ({"points":[{"kind":"question"|"decision","text":"...","second":65}]}); the answer is what survives: at most five of each kind, in order of time. A point is dropped (and
 * counted) for any reason in the file's header. Nothing left is OPEN_POINTS_EMPTY.
 */
export function checkOpenPoints(raw: string, segments: readonly SummarySegment[]): MeetingOpenPointsAnswer {
  const root = jsonObject(raw);
  if (!isRecord(root) || !Array.isArray(root.points)) throw new OpenPointsError('OPEN_POINTS_UNPARSABLE');
  // The whole seconds a transcript line starts at, and the figures that very line says (a figure in a point must be one the line the reader opens says, not one said anywhere in the meeting).
  const figuresAt = new Map<number, Set<string>>();
  for (const s of segments) {
    const second = wholeSecond(s.startSeconds);
    const figures = figuresAt.get(second) ?? new Set<string>();
    for (const n of numbersIn(s.text)) figures.add(n);
    figuresAt.set(second, figures);
  }
  const transcriptHasMoneyScaleWords = hasUngroundedMoneyOrScaleWords(segments.map((s) => s.text).join('\n'));
  const kept: Record<OpenPointKind, { lines: OpenPointLine[]; seen: Set<string> }> = { question: { lines: [], seen: new Set() }, decision: { lines: [], seen: new Set() } };
  let dropped = 0;
  for (const point of root.points as unknown[]) {
    if (!isRecord(point) || typeof point.kind !== 'string' || typeof point.text !== 'string' || typeof point.second !== 'number') {
      dropped += 1;
      continue;
    }
    const kind = (OPEN_POINT_KINDS as readonly string[]).includes(point.kind) ? (point.kind as OpenPointKind) : null;
    const text = foldTitleText(point.text);
    const key = text.normalize('NFKC').toLowerCase();
    const into = kind === null ? null : kept[kind];
    const figures = Number.isInteger(point.second) ? figuresAt.get(point.second) : undefined;
    if (
      into === null ||
      figures === undefined ||
      point.second > OPEN_POINT_SECOND_MAX ||
      text.length < OPEN_POINT_LIMITS.minChars ||
      text.length > OPEN_POINT_LIMITS.textChars ||
      hasContact(text) ||
      hasObfuscatedContactOrLink(text) ||
      hasPromptMarkupLeak(point.text) ||
      hasPromptMarkupLeak(text) ||
      hasAutonomousActionDirective(text) ||
      (!transcriptHasMoneyScaleWords && hasUngroundedMoneyOrScaleWords(text)) ||
      text.includes('@') ||
      /\p{Nd}{8}/u.test(text.normalize('NFKC')) ||
      numbersIn(text).some((n) => !figures.has(n)) ||
      into.seen.has(key) ||
      into.lines.length >= OPEN_POINT_LIMITS.perKind
    ) {
      dropped += 1;
      continue;
    }
    into.seen.add(key);
    into.lines.push({ text, seconds: point.second });
  }
  const byTime = (a: OpenPointLine, b: OpenPointLine): number => a.seconds - b.seconds;
  const questions = [...kept.question.lines].sort(byTime);
  const decisions = [...kept.decision.lines].sort(byTime);
  if (questions.length === 0 && decisions.length === 0) throw new OpenPointsError('OPEN_POINTS_EMPTY');
  return { questions, decisions, dropped: Math.min(dropped, DROPPED_MAX) };
}

const INSTRUCTION = (language: 'vi' | 'en'): string =>
  [
    'You list what one meeting left open, from its transcript, for the person who recorded it: questions that were asked and that you did not see answered afterwards, and topics where a decision was raised but not taken.',
    `Write the points in ${language === 'vi' ? 'Vietnamese' : 'English'}.`,
    'Answer with one JSON object only, no other text: {"points": [{"kind": "question" | "decision", "text": string, "second": number}]}.',
    'A "question" is something a speaker asked that no later line answers. A "decision" is a topic where someone proposed or asked for a decision and none was made. "text" is one short plain sentence of at most 160 characters on one line, in your own words.',
    '"second" is the whole second of the transcript line the point rests on, as a number (for [1:05] it is 65): for a question the line that asks it, for a decision the line that raises it. Write at most 5 questions and at most 5 decisions. If everything was answered and decided, answer {"points":[]}.',
    'Never write who asked, who should answer, how anyone spoke, a tone, a mood or an opinion of a person. Use only numbers, names and dates that appear in the cited line. Never write a link, an email address or a phone number. Add nothing the transcript does not say.',
  ].join('\n');

/** One run of the recorder's Vy over a transcript: the model is asked once, the checks above decide what is kept. */
export async function listOpenPoints(input: MeetingOpenPointsInput, ports: BoundPorts): Promise<MeetingOpenPointsResult> {
  const text = transcriptLines(input.segments);
  // Refused before any call, never cut.
  if (input.segments.length === 0) throw new OpenPointsError('OPEN_POINTS_NO_TRANSCRIPT');
  if (new TextEncoder().encode(text).length > OPEN_POINT_LIMITS.transcriptBytes) throw new OpenPointsError('OPEN_POINTS_TOO_LONG');
  const out = await runFeature({ instruction: INSTRUCTION(input.language), subject: privateText(text), maxSubjectChars: OPEN_POINT_LIMITS.transcriptBytes, feature: 'meetings.open_points' }, ports);
  return { answer: checkOpenPoints(revealPrivateText(out.text), input.segments), usage: out.usage };
}
