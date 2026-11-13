// SPDX-License-Identifier: AGPL-3.0-only
// Marks the words a meeting search matched, in the line it found. The server decides what matches (crove_kernel.search_fold in SQL: lower case, Vietnamese marks and đ
// removed, every typed word a word prefix, all required); this only repeats that fold on the client to show which words of an already found line to mark, so a
// difference could at worst mark a word too many or too few and never change what was found.
export function foldWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

export interface MarkedPart {
  text: string;
  mark: boolean;
}

const WORD = /[\p{L}\p{N}]+/gu;

// The line cut into runs, the words that start with a typed word marked (at most the first 8 typed words count, as on the server).
export function markMatches(line: string, typed: string): MarkedPart[] {
  const wanted = (typed.match(WORD) ?? []).slice(0, 8).map(foldWord).filter((w) => w !== '');
  if (wanted.length === 0) return [{ text: line, mark: false }];
  const parts: MarkedPart[] = [];
  let at = 0;
  for (const m of line.matchAll(WORD)) {
    const start = m.index ?? 0;
    const folded = foldWord(m[0]);
    if (!wanted.some((w) => folded.startsWith(w))) continue;
    if (start > at) parts.push({ text: line.slice(at, start), mark: false });
    parts.push({ text: m[0], mark: true });
    at = start + m[0].length;
  }
  if (at < line.length) parts.push({ text: line.slice(at), mark: false });
  return parts;
}
