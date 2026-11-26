// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createTranslator, DEFAULT_LOCALE, LOCALES, MESSAGES, resolveLocale } from '../src/i18n.ts';

describe('messages', () => {
  it('has the same keys and placeholders in every language, and no empty text', () => {
    const vi = MESSAGES.vi;
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual(Object.keys(vi).sort());
      for (const [key, text] of Object.entries(MESSAGES[locale])) {
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
        expect(text.match(/\{\w+\}/g)?.sort() ?? [], `${locale}.${key}`).toEqual((vi as Record<string, string>)[key]?.match(/\{\w+\}/g)?.sort() ?? []);
        expect(text, `${locale}.${key}`).not.toMatch(/[—–]/);
      }
    }
  });

  it('is Vietnamese by default and follows the phone\'s language when it is English', () => {
    expect(DEFAULT_LOCALE).toBe('vi');
    expect(resolveLocale([])).toBe('vi');
    expect(resolveLocale(['fr-FR', 'en-US'])).toBe('en');
    expect(resolveLocale(['vi_VN'])).toBe('vi');
    expect(resolveLocale(['de'])).toBe('vi');
  });

  it('fills placeholders as text', () => {
    expect(createTranslator('en')('home.title', { name: '<b>An</b>' })).toBe('Hello, <b>An</b>');
    expect(createTranslator('vi')('home.title', { name: 'An' })).toBe('Xin chào, An');
  });
});
