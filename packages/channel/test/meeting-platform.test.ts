// SPDX-License-Identifier: AGPL-3.0-only
// The meeting platform adapter interface and its offline sandbox (meetings integrations C1, #3173); no network.
import { describe, expect, it } from 'vitest';
import { MeetingPlatformError, SandboxMeetingPlatform, meetingPlatformAdapters, minimalMp4, silentWav, type MeetingPlatformCredential } from '../src/index.ts';

const CREDENTIAL: MeetingPlatformCredential = { accessToken: 'sandbox-token-not-real-0001', refreshToken: 'sandbox-refresh-not-real-0001' };
const NOW = new Date('2026-11-15T12:00:00Z');
const HOUR = 3_600_000;

function rec(id: string, hoursAgo: number, over: Partial<Parameters<SandboxMeetingPlatform['add']>[0]> = {}) {
  return { id, title: `Meeting ${id}`, startedAt: new Date(NOW.getTime() - hoursAgo * HOUR), lengthSeconds: 60, hasAudio: true, hasVideo: false, hasTranscript: false, audio: silentWav(), ...over };
}

describe('silentWav', () => {
  it('is a valid mono 8 kHz 16-bit PCM WAV of 2 seconds with consistent sizes', () => {
    const wav = silentWav();
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const text = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(16000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(wav.byteLength - 44);
    expect(view.getUint32(40, true)).toBe(2 * 8000 * 2);
    expect(wav.subarray(44).every((b) => b === 0)).toBe(true);
  });
});

describe('minimalMp4', () => {
  it('starts with an ftyp box the container sniff accepts', () => {
    const mp4 = minimalMp4();
    expect(String.fromCharCode(...mp4.subarray(4, 12))).toBe('ftypisom');
  });
});

describe('SandboxMeetingPlatform', () => {
  it('seeds one audio and one video-only recording', async () => {
    const sandbox = new SandboxMeetingPlatform({ now: () => NOW });
    const listed = await sandbox.list(CREDENTIAL, new Date(NOW.getTime() - 14 * 24 * HOUR));
    expect(listed.map((r) => [r.id, r.hasAudio, r.hasVideo])).toEqual([
      ['sandbox-rec-audio', true, false],
      ['sandbox-rec-video', false, true],
    ]);
    const audio = await sandbox.prepareDownload(CREDENTIAL, 'sandbox-rec-audio', 'audio');
    expect(audio.inline?.bytes).toEqual(silentWav());
    const video = await sandbox.prepareDownload(CREDENTIAL, 'sandbox-rec-video', 'video');
    expect(String.fromCharCode(...(video.inline?.bytes.subarray(4, 12) ?? []))).toBe('ftypisom');
  });

  it('lists only recordings started at or after `since`, newest first', async () => {
    const sandbox = new SandboxMeetingPlatform({ seed: false });
    sandbox.add(rec('old', 100));
    sandbox.add(rec('mid', 10));
    sandbox.add(rec('new', 1));
    const listed = await sandbox.list(CREDENTIAL, new Date(NOW.getTime() - 10 * HOUR));
    expect(listed.map((r) => r.id)).toEqual(['new', 'mid']);
    expect(listed[0]).toMatchObject({ title: 'Meeting new', startedAt: '2026-11-15T11:00:00.000Z', lengthSeconds: 60, hasAudio: true, hasVideo: false, hasTranscript: false });
    expect(listed[0]?.sizeBytes).toBe(silentWav().byteLength);
  });

  it('caps the list at 100', async () => {
    const sandbox = new SandboxMeetingPlatform({ seed: false });
    for (let i = 0; i < 130; i++) sandbox.add(rec(`r${i}`, i + 1, { audio: undefined, hasAudio: false }));
    const listed = await sandbox.list(CREDENTIAL, new Date(NOW.getTime() - 1000 * HOUR));
    expect(listed).toHaveLength(100);
    expect(listed[0]?.id).toBe('r0');
    expect(listed[99]?.id).toBe('r99');
  });

  it('describes an inline download for audio and for video, with no host', async () => {
    const sandbox = new SandboxMeetingPlatform({ seed: false });
    const video = minimalMp4();
    sandbox.add(rec('both', 1, { hasVideo: true, video }));
    const audio = await sandbox.prepareDownload(CREDENTIAL, 'both', 'audio');
    expect(audio).toMatchObject({ url: 'sandbox://local/both', format: 'audio', contentType: 'audio/wav', hosts: [], hostSuffixes: [], headers: {} });
    expect(audio.inline?.bytes).toEqual(silentWav());
    expect(audio.sizeBytes).toBe(silentWav().byteLength);
    const v = await sandbox.prepareDownload(CREDENTIAL, 'both', 'video');
    expect(v).toMatchObject({ format: 'video', contentType: 'video/mp4' });
    expect(v.inline).toEqual({ bytes: video, contentType: 'video/mp4' });
  });

  it('refuses an audio download of a video-only recording with no_audio', async () => {
    const sandbox = new SandboxMeetingPlatform({ seed: false });
    sandbox.add(rec('vid', 1, { hasAudio: false, audio: undefined, hasVideo: true, video: minimalMp4() }));
    const error = await sandbox.prepareDownload(CREDENTIAL, 'vid', 'audio').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeetingPlatformError);
    expect((error as MeetingPlatformError).code).toBe('no_audio');
  });

  it('refuses a video download of an audio-only recording', async () => {
    const sandbox = new SandboxMeetingPlatform({ seed: false });
    sandbox.add(rec('aud', 1));
    const error = await sandbox.prepareDownload(CREDENTIAL, 'aud', 'video').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeetingPlatformError);
    expect((error as MeetingPlatformError).code).toBe('platform_refused');
  });

  it('hands over the transcript of a recording that has one (labelled like Google Meet\'s), copies it, and says no_transcript or recording_gone otherwise (C2, #3174)', async () => {
    const sandbox = new SandboxMeetingPlatform({ seed: false });
    const entries = [{ startSeconds: 1, endSeconds: 3, speaker: 'Lan', text: 'Xin chào.' }];
    sandbox.add(rec('with-text', 1, { hasAudio: false, audio: undefined, hasTranscript: true, transcript: entries }));
    sandbox.add(rec('without', 2));
    const got = await sandbox.transcript(CREDENTIAL, 'with-text');
    expect(got).toEqual({ source: 'google_meet', language: null, truncated: false, entries });
    // A copy: a caller that changes it does not change the fixture.
    got.entries[0]!.text = 'đã sửa';
    expect((await sandbox.transcript(CREDENTIAL, 'with-text')).entries[0]?.text).toBe('Xin chào.');
    await expect(sandbox.transcript(CREDENTIAL, 'without')).rejects.toMatchObject({ code: 'no_transcript' });
    await expect(sandbox.transcript(CREDENTIAL, 'nope')).rejects.toMatchObject({ code: 'recording_gone' });
    // The list says what the recording offers.
    expect((await sandbox.list(CREDENTIAL, new Date(0))).find((r) => r.id === 'with-text')).toMatchObject({ hasAudio: false, hasVideo: false, hasTranscript: true });
  });

  it('answers recording_gone for an unknown id', async () => {
    const sandbox = new SandboxMeetingPlatform();
    const error = await sandbox.prepareDownload(CREDENTIAL, 'nope', 'audio').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeetingPlatformError);
    expect((error as MeetingPlatformError).code).toBe('recording_gone');
  });

  it('never puts a token in an error message', async () => {
    const sandbox = new SandboxMeetingPlatform({ seed: false });
    sandbox.add(rec('vid', 1, { hasAudio: false, audio: undefined, hasVideo: true, video: minimalMp4() }));
    const errors: unknown[] = [];
    errors.push(await sandbox.prepareDownload(CREDENTIAL, 'vid', 'audio').catch((e: unknown) => e));
    errors.push(await sandbox.prepareDownload(CREDENTIAL, 'missing', 'video').catch((e: unknown) => e));
    errors.push(await sandbox.prepareDownload(CREDENTIAL, 'vid', 'audio').catch((e: unknown) => e));
    for (const error of errors) {
      const message = (error as MeetingPlatformError).message;
      expect(message).not.toContain(CREDENTIAL.accessToken);
      expect(message).not.toContain(CREDENTIAL.refreshToken ?? 'x');
    }
  });
});

describe('MeetingPlatformError', () => {
  it('carries its code and defaults the message to it', () => {
    const error = new MeetingPlatformError('connection_expired');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('connection_expired');
    expect(error.message).toBe('connection_expired');
  });
});

describe('meetingPlatformAdapters', () => {
  it('has only the sandbox in C1', () => {
    const adapters = meetingPlatformAdapters({});
    expect(Object.keys(adapters)).toEqual(['sandbox']);
    expect(adapters.sandbox?.provider).toBe('sandbox');
    expect(adapters.google_meet).toBeUndefined();
    expect(adapters.zoom).toBeUndefined();
    expect(adapters.microsoft_teams).toBeUndefined();
  });

  it('is empty when the sandbox is off', () => {
    expect(Object.keys(meetingPlatformAdapters({ sandbox: false }))).toEqual([]);
  });

  it('uses a shared sandbox store when given one', async () => {
    const store = new SandboxMeetingPlatform({ seed: false });
    expect(meetingPlatformAdapters({ sandboxPlatform: store }).sandbox).toBe(store);
  });
});
