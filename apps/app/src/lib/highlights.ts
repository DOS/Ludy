// SPDX-License-Identifier: AGPL-3.0-only
// Highlights on a transcript line or range (#4819): the small rules the page uses, kept apart from the screen so they can be tested. A highlight is an anchor in whole seconds (the start second of the
// first and of the last line of the mark) and holds no text; the lines it shows are looked up in the transcript the page already reads. Two lines that start in the same second are one anchor, so a mark
// at that second covers both. No request, no state.

export interface HighlightRange {
  startSeconds: number;
  endSeconds: number;
}

export interface HighlightedLine {
  startSeconds: number;
  speakerLabel: string;
  text: string;
}

/** The whole second a line is marked at. */
export const secondOf = (startSeconds: number): number => Math.floor(startSeconds);

/** The range between two seconds, whichever comes first; each end is the start second of a line. */
export function rangeBetween(a: number, b: number): HighlightRange {
  const x = secondOf(a);
  const y = secondOf(b);
  return { startSeconds: Math.min(x, y), endSeconds: Math.max(x, y) };
}

/** True when a line that starts at `startSeconds` is inside the mark (both ends included). */
export function covers(range: HighlightRange, startSeconds: number): boolean {
  const second = secondOf(startSeconds);
  return second >= range.startSeconds && second <= range.endSeconds;
}

/** The lines of the transcript inside the mark, in the order of the transcript. A mark whose lines are gone (the recorder replaced the transcript) has none. */
export function linesOf<T extends { startSeconds: number }>(range: HighlightRange, lines: readonly T[]): T[] {
  return lines.filter((l) => covers(range, l.startSeconds)).sort((a, b) => a.startSeconds - b.startSeconds);
}

/** The caller's own mark on exactly this second (a single line), when there is one: the one a click on the line's button takes away. */
export function ownSingleAt<T extends HighlightRange & { mine: boolean }>(highlights: readonly T[], startSeconds: number): T | undefined {
  const second = secondOf(startSeconds);
  return highlights.find((h) => h.mine && h.startSeconds === second && h.endSeconds === second);
}

/** The text a copy puts on the clipboard: one line per transcript line, "time speaker: text". */
export function copyText(lines: readonly HighlightedLine[], clock: (seconds: number) => string): string {
  return lines.map((l) => `${clock(l.startSeconds)} ${l.speakerLabel}: ${l.text}`).join('\n');
}
