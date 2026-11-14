// SPDX-License-Identifier: AGPL-3.0-only
// The recording notice kit (Meetings A1, #3159): fixed text, a version, the meeting's language as the default.
import { describe, expect, it } from 'vitest';
import { beginRecording, isRecordingStopReason, noticeLanguageFor, noticeToCopy, otherNoticeLanguage, RECORDING_NOTICE, stopReasonForUpload, type ChunkStore, type RecordingMeta } from '../src/index.ts';

describe('recording notice kit', () => {
  it('has a Vietnamese and an English text, a version, and says it awaits the lawyer (#2585)', () => {
    expect(RECORDING_NOTICE.version).toMatch(/^\d{4}-\d{2}-v\d+$/);
    expect(RECORDING_NOTICE.reviewed).toBe(false);
    expect(RECORDING_NOTICE.reviewIssue).toBe(2585);
    expect(RECORDING_NOTICE.text.vi).toContain('ghi âm');
    expect(RECORDING_NOTICE.text.en).toContain('recorded');
  });

  it('defaults to the meeting language, Vietnamese when unknown or automatic', () => {
    expect(noticeLanguageFor('en')).toBe('en');
    expect(noticeLanguageFor('vi')).toBe('vi');
    expect(noticeLanguageFor('auto')).toBe('vi');
    expect(otherNoticeLanguage('vi')).toBe('en');
    expect(otherNoticeLanguage('en')).toBe('vi');
  });

  it('copies the text together with the version that is stored on the meeting', () => {
    expect(noticeToCopy('vi')).toEqual({ text: RECORDING_NOTICE.text.vi, version: RECORDING_NOTICE.version });
    expect(noticeToCopy('en').version).toBe(RECORDING_NOTICE.version);
  });

  it('has no em dash and no markup in either text', () => {
    for (const text of Object.values(RECORDING_NOTICE.text)) {
      expect(text).not.toMatch(/—|<|>/);
    }
  });
});

describe('how a recording ended (A1, #3159)', () => {
  const store = (): ChunkStore & { saved: RecordingMeta[] } => {
    const saved: RecordingMeta[] = [];
    return { saved, put: async (m) => void saved.push(m), append: async () => undefined, list: async () => [], chunks: async () => [], remove: async () => undefined };
  };
  const base = { id: 'r1', scope: 'org:user', meetingId: 'm1', title: 'Họp', kind: 'audio' as const, mimeType: 'audio/webm', startedAt: 1 };

  it('sends no reason for a stop the recorder asked for, the code for one that ended by itself, and "unknown" for one nobody saw end', () => {
    expect(stopReasonForUpload({ stopped: 'user' })).toBeUndefined();
    expect(stopReasonForUpload({ stopped: 'tab_closed' })).toBe('tab_closed');
    expect(stopReasonForUpload({})).toBe('unknown');
  });

  it('keeps the first word on how it ended and saves it with the recording', async () => {
    const s = store();
    const writer = await beginRecording(s, base);
    await writer.markStopped('mic_lost');
    await writer.markStopped('user');
    expect(writer.meta().stopped).toBe('mic_lost');
    expect(s.saved.at(-1)?.stopped).toBe('mic_lost');
  });

  it('knows its codes', () => {
    expect(isRecordingStopReason('left_screen')).toBe(true);
    expect(isRecordingStopReason('because')).toBe(false);
    expect(isRecordingStopReason(undefined)).toBe(false);
  });
});
