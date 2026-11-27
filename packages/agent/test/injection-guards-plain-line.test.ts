// SPDX-License-Identifier: AGPL-3.0-only
// The agent's `plainLine` drops variation selectors like `@ludy/kernel-contract`'s `plainLine` (#5188, #4099).
import { describe, expect, it } from 'vitest';
import { plainLine } from '../src/injection-guards.ts';

describe('plainLine variation selectors', () => {
  it('drops a run of selectors hidden after a letter', () => {
    expect(plainLine('a\u{e0100}\u{e0101}\u{e0102}b', 20)).toBe('ab');
    expect(plainLine('x︁︂y', 20)).toBe('xy');
  });

  it('drops a lone selector at the start', () => {
    expect(plainLine('️hello', 20)).toBe('hello');
  });

  it('keeps one emoji presentation selector after an emoji', () => {
    expect(plainLine('❤️ ok', 20)).toBe('❤️ ok');
  });

  it('drops a selector run after an emoji beyond the first presentation selector', () => {
    expect(plainLine('❤️\u{e0100}\u{e0101}', 20)).toBe('❤️');
  });

  it('still collapses whitespace and bounds by code point', () => {
    expect(plainLine('  a \n\t b  ', 20)).toBe('a b');
    expect(plainLine('abcdef', 3)).toBe('abc');
  });
});
