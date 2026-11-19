// SPDX-License-Identifier: AGPL-3.0-only
// The facts the Meetings screens read from a platform recording (C1, #3173): what blocks an import, how often to look again, the words of a failure, what is claimed and when the dialog may submit.
import { describe, expect, it } from 'vitest';
import { IMPORT_CONSENT_NOTICE_VERSION, MEETING_PLATFORM_ERROR_CODES, MEETING_PLATFORM_IMPORT_MAX_BYTES, MEETING_PLATFORM_VIDEO_MAX_BYTES, TRANSCRIPT_SEGMENTS_MAX, type MeetingPlatformRecordingView } from '@crove/kernel-contract';
import { IMPORT_NOTICE } from '@crove/meeting-recorder';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { IMPORT_MAX_SECONDS, POLL_BUSY_MS, POLL_IDLE_MS, canRetry, canSubmitImport, errorKey, importBlock, isBenignClaimRefusal, isInFlight, isTranscriptImport, lengthParts, platformTranscript, pollMs, rowsToClaim } from '../src/lib/meeting-platform.ts';

const row = (over: Partial<MeetingPlatformRecordingView> = {}): MeetingPlatformRecordingView => ({
  id: 'r1',
  connectionId: 'c1',
  provider: 'sandbox',
  title: 'Họp khách A',
  startedAt: '2026-11-14T02:00:00.000Z',
  lengthSeconds: 1800,
  sizeBytes: 4096,
  hasAudio: true,
  hasVideo: false,
  hasTranscript: false,
  videoImportMaxBytes: null,
  status: 'suggested',
  meetingId: null,
  errorCode: null,
  ...over,
});

describe('importBlock', () => {
  it('lets an audio recording within 90 minutes and 300 MB through, and blocks the rest in words', () => {
    expect(importBlock(row())).toBeNull();
    expect(importBlock(row({ lengthSeconds: IMPORT_MAX_SECONDS, sizeBytes: MEETING_PLATFORM_IMPORT_MAX_BYTES }))).toBeNull();
    expect(importBlock(row({ lengthSeconds: null, sizeBytes: null }))).toBeNull();
    expect(importBlock(row({ hasAudio: false, hasVideo: true }))).toBe('video_only');
    // Where the deployment can take the audio out of a video file (C2a), a video-only recording is importable, under the video's own size cap; with nothing at all it still is not.
    expect(importBlock(row({ hasAudio: false, hasVideo: true, videoImportMaxBytes: MEETING_PLATFORM_VIDEO_MAX_BYTES }))).toBeNull();
    expect(importBlock(row({ hasAudio: false, hasVideo: true, videoImportMaxBytes: MEETING_PLATFORM_VIDEO_MAX_BYTES, sizeBytes: MEETING_PLATFORM_IMPORT_MAX_BYTES + 1 }))).toBeNull();
    expect(importBlock(row({ hasAudio: false, hasVideo: true, videoImportMaxBytes: MEETING_PLATFORM_VIDEO_MAX_BYTES, sizeBytes: MEETING_PLATFORM_VIDEO_MAX_BYTES + 1 }))).toBe('too_large');
    // A deployment whose media sandbox takes less than the product cap lowers it: 1 GiB here.
    expect(importBlock(row({ hasAudio: false, hasVideo: true, videoImportMaxBytes: 1024 ** 3, sizeBytes: 1024 ** 3 + 1 }))).toBe('too_large');
    expect(importBlock(row({ hasAudio: false, hasVideo: true, videoImportMaxBytes: 1024 ** 3, sizeBytes: 1024 ** 3 }))).toBeNull();
    expect(importBlock(row({ hasAudio: false, hasVideo: false, videoImportMaxBytes: MEETING_PLATFORM_VIDEO_MAX_BYTES }))).toBe('video_only');
    expect(importBlock(row({ hasAudio: true, hasVideo: true, videoImportMaxBytes: MEETING_PLATFORM_VIDEO_MAX_BYTES, sizeBytes: MEETING_PLATFORM_IMPORT_MAX_BYTES + 1 }))).toBe('too_large');
    expect(importBlock(row({ lengthSeconds: IMPORT_MAX_SECONDS + 1 }))).toBe('too_long');
    expect(importBlock(row({ sizeBytes: MEETING_PLATFORM_IMPORT_MAX_BYTES + 1 }))).toBe('too_large');
  });

  it('is 90 minutes', () => expect(IMPORT_MAX_SECONDS).toBe(5400));

  it('imports a recording that has only the platform\'s transcript when its provider has a transcript path (C2, #3174), with no length or size limit of Ludy\'s own', () => {
    const only = { hasAudio: false, hasVideo: false, hasTranscript: true } as const;
    for (const provider of ['sandbox', 'google_meet', 'microsoft_teams'] as const) {
      expect(isTranscriptImport(row({ ...only, provider }))).toBe(true);
      expect(importBlock(row({ ...only, provider, lengthSeconds: IMPORT_MAX_SECONDS * 4, sizeBytes: MEETING_PLATFORM_IMPORT_MAX_BYTES * 2 }))).toBeNull();
    }
    // Zoom has no transcript path: shown as such, not as "video only".
    expect(isTranscriptImport(row({ ...only, provider: 'zoom' }))).toBe(false);
    expect(importBlock(row({ ...only, provider: 'zoom' }))).toBe('transcript_only');
    // Any audio or video file wins over the transcript, and a row with no transcript is not one.
    expect(isTranscriptImport(row({ ...only, hasAudio: true }))).toBe(false);
    expect(isTranscriptImport(row({ ...only, hasVideo: true }))).toBe(false);
    expect(importBlock(row({ ...only, hasVideo: true }))).toBe('video_only');
    expect(isTranscriptImport(row({ hasAudio: false, hasVideo: false, hasTranscript: false }))).toBe(false);
    expect(importBlock(row({ hasAudio: false, hasVideo: false, hasTranscript: false }))).toBe('video_only');
  });
});

