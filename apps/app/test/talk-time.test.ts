// SPDX-License-Identifier: AGPL-3.0-only
// Who did the talking (#4765): the figures worked out from a meeting's transcript lines, in code. Talk time counts a speaker's overlapping lines once, a turn is a run of consecutive lines
// by one speaker, the longest monologue leaves the pauses out, and a line with no text or no length counts for nothing, so an emptied transcript has no figures.
import { describe, expect, it } from 'vitest';
import { speakerFigures, wholePercents, type TalkLine } from '../src/lib/talk-time.ts';

const line = (speakerLabel: string, startSeconds: number, endSeconds: number, text = 'Nội dung'): TalkLine => ({ speakerLabel, startSeconds, endSeconds, text });
const byName = (lines: TalkLine[]) => Object.fromEntries((speakerFigures(lines)?.speakers ?? []).map((s) => [s.speaker, s]));

describe('speakerFigures', () => {
  it('works out talk time, share, turns and the longest monologue of each speaker', () => {
    const figures = speakerFigures([line('Lan', 0, 10), line('Hùng', 10, 15), line('Lan', 15, 25)]);
    expect(figures?.totalSeconds).toBe(25);
    expect(figures?.speakers.map((s) => s.speaker)).toEqual(['Lan', 'Hùng']);
    expect(figures?.speakers[0]).toEqual({ speaker: 'Lan', seconds: 20, share: 0.8, turns: 2, longestMonologue: 10 });
    expect(figures?.speakers[1]).toEqual({ speaker: 'Hùng', seconds: 5, share: 0.2, turns: 1, longestMonologue: 5 });
  });

  it('counts a speaker\'s overlapping lines once', () => {
    const lan = byName([line('Lan', 0, 10), line('Lan', 5, 12)]).Lan;
    expect(lan?.seconds).toBe(12);
    expect(lan?.turns).toBe(1);
    expect(lan?.longestMonologue).toBe(12);
  });

  it('gives each speaker their own time when different speakers overlap', () => {
    const figures = byName([line('Lan', 0, 10), line('Hùng', 5, 8)]);
    expect(figures.Lan?.seconds).toBe(10);
    expect(figures.Hùng?.seconds).toBe(3);
  });

  it('keeps one speaker\'s consecutive lines as one turn and leaves the pause out of the monologue', () => {
    const lan = byName([line('Lan', 0, 5), line('Lan', 20, 25), line('Hùng', 30, 31)]).Lan;
    expect(lan?.turns).toBe(1);
    expect(lan?.seconds).toBe(10);
    expect(lan?.longestMonologue).toBe(10);
  });

  it('puts the lines in start order whatever order they arrive in, and ties by name', () => {
    const figures = speakerFigures([line('Lan', 15, 25), line('Hùng', 10, 15), line('Lan', 0, 10), line('An', 30, 40)]);
    expect(figures?.speakers.map((s) => [s.speaker, s.seconds])).toEqual([
      ['Lan', 20],
      ['An', 10],
      ['Hùng', 5],
    ]);
    expect(figures?.speakers[0]?.turns).toBe(2);
    const tie = speakerFigures([line('Hùng', 0, 5), line('An', 5, 10)]);
    expect(tie?.speakers.map((s) => s.speaker)).toEqual(['An', 'Hùng']);
  });

  it('counts nothing for a line with no text, no length or a broken time', () => {
    const figures = byName([line('Lan', 0, 10), line('Hùng', 10, 20, '   '), line('Hùng', 20, 20), line('Hùng', 30, 25), line('Hùng', Number.NaN, 40), line('Vy', 0, Number.POSITIVE_INFINITY)]);
    expect(Object.keys(figures)).toEqual(['Lan']);
  });

  it('has no figures for no lines, or when no line has text left', () => {
    expect(speakerFigures([])).toBeNull();
    expect(speakerFigures([line('Lan', 0, 10, ''), line('Hùng', 10, 20, ' \n')])).toBeNull();
  });

  it('works for one speaker', () => {
    const figures = speakerFigures([line('Lan', 0, 10)]);
    expect(figures?.speakers).toEqual([{ speaker: 'Lan', seconds: 10, share: 1, turns: 1, longestMonologue: 10 }]);
  });

  it('does not change the lines it is given', () => {
    const lines = [line('Lan', 15, 25), line('Hùng', 0, 10)];
    const copy = structuredClone(lines);
    speakerFigures(lines);
    expect(lines).toEqual(copy);
  });
});

describe('wholePercents', () => {
  it('adds up to 100 and gives the missing points to the largest remainders', () => {
    expect(wholePercents([1 / 3, 1 / 3, 1 / 3])).toEqual([34, 33, 33]);
    expect(wholePercents([0.5, 0.5])).toEqual([50, 50]);
    expect(wholePercents([0.8, 0.2])).toEqual([80, 20]);
    expect(wholePercents([0.666, 0.334])).toEqual([67, 33]);
  });

  it('adds up to 100 for any list of shares that adds up to 1', () => {
    for (const seconds of [[7, 11, 13], [1, 1, 1, 1, 1, 1, 1], [97, 1, 1, 1], [3, 3, 94], [5, 6, 7, 8, 9, 10, 11]]) {
      const total = seconds.reduce((a, b) => a + b, 0);
      const percents = wholePercents(seconds.map((s) => s / total));
      expect(percents.reduce((a, b) => a + b, 0)).toBe(100);
      expect(percents.every((p) => p >= 0)).toBe(true);
    }
  });
});
