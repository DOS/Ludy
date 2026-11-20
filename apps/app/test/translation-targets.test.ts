// SPDX-License-Identifier: AGPL-3.0-only
// The picker's pure parts (E3, #3186): the language tag of a translated text, whether there is a choice to show, and which picked language the server still offers.
import { describe, expect, it } from 'vitest';
import { hasChoice, langTag, pickedTarget } from '../src/lib/translation-targets.ts';

describe('translation targets', () => {
  it('tags Chinese as Simplified and every other language as itself', () => {
    expect(langTag('zh')).toBe('zh-Hans');
    for (const to of ['vi', 'en', 'ja', 'ko']) expect(langTag(to)).toBe(to);
  });

  it('shows a choice only when the server offers more than one language', () => {
    expect(hasChoice(undefined)).toBe(false);
    expect(hasChoice([])).toBe(false);
    expect(hasChoice(['en'])).toBe(false);
    expect(hasChoice(['en', 'zh'])).toBe(true);
  });

  it('asks for a picked language only while the server still offers it', () => {
    expect(pickedTarget(undefined, ['en', 'zh'])).toBeUndefined();
    expect(pickedTarget('zh', ['en', 'zh'])).toBe('zh');
    expect(pickedTarget('ko', ['en', 'zh'])).toBeUndefined();
    expect(pickedTarget('zh', undefined)).toBeUndefined();
  });
});
