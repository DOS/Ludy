// SPDX-License-Identifier: AGPL-3.0-only
// Counting a tracked word or phrase in a line of a transcript (#4818): pure, no database. A phrase is found as whole words, ignoring case, with punctuation counted as a space ("hợp, đồng" reads as
// "hợp đồng"). Marks follow what the owner typed: a term with a Vietnamese mark or the letter đ ("giá", "hợp đồng") is found with its marks only, so "giá" does not count "già", "giả" or "gia đình";
// a term typed with none ("gia", "hop dong") is found whatever the marks of the line, since the person asked for the plain spelling.
import { plainName } from './plain-name.ts';

const punctuationToSpace = (text: string): string => ` ${text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** The words of a line in the two spellings a term may be looked for in: with its marks (lower case, Unicode form C) and without. A space at each end of both, so a whole word can be looked for with its spaces. */
export function lineWords(text: string): { strict: string; loose: string } {
  return { strict: punctuationToSpace(text.normalize('NFC').toLowerCase()), loose: punctuationToSpace(plainName(text)) };
}

/** True when the term carries a Vietnamese mark or the letter đ, so it is found with its marks. */
export function hasMarks(term: string): boolean {
  return /[\p{M}đĐ]/u.test(term.normalize('NFD'));
}

export interface Needle {
  needle: string;
  // True when the term was typed without marks: it is looked for in the line without its marks too.
  loose: boolean;
}

/** The needle of a term: its words with a space at each end, or null when it has no word left (a term is a tracked word, so this is a guard only). */
export function needleOf(term: string): Needle | null {
  const loose = !hasMarks(term);
  const words = (loose ? punctuationToSpace(plainName(term)) : punctuationToSpace(term.normalize('NFC').toLowerCase())).trim();
  return words === '' ? null : { needle: ` ${words} `, loose };
}

/** How many times the needle occurs in a line; two hits may share the space between them ("a a" holds the word "a" twice). */
export function countNeedle(line: { strict: string; loose: string }, target: Needle): number {
  const words = target.loose ? line.loose : line.strict;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = words.indexOf(target.needle, from);
    if (at === -1) return count;
    count += 1;
    // The closing space of this hit may open the next one.
    from = at + target.needle.length - 1;
  }
}
