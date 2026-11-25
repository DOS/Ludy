// SPDX-License-Identifier: AGPL-3.0-only
// How each speaker spoke (#4919): the counting, in code, from transcript lines. Vietnamese diacritics and case, word boundaries, the fixed filler list in mixed Vietnamese and English text,
// the pace, the stretch without a pause, and a zero-length line.
import { describe, expect, it } from 'vitest';
import { FILLERS, PACE_MIN_SECONDS, fillersIn, speakingStyle, wordsOf, type StyleLine } from '../src/speaking-style.ts';

const line = (speakerLabel: string, startSeconds: number, endSeconds: number, text: string): StyleLine => ({ speakerLabel, startSeconds, endSeconds, text });
const style = (lines: StyleLine[], speaker: string) => speakingStyle(lines).find((s) => s.speaker === speaker);

describe('words', () => {
  it('splits on anything that is not a letter, a mark or a digit, keeps diacritics and folds case', () => {
    expect(wordsOf('Chốt báo giá, 1.250.000 đồng!')).toEqual(['chốt', 'báo', 'giá', '1', '250', '000', 'đồng']);
    expect(wordsOf('ĐƯỢC rồi')).toEqual(['được', 'rồi']);
    expect(wordsOf("We don't know")).toEqual(['we', "don't", 'know']);
    expect(wordsOf('   ')).toEqual([]);
  });

  it('composes a decomposed letter, so a text typed either way matches', () => {
    const decomposed = 'à'; // "à" as a and a combining grave accent
    expect(wordsOf(decomposed)).toEqual(['à']);
    expect(wordsOf(decomposed)[0]).toBe('à');
  });
});

describe('filler words', () => {
  it('matches the list with Vietnamese diacritics and any case', () => {
    expect([...fillersIn(wordsOf('Ờ... ừm, À, ờm'))]).toEqual([
      ['ờ', 1],
      ['ừm', 1],
      ['à', 1],
      ['ờm', 1],
    ]);
    // A text typed with combining marks is the same word.
    expect(fillersIn(wordsOf('à ờ')).size).toBe(2);
  });

  it('keeps the diacritics: a letter without them, or with another one, is not a filler', () => {
    expect(fillersIn(wordsOf('a o u ạ ả ừ ơ')).size).toBe(0);
  });

  it('matches whole words only: "à" or "ờ" inside a word does not count', () => {
    expect(fillersIn(wordsOf('Bà ấy là giám đốc, còn bờ sông thì xa')).size).toBe(0);
    expect(fillersIn(wordsOf('um-hum, umbrella, uhh, thing')).get('um')).toBe(1);
    expect(fillersIn(wordsOf('chào anh à.')).get('à')).toBe(1);
  });

  it('finds phrases and single words in mixed Vietnamese and English text, each word used once', () => {
    const found = fillersIn(wordsOf('Kiểu như là, you know, thì là um we should uh kiểu như ship it, ờ, you know'));
    expect([...found].sort()).toEqual([
      ['kiểu như', 2],
      ['thì là', 1],
      ['um', 1],
      ['uh', 1],
      ['you know', 2],
      ['ờ', 1],
    ].sort());
    // A phrase is not split into its words: "you know" is not also counted for "you" or "know", and "thì là" does not count "là" by itself.
    expect(found.has('know')).toBe(false);
    expect(found.has('là')).toBe(false);
  });

  it('has a fixed list in code', () => {
    expect(FILLERS).toContain('kiểu như');
    expect(FILLERS).toContain('you know');
    expect(new Set(FILLERS).size).toBe(FILLERS.length);
  });
});

