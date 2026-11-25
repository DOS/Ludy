// SPDX-License-Identifier: AGPL-3.0-only
// Counting a tracked word or phrase in a transcript line (#4818): whole words only, case ignored, punctuation read as a space, hits that share a space both counted, and marks following what the
// owner typed (a term with marks is found with its marks only, a term typed without marks is found whatever the marks of the line).
import { describe, expect, it } from 'vitest';
import { countNeedle, hasMarks, lineWords, needleOf } from '../src/tracker-count.ts';

const count = (text: string, term: string): number => {
  const target = needleOf(term);
  return target === null ? 0 : countNeedle(lineWords(text), target);
};

describe('lineWords and needleOf', () => {
  it('turns a line into its words in two spellings, a space at each end', () => {
    expect(lineWords('  Hợp đồng, ĐÃ ký!  ')).toEqual({ strict: ' hợp đồng đã ký ', loose: ' hop dong da ky ' });
    expect(lineWords('')).toEqual({ strict: '  ', loose: '  ' });
  });

  it('gives a term the spelling it was typed in, or no needle when no word is left', () => {
    expect(needleOf('Hợp đồng')).toEqual({ needle: ' hợp đồng ', loose: false });
    expect(needleOf('Hop dong')).toEqual({ needle: ' hop dong ', loose: true });
    expect(needleOf('!!!')).toBeNull();
  });

  it('knows a term with marks, the letter đ included, from one without', () => {
    expect([hasMarks('giá'), hasMarks('đối thủ'), hasMarks('gia'), hasMarks('Dai Viet 2')]).toEqual([true, true, false, false]);
  });
});

describe('countNeedle', () => {
  it('finds a word whatever its case', () => {
    expect(count('Giá này cao quá, GIÁ bên kia thấp hơn', 'giá')).toBe(2);
  });

  it('finds a term typed with marks with its marks only', () => {
    expect(count('giá, già, giả và gia đình', 'giá')).toBe(1);
    expect(count('hợp đồng, hop dong', 'hợp đồng')).toBe(1);
  });

  it('finds a term typed without marks whatever the marks of the line', () => {
    expect(count('giá, già, giả và gia đình', 'gia')).toBe(4);
    expect(count('Ký Hợp đồng mới', 'hop dong')).toBe(1);
  });

  it('finds whole words only', () => {
    expect(count('giảm giá mạnh, giám đốc đồng ý', 'giá')).toBe(1);
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
    expect(count('đại việt 22', 'đại việt 2')).toBe(0);
  });

  it('finds a name written in Unicode forms D and C alike', () => {
    expect(count('Giá cao', 'giá')).toBe(1);
    expect(count('giá cao', 'Giá')).toBe(1);
  });

  it('finds nothing in an empty line', () => {
    expect(count('', 'giá')).toBe(0);
  });
});
