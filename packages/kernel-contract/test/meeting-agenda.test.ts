// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  AGENDA_UPCOMING_DAYS,
  MEETING_PLATFORMS,
  joinServiceFromUrl,
  safeJoinUrl,
  zAgendaListInput,
  zMeetingPlatform,
  zMeetingSummary,
} from '../src/index.ts';

describe('meeting-agenda contracts (#4477)', () => {
  it('exposes AGENDA_UPCOMING_DAYS and MEETING_PLATFORMS', () => {
    expect(AGENDA_UPCOMING_DAYS).toBe(7);
    expect(MEETING_PLATFORMS).toEqual(['meet', 'zoom', 'teams']);
    expect(zMeetingPlatform.options).toEqual(['meet', 'zoom', 'teams']);
  });

  it('recognizes only https Meet, Zoom, and Teams join URLs', () => {
    expect(joinServiceFromUrl('https://meet.google.com/abc-defg-hij')).toBe('meet');
    expect(joinServiceFromUrl('  https://zoom.us/j/12345  ')).toBe('zoom');
    expect(joinServiceFromUrl('https://us02web.zoom.us/j/12345?pwd=xyz')).toBe('zoom');
    expect(joinServiceFromUrl('https://teams.microsoft.com/l/meetup-join/1')).toBe('teams');
    expect(joinServiceFromUrl('https://teams.live.com/meet/123')).toBe('teams');

    expect(joinServiceFromUrl('http://meet.google.com/abc-defg-hij')).toBeNull();
    expect(joinServiceFromUrl('javascript:alert(1)')).toBeNull();
    expect(joinServiceFromUrl('https://evil.example/meet.google.com')).toBeNull();
    expect(joinServiceFromUrl('https://user:pass@meet.google.com/abc-defg-hij')).toBeNull();
    expect(joinServiceFromUrl('https://meet.google.com:8443/abc')).toBeNull();
    expect(joinServiceFromUrl('https://.zoom.us/j/1')).toBeNull();
    expect(joinServiceFromUrl('https://a..zoom.us/j/1')).toBeNull();
    expect(joinServiceFromUrl('https://foo..bar.zoom.us/j/1')).toBeNull();
    expect(joinServiceFromUrl('https://notzoom.us/j/1')).toBeNull();
    expect(joinServiceFromUrl('https://fake-teams.microsoft.com/x')).toBeNull();
    expect(joinServiceFromUrl('not-a-url')).toBeNull();
    expect(joinServiceFromUrl('')).toBeNull();
    expect(joinServiceFromUrl(null)).toBeNull();
  });

  it('returns canonical href from safeJoinUrl iff joinServiceFromUrl matches', () => {
    expect(safeJoinUrl('  https://meet.google.com/abc-defg-hij  ')).toBe('https://meet.google.com/abc-defg-hij');
    expect(safeJoinUrl('https://MEET.GOOGLE.COM/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    expect(safeJoinUrl('https://us02web.zoom.us/j/999')).toBe('https://us02web.zoom.us/j/999');
    expect(safeJoinUrl('https://meet.google.com:8443/abc')).toBeNull();
    expect(safeJoinUrl('https://a..zoom.us/j/1')).toBeNull();
    expect(safeJoinUrl('https://foo..bar.zoom.us/j/1')).toBeNull();
    expect(safeJoinUrl('http://zoom.us/j/999')).toBeNull();
    expect(safeJoinUrl('javascript:alert(1)')).toBeNull();
    expect(safeJoinUrl('https://evil.example/zoom.us')).toBeNull();
    expect(safeJoinUrl('   ')).toBeNull();
    expect(safeJoinUrl(null)).toBeNull();
  });

  it('accepts optional range on zAgendaListInput and rejects unknown keys', () => {
    expect(zAgendaListInput.safeParse({}).success).toBe(true);
    expect(zAgendaListInput.safeParse({ range: 'today' }).success).toBe(true);
    expect(zAgendaListInput.safeParse({ range: 'upcoming' }).success).toBe(true);
    expect(zAgendaListInput.safeParse({ range: 'month' }).success).toBe(false);
    expect(zAgendaListInput.safeParse({ extra: true }).success).toBe(false);
  });

  it('requires hasTranscript and platform on zMeetingSummary', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Weekly sync',
      language: 'vi',
      visibility: 'attendees',
      status: 'ready',
      recorderUserId: '22222222-2222-4222-8222-222222222222',
      startedAt: '2026-11-23T02:00:00.000Z',
      endedAt: null,
      lengthSeconds: 1800,
      keepVideo: false,
      liveNotes: false,
      summaryTemplate: 'general',
      place: null,
      audioRetentionDate: '2026-12-23',
      textRetentionDate: null,
      hasAudio: true,
      hasVideo: false,
      hasTranscript: true,
      platform: 'meet',
      readersCount: 2,
      createdAt: '2026-11-23T02:00:00.000Z',
      updatedAt: '2026-11-23T02:00:00.000Z',
    };
    expect(zMeetingSummary.safeParse(base).success).toBe(true);
    expect(zMeetingSummary.safeParse({ ...base, platform: null, hasTranscript: false }).success).toBe(true);
    expect(zMeetingSummary.safeParse({ ...base, platform: 'webex' }).success).toBe(false);
  });
});
