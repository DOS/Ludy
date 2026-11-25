// SPDX-License-Identifier: AGPL-3.0-only
// Counting a tracked word or phrase in a transcript line (#4818): whole words only, case and marks ignored, punctuation read as a space, hits that share a space both counted.
import { describe, expect, it } from 'vitest';
import { countNeedle, needleOf, wordsOf } from '../src/tracker-count.ts';

const count = (text: string, term: string): number => {
  const needle = needleOf(term);
  return needle === null ? 0 : countNeedle(wordsOf(text), needle);
};

describe('wordsOf and needleOf', () => {
  it('turns a text into lower case words without marks, a space at each end', () => {
    expect(wordsOf('  Hợp đồng, ĐÃ ký!  ')).toBe(' hop dong da ky ');
    expect(wordsOf('')).toBe('  ');
  });

  it('gives a term the same words, or no needle when no word is left', () => {
    expect(needleOf('Hợp đồng')).toBe(' hop dong ');
    expect(needleOf('!!!')).toBeNull();
  });
});

describe('countNeedle', () => {
  it('finds a word whatever its case and marks', () => {
    expect(count('Giá này cao quá, GIÁ bên kia thấp hơn', 'giá')).toBe(2);
    expect(count('gia ca', 'Giá')).toBe(1);
  });

  it('finds whole words only', () => {
    expect(count('giảm giá mạnh, giám đốc đồng ý', 'gia')).toBe(1);
    expect(count('hợp đồng hợp đồngg', 'hợp đồng')).toBe(1);
  });

  it('finds a phrase of several words, punctuation read as a space', () => {
    expect(count('Ký hợp đồng. Hợp, đồng mới', 'hợp đồng')).toBe(2);
    expect(count('hợp tác, đồng ý', 'hợp đồng')).toBe(0);
  });

  it('counts two hits that share the space between them', () => {
    expect(count('a a a', 'a')).toBe(3);
    expect(count('ab ab', 'ab ab')).toBe(1);
    expect(count('ab ab ab', 'ab ab')).toBe(1);
  });

  it('finds a competitor name written with the letter đ or a digit', () => {
    expect(count('Đối thủ Đại Việt 2 vừa giảm giá', 'đại việt 2')).toBe(1);
    expect(count('dai viet 22', 'dai viet 2')).toBe(0);
  });

  it('finds nothing in an empty line', () => {
    expect(count('', 'giá')).toBe(0);
  });
});