describe('polling', () => {
  it('reads every 5 seconds while a row is importing, staged or claimed, and every minute otherwise', () => {
    expect(pollMs(undefined)).toBe(POLL_IDLE_MS);
    expect(pollMs([])).toBe(POLL_IDLE_MS);
    for (const status of ['suggested', 'imported', 'failed', 'dismissed'] as const) expect(pollMs([row({ status })])).toBe(POLL_IDLE_MS);
    for (const status of ['importing', 'staged', 'claimed'] as const) {
      expect(isInFlight(status)).toBe(true);
      expect(pollMs([row({ status: 'imported' }), row({ id: 'r2', status })])).toBe(POLL_BUSY_MS);
    }
    expect(POLL_BUSY_MS).toBe(5_000);
    expect(POLL_IDLE_MS).toBe(60_000);
  });
});

describe('errorKey and canRetry', () => {
  it('knows every code of the server and falls back for a code it does not know', () => {
    for (const code of MEETING_PLATFORM_ERROR_CODES) expect(errorKey(code)).toBe(code);
    expect(errorKey('something_new')).toBe('unknown');
    expect(errorKey(null)).toBe('unknown');
  });

  it('offers a retry unless the same failure would come back', () => {
    expect(canRetry(row({ errorCode: 'download_failed' }))).toBe(true);
    expect(canRetry(row({ errorCode: 'not_claimed' }))).toBe(true);
    expect(canRetry(row({ errorCode: 'connection_expired' }))).toBe(true);
    for (const code of ['recording_gone', 'no_audio', 'no_transcript', 'too_large', 'too_long']) expect(canRetry(row({ errorCode: code }))).toBe(false);
    // A tenant administrator can fix these, so trying again can work.
    for (const code of ['transcripts_disabled', 'speakers_disabled']) expect(canRetry(row({ errorCode: code, hasAudio: false, hasTranscript: true }))).toBe(true);
    expect(canRetry(row({ errorCode: 'download_failed', hasAudio: false }))).toBe(false);
  });
});

describe('rowsToClaim', () => {
  it('picks the staged rows linked to a meeting that this page has not tried, and nothing else', () => {
    const rows = [
      row({ id: 'a', status: 'staged', meetingId: 'm1' }),
      row({ id: 'b', status: 'staged', meetingId: 'm2' }),
      row({ id: 'c', status: 'staged', meetingId: null }),
      row({ id: 'd', status: 'importing', meetingId: 'm4' }),
      row({ id: 'e', status: 'claimed', meetingId: 'm5' }),
      row({ id: 'f', status: 'imported', meetingId: 'm6' }),
    ];
    expect(rowsToClaim(rows, new Set())).toEqual([
      { id: 'a', meetingId: 'm1', transcript: false },
      { id: 'b', meetingId: 'm2', transcript: false },
    ]);
    expect(rowsToClaim(rows, new Set(['a']))).toEqual([{ id: 'b', meetingId: 'm2', transcript: false }]);
    // A transcript-only row is claimed through its own route (C2, #3174).
    expect(rowsToClaim([row({ id: 't', status: 'staged', meetingId: 'm7', hasAudio: false, hasTranscript: true })], new Set())).toEqual([{ id: 't', meetingId: 'm7', transcript: true }]);
    expect(rowsToClaim(undefined, new Set())).toEqual([]);
  });
});

