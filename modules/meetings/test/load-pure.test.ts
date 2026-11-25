// SPDX-License-Identifier: AGPL-3.0-only
// The week's meeting load (#4770), the pure parts: the week a count names (Monday to Sunday, Vietnam time), a meeting's length, each person's meetings and minutes (an overlap counted once, a meeting with no
// length counted for nothing) and what the signals say about a recurring series.
import { describe, expect, it } from 'vitest';
import { assessSeries, lengthSeconds, memberFigures, weekBounds, type HeldMeeting, type SeriesMeeting } from '../src/load.ts';

const at = (iso: string) => new Date(iso);
const held = (id: string, recorderUserId: string, start: string, minutes: number | null): HeldMeeting => ({ id, recorderUserId, startedAt: at(start), seconds: minutes === null ? null : minutes * 60 });
const readers = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

describe('weekBounds', () => {
  it('names the Monday to Sunday week of a Vietnam day', () => {
    // 2026-11-25 is a Wednesday.
    expect(weekBounds(at('2026-11-25T04:00:00Z'), 0)).toEqual({ start: '2026-11-23', last: '2026-11-29', end: '2026-11-30' });
    expect(weekBounds(at('2026-11-25T04:00:00Z'), 1)).toEqual({ start: '2026-11-16', last: '2026-11-22', end: '2026-11-23' });
    expect(weekBounds(at('2026-11-25T04:00:00Z'), 12).start).toBe('2026-08-31');
  });

  it('takes Monday and Sunday as themselves, and reads the day in Vietnam time', () => {
    expect(weekBounds(at('2026-11-23T05:00:00Z'), 0).start).toBe('2026-11-23');
    expect(weekBounds(at('2026-11-29T10:00:00Z'), 0).start).toBe('2026-11-23');
    // 18:00 UTC on a Sunday is already Monday 01:00 in Vietnam: the next week.
    expect(weekBounds(at('2026-11-29T18:00:00Z'), 0).start).toBe('2026-11-30');
    // 16:59 UTC on a Sunday is still Sunday 23:59 there.
    expect(weekBounds(at('2026-11-29T16:59:00Z'), 0).start).toBe('2026-11-23');
  });
});

describe('lengthSeconds', () => {
  it('takes the recorded length, else the end minus the start, else nothing', () => {
    expect(lengthSeconds({ started_at: null, ended_at: null, length_seconds: 600 })).toBe(600);
    expect(lengthSeconds({ started_at: '2026-11-25T01:00:00Z', ended_at: '2026-11-25T01:30:00Z', length_seconds: null })).toBe(1800);
    expect(lengthSeconds({ started_at: at('2026-11-25T01:00:00Z'), ended_at: null, length_seconds: null })).toBeNull();
    expect(lengthSeconds({ started_at: '2026-11-25T01:00:00Z', ended_at: '2026-11-25T01:00:00Z', length_seconds: null })).toBeNull();
    expect(lengthSeconds({ started_at: '2026-11-25T02:00:00Z', ended_at: '2026-11-25T01:00:00Z', length_seconds: 0 })).toBeNull();
  });
});

describe('memberFigures', () => {
  it('counts the recorder and the readers the recorder added, most minutes first', () => {
    const figures = memberFigures([held('m1', 'lan', '2026-11-24T02:00:00Z', 60), held('m2', 'hung', '2026-11-25T02:00:00Z', 30)], readers({ m1: ['hung', 'an'], m2: ['lan'] }));
    expect(figures).toEqual([
      { userId: 'hung', meetings: 2, minutes: 90 },
      { userId: 'lan', meetings: 2, minutes: 90 },
      { userId: 'an', meetings: 1, minutes: 60 },
    ]);
  });

  it('counts a person once in a meeting even when they are the recorder and a reader', () => {
    expect(memberFigures([held('m1', 'lan', '2026-11-24T02:00:00Z', 60)], readers({ m1: ['lan', 'lan'] }))).toEqual([{ userId: 'lan', meetings: 1, minutes: 60 }]);
  });

  it('counts an overlap once but both meetings', () => {
    const figures = memberFigures([held('m1', 'lan', '2026-11-24T02:00:00Z', 60), held('m2', 'lan', '2026-11-24T02:30:00Z', 60)], readers({}));
    expect(figures).toEqual([{ userId: 'lan', meetings: 2, minutes: 90 }]);
  });

  it('counts nothing for a meeting with no length, and nobody when there is none', () => {
    expect(memberFigures([held('m1', 'lan', '2026-11-24T02:00:00Z', null)], readers({ m1: ['an'] }))).toEqual([]);
    expect(memberFigures([], readers({}))).toEqual([]);
  });
});

