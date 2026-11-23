// SPDX-License-Identifier: AGPL-3.0-only
// MEETINGS_TRANSLATION_LANGUAGES (meetings translation into Chinese, Japanese and Korean, E3, #3186): each language is its own switch, off by default, so a language ships only after a native reader's check.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };

describe('MEETINGS_TRANSLATION_LANGUAGES', () => {
  it('is empty by default and when blank: no language besides the vi/en pair is offered', () => {
    expect(loadConfig({ ...BASE }).MEETINGS_TRANSLATION_LANGUAGES).toEqual([]);
    expect(loadConfig({ ...BASE, MEETINGS_TRANSLATION_LANGUAGES: '' }).MEETINGS_TRANSLATION_LANGUAGES).toEqual([]);
    expect(loadConfig({ ...BASE, MEETINGS_TRANSLATION_LANGUAGES: ' , ' }).MEETINGS_TRANSLATION_LANGUAGES).toEqual([]);
  });

  it('takes any of zh, ja and ko, in any case and order, once each, listed in a fixed order', () => {
    expect(loadConfig({ ...BASE, MEETINGS_TRANSLATION_LANGUAGES: 'ja' }).MEETINGS_TRANSLATION_LANGUAGES).toEqual(['ja']);
    expect(loadConfig({ ...BASE, MEETINGS_TRANSLATION_LANGUAGES: 'KO, zh ,ko' }).MEETINGS_TRANSLATION_LANGUAGES).toEqual(['zh', 'ko']);
    expect(loadConfig({ ...BASE, MEETINGS_TRANSLATION_LANGUAGES: 'ko,ja,zh' }).MEETINGS_TRANSLATION_LANGUAGES).toEqual(['zh', 'ja', 'ko']);
  });

  it('stops the boot on a name it does not know, so a typo never silently leaves a language off (vi and en are always there and are not switches)', () => {
    for (const value of ['cn', 'zh,jp', 'vi', 'en', 'chinese']) expect(() => loadConfig({ ...BASE, MEETINGS_TRANSLATION_LANGUAGES: value }), value).toThrow(/MEETINGS_TRANSLATION_LANGUAGES/);
  });
});
