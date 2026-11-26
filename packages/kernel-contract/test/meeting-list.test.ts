// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { zMeetingListInput } from '../src/index.ts';

const ID = '0190b1c2-0000-7000-8000-000000000001';

describe('zMeetingListInput (#5052)', () => {
  it('accepts omitted filters, visibility, limit, trimmed search, and paired cursor', () => {
    expect(zMeetingListInput.safeParse({}).success).toBe(true);
    expect(zMeetingListInput.safeParse({ visibility: 'org', limit: 100 }).success).toBe(true);
    expect(zMeetingListInput.parse({ search: '  Họp Hoa Sen  ' }).search).toBe('Họp Hoa Sen');
    expect(zMeetingListInput.parse({ search: '   ' }).search).toBe('');
    expect(zMeetingListInput.safeParse({ search: 'a'.repeat(200) }).success).toBe(true);
    expect(
      zMeetingListInput.safeParse({
        afterStartedAt: '2026-11-25T03:00:00.123Z',
        afterId: ID,
      }).success,
    ).toBe(true);
    expect(
      zMeetingListInput.safeParse({
        afterStartedAt: '2026-11-25T03:00:00.123900Z',
        afterId: ID,
      }).success,
    ).toBe(true);
    expect(
      zMeetingListInput.safeParse({
        afterStartedAt: '2026-11-25T10:00:00+15:59',
        afterId: ID,
      }).success,
    ).toBe(true);
    expect(
      zMeetingListInput.safeParse({
        afterStartedAt: '2026-11-25T10:00:00-15:59',
        afterId: ID,
      }).success,
    ).toBe(true);
    expect(
      zMeetingListInput.safeParse({
        visibility: 'attendees',
        limit: 50,
        search: 'hoa sen',
        afterStartedAt: '2026-11-25T10:00:00+07:00',
        afterId: ID,
      }).success,
    ).toBe(true);
  });

  it('refuses half cursors, invalid or out-of-range timestamps, invalid ids, out-of-range limits, long search, and extra fields', () => {
    expect(zMeetingListInput.safeParse({ afterStartedAt: '2026-11-25T03:00:00.000Z' }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterId: ID }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterStartedAt: 'not-a-date', afterId: ID }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterStartedAt: '2026-11-25', afterId: ID }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterStartedAt: '2026-11-25T03:00:00+16:00', afterId: ID }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterStartedAt: '2026-11-25T03:00:00-16:00', afterId: ID }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterStartedAt: '2026-11-25T03:00:00+23:59', afterId: ID }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterStartedAt: '2026-11-25T03:00:00-23:59', afterId: ID }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterStartedAt: '0000-01-01T00:00:00Z', afterId: ID }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterStartedAt: `2026-11-25T03:00:00.${'0'.repeat(100)}Z`, afterId: ID }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ afterStartedAt: '2026-11-25T03:00:00Z', afterId: 'not-a-uuid' }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ search: 'a'.repeat(201) }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ search: 'abc\u0000def' }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ search: '\u0000' }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ limit: 0 }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ limit: 201 }).success).toBe(false);
    expect(zMeetingListInput.safeParse({ extra: 1 }).success).toBe(false);
  });
});
