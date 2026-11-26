// SPDX-License-Identifier: AGPL-3.0-only
// The place of a meeting counts its length in code points everywhere (#5043): the command, the database's char_length and the schemas of the answer and the meeting's read agree, so a place of
// 200 emoji (400 UTF-16 units) is valid and one of 201 is not, the way a label of 40 code points is (meeting-labels.test.ts).
import { describe, expect, it } from 'vitest';
import { MEETING_PLACE_MAX, zMeetingPlaceSet, zMeetingSetPlace, zMinutesDocxInput, zPlaceValue } from '../src/index.ts';

const MEETING_ID = '0190c0de-0000-7000-8000-000000000001';

describe('the place of a meeting is bounded in code points (#5043)', () => {
  const emoji = (n: number) => '😀'.repeat(n);

  it('accepts 200 astral characters although they take 400 UTF-16 units, and refuses 201', () => {
    const full = emoji(MEETING_PLACE_MAX);
    expect(full.length).toBe(MEETING_PLACE_MAX * 2);
    expect([...full].length).toBe(MEETING_PLACE_MAX);
    expect(zPlaceValue.safeParse(full).success).toBe(true);
    expect(zPlaceValue.safeParse(emoji(MEETING_PLACE_MAX + 1)).success).toBe(false);
  });

  it('bounds a letter place at 200 as before, and never lets an empty one through', () => {
    expect(zPlaceValue.safeParse('a'.repeat(MEETING_PLACE_MAX)).success).toBe(true);
    expect(zPlaceValue.safeParse('a'.repeat(MEETING_PLACE_MAX + 1)).success).toBe(false);
    expect(zPlaceValue.safeParse('').success).toBe(false);
  });

  it('lets the command answer carry a full astral place, null, and refuses an over-long one', () => {
    expect(zMeetingPlaceSet.safeParse({ meetingId: MEETING_ID, place: emoji(MEETING_PLACE_MAX) }).success).toBe(true);
    expect(zMeetingPlaceSet.safeParse({ meetingId: MEETING_ID, place: null }).success).toBe(true);
    expect(zMeetingPlaceSet.safeParse({ meetingId: MEETING_ID, place: emoji(MEETING_PLACE_MAX + 1) }).success).toBe(false);
  });

  it('lets the Word file take the place the page lets be typed, in code points, and defaults to none', () => {
    expect(zMinutesDocxInput.safeParse({ meetingId: MEETING_ID, place: emoji(MEETING_PLACE_MAX) }).success).toBe(true);
    expect(zMinutesDocxInput.safeParse({ meetingId: MEETING_ID, place: emoji(MEETING_PLACE_MAX + 1) }).success).toBe(false);
    expect(zMinutesDocxInput.safeParse({ meetingId: MEETING_ID, place: 'a'.repeat(MEETING_PLACE_MAX + 1) }).success).toBe(false);
    expect(zMinutesDocxInput.parse({ meetingId: MEETING_ID }).place).toBe('');
    expect(zMinutesDocxInput.parse({ meetingId: MEETING_ID, place: '' }).place).toBe('');
  });

  it('keeps the input loose enough for the command to count and refuse with its own code', () => {
    expect(zMeetingSetPlace.safeParse({ meetingId: MEETING_ID, place: emoji(MEETING_PLACE_MAX + 1) }).success).toBe(true);
  });
});
