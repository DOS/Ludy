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
    for (const code of [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x034f]) expect(hiddenTextCode(code), `U+${code.toString(16)}`).toBe(true);
  });
});
