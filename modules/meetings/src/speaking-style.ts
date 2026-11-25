// SPDX-License-Identifier: AGPL-3.0-only
// How each speaker spoke in a meeting (#4919, plan docs/plan/meetings.md): speaking pace, filler words and the longest stretch without a pause, counted by code from the transcript lines.
//
// meetings.speaking_style.get   per speaker label: words, talk time, words per minute of talk time, the words of a fixed filler list (how many, their share of the speaker's words, the three most used) and
//                               the longest run of consecutive lines with no pause. A sensitive read (each one leaves an audit row naming the meeting, with no text in it).
//
// The reader rule is the transcript page's (meetings.transcript.get) and the talk-time card's: the meeting is opened under the caller's own row security and text period (a meeting the caller does not read,
// or whose text has gone, is a 404), and the lines are read under the same row security, so a reader's figures rest on the published lines and the recorder's on their draft while one exists. The answer is
// numbers and words of the fixed list below, never a transcript line. Nothing is written and no model is used, so it works with AI off. The figures are facts about the transcript, with no score or judgment.
import { sql } from 'kysely';
import { SPEAKING_STYLE_SPEAKERS_MAX, SPEAKING_STYLE_TOP, zSpeakingStyle, zSpeakingStyleInput, type SpeakingStyle, type SpeakerStyle } from '@ludy/kernel-contract';
import { defineQuery } from '@ludy/kernel-runtime';
import { ROLES, openMeeting, userOf } from './transcript.ts';

export interface StyleLine {
  startSeconds: number;
  endSeconds: number;
  speakerLabel: string;
  text: string;
}

// Filler words and phrases, Vietnamese and English, fixed in code. Matched whole, by word, after case folding and Unicode composition, with the diacritics kept ("à" is a filler, "a", "ạ", "là" and "bà" are
// not). A phrase matches its words in a row. They are facts about the words said, not a judgment: "à" can be a real answer.
export const FILLERS: readonly string[] = ['ờ', 'ờm', 'ừm', 'à', 'kiểu như', 'thì là', 'um', 'uhm', 'uh', 'you know'];

// A pace is only given from this much talk time: under it a few words say nothing about how someone speaks.
export const PACE_MIN_SECONDS = 10;
// Two lines of one speaker are one stretch while the next starts less than this many seconds after the stretch so far has ended.
export const PAUSE_SECONDS = 2;

// A word is a run of letters, marks (the diacritics of a decomposed letter) and digits, with an apostrophe between them ("don't" is one word).
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;

/** The words of a text, lower case and composed (NFC). */
export function wordsOf(text: string): string[] {
  return text.normalize('NFC').toLowerCase().match(WORD) ?? [];
}

// The fillers as word lists, longest first, so "you know" is matched before a shorter filler could take part of it.
const FILLER_WORDS: ReadonlyArray<readonly string[]> = FILLERS.map((f) => wordsOf(f)).sort((a, b) => b.length - a.length);

/** The fillers in a list of words, left to right, each word used once: the filler (as written in the list) and how many times it came up. */
export function fillersIn(words: readonly string[]): Map<string, number> {
  const found = new Map<string, number>();
  let i = 0;
  while (i < words.length) {
    const hit = FILLER_WORDS.find((f) => f.every((w, k) => words[i + k] === w));
    if (hit) {
      const key = hit.join(' ');
      found.set(key, (found.get(key) ?? 0) + 1);
      i += hit.length;
    } else {
      i += 1;
    }
  }
  return found;
}

type Span = readonly [start: number, end: number];

// The length covered by the spans, an overlap counted once.
function covered(spans: readonly Span[]): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let from = Number.NEGATIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const [start, end] of sorted) {
    if (start > to) {
      if (to > from) total += to - from;
      from = start;
      to = end;
    } else if (end > to) {
      to = end;
    }
  }
  if (to > from) total += to - from;
  return total;
}

