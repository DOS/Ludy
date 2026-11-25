// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy suggesting the minutes template of one meeting when code could not tell (#4772, ADR-0049 stage A): one of the four built-in templates that are not the general summary, a one-line reason, and the
// whole start second of the transcript line the reason rests on. The model is asked once, through the member-Vy ports, and what it answers is only a proposal: the checks below are code, not the model. The answer is
// dropped, never repaired, when its template is not one of the four (or is null: "none fits"), its second is not the whole start second of a real transcript line, or its reason is empty after cleaning, shorter than 3 or
// longer than 160 characters, carries a link, an email address, a phone number, a run of 8 or more digits or a figure the cited line does not say. Nothing here reads a database, names a table or command, or persists
// anything (the boundary test pins that); the answer goes back to the recorder's browser, who accepts it with one click that is the existing meetings.minutes.set_template.
import { hasAutonomousActionDirective, hasObfuscatedContactOrLink, hasPromptMarkupLeak, hasUngroundedMoneyOrScaleWords } from '../injection-guards.ts';
import { privateText, revealPrivateText } from '../private-text.ts';
import { foldTitleText } from './meeting-chapters.ts';
import type { BoundPorts } from './ports.ts';
import { runFeature } from './run-feature.ts';
import { hasContact, numbersIn, SUMMARY_LIMITS, transcriptLines, type SummarySegment } from './meeting-summary.ts';

// Equal to SUGGESTABLE_TEMPLATES of the contract (this package cannot import it).
export const TEMPLATE_SUGGEST_TEMPLATES = ['briefing', 'customer', 'supplier', 'one_on_one'] as const;
export type SuggestedTemplate = (typeof TEMPLATE_SUGGEST_TEMPLATES)[number];

export const TEMPLATE_SUGGEST_LIMITS = {
  // Equal to TEMPLATE_REASON_CHARS_MIN and TEMPLATE_REASON_CHARS_MAX of the contract.
  minChars: 3,
  reasonChars: 160,
  // The transcript sent to the model, in UTF-8 bytes: the summary's cap, refused and never cut.
  transcriptBytes: SUMMARY_LIMITS.transcriptBytes,
} as const;
// Equal to CHAPTER_SECOND_MAX of the contract: a second past a day is no line of a meeting, and the contract would refuse it.
const SECOND_MAX = 86_400;

export type TemplateSuggestErrorCode = 'TEMPLATE_SUGGEST_UNPARSABLE' | 'TEMPLATE_SUGGEST_EMPTY' | 'TEMPLATE_SUGGEST_TOO_LONG' | 'TEMPLATE_SUGGEST_NO_TRANSCRIPT';
export class TemplateSuggestError extends Error {
  code: TemplateSuggestErrorCode;
  constructor(code: TemplateSuggestErrorCode) {
    super(code);
    this.name = 'TemplateSuggestError';
    this.code = code;
  }
}

export interface MeetingTemplateSuggestInput {
  segments: readonly SummarySegment[];
  language: 'vi' | 'en';
}
export interface TemplateSuggestion {
  template: SuggestedTemplate;
  reason: string;
  // The whole start second of a real transcript line.
  seconds: number;
}
export interface MeetingTemplateSuggestResult {
  suggestion: TemplateSuggestion;
  usage: { inputTokens: number; outputTokens: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function jsonObject(raw: string): unknown {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) throw new TemplateSuggestError('TEMPLATE_SUGGEST_UNPARSABLE');
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    throw new TemplateSuggestError('TEMPLATE_SUGGEST_UNPARSABLE');
  }
}

/**
 * The checks. `raw` is the model's text ({"template":"customer","reason":"...","second":65}); the answer is what survives, or TEMPLATE_SUGGEST_EMPTY when the model said no template fits or the answer failed a check.
 */
