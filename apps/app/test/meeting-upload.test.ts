// SPDX-License-Identifier: AGPL-3.0-only
// A video chosen as a meeting's audio keeps only its audio (#3337): which files count as video, and the query the upload sends.
import { describe, expect, it } from 'vitest';
import { mediaUploadQuery, needsAudioExtraction } from '../src/lib/meeting-upload.ts';

describe('needsAudioExtraction', () => {
  it('is true for a video type or a video file name, in any case', () => {
    for (const file of [
      { type: 'video/mp4', name: 'zoom.mp4' },
      { type: 'video/quicktime', name: 'teams.mov' },
      { type: 'video/webm', name: 'rec' },
      { type: '', name: 'Zoom Meeting.MP4' },
      { type: 'application/octet-stream', name: 'call.MoV' },
      { type: '', name: 'clip.m4v' },
    ]) {
      expect(needsAudioExtraction(file), `${file.type} ${file.name}`).toBe(true);
    }
  });

  it('is false for audio, including audio in an MP4 container', () => {
    for (const file of [
      { type: 'audio/mpeg', name: 'a.mp3' },
      { type: 'audio/mp4', name: 'a.m4a' },
      { type: 'audio/mp4', name: 'a.mp4' },
      { type: '', name: 'a.m4a' },
      { type: 'audio/webm', name: 'a.webm' },
      { type: 'audio/ogg', name: 'a.ogg' },
      { type: '', name: 'notes.txt' },
    ]) {
      expect(needsAudioExtraction(file), `${file.type} ${file.name}`).toBe(false);
    }
  });
});

describe('mediaUploadQuery', () => {
  it('carries extract=audio only when asked', () => {
    expect(mediaUploadQuery({ kind: 'audio', extractAudio: true })).toBe('kind=audio&extract=audio');
    expect(mediaUploadQuery({ kind: 'audio', extractAudio: false })).toBe('kind=audio');
    expect(mediaUploadQuery({ kind: 'video' })).toBe('kind=video');
  });

  it('keeps the length and the stop reason in the query as before', () => {
    expect(mediaUploadQuery({ kind: 'audio', lengthSeconds: 90, stopReason: 'mic_lost' })).toBe('kind=audio&lengthSeconds=90&stopReason=mic_lost');
    expect(mediaUploadQuery({ kind: 'audio', lengthSeconds: 90, extractAudio: true })).toBe('kind=audio&lengthSeconds=90&extract=audio');
  });
});
