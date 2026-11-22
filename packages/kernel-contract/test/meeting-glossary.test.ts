// SPDX-License-Identifier: AGPL-3.0-only
// The glossary's term rules (#4043, #4137 points 2b and 3): cleaned to plain text, then judged. The same rules sit in the database (ludy_meetings.glossary_term_ok, tested on a real database in
// apps/kernel/test/meetings-glossary.db.test.ts and apps/kernel/test/meetings-glossary-invisible-chars-scrub.db.test.ts).
import { describe, expect, it } from 'vitest';
import { GLOSSARY_TERM_MAX, INVISIBLE_PATTERN, glossaryTermProblem, zGlossaryAdd, zGlossaryRemove, zGlossaryUpdate } from '../src/index.ts';

const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const TAG_A = String.fromCodePoint(0xe0061);
const parse = (term: string) => zGlossaryAdd.safeParse({ term });
const termOf = (term: string) => {
  const result = parse(term);
  return result.success ? result.data.term : null;
};

describe('glossary terms', () => {
  it('keeps a name as typed, cleaned of invisible and control characters, whitespace and form', () => {
    expect(termOf('Crove')).toBe('Crove');
    expect(termOf(`  Mặt${ZWSP}  Trời${RLO}\n`)).toBe('Mặt Trời');
    expect(termOf(`MISA${TAG_A} AMIS`)).toBe('MISA AMIS');
    expect(termOf(['C', 'a', String.fromCodePoint(0x302), String.fromCodePoint(0x300)].join(''))).toBe('Cầ');
    // Markup is literal text, not something to strip.
    expect(termOf('<b>VAT</b>')).toBe('<b>VAT</b>');
    expect(termOf('Hợp đồng 2026')).toBe('Hợp đồng 2026');
    // Legitimate terms with dots or punctuation stay valid.
    expect(termOf('Node.js')).toBe('Node.js');
    expect(termOf('C.E.O')).toBe('C.E.O');
  });

  it('strips the widened invisible-character ranges on parse and rejects them directly in glossaryTermProblem', () => {
    const widenedEdges = [0x180b, 0x180d, 0x206a, 0x206f, 0xffa0, 0x1d173, 0x1d17a];
    for (const point of widenedEdges) {
      const ch = String.fromCodePoint(point);
      expect(termOf(`MISA${ch}AMIS`), `parse U+${point.toString(16)}`).toBe('MISA AMIS');
      expect(termOf(ch), `empty U+${point.toString(16)}`).toBeNull();
      expect(glossaryTermProblem(`MISA${ch}AMIS`), `problem U+${point.toString(16)}`).toMatch(/invisible|control/);
      expect(glossaryTermProblem(ch), `direct U+${point.toString(16)}`).toMatch(/invisible|control/);
    }
    // Lone surrogates are stripped on parse and refused directly; non-invisible neighbours stay valid.
    expect(termOf('MISA\ud800AMIS')).toBe('MISA AMIS');
    expect(glossaryTermProblem('MISA\ud800AMIS')).toMatch(/invisible|control/);
    expect(glossaryTermProblem('MISA\udc00AMIS')).toMatch(/invisible|control/);
    for (const point of [0x2070, 0xffa1, 0x1d172, 0x1d17b, 0xfe0f]) {
      const ch = String.fromCodePoint(point);
      expect(termOf(`a${ch}b`), `outside U+${point.toString(16)}`).toBe(`a${ch}b`);
      expect(glossaryTermProblem(`a${ch}b`), `outside problem U+${point.toString(16)}`).toBeNull();
    }
    expect(new RegExp(INVISIBLE_PATTERN, 'u').test('\uffa0')).toBe(true);
  });

  it('counts code points, not UTF-16 units, against the length cap', () => {
    expect(termOf('x'.repeat(GLOSSARY_TERM_MAX))).not.toBeNull();
    expect(termOf('x'.repeat(GLOSSARY_TERM_MAX + 1))).toBeNull();
    expect(termOf('\u{1d4d0}'.repeat(GLOSSARY_TERM_MAX))).not.toBeNull();
    expect(termOf('\u{1d4d0}'.repeat(GLOSSARY_TERM_MAX + 1))).toBeNull();
  });

  it('refuses what is not a name: empty, no letter, a number, an address', () => {
    for (const bad of ['', '   ', `${ZWSP}${ZWSP}`, '\uffa0', '12345', '0912 345 678', '1-2-3-4-5', '!!!', 'an@example.com', 'https://example.com', 'www.example.com', 'tại https://x.vn']) {
      expect(termOf(bad), JSON.stringify(bad)).toBeNull();
    }
    // Full-width and compatibility look-alikes are seen as the characters they imitate via NFKC.
    for (const lookAlike of [
      'an＠example.com',
      'a﹫b',
      'www．example.com',
      'www․example.com',
      'www﹒example.com',
      'www‥example.com',
      'www…example.com',
      'wｗw．example.com',
      'ⓦⓦⓦ.example.com',
      '𝐰𝐰𝐰.example.com',
      'ｈｔｔｐｓ：／／example.com',
      'https﹕／／example.com',
      'https︓／／example.com',
    ]) {
      expect(termOf(lookAlike), lookAlike).toBeNull();
      expect(glossaryTermProblem(lookAlike), lookAlike).toMatch(/address/);
    }
    // Up to 4 digits are fine; every Unicode decimal digit counts.
    expect(termOf('Q4 26')).not.toBeNull();
    expect(termOf('Q4 2026')).toBeNull();
    expect(termOf('١٢٣٤٥')).toBeNull();
  });

  it('judges only a cleaned term, and names its problem', () => {
    expect(glossaryTermProblem('Crove')).toBeNull();
    expect(glossaryTermProblem('')).toMatch(/empty/);
    expect(glossaryTermProblem('12345')).toMatch(/letter/);
    expect(glossaryTermProblem('a1b2c3d4e5')).toMatch(/digits/);
    expect(glossaryTermProblem('a@b')).toMatch(/address/);
    expect(glossaryTermProblem('a\u200bb')).toMatch(/invisible|control/);
  });

  it('is strict about the shape of each command input', () => {
    expect(zGlossaryAdd.safeParse({ term: 'Crove', extra: 1 }).success).toBe(false);
    expect(zGlossaryAdd.safeParse({}).success).toBe(false);
    expect(zGlossaryAdd.safeParse({ term: 5 }).success).toBe(false);
    expect(zGlossaryUpdate.safeParse({ termId: 'not-an-id', term: 'Crove' }).success).toBe(false);
    expect(zGlossaryUpdate.safeParse({ termId: '0195f3a0-7b1c-7c3e-9d41-2f6a8b9c0d1e', term: 'Crove' }).success).toBe(true);
    expect(zGlossaryRemove.safeParse({ termId: '0195f3a0-7b1c-7c3e-9d41-2f6a8b9c0d1e', term: 'x' }).success).toBe(false);
  });
});