describe('speakingStyle', () => {
  it('gives each speaker their words, talk time, pace, fillers and longest stretch, most talk first', () => {
    // Lan: 20 s of talk, 40 words (two lines of 20 words), with an "ờ" and a "kiểu như". Hùng: 5 s.
    const twenty = (extra: string) => `${extra} ${Array.from({ length: 18 }, () => 'lời').join(' ')}`;
    const lines = [line('Lan', 0, 10, twenty('Ờ kiểu')), line('Hùng', 10, 15, 'Đồng ý với chị Lan'), line('Lan', 15, 25, twenty('như ừm'))];
    const result = speakingStyle(lines);
    expect(result.map((s) => s.speaker)).toEqual(['Lan', 'Hùng']);
    const lan = result[0];
    expect(lan).toMatchObject({ speaker: 'Lan', seconds: 20, words: 40 });
    // 40 words in 20 seconds: 120 words a minute.
    expect(lan?.wordsPerMinute).toBe(120);
    // "ờ", "ừm" and "kiểu như" (the phrase is split across the two lines, so it is not found): two single fillers of 40 words.
    expect(lan?.fillerWords).toBe(2);
    expect(lan?.fillerShare).toBeCloseTo(2 / 40, 6);
    expect(lan?.fillerTop).toEqual([
      { word: 'ờ', count: 1 },
      { word: 'ừm', count: 1 },
    ]);
    // Hùng talked 5 seconds: too little for a pace.
    expect(result[1]).toMatchObject({ speaker: 'Hùng', seconds: 5, words: 5, wordsPerMinute: null, fillerWords: 0, fillerShare: 0, fillerTop: [] });
  });

  it('ranks the three most used fillers, a tie by name, and counts a phrase as its words in the share', () => {
    const text = 'um um um uh uh ờ ờ ờ ờ à kiểu như kiểu như hôm nay họp';
    const lan = style([line('Lan', 0, 30, text)], 'Lan');
    expect(lan?.fillerTop).toEqual([
      { word: 'ờ', count: 4 },
      { word: 'um', count: 3 },
      { word: 'kiểu như', count: 2 },
    ]);
    // 3 + 2 + 4 + 1 single fillers and two two-word phrases = 14 filler words of 17.
    expect(lan?.words).toBe(17);
    expect(lan?.fillerWords).toBe(14);
  });

  it('measures the longest stretch without a pause: a gap of two seconds or more, or another speaker, ends it', () => {
    const lines = [
      line('Lan', 0, 5, 'một'),
      line('Lan', 6, 12, 'hai'), // 1 s after the first: same stretch, 0 to 12
      line('Lan', 20, 24, 'ba'), // 8 s gap: a new stretch of 4
      line('Hùng', 24, 26, 'bốn'),
      line('Lan', 26, 40, 'năm'), // another speaker in between: a new stretch of 14
    ];
    expect(style(lines, 'Lan')?.longestStretchSeconds).toBe(14);
    expect(style(lines, 'Hùng')?.longestStretchSeconds).toBe(2);
    // Exactly two seconds of pause is a pause.
    expect(style([line('Lan', 0, 5, 'a b'), line('Lan', 7, 9, 'c')], 'Lan')?.longestStretchSeconds).toBe(5);
    expect(style([line('Lan', 0, 5, 'a b'), line('Lan', 6.5, 9, 'c')], 'Lan')?.longestStretchSeconds).toBe(9);
  });

  it('finds a filler phrase inside one line only: the end of one line and the start of the next are not a phrase', () => {
    const lan = style([line('Lan', 0, 5, 'chúng ta làm kiểu'), line('Lan', 20, 25, 'như thế này, ờ')], 'Lan');
    expect(lan?.fillerWords).toBe(1);
    expect(lan?.fillerTop).toEqual([{ word: 'ờ', count: 1 }]);
    expect(lan?.words).toBe(8);
  });

  it('counts overlapping lines of one speaker once in the talk time', () => {
    const lan = style([line('Lan', 0, 10, 'một hai'), line('Lan', 5, 15, 'ba bốn')], 'Lan');
    expect(lan?.seconds).toBe(15);
    expect(lan?.words).toBe(4);
  });

  it('counts nothing for a zero-length line, a line with no text or a line with no valid times', () => {
    expect(speakingStyle([line('Lan', 5, 5, 'ờ ừm um'), line('Lan', 6, 3, 'ờ'), line('Hùng', 0, 4, '   '), line('Hùng', Number.NaN, 4, 'ờ')])).toEqual([]);
    const lan = style([line('Lan', 0, 12, 'một hai ba'), line('Lan', 12, 12, 'ờ ờ ờ')], 'Lan');
    expect(lan).toMatchObject({ seconds: 12, words: 3, fillerWords: 0 });
  });

  it('gives a pace only from the least talk time, and none for an empty transcript', () => {
    expect(style([line('Lan', 0, PACE_MIN_SECONDS - 0.5, 'một hai ba bốn')], 'Lan')?.wordsPerMinute).toBeNull();
    expect(style([line('Lan', 0, PACE_MIN_SECONDS, 'một hai ba bốn năm')], 'Lan')?.wordsPerMinute).toBe(30);
    expect(speakingStyle([])).toEqual([]);
  });

  it('counts two labels that are the same text as one speaker, and puts the larger talker first, a tie by name', () => {
    const result = speakingStyle([line('Mai', 0, 5, 'a'), line('An', 5, 10, 'b'), line('Mai', 10, 12, 'c')]);
    expect(result.map((s) => [s.speaker, s.seconds])).toEqual([['Mai', 7], ['An', 5]]);
    expect(speakingStyle([line('B', 0, 5, 'a'), line('A', 5, 10, 'b')]).map((s) => s.speaker)).toEqual(['A', 'B']);
  });

  it('never puts a line of text in the answer', () => {
    const secret = 'khach.hang@example.com đã nói số tài khoản bí mật';
    const all = JSON.stringify(speakingStyle([line('Lan', 0, 30, `${secret} ờ ừm`)]));
    expect(all).not.toContain('khach.hang');
    expect(all).not.toContain('bí mật');
  });
});
