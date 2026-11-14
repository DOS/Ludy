// SPDX-License-Identifier: AGPL-3.0-only
// Ask across meetings (Meetings A3, #3161, plan docs/plan/meetings-integrations.md section 4.2). A box above the meetings list: the member types a question; the lines the member's own
// search finds (the L2 search, row security on every line) go to one model call as the member's own Vy (feature meetings.ask); every sentence of the answer cites a numbered line, and
// code checks the citations before anything shows. Nothing of the answer is stored and nothing is sent.
//
// This file holds the shapes of the route and the pure words-from-a-question step both sides use. No model call, database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';
import { MEETING_SEARCH_QUERY_MAX, zMeetingSearchHit } from './meetings.ts';

export const ASK_QUESTION_MIN = 6;
export const ASK_QUESTION_MAX = 300;
// What goes to the model: at most 40 lines from at most 8 meetings (plan section 4.2); an answer is two to six sentences.
export const ASK_LINES_MAX = 40;
export const ASK_MEETINGS_MAX = 8;
export const ASK_SENTENCES_MAX = 6;
// The plain hit list shown when the answer has no valid citation, or the model could not be used.
export const ASK_HITS_MAX = 20;
export const ASK_SENTENCE_CHARS_MAX = 600;
// What one question is expected to use, for the cost shown before the member asks: 40 lines of about 400 characters at about 2.5 characters a token, plus the instruction, and a short answer.
// An estimate, not a promise: the meter records what the provider reports.
export const ASK_ESTIMATE = { inputTokens: 6_800, outputTokens: 600 } as const;

// The status and the start take nothing: the question is read only by the lines query and the route.
export const zAskEmpty = z.strictObject({});

export const zAskInput = z.strictObject({ question: z.string().trim().min(ASK_QUESTION_MIN).max(ASK_QUESTION_MAX) });
export type AskInput = z.infer<typeof zAskInput>;

// Whether Vy may be asked now, and why not: the deployment's switch is off (`off`), the member may not work with Vy (`forbidden`), a kill switch of the org, the module or the operator holds AI (`paused`), or this month's budget of the org or
// the meetings module is spent (`budget`). `estimate` is the cost of one question; null cost when the deployment sets no price. The amount left is not here: only an owner or an admin reads the
// budgets, through their existing read.
export const zAskStatus = z.strictObject({
  enabled: z.boolean(),
  reason: z.enum(['off', 'forbidden', 'paused', 'budget']).nullable(),
  estimate: z.strictObject({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), cost: z.string().regex(/^\d+(?:\.\d+)?$/).nullable() }).nullable(),
});
export type AskStatus = z.infer<typeof zAskStatus>;

// `sources` are the lines the sentences cite, in the order they are first cited; a sentence names them by their index. Every source is a line the asker's own search found, which is a line they read.
export const zAskSentence = z.strictObject({
  text: z.string().min(1).max(ASK_SENTENCE_CHARS_MAX),
  sources: z.array(z.number().int().min(0).max(ASK_LINES_MAX - 1)).min(1).max(ASK_SENTENCES_MAX),
});
export type AskSentence = z.infer<typeof zAskSentence>;

// `answered`: at least one sentence has a valid citation. `none`: no sentence kept a valid citation, or nothing was found; `hits` is the plain hit list of the search. `failed`: the call could not be
// used (a fixed code); `hits` is still the plain list, so the member has what the search found.
export const ASK_STATES = ['answered', 'none', 'failed'] as const;
export const zAskAnswer = z.strictObject({
  state: z.enum(ASK_STATES),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  sentences: z.array(zAskSentence).max(ASK_SENTENCES_MAX),
  sources: z.array(zMeetingSearchHit).max(ASK_LINES_MAX),
  hits: z.array(zMeetingSearchHit).max(ASK_HITS_MAX),
  // How many sentences code removed for want of a valid citation, a quoted phrase or a figure the cited lines hold.
  dropped: z.number().int().min(0).max(100),
});
export type AskAnswer = z.infer<typeof zAskAnswer>;

// What the module reads for a question: the lines the member's own search found, in the order they are given to the model (at most ASK_LINES_MAX from at most ASK_MEETINGS_MAX meetings).
export const zAskLines = z.strictObject({ lines: z.array(zMeetingSearchHit).max(ASK_LINES_MAX) });
export type AskLines = z.infer<typeof zAskLines>;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The words of a question
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

