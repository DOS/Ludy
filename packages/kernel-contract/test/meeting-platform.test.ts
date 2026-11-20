// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { AGENDA_OVERLAP_MINUTES, meetingOverlapWindow, zMeetingPlatformRecordingView } from '../src/index.ts';

describe('meetingOverlapWindow', () => {
  it('pads startedAt and endedAt by 15 minutes (using lengthSeconds when endedAt is missing)', () => {
    const startedAt = new Date('2026-11-20T09:00:00.000Z');
    const endedAt = new Date('2026-11-20T09:45:00.000Z');
    expect(AGENDA_OVERLAP_MINUTES).toBe(15);

    const withEnd = meetingOverlapWindow({ startedAt, endedAt, lengthSeconds: 60 });
    expect(withEnd.startedAt.toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(withEnd.endedAt.toISOString()).toBe('2026-11-20T09:45:00.000Z');
    expect(withEnd.windowStart.toISOString()).toBe('2026-11-20T08:45:00.000Z');
    expect(withEnd.windowEnd.toISOString()).toBe('2026-11-20T10:00:00.000Z');

    const withLength = meetingOverlapWindow({ startedAt, lengthSeconds: 1800 });
    expect(withLength.endedAt.toISOString()).toBe('2026-11-20T09:30:00.000Z');
    expect(withLength.windowStart.toISOString()).toBe('2026-11-20T08:45:00.000Z');
    expect(withLength.windowEnd.toISOString()).toBe('2026-11-20T09:45:00.000Z');

    const point = meetingOverlapWindow({ startedAt, lengthSeconds: null });
    expect(point.endedAt.toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(point.windowStart.toISOString()).toBe('2026-11-20T08:45:00.000Z');
    expect(point.windowEnd.toISOString()).toBe('2026-11-20T09:15:00.000Z');
  });

  it('clamps inverted endedAt to startedAt so the window never inverts', () => {
    const startedAt = new Date('2026-11-20T09:00:00.000Z');
    const earlierEnd = new Date('2026-11-20T08:30:00.000Z');
    const clamped = meetingOverlapWindow({ startedAt, endedAt: earlierEnd });
    expect(clamped.endedAt.toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(clamped.windowStart.toISOString()).toBe('2026-11-20T08:45:00.000Z');
    expect(clamped.windowEnd.toISOString()).toBe('2026-11-20T09:15:00.000Z');
  });
});

describe('zMeetingPlatformRecordingView', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    connectionId: '22222222-2222-4222-8222-222222222222',
    provider: 'zoom' as const,
    title: 'Weekly sync',
    startedAt: '2026-11-20T09:00:00.000Z',
    lengthSeconds: 1800,
    sizeBytes: 1024,
    hasAudio: true,
    hasVideo: false,
    hasTranscript: false,
    videoImportMaxBytes: null,
    status: 'suggested' as const,
    meetingId: null,
    errorCode: null,
  };

  it('allows null or a strict minimal { meetingId } match reference without extra fields', () => {
    expect(zMeetingPlatformRecordingView.parse({ ...base, matchedMeeting: null }).matchedMeeting).toBeNull();
    const meetingId = '33333333-3333-4333-8333-333333333333';
    expect(zMeetingPlatformRecordingView.parse({ ...base, matchedMeeting: { meetingId } }).matchedMeeting).toEqual({ meetingId });
    expect(() => zMeetingPlatformRecordingView.parse({ ...base, matchedMeeting: { meetingId, title: 'Secret' } })).toThrow();
  });
});
