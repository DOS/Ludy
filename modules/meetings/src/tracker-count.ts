// SPDX-License-Identifier: AGPL-3.0-only
// Counting a tracked word or phrase in a line of a transcript (#4818): pure, no database. A phrase is found as whole words, ignoring case and marks ("hop dong" finds "Hợp đồng", "gia" does not
// find "giam"), with punctuation counted as a space ("hợp, đồng" reads as "hợp đồng").
import { plainName } from './plain-name.ts';

// The text as words: no marks, lower case, everything that is not a letter or a digit turned into single spaces, a space at each end so a whole word can be looked for with its spaces.
export function wordsOf(text: string): string {
  return ` ${plainName(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

/** The needle of a term: its words with a space at each end, or null when it has no word left (a term is a tracked word, so this is a guard only). */
export function needleOf(term: string): string | null {
  const words = wordsOf(term).trim();
  return words === '' ? null : ` ${words} `;
}

/** How many times the needle (from needleOf) occurs in the words of a line; two hits may share the space between them ("a a" holds the word "a" twice). */
export function countNeedle(words: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = words.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    // The closing space of this hit may open the next one.
    from = at + needle.length - 1;
  }
}