describe('canSubmitImport and lengthParts', () => {
  it('needs the consent tick and a title, refuses a strict org, and waits while sending', () => {
    const ok = { consentTicked: true, title: 'Họp', strict: false, pending: false };
    expect(canSubmitImport(ok)).toBe(true);
    expect(canSubmitImport({ ...ok, consentTicked: false })).toBe(false);
    expect(canSubmitImport({ ...ok, title: '   ' })).toBe(false);
    expect(canSubmitImport({ ...ok, strict: true })).toBe(false);
    expect(canSubmitImport({ ...ok, pending: true })).toBe(false);
  });

  it('splits seconds into hours and minutes', () => {
    expect(lengthParts(30)).toEqual({ hours: 0, minutes: 1 });
    expect(lengthParts(10)).toEqual({ hours: 0, minutes: 0 });
    expect(lengthParts(3900)).toEqual({ hours: 1, minutes: 5 });
  });
});

describe('the words', () => {
  const flat = (tree: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? flat(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const text = (tree: Record<string, unknown>): string[] => Object.values(tree).flatMap((v) => (typeof v === 'object' && v !== null ? text(v as Record<string, unknown>) : [String(v)]));

  it('has the same keys in Vietnamese and English, and a sentence for every error code', () => {
    expect(flat(viMessages.meetings.platform).sort()).toEqual(flat(en.meetings.platform).sort());
    for (const code of MEETING_PLATFORM_ERROR_CODES) {
      expect(viMessages.meetings.platform.errors[code].length).toBeGreaterThan(10);
      expect(en.meetings.platform.errors[code].length).toBeGreaterThan(10);
    }
    expect(viMessages.meetings.platform.errors.unknown.length).toBeGreaterThan(10);
  });

  it('uses no em dash and keeps the Vietnamese consent line the product owner wrote', () => {
    for (const s of [...text(viMessages.meetings.platform), ...text(en.meetings.platform)]) expect(s).not.toContain('—');
    expect(viMessages.meetings.platform.dialog.consent).toBe('Nền tảng đã hiện thông báo ghi hình của chính họ cho mọi người trong cuộc họp, và tôi xác nhận điều đó.');
    expect(viMessages.meetings.platform.errors.not_claimed).toBe('Bản ghi tải xong nhưng chưa được nhận trong 55 phút, hãy nhập lại.');
    expect(viMessages.meetings.platform.recordings.videoOnly).toBe('Chỉ có bản hình, chưa nhập được');
  });

  it('shows the notice version the server accepts', () => {
    expect(IMPORT_NOTICE.version).toBe(IMPORT_CONSENT_NOTICE_VERSION);
  });
});

describe('isBenignClaimRefusal', () => {
  it('treats a row that moved on (another tab claimed it, no longer staged, not theirs) as no error, and anything else as one', () => {
    expect(isBenignClaimRefusal({ code: 'MEETING_PLATFORM_STATE', status: 409 })).toBe(true);
    expect(isBenignClaimRefusal({ code: 'MEETING_PLATFORM_NOT_FOUND', status: 404 })).toBe(true);
    for (const error of [{ code: 'MEDIA_PROBE_UNAVAILABLE', status: 503 }, { code: 'IMPORT_ONLY', status: 403 }, new TypeError('Failed to fetch'), new Error('x'), null, undefined, 'x']) expect(isBenignClaimRefusal(error)).toBe(false);
  });
});

describe('platformTranscript', () => {
  it('names the platform whose lines they are and says when the count is the draft\'s limit (#3922); null for Ludy\'s own', () => {
    const lines = (n: number, source: 'ludy' | 'google_meet' | 'microsoft_teams') => Array.from({ length: n }, () => ({ source }));
    expect(platformTranscript([])).toBeNull();
    expect(platformTranscript(lines(3, 'ludy'))).toBeNull();
    expect(platformTranscript(lines(5000, 'ludy'))).toBeNull();
    expect(platformTranscript(lines(3, 'google_meet'))).toEqual({ platform: 'google_meet', cut: false });
    expect(platformTranscript(lines(4999, 'microsoft_teams'))).toEqual({ platform: 'microsoft_teams', cut: false });
    expect(platformTranscript(lines(TRANSCRIPT_SEGMENTS_MAX, 'google_meet'))).toEqual({ platform: 'google_meet', cut: true });
  });
});
