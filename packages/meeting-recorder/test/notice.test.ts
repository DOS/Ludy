// SPDX-License-Identifier: AGPL-3.0-only
// The recording notice kit (Meetings A1, #3159): fixed text, a version, the meeting's language as the default.
import { describe, expect, it } from 'vitest';
import { noticeLanguageFor, noticeToCopy, otherNoticeLanguage, RECORDING_NOTICE } from '../src/index.ts';

describe('recording notice kit', () => {
  it('has a Vietnamese and an English text, a version, and says it awaits the lawyer (#2585)', () => {
    expect(RECORDING_NOTICE.version).toMatch(/^\d{4}-\d{2}-v\d+$/);
    expect(RECORDING_NOTICE.reviewed).toBe(false);
    expect(RECORDING_NOTICE.reviewIssue).toBe(2585);
    expect(RECORDING_NOTICE.text.vi).toContain('ghi âm');
    expect(RECORDING_NOTICE.text.en).toContain('recorded');
  });

  it('defaults to the meeting language, Vietnamese when unknown or automatic', () => {
    expect(noticeLanguageFor('en')).toBe('en');
    expect(noticeLanguageFor('vi')).toBe('vi');
    expect(noticeLanguageFor('auto')).toBe('vi');
    expect(otherNoticeLanguage('vi')).toBe('en');
    expect(otherNoticeLanguage('en')).toBe('vi');
  });

  it('copies the text together with the version that is stored on the meeting', () => {
    expect(noticeToCopy('vi')).toEqual({ text: RECORDING_NOTICE.text.vi, version: RECORDING_NOTICE.version });
    expect(noticeToCopy('en').version).toBe(RECORDING_NOTICE.version);
  });

  it('has no em dash and no markup in either text', () => {
    for (const text of Object.values(RECORDING_NOTICE.text)) {
      expect(text).not.toMatch(/—|<|>/);
    }
  });
});
