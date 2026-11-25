// SPDX-License-Identifier: AGPL-3.0-only
// What code finds wrong with the reviewed text of a second-language version against the published original it sits beside (#4777): a figure the original does not hold, or a link, address or
// phone number it does not hold. Separators of figures (1.500.000 and 1,500,000) and leading zeros are not a different figure.
import { describe, expect, it } from 'vitest';
import { zMinutesVersionSegment } from '@ludy/kernel-contract';
import { versionTextProblem } from '../src/minutes-version.ts';

describe('versionTextProblem', () => {
  it('accepts the same figures written the other way and plain words', () => {
    expect(versionTextProblem('Chốt báo giá 1.250.000 cho khách A.', 'Quote of 1,250,000 agreed for customer A.')).toBeNull();
    expect(versionTextProblem('Họp lúc 09:30 ngày 5/12', 'Meeting at 9:30 on 5/12')).toBeNull();
    expect(versionTextProblem('Giữ giá cũ', 'Keep the old price')).toBeNull();
  });

  it('refuses a figure the original does not hold', () => {
    expect(versionTextProblem('Chốt báo giá 1.250.000', 'Quote of 1,350,000')).toBe('INVENTED_NUMBER');
    expect(versionTextProblem('Giữ giá cũ', 'Keep the old price of 500')).toBe('INVENTED_NUMBER');
  });

  it('refuses a link, an address or a phone number the original does not hold, and allows one the original has', () => {
    expect(versionTextProblem('Gửi báo giá', 'Send the quote to a@evil.example')).toBe('CONTACT_ADDED');
    expect(versionTextProblem('Gửi báo giá', 'See https://evil.example')).toBe('CONTACT_ADDED');
    expect(versionTextProblem('Gửi báo giá', 'Call 0912 345 678')).toBe('INVENTED_NUMBER');
    expect(versionTextProblem('Gọi 0912 345 678', 'Call 0912 345 678')).toBeNull();
    expect(versionTextProblem('Gửi tới a@b.example', 'Send to a@b.example')).toBeNull();
  });
});

describe('zMinutesVersionSegment', () => {
  it('keeps the breaks of a summary and refuses a hidden character', () => {
    expect(zMinutesVersionSegment.safeParse({ key: 'summary', text: 'Line one.\r\nLine two.\n\tIndented.' }).success).toBe(true);
    expect(zMinutesVersionSegment.safeParse({ key: 'summary', text: 'Quote agreed\u202e.' }).success).toBe(false);
    expect(zMinutesVersionSegment.safeParse({ key: 'summary', text: 'Quote\u200b agreed.' }).success).toBe(false);
    expect(zMinutesVersionSegment.safeParse({ key: 'summary', text: 'Bell\u0007.' }).success).toBe(false);
    expect(zMinutesVersionSegment.safeParse({ key: 'summary', text: '   ' }).success).toBe(false);
  });
});