// A line that counts: it has text, a finite start and a later end (a zero-length line counts for nothing, as in the talk-time card).
function counts(line: StyleLine): boolean {
  return line.text.trim() !== '' && Number.isFinite(line.startSeconds) && Number.isFinite(line.endSeconds) && line.endSeconds > line.startSeconds;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The figures of a meeting's lines, most talk first then by name; empty when no line counts. At most SPEAKING_STYLE_SPEAKERS_MAX speakers. */
export function speakingStyle(lines: readonly StyleLine[]): SpeakerStyle[] {
  // The same order the transcript is shown in; the sort is stable, so equal starts keep the order they came in.
  const ordered = lines.filter(counts).sort((a, b) => a.startSeconds - b.startSeconds);
  const spans = new Map<string, Span[]>();
  const words = new Map<string, string[]>();
  const longest = new Map<string, number>();
  // The stretch of the speaker whose line came last (another speaker's line ends it).
  let run: { speaker: string; start: number; end: number } | null = null;
  const closeRun = () => {
    if (run) longest.set(run.speaker, Math.max(longest.get(run.speaker) ?? 0, run.end - run.start));
    run = null;
  };
  for (const line of ordered) {
    const own = spans.get(line.speakerLabel);
    if (own) own.push([line.startSeconds, line.endSeconds]);
    else spans.set(line.speakerLabel, [[line.startSeconds, line.endSeconds]]);
    const said = words.get(line.speakerLabel);
    if (said) said.push(...wordsOf(line.text));
    else words.set(line.speakerLabel, wordsOf(line.text));
    if (run && run.speaker === line.speakerLabel && line.startSeconds - run.end < PAUSE_SECONDS) {
      run.end = Math.max(run.end, line.endSeconds);
    } else {
      closeRun();
      run = { speaker: line.speakerLabel, start: line.startSeconds, end: line.endSeconds };
    }
  }
  closeRun();

  const out = [...spans].map(([speaker, own]): SpeakerStyle => {
    const said = words.get(speaker) ?? [];
    const seconds = covered(own);
    const found = fillersIn(said);
    let fillerWords = 0;
    for (const [filler, n] of found) fillerWords += n * wordsOf(filler).length;
    const top = [...found]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, SPEAKING_STYLE_TOP)
      .map(([word, count]) => ({ word, count }));
    return {
      speaker,
      seconds: round1(seconds),
      words: said.length,
      wordsPerMinute: seconds >= PACE_MIN_SECONDS ? Math.round(said.length / (seconds / 60)) : null,
      fillerWords,
      fillerShare: said.length === 0 ? 0 : fillerWords / said.length,
      fillerTop: top,
      longestStretchSeconds: round1(longest.get(speaker) ?? 0),
    };
  });
  out.sort((a, b) => b.seconds - a.seconds || (a.speaker < b.speaker ? -1 : a.speaker > b.speaker ? 1 : 0));
  return out.slice(0, SPEAKING_STYLE_SPEAKERS_MAX);
}

export const speakingStyleGet = defineQuery({
  name: 'meetings.speaking_style.get',
  input: zSpeakingStyleInput,
  access: ROLES,
  sensitive: true,
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx, input): Promise<SpeakingStyle> => {
    userOf(ctx.actor);
    await openMeeting(ctx.trx, ctx.orgId, input.meetingId);
    const rows = await ctx.trx
      .selectFrom('ludy_meetings.transcript_segment')
      .select([sql<string>`start_seconds::text`.as('start_seconds'), sql<string>`end_seconds::text`.as('end_seconds'), 'speaker_label', 'text', 'stage'])
      .where('org_id', '=', ctx.orgId)
      .where('meeting_id', '=', input.meetingId)
      .orderBy('start_seconds')
      .orderBy('id')
      .execute();
    // The stage the caller sees on the page: their draft while one exists, else the published lines.
    const stage = rows.some((r) => r.stage === 'draft') ? 'draft' : 'published';
    const lines = rows.filter((r) => r.stage === stage).map((r) => ({ startSeconds: Number(r.start_seconds), endSeconds: Number(r.end_seconds), speakerLabel: r.speaker_label, text: r.text }));
    return zSpeakingStyle.parse({ meetingId: input.meetingId, stage, speakers: speakingStyle(lines) });
  },
});

export const speakingStyleQueries = [speakingStyleGet];
