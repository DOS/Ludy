// SPDX-License-Identifier: AGPL-3.0-only
// Which transcript line a jump marks (#3844 chapters, #3954 commitments, #3959 agenda check). A jump carries a whole second and, when the line it came from names a speaker (a commitment line does), that
// speaker: two people who start in the same second are two lines, and the jump must land on the one it came from. With no speaker, or none that matches, it is the first line at that second, as before.
export interface TranscriptFocus {
  second: number;
  speaker?: string | undefined;
  token: number;
}

// A label as the transcript shows it: spaces folded, trimmed (the commitments run matches speakers the same way).
const folded = (label: string): string => label.replace(/\s+/g, ' ').trim();

export function focusedSegment<T extends { startSeconds: number; speakerLabel: string }>(segments: readonly T[], focus: TranscriptFocus): T | undefined {
  const atSecond = segments.filter((s) => Math.floor(s.startSeconds) === focus.second);
  if (focus.speaker === undefined) return atSecond[0];
  const who = folded(focus.speaker);
  return atSecond.find((s) => folded(s.speakerLabel) === who) ?? atSecond[0];
}
