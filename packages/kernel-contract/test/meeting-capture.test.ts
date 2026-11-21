// SPDX-License-Identifier: AGPL-3.0-only
// Which call a join address names (ADR-0055 slice 1, #4123): the same call under every spelling of its address, and nothing guessed for an address that is not a meeting's.
import { describe, expect, it } from 'vitest';
import { CAPTURE_HEARTBEAT_SECONDS, CAPTURE_LOST_SECONDS, captureCallOf, zCaptureHeartbeat, zCaptureRunning, zCaptureStart } from '../src/index.ts';

describe('captureCallOf', () => {
  it('reads a Google Meet code, in any case and with a query or a trailing slash', () => {
    const call = { platform: 'google_meet', id: 'abc-defg-hij' };
    expect(captureCallOf('https://meet.google.com/abc-defg-hij')).toEqual(call);
    expect(captureCallOf('https://meet.google.com/ABC-defg-HIJ/')).toEqual(call);
    expect(captureCallOf('https://meet.google.com/abc-defg-hij?authuser=1&hs=179')).toEqual(call);
    expect(captureCallOf('  https://MEET.google.com/abc-defg-hij  ')).toEqual(call);
  });

  it('reads a Zoom meeting number from /j/ and the web client, on zoom.us and a company subdomain, and ignores the password', () => {
    const call = { platform: 'zoom', id: '81234567890' };
    expect(captureCallOf('https://zoom.us/j/81234567890')).toEqual(call);
    expect(captureCallOf('https://us02web.zoom.us/j/81234567890?pwd=abcDEF123')).toEqual(call);
    expect(captureCallOf('https://congty.zoom.us/wc/join/81234567890')).toEqual(call);
  });

  it('reads a Teams thread and the short meet address', () => {
    const thread = '19:meeting_nzk1ytqzmjmtmgfhzs00zdq1lthhyzmtnzu3mdixyzfmnmvk@thread.v2';
    expect(captureCallOf(`https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(thread)}/0?context=%7b%22Tid%22%3a%22x%22%7d`)).toEqual({ platform: 'microsoft_teams', id: thread });
    expect(captureCallOf(`https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(thread.toUpperCase())}/0`)).toEqual({ platform: 'microsoft_teams', id: thread });
    expect(captureCallOf('https://teams.microsoft.com/meet/123456789012?p=abc')).toEqual({ platform: 'microsoft_teams', id: '123456789012' });
  });

  it('names no call for an address that is not one: another host, a lookalike host, http, a path that is not a meeting, credentials in the address, or text that is no address', () => {
    for (const url of [
      'https://calendar.google.com/calendar/event?eid=abc',
      'https://meet.google.com/landing',
      'https://meet.google.com/lookup/abcdefg',
      'https://meet.google.com.evil.example/abc-defg-hij',
      'https://evilmeet.google.com/abc-defg-hij',
      'http://meet.google.com/abc-defg-hij',
      'https://user:pw@meet.google.com/abc-defg-hij',
      'https://zoom.us/j/123',
      'https://zoom.us/my/linh.nguyen',
      'https://notzoom.us/j/81234567890',
      'https://teams.microsoft.com/l/meetup-join/not-a-thread/0',
      'https://teams.microsoft.com/l/meetup-join/%E0%A4%A/0',
      'https://example.com/abc-defg-hij',
      'meet.google.com/abc-defg-hij',
      'not an address',
      '',
    ]) {
      expect(captureCallOf(url), url).toBeNull();
    }
  });
});

describe('the capture shapes', () => {
  it('keeps the heartbeat shorter than the time after which a capture is lost, with room for two missed beats', () => {
    expect(CAPTURE_HEARTBEAT_SECONDS * 3).toBeLessThanOrEqual(CAPTURE_LOST_SECONDS);
  });

  it('takes an optional calendar event and join address, and nothing else', () => {
    expect(zCaptureStart.parse({})).toEqual({});
    expect(zCaptureStart.parse({ agendaId: '0195f2b0-0000-7000-8000-000000000001', joinUrl: 'https://zoom.us/j/81234567890' })).toBeTruthy();
    expect(() => zCaptureStart.parse({ kind: 'app' })).toThrow();
    expect(() => zCaptureStart.parse({ joinUrl: 'x'.repeat(501) })).toThrow();
  });

  it('takes a meeting for the heartbeat, and refuses with a kind and a time only', () => {
    expect(() => zCaptureHeartbeat.parse({})).toThrow();
    expect(zCaptureHeartbeat.parse({ meetingId: '0195f2b0-0000-7000-8000-000000000001', end: true })).toEqual({ meetingId: '0195f2b0-0000-7000-8000-000000000001', end: true });
    expect(() => zCaptureHeartbeat.parse({ meetingId: '0195f2b0-0000-7000-8000-000000000001', end: 'yes' })).toThrow();
    expect(zCaptureRunning.parse({ kind: 'extension', since: '2027-01-20T07:02:00.000Z' })).toEqual({ kind: 'extension', since: '2027-01-20T07:02:00.000Z' });
    expect(() => zCaptureRunning.parse({ kind: 'extension', since: 'x', userId: 'u' })).toThrow();
    expect(() => zCaptureRunning.parse({ kind: 'bot', since: 'x' })).toThrow();
  });
});
