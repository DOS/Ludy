// SPDX-License-Identifier: AGPL-3.0-only
// The pure part of the Meetings MCP search (#4030): how the typed words are folded and bounded, how a line is matched, and how the snippet is cut. No database, no clock, no I/O. The query string is turned
// into at most MCP_SEARCH_WORDS_MAX plain words here and never reaches SQL, so there is nothing to inject and nothing to log. The fold is the one of `ludy_kernel.search_fold` (marks and đ removed, lower
// case, anything but a-z and 0-9 is a separator), done per character so the position of a match in the original line is known for the snippet.
import { MCP_SEARCH_WORDS_MAX, MCP_SNIPPET_MAX } from '@ludy/kernel-contract';

export interface SearchToken {
  /** The folded word: only a-z and 0-9. */
  word: string;
  /** Where the word starts in the original text, in UTF-16 units. */
  start: number;
  /** Where the word ends (just past its last character), in UTF-16 units. */
  end: number;
}

// One character folded: its marks dropped, lower case, đ as d; every character that is then not a-z or 0-9 is a separator (a space). A lone combining mark folds to nothing, so a letter written as a base
// and a mark is the same word as the composed letter.
const folded = new Map<string, string>();
const FOLDED_MAX = 4096;
function foldChar(ch: string): string {
  const cp = ch.codePointAt(0) as number;
  // ASCII is the common case and needs no normalisation.
  if (cp < 128) return cp >= 97 && cp <= 122 || cp >= 48 && cp <= 57 ? ch : cp >= 65 && cp <= 90 ? ch.toLowerCase() : ' ';
  const known = folded.get(ch);
  if (known !== undefined) return known;
  const base = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd');
  let out = '';
  for (const c of base) out += c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ? c : ' ';
  // A small cache: the letters of one language repeat; it never grows past FOLDED_MAX characters.
  if (folded.size < FOLDED_MAX) folded.set(ch, out);
  return out;
}

/** The words of a text, folded, each with the position of its first character in the original and the position just past its last. */
export function tokenize(text: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  let word = '';
  let start = 0;
  let at = 0;
  const flush = () => {
    if (word !== '') tokens.push({ word, start, end: at });
    word = '';
  };
  for (const ch of text) {
    for (const f of foldChar(ch)) {
      if (f === ' ') flush();
      else {
        if (word === '') start = at;
        word += f;
      }
    }
    at += ch.length;
  }
  flush();
  return tokens;
}

/**
 * The words a typed query is searched by: folded, each once, in order, at most MCP_SEARCH_WORDS_MAX of them. Null when nothing can be searched (no word at all, or no word of two characters or more:
 * a one-letter prefix would match almost every line), so the caller answers the empty answer, as the in-app search does.
 */
export function foldQuery(q: string): string[] | null {
  const words: string[] = [];
  for (const t of tokenize(q)) {
    if (!words.includes(t.word)) words.push(t.word);
    if (words.length >= MCP_SEARCH_WORDS_MAX) break;
  }
  return words.some((w) => w.length >= 2) ? words : null;
}

/**
 * Whether one line holds every word as the start of one of its words, and where the earliest of those words starts in the line (for the snippet). Every word must be found in this one line: words spread
 * over two lines (or a line and the title) are not a hit.
 */
export function matchLine(line: string, words: readonly string[]): { start: number; end: number } | null {
  if (words.length === 0) return null;
  const tokens = tokenize(line);
  let first = Number.MAX_SAFE_INTEGER;
  let firstEnd = 0;
  for (const w of words) {
    const hit = tokens.find((t) => t.word.startsWith(w));
    if (!hit) return null;
    if (hit.start < first) {
      first = hit.start;
      firstEnd = hit.end;
    }
  }
  return { start: first, end: firstEnd };
}

const WINDOW = MCP_SNIPPET_MAX - 10;
const LEAD = 60;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * One plain line cut to at most MCP_SNIPPET_MAX characters around the match that starts at `start` and ends at `matchEnd`, with an ellipsis where it is cut. The line is already plain (see plainLine); a surrogate pair
 * is never split. A cut falls on a space where the window has one outside the match, so a snippet does not start or end in the middle of a word; a word longer than the room there is cut where it must be.
 */
export function snippetAround(line: string, start: number, matchEnd: number = start): string {
  if (line.length <= MCP_SNIPPET_MAX) return line;
  let from = Math.max(0, Math.min(start - LEAD, line.length - WINDOW));
  if (from > 0 && isLow(line.charCodeAt(from))) from += 1;
  let end = Math.min(line.length, from + WINDOW);
  if (end < line.length && isHigh(line.charCodeAt(end - 1))) end -= 1;
  // The start moves forward to the next space and the end back to the last one, never into the match.
  if (from > 0 && line[from - 1] !== ' ' && line[from] !== ' ') {
    const next = line.indexOf(' ', from);
    if (next !== -1 && next < start) from = next + 1;
  }
  if (end < line.length && line[end - 1] !== ' ' && line[end] !== ' ') {
    const prev = line.lastIndexOf(' ', end - 1);
    if (prev >= matchEnd && prev > from) end = prev;
  }
  const body = line.slice(from, end).trim();
  return `${from > 0 ? '…' : ''}${body}${end < line.length ? '…' : ''}`;
}
