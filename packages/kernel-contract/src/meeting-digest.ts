// SPDX-License-Identifier: AGPL-3.0-only
// This week's decisions and what is still open, across the meetings a member reads (#3949, plan docs/plan/meetings.md §1 "the weekly job"). One card on the meetings page: the published decisions and the
// still-open action items of the meetings that started in the last 7, 14 or 30 days, each with its meeting. Vy's few sentences on top are an extra, on a click.
//
// The FACTS are read by code, as the member (row security on every one): a meeting the member does not read, a draft result and a meeting past its text retention show nothing. They work with AI off. Vy's
// sentences are written from the numbered facts only, every sentence citing facts, and code refuses a sentence whose figure no cited fact writes (the checks of the brief).
//
// This file holds the shapes and the pure numbering both sides use (the model call is in packages/agent, the card in apps/app). No model call, database or network access here.
import { z } from 'zod';
import { zAskStatus } from './meeting-ask.ts';
import { BRIEF_SENTENCE_CHARS_MAX, BRIEF_SENTENCES_MAX, BRIEF_STATES, briefItemDue, vnDateOf } from './meeting-brief.ts';
import { zSeriesOpenItem } from './meetings.ts';
import { zId } from './schemas.ts';

export const DIGEST_DAYS = [7, 14, 30] as const;
export const DIGEST_MEETINGS_MAX = 50;
// At most this many decisions and this many open items in all, newest meeting first; the facts say when they cut.
export const DIGEST_DECISIONS_MAX = 30;
export const DIGEST_ITEMS_MAX = 30;
export const DIGEST_LINES_MAX = DIGEST_DECISIONS_MAX + DIGEST_ITEMS_MAX;
// What one recap is expected to use (one call over at most 60 short facts), for a figure shown before the member asks. An estimate, not a promise: the meter records what the provider reports.
export const DIGEST_ESTIMATE = { inputTokens: 3_500, outputTokens: 300 } as const;

export const zDigestAsk = z.strictObject({ days: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(7) });
export type DigestAsk = z.infer<typeof zDigestAsk>;

// The status takes nothing but the deployment's switches: the same answer as for asking across meetings (whether Vy may be used now, and why not).
export const zDigestStatus = zAskStatus;
export type DigestStatus = z.infer<typeof zDigestStatus>;

export const zDigestMeeting = z.strictObject({
  meetingId: zId,
  title: z.string(),
  startedAt: z.string(),
  decisions: z.array(z.string()).max(DIGEST_DECISIONS_MAX),
  items: z.array(zSeriesOpenItem).max(DIGEST_ITEMS_MAX),
});
export type DigestMeeting = z.infer<typeof zDigestMeeting>;

// `cut` is true when the caps removed something (the card says so). `empty`: no decision and no open item, so the card shows a plain note and no recap button.
export const zDigestFacts = z.strictObject({
  days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  meetings: z.array(zDigestMeeting).max(DIGEST_MEETINGS_MAX),
  cut: z.boolean(),
  empty: z.boolean(),
});
export type DigestFacts = z.infer<typeof zDigestFacts>;

export const zDigestSentence = z.strictObject({
  text: z.string().min(1).max(BRIEF_SENTENCE_CHARS_MAX),
  // The numbers (from 1) of the facts the sentence cites, as `digestLines` numbers them.
  facts: z.array(z.number().int().min(1).max(DIGEST_LINES_MAX)).min(1).max(6),
});
export type DigestSentence = z.infer<typeof zDigestSentence>;
// The state of Vy's words: `written` (at least one sentence kept), `none` (nothing to write from, or no sentence held up), `failed` (the call could not be used, a fixed code).
export const zDigestAnswer = z.strictObject({
  state: z.enum(BRIEF_STATES),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  sentences: z.array(zDigestSentence).max(BRIEF_SENTENCES_MAX),
  // How many sentences code removed for want of a valid citation, a quoted phrase or a figure the cited facts hold.
  dropped: z.number().int().min(0).max(100),
  // How many numbered facts the answer was written from. The card compares it with its own count: when the lists changed since the card read them, the numbers a sentence cites may point at other facts, and the card says so.
  lines: z.number().int().min(0).max(DIGEST_LINES_MAX),
});
export type DigestAnswer = z.infer<typeof zDigestAnswer>;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The numbered facts
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DigestLine {
  // Counting from 1: the number a sentence cites.
  n: number;
  kind: 'decision' | 'item';
  // The fact itself, as people wrote it, and nothing else: the checks on Vy's sentences read this text and only this text, so the figures and the dates of a meeting's name or day are never "written in a cited fact".
  text: string;
  // The meeting the fact comes from, given to the model in fields of their own (and to the card), outside `text`.
  meeting: string;
  date: string;
  meetingId: string;
}

const TEXT_CHARS = 300;
const flat = (value: string, max: number): string => Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()).slice(0, max).join('');
const STATUS_TEXT: Record<string, string> = { todo: 'to do', in_progress: 'in progress', waiting: 'waiting', in_review: 'in review' };

/**
 * The facts of a digest as numbered lines, in a fixed order (meeting by meeting, newest first; a meeting's decisions, then its open items), each with its meeting. The model is given exactly these lines, a
 * sentence cites their numbers, and the card lists the same facts: so a citation can only name a fact the member can see. Pure.
 */
export function digestLines(facts: DigestFacts): DigestLine[] {
  const lines: Omit<DigestLine, 'n'>[] = [];
  for (const meeting of facts.meetings) {
    const where = { meeting: flat(meeting.title, 120), date: vnDateOf(meeting.startedAt) };
    for (const decision of meeting.decisions) lines.push({ kind: 'decision', text: flat(decision, TEXT_CHARS), ...where, meetingId: meeting.meetingId });
    for (const item of meeting.items) {
      const owner = item.whoUserId !== null || item.who !== '' ? flat(item.who, 100) : '';
      const parts = [
        item.assigned ? 'accepted as a task' : 'not given to anyone yet',
        ...(owner !== '' ? [`owner: ${owner}`] : []),
        ...(briefItemDue(item) !== null ? [`due: ${briefItemDue(item)}`] : []),
        ...(item.taskStatus !== null ? [`status: ${STATUS_TEXT[item.taskStatus] ?? item.taskStatus}`] : []),
      ];
      lines.push({ kind: 'item', text: `${flat(item.title, TEXT_CHARS)} (${parts.join('; ')})`, ...where, meetingId: meeting.meetingId });
    }
  }
  return lines.slice(0, DIGEST_LINES_MAX).map((line, index) => ({ ...line, n: index + 1 }));
}
