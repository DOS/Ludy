// SPDX-License-Identifier: AGPL-3.0-only
// The pick of a Google Meet recording's Drive file (#3174, ADR-0025 amendment): only a Drive file id crosses the API, never a token, and only a Google Meet recording that is a video file alone needs one.
import { describe, expect, it } from 'vitest';
import { MEETING_PLATFORM_DRIVE_FILE_ID, MEETING_PLATFORM_ERROR_CODES, meetingPlatformNeedsPick, zMeetingPlatformRecordingPick } from '../src/index.ts';

const ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const FILE = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123456789';

describe('zMeetingPlatformRecordingPick', () => {
  it('takes a recording id and a Drive file id and nothing else, so no token field can ride along', () => {
    expect(zMeetingPlatformRecordingPick.parse({ recordingId: ID, fileId: FILE })).toEqual({ recordingId: ID, fileId: FILE });
    for (const extra of ['accessToken', 'token', 'oauthToken', 'credential']) expect(zMeetingPlatformRecordingPick.safeParse({ recordingId: ID, fileId: FILE, [extra]: 'ya29.x' }).success, extra).toBe(false);
    expect(Object.keys(zMeetingPlatformRecordingPick.shape).sort()).toEqual(['fileId', 'recordingId']);
  });

  it('refuses what is not a Drive file id: short, long, a path, a query, a space, a token-looking string with dots', () => {
    for (const fileId of ['', 'short', 'a'.repeat(129), '../../etc/passwd', `${FILE}?x=1`, `${FILE} `, 'ya29.a0AfH6SMBx-token.with.dots.here']) {
      expect(zMeetingPlatformRecordingPick.safeParse({ recordingId: ID, fileId }).success, fileId).toBe(false);
      expect(MEETING_PLATFORM_DRIVE_FILE_ID.test(fileId), fileId).toBe(false);
    }
  });
});

describe('meetingPlatformNeedsPick', () => {
  it('is true only for a Google Meet recording with a video file and neither audio nor a transcript', () => {
    expect(meetingPlatformNeedsPick('google_meet', { hasAudio: false, hasVideo: true, hasTranscript: false })).toBe(true);
    expect(meetingPlatformNeedsPick('google_meet', { hasAudio: false, hasVideo: false, hasTranscript: true })).toBe(false);
    expect(meetingPlatformNeedsPick('google_meet', { hasAudio: true, hasVideo: true, hasTranscript: false })).toBe(false);
    expect(meetingPlatformNeedsPick('google_meet', { hasAudio: false, hasVideo: true, hasTranscript: true })).toBe(false);
    for (const provider of ['zoom', 'microsoft_teams', 'sandbox']) expect(meetingPlatformNeedsPick(provider, { hasAudio: false, hasVideo: true, hasTranscript: false }), provider).toBe(false);
  });

  it('has its two failure codes among the codes the app words', () => {
    expect(MEETING_PLATFORM_ERROR_CODES).toEqual(expect.arrayContaining(['pick_missing', 'pick_mismatch']));
  });
});