// Words that say nothing about what to look for in Vietnamese or English; compared after folding (lower case, Vietnamese marks and đ removed), the way the search folds what it is given.
const STOP_WORDS = new Set<string>([
  // Vietnamese, folded. Only words that are function words whatever the marks: not "hop" (hợp đồng), "chi", "ma" (mã), "the" (thẻ), "ban" (bàn), "chung", "qua" (quà), "minh" (a name), "noi", "on", "long".
  'la', 'va', 'cua', 'cho', 'co', 'khong', 'duoc', 'da', 'dang', 'se', 'nhu', 'nao', 'gi', 'sao', 'bao', 'nhieu', 'may', 'khi', 'o', 'dau', 'ai', 'cac', 'nhung', 'mot', 'hai',
  'nay', 'kia', 'do', 'thi', 'de', 'voi', 'trong', 'ngoai', 'tren', 'duoi', 'tu', 'den', 've', 'theo', 'hay', 'hoac', 'vi', 'nen', 'cung', 'con', 'roi', 'luon', 'rat', 'lai', 'nua',
  'toi', 'anh', 'em', 'cuoc', 'xin',
  // English.
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'much', 'many', 'of', 'to', 'in', 'on', 'at', 'for',
  'and', 'or', 'with', 'about', 'from', 'by', 'it', 'its', 'this', 'that', 'these', 'those', 'we', 'you', 'they', 'i', 'me', 'my', 'our', 'your', 'their', 'meeting', 'meetings', 'said', 'say', 'tell',
]);

const FOLD_MARKS = /[̀-ͯ]/g;
/** Lower case, Vietnamese marks and đ removed: the way the search folds what it is given and what it stores. */
export const askFold = (text: string): string => text.normalize('NFD').replace(FOLD_MARKS, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

/**
 * The words to look for, from a question: letters and digits only, at least 3 characters (a number may be shorter), none a stop word, each once, strongest first (a figure first, then the
 * longer word), at most `max`. The words keep their own spelling (the search folds them itself); the stop-word test and the order use the folded spelling. Linear in the question's length.
 */
export function askKeywords(question: string, max = 6): string[] {
  const seen = new Set<string>();
  const words: Array<{ word: string; key: string; digits: boolean; index: number }> = [];
  for (const raw of question.normalize('NFC').split(/[^\p{L}\p{N}]+/u)) {
    if (raw === '') continue;
    const key = askFold(raw);
    const digits = /^\p{N}+$/u.test(raw);
    if (!digits && (key.length < 3 || STOP_WORDS.has(key))) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    words.push({ word: raw, key, digits, index: words.length });
  }
  // Strongest first: a figure, then a longer word, then the earlier in the question.
  words.sort((a, b) => Number(b.digits) - Number(a.digits) || b.key.length - a.key.length || a.index - b.index);
  return words.slice(0, max).map((w) => w.word);
}

/**
 * Passes the search is asked, in order: all the words together (the search wants every word, so a question with one word the lines never use finds nothing this way), then the three strongest
 * together, then each of those alone. A query is at most the search's own limit long; a pass that repeats an earlier one is left out.
 */
export function askQueries(words: readonly string[], singles = 3): string[] {
  if (words.length === 0) return [];
  const queries = [words.join(' ').slice(0, MEETING_SEARCH_QUERY_MAX).trim()];
  const strongest = words.slice(0, singles);
  if (words.length > singles) queries.push(strongest.join(' '));
  if (words.length > 1) for (const word of strongest) queries.push(word);
  return [...new Set(queries)].filter((q) => q.length >= 2);
}

/** How many of the words a line holds, after folding both (a word is held when the folded line contains it): the order the lines go to the model in, most relevant first. */
export function askRank(text: string, words: readonly string[]): number {
  const folded = askFold(text);
  let held = 0;
  for (const word of words) if (folded.includes(askFold(word))) held += 1;
  return held;
}

// The run the module starts for a question (an id the screen never sees): the member's own Vy run of the feature meetings.ask.
export const zAskStarted = z.strictObject({ runId: zId });
