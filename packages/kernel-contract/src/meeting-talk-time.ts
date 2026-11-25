// SPDX-License-Identifier: AGPL-3.0-only
// Who did the talking in a meeting (#4765, reused by L26 sales insights #4920): each speaker's talk time and share of it, turns and longest monologue, worked out in code from the transcript
// lines (speaker label, start and end seconds). Overlapping lines of one speaker are counted once; a line with no text or no length counts for nothing.

export interface TalkLine {
  startSeconds: number;
  endSeconds: number;
  speakerLabel: string;
  text: string;
}

export interface SpeakerFigure {
  speaker: string;
  // Seconds this speaker talked. A speaker's lines that overlap are counted once.
  seconds: number;
  // This speaker's part of all talk time, 0 to 1.
  share: number;
  // A turn is a run of consecutive lines by one speaker; another speaker's line (in start order) ends it.
  turns: number;
  // The talk time inside this speaker's longest turn, pauses between its lines left out.
  longestMonologue: number;
}

export interface SpeakerFigures {
  // Most talk first, then by name.
  speakers: SpeakerFigure[];
  totalSeconds: number;
}

type Span = readonly [start: number, end: number];

// The length covered by the spans, an overlap counted once.
export function coveredSeconds(spans: readonly Span[]): number {
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

// A line that counts: it has text, a finite start and a later end.
function counts(line: TalkLine): boolean {
  return line.text.trim() !== '' && Number.isFinite(line.startSeconds) && Number.isFinite(line.endSeconds) && line.endSeconds > line.startSeconds;
}

/** The figures of a meeting's lines, or null when no line counts (no transcript, or none with text and a length). */
export function speakerFigures(lines: readonly TalkLine[]): SpeakerFigures | null {
  // The same order the transcript is shown in; the sort is stable, so equal starts keep the order they came in.
  const ordered = lines.filter(counts).sort((a, b) => a.startSeconds - b.startSeconds);
  if (ordered.length === 0) return null;

  const spansBySpeaker = new Map<string, Span[]>();
  const turnsBySpeaker = new Map<string, number>();
  const longestBySpeaker = new Map<string, number>();
  let run: { speaker: string; spans: Span[] } | null = null;
  const closeRun = () => {
    if (!run) return;
    turnsBySpeaker.set(run.speaker, (turnsBySpeaker.get(run.speaker) ?? 0) + 1);
    longestBySpeaker.set(run.speaker, Math.max(longestBySpeaker.get(run.speaker) ?? 0, coveredSeconds(run.spans)));
    run = null;
  };
  for (const line of ordered) {
    const span: Span = [line.startSeconds, line.endSeconds];
    const all = spansBySpeaker.get(line.speakerLabel);
    if (all) all.push(span);
    else spansBySpeaker.set(line.speakerLabel, [span]);
    if (run && run.speaker === line.speakerLabel) {
      run.spans.push(span);
    } else {
      closeRun();
      run = { speaker: line.speakerLabel, spans: [span] };
    }
  }
  closeRun();

  const seconds = new Map([...spansBySpeaker].map(([speaker, spans]) => [speaker, coveredSeconds(spans)] as const));
  const totalSeconds = [...seconds.values()].reduce((a, b) => a + b, 0);
  const speakers = [...seconds].map(
    ([speaker, own]): SpeakerFigure => ({
      speaker,
      seconds: own,
      share: own / totalSeconds,
      turns: turnsBySpeaker.get(speaker) ?? 0,
      longestMonologue: longestBySpeaker.get(speaker) ?? 0,
    }),
  );
  speakers.sort((a, b) => b.seconds - a.seconds || (a.speaker < b.speaker ? -1 : a.speaker > b.speaker ? 1 : 0));
  return { speakers, totalSeconds };
}

/**
 * Whole percentages of the shares that add up to 100 (the largest remainders take the missing points), so a list of them never reads 99 or 101. The result has the order of `shares`.
 */
export function wholePercents(shares: readonly number[]): number[] {
  const floors = shares.map((s) => Math.floor(s * 100));
  let missing = 100 - floors.reduce((a, b) => a + b, 0);
  const byRemainder = shares.map((s, i) => ({ i, rest: s * 100 - Math.floor(s * 100) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of byRemainder) {
    if (missing <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    missing -= 1;
  }
  return floors;
}