export function checkTemplateSuggestion(raw: string, segments: readonly SummarySegment[]): TemplateSuggestion {
  const root = jsonObject(raw);
  if (!isRecord(root) || !('template' in root)) throw new TemplateSuggestError('TEMPLATE_SUGGEST_UNPARSABLE');
  // "None fits" is the model's honest answer: null, or the general summary, which is where a meeting starts.
  if (root.template === null || root.template === 'general') throw new TemplateSuggestError('TEMPLATE_SUGGEST_EMPTY');
  // The whole seconds a transcript line starts at, and the figures that very line says (a figure in the reason must be one the line the reader opens says).
  const figuresAt = new Map<number, Set<string>>();
  for (const s of segments) {
    const second = Math.max(0, Math.floor(s.startSeconds));
    const figures = figuresAt.get(second) ?? new Set<string>();
    for (const n of numbersIn(s.text)) figures.add(n);
    figuresAt.set(second, figures);
  }
  const template = (TEMPLATE_SUGGEST_TEMPLATES as readonly unknown[]).includes(root.template) ? (root.template as SuggestedTemplate) : null;
  const text = typeof root.reason === 'string' ? foldTitleText(root.reason) : '';
  const second = typeof root.second === 'number' && Number.isInteger(root.second) ? root.second : null;
  const figures = second === null ? undefined : figuresAt.get(second);
  // A scale word (million, billion...) in the reason is allowed only when the CITED line has one, not any line of the transcript.
  const citedHasScaleWords = second === null ? false : hasUngroundedMoneyOrScaleWords(segments.filter((s) => Math.max(0, Math.floor(s.startSeconds)) === second).map((s) => s.text).join('\n'));
  if (
    template === null ||
    second === null ||
    figures === undefined ||
    second > SECOND_MAX ||
    text.length < TEMPLATE_SUGGEST_LIMITS.minChars ||
    text.length > TEMPLATE_SUGGEST_LIMITS.reasonChars ||
    hasContact(text) ||
    hasObfuscatedContactOrLink(text) ||
    hasPromptMarkupLeak(String(root.reason)) ||
    hasPromptMarkupLeak(text) ||
    hasAutonomousActionDirective(text) ||
    (!citedHasScaleWords && hasUngroundedMoneyOrScaleWords(text)) ||
    text.includes('@') ||
    /\p{Nd}{8}/u.test(text.normalize('NFKC')) ||
    numbersIn(text).some((n) => !figures.has(n))
  ) {
    throw new TemplateSuggestError('TEMPLATE_SUGGEST_EMPTY');
  }
  return { template, reason: text, seconds: second };
}

const INSTRUCTION = (language: 'vi' | 'en'): string =>
  [
    'You choose which minutes template best fits one meeting, from its transcript, for the person who recorded it.',
    'The templates are: "briefing" (a periodic internal meeting where people report what they did and plan next), "customer" (a meeting with a customer or prospect about their needs, an offer or a deal), "supplier" (a meeting with a supplier or vendor about supply, prices, delivery or complaints) and "one_on_one" (a meeting between a manager and one person about their work and goals).',
    `Write the reason in ${language === 'vi' ? 'Vietnamese' : 'English'}.`,
    'Answer with one JSON object only, no other text: {"template": "briefing" | "customer" | "supplier" | "one_on_one" | null, "reason": string, "second": number}. Use null when none fits clearly.',
    '"reason" is one short plain sentence of at most 140 characters on one line, in your own words, saying what in the meeting shows it. "second" is the whole second of the transcript line the reason rests on, as a number (for [1:05] it is 65).',
    'Never write a name of a person, a link, an email address or a phone number. Use only numbers and dates that appear in the cited line. Add nothing the transcript does not say.',
  ].join('\n');

/** One run of the recorder's Vy over a transcript: the model is asked once, the checks above decide what is kept. */
export async function suggestMeetingTemplate(input: MeetingTemplateSuggestInput, ports: BoundPorts): Promise<MeetingTemplateSuggestResult> {
  const text = transcriptLines(input.segments);
  // Refused before any call, never cut.
  if (input.segments.length === 0) throw new TemplateSuggestError('TEMPLATE_SUGGEST_NO_TRANSCRIPT');
  if (new TextEncoder().encode(text).length > TEMPLATE_SUGGEST_LIMITS.transcriptBytes) throw new TemplateSuggestError('TEMPLATE_SUGGEST_TOO_LONG');
  const out = await runFeature({ instruction: INSTRUCTION(input.language), subject: privateText(text), maxSubjectChars: TEMPLATE_SUGGEST_LIMITS.transcriptBytes, feature: 'meetings.template_suggest' }, ports);
  return { suggestion: checkTemplateSuggestion(revealPrivateText(out.text), input.segments), usage: out.usage };
}
