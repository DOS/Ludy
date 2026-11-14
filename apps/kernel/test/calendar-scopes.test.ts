// SPDX-License-Identifier: AGPL-3.0-only
// The events scope is named in two places that cannot import each other: the contract (the kernel checks a grant for it)
// and the Google adapter (the connect dialog asks for it). They must be the same string.
import { describe, expect, it } from 'vitest';
import { GOOGLE_CALENDAR_EVENTS_READ_SCOPE as ASKED_READ, GOOGLE_CALENDAR_EVENTS_SCOPE as ASKED } from '@crove/channel';
import { GOOGLE_CALENDAR_EVENTS_READ_SCOPE as CHECKED_READ, GOOGLE_CALENDAR_EVENTS_SCOPE as CHECKED } from '@crove/kernel-contract';

describe('the Google events scope', () => {
  it('is the same string where the adapter asks for it and where the kernel checks for it', () => {
    expect(ASKED).toBe(CHECKED);
    expect(CHECKED).toBe('https://www.googleapis.com/auth/calendar.events.owned');
  });
});

describe('the Google events-read scope (B1, #3165)', () => {
  it('is the same string where the adapter asks for it and where the kernel checks for it, and the narrowest read of owned calendars', () => {
    expect(ASKED_READ).toBe(CHECKED_READ);
    expect(CHECKED_READ).toBe('https://www.googleapis.com/auth/calendar.events.owned.readonly');
    // Not the write scope, so a grant for write-back never reads titles and a grant for reading never writes.
    expect(CHECKED_READ).not.toBe(CHECKED);
  });
});
