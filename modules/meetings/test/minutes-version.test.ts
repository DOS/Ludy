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
    expect(versionTextProblem('Gửi báo giá', 'Call 0212 345 678')).toBe('INVENTED_NUMBER');
    expect(versionTextProblem('Gọi 0212 345 678', 'Call 0212 345 678')).toBeNull();
    expect(versionTextProblem('Gửi tới a@b.example', 'Send to a@b.example')).toBeNull();
    // An original with a phone-like amount (1.250.000) does not let an address or a link through.
    expect(versionTextProblem('Chốt báo giá 1.250.000', 'Quote of 1,250,000. Write to a@evil.example')).toBe('CONTACT_ADDED');
    expect(versionTextProblem('Chốt báo giá 1.250.000', 'Quote of 1,250,000. See https://evil.example')).toBe('CONTACT_ADDED');
    expect(versionTextProblem('Chốt báo giá 1.250.000', 'Quote of 1,250,000')).toBeNull();
  });

  it('allows only the very address, link and number the original writes: another one of a kind the original holds is refused (the erasure finds a person in the original, never in a version)', () => {
    const original = 'Gửi tới alice@example.com, xem https://example.com/bao-gia hoặc gọi 0212 345 678';
    // The same ones, in any case and with other punctuation or spacing, are the original's own.
    expect(versionTextProblem(original, 'Send to (Alice@Example.com), see https://example.com/bao-gia, or call 0212-345-678.')).toBeNull();
    // Another address, link or number of a kind the original already holds is refused.
    expect(versionTextProblem(original, 'Send to bob@example.org')).toBe('CONTACT_ADDED');
    expect(versionTextProblem(original, 'See https://example.org/bao-gia')).toBe('CONTACT_ADDED');
    expect(versionTextProblem(original, 'Call 0212 987 654')).toBe('INVENTED_NUMBER');
    // A number built from digit runs the original writes apart is not the original's number.
    expect(versionTextProblem('Mã 0212 và 345 và 678, gọi 0212 345 678', 'Call 0212 678 345')).toBe('CONTACT_ADDED');
    // A figure written with other separators is the same figure.
    expect(versionTextProblem('Chốt báo giá 1.250.000', 'Quote of 1 250 000')).toBeNull();
  });

  it('keeps a figure in the statement it was written in: swapped figures between two statements are each refused (the check is per segment, against that segment\'s own original)', () => {
    expect(versionTextProblem('Chốt báo giá 1.250.000', 'Quote of 1,300,000')).toBe('INVENTED_NUMBER');
    expect(versionTextProblem('Giữ giá cũ 1.300.000', 'Keep the old price of 1,250,000')).toBe('INVENTED_NUMBER');
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
