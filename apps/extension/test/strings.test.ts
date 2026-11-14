// SPDX-License-Identifier: AGPL-3.0-only
// The popup's two languages (#3008): English has every key Vietnamese has (and no other), no text is empty, the consent step keeps its three confirmations in both, and the
// language is chosen from the browser's: English for English, Vietnamese for anything else.
import { describe, expect, it } from 'vitest';
import { ENGLISH, VIETNAMESE, chooseStrings } from '../src/strings.ts';

const paths = (value: unknown, prefix = ''): string[] =>
  typeof value === 'string' ? [prefix] : Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => paths(inner, prefix === '' ? key : `${prefix}.${key}`));
const texts = (value: unknown): string[] => (typeof value === 'string' ? [value] : Object.values(value as Record<string, unknown>).flatMap(texts));

describe('popup strings', () => {
  it('English has exactly the keys Vietnamese has', () => {
    expect(paths(ENGLISH).sort()).toEqual(paths(VIETNAMESE).sort());
  });

  it('no text is empty, and English is not Vietnamese left untranslated (apart from the brand and the example address)', () => {
    expect(texts(ENGLISH).every((t) => t.trim() !== '')).toBe(true);
    expect(texts(VIETNAMESE).every((t) => t.trim() !== '')).toBe(true);
    const same = paths(ENGLISH).filter((path) => {
      const get = (s: unknown) => path.split('.').reduce((v, k) => (v as Record<string, unknown>)[k], s) as string;
      return get(ENGLISH) === get(VIETNAMESE);
    });
    expect(same.sort()).toEqual(['cloud', 'title']);
  });

  it('the consent step has its method choices and the confirmation in both languages', () => {
    for (const strings of [ENGLISH, VIETNAMESE]) {
      expect(Object.keys(strings.consentMethods).sort()).toEqual(['in_invite', 'in_writing', 'told_at_start']);
      expect(strings.consentConfirm.length).toBeGreaterThan(20);
      expect(strings.blockers.consentAgreed.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['en', ENGLISH],
    ['en-US', ENGLISH],
    ['en-GB', ENGLISH],
    ['EN_us', ENGLISH],
    ['vi', VIETNAMESE],
    ['vi-VN', VIETNAMESE],
    ['fr', VIETNAMESE],
    ['de-DE', VIETNAMESE],
    ['enx', VIETNAMESE],
    ['', VIETNAMESE],
    [undefined, VIETNAMESE],
    [null, VIETNAMESE],
  ])('the browser language %s gives the right words', (language, expected) => {
    expect(chooseStrings(language)).toBe(expected);
  });
});