const meeting = (n: number, readerCount: number, published: boolean, minutes = 30, orgWide = false): SeriesMeeting => ({
  ...held(`m${n}`, 'lan', `2026-11-${String(10 + n).padStart(2, '0')}T02:00:00Z`, minutes),
  title: `Họp tuần ${n}`,
  orgWide,
  readers: readerCount,
  published,
});

describe('assessSeries', () => {
  it('has nothing to say about a series of fewer than three meetings', () => {
    expect(assessSeries('s1', [meeting(1, 0, false), meeting(2, 0, false)], [5, 5])).toBeNull();
  });

  it('has nothing to say about a healthy series', () => {
    expect(assessSeries('s1', [meeting(1, 3, true), meeting(2, 3, true), meeting(3, 3, true)], [0, 1])).toBeNull();
  });

  it('flags a series where nobody but the recorder is in half of the meetings or more', () => {
    const series = assessSeries('s1', [meeting(1, 0, true), meeting(2, 2, true), meeting(3, 0, true), meeting(4, 3, true)], [0, 0]);
    expect(series?.signals).toEqual(['few_people']);
    expect(series?.soloMeetings).toBe(2);
    expect(assessSeries('s1', [meeting(1, 0, true), meeting(2, 2, true), meeting(3, 2, true), meeting(4, 3, true)], [0, 0])).toBeNull();
  });

  it('never counts an org-wide meeting as one the recorder sat alone in, since it has no readers and who attended is unknown', () => {
    const orgWide = [1, 2, 3, 4].map((n) => meeting(n, 0, true, 30, true));
    expect(assessSeries('s1', orgWide, [0, 0])).toBeNull();
    const mixed = assessSeries('s1', [meeting(1, 0, true, 30, true), meeting(2, 0, true), meeting(3, 0, true, 30, true), meeting(4, 0, true)], [0, 0]);
    expect(mixed?.signals).toEqual(['few_people']);
    expect(mixed?.soloMeetings).toBe(2);
  });

  it('flags a series with published minutes in fewer than half of its meetings', () => {
    expect(assessSeries('s1', [meeting(1, 2, true), meeting(2, 2, false), meeting(3, 2, false)], [0, 0])?.signals).toEqual(['no_minutes']);
    expect(assessSeries('s1', [meeting(1, 2, true), meeting(2, 2, true), meeting(3, 2, false), meeting(4, 2, false)], [0, 0])).toBeNull();
  });

  it('flags open items piling up only when each of the last two meetings has three or more', () => {
    const meetings = [meeting(1, 2, true), meeting(2, 2, true), meeting(3, 2, true)];
    expect(assessSeries('s1', meetings, [3, 4])?.signals).toEqual(['items_piling']);
    expect(assessSeries('s1', meetings, [3, 2])).toBeNull();
    expect(assessSeries('s1', meetings, [2, 9])).toBeNull();
  });

  it('names the latest meeting and gives the figures, with every signal that holds', () => {
    const series = assessSeries('s1', [meeting(2, 0, false, 60), meeting(1, 0, false, 30), meeting(3, 0, false, 45)], [4, 3]);
    expect(series).toEqual({
      seriesId: 's1',
      latestMeetingId: 'm3',
      title: 'Họp tuần 3',
      meetings: 3,
      averageMinutes: 45,
      soloMeetings: 3,
      withMinutes: 0,
      openItems: [4, 3],
      signals: ['few_people', 'no_minutes', 'items_piling'],
    });
  });

  it('gives an average of 0 minutes when no meeting has a length', () => {
    const none = [1, 2, 3].map((n) => ({ ...meeting(n, 0, false), seconds: null }));
    expect(assessSeries('s1', none, [0, 0])?.averageMinutes).toBe(0);
  });
});
