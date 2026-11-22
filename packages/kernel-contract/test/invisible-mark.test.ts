// SPDX-License-Identifier: AGPL-3.0-only
// The one place that writes hidden characters out (#4423): markHiddenText and hiddenTextCode are built from the contract's invisible-character class, so the Inbox card, the task screens and the AI-written weekly
// status share one set, the Hangul fillers and the braille blank included.
import { describe, expect, it } from 'vitest';
import { INVISIBLE_PATTERN, hiddenTextCode, markHiddenText } from '../src/index.ts';

describe('markHiddenText', () => {
  it('writes the Hangul fillers and the braille blank out, which made a title look empty', () => {
    expect(markHiddenText('ᅟᅠㅤﾠ⠀')).toBe('<U+115F><U+1160><U+3164><U+FFA0><U+2800>');
    expect(markHiddenText('Gửiㅤbáo giá')).toBe('Gửi<U+3164>báo giá');
  });

  it('writes the direction marks, zero-width, invisible operators, tags and controls out, and keeps a newline and a tab', () => {
    expect(markHiddenText('a‮b​c⁢d\u{e0041}e\u0085f')).toBe('a<U+202E>b<U+200B>c<U+2062>d<U+E0041>e<U+0085>f');
    expect(markHiddenText('dòng một\n\tdòng hai')).toBe('dòng một\n\tdòng hai');
  });

  it('keeps the zero-width joiners when asked (emoji), and uses the brackets given', () => {
    expect(markHiddenText('👨‍👩', { keepJoiners: true })).toBe('👨‍👩');
    expect(markHiddenText('👨‍👩')).toBe('👨<U+200D>👩');
    expect(markHiddenText('x‮', { open: '⟨', close: '⟩' })).toBe('x⟨U+202E⟩');
  });

  it('marks exactly the contract class but for a newline and a tab (the one set, not a second list)', () => {
    const re = new RegExp(`^${INVISIBLE_PATTERN}$`, 'u');
    for (let code = 0; code <= 0x10ffff; code += code < 0x3000 ? 1 : 7) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const expected = re.test(String.fromCodePoint(code)) && code !== 0x09 && code !== 0x0a;
      expect(hiddenTextCode(code), `U+${code.toString(16)}`).toBe(expected);
    }
    // An explicit list, not derived from the pattern: the first and last of each range of the class, the ones a title made of nothing visible uses, and the neighbours that are NOT in it.
    const marked = [0x00, 0x08, 0x0b, 0x1f, 0x7f, 0x85, 0x9f, 0xad, 0x034f, 0x061c, 0x115f, 0x1160, 0x180b, 0x180e, 0x200b, 0x200f, 0x2028, 0x202e, 0x2060, 0x206f, 0x2800, 0x3164, 0xfeff, 0xffa0, 0xfff9, 0xfffb, 0x1d173, 0x1d17a, 0xe0000, 0xe007f];
    for (const code of marked) expect(hiddenTextCode(code), `U+${code.toString(16)}`).toBe(true);
    const plain = [0x09, 0x0a, 0x20, 0x41, 0xa0, 0xae, 0x0e9, 0x1ea1, 0x180a, 0x180f, 0x2010, 0x2027, 0x202f, 0x205f, 0x2070, 0x27e8, 0x2801, 0xfe0f, 0xfeff + 1, 0xfffc, 0x1d172, 0x1d17b, 0x1f600, 0xe0080];
    for (const code of plain) expect(hiddenTextCode(code), `U+${code.toString(16)}`).toBe(false);
    expect(hiddenTextCode(0x200c, true)).toBe(false);
    expect(hiddenTextCode(0x200d, true)).toBe(false);
    expect(hiddenTextCode(0x200c)).toBe(true);
    expect(hiddenTextCode(0x200d)).toBe(true);
  });
});
