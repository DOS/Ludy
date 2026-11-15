// SPDX-License-Identifier: AGPL-3.0-only
// A video file chosen in the audio field of the meeting form (a local Zoom or Teams MP4) keeps only its audio (#3337): the upload asks the server to
// extract it with `extract=audio`, and the video is never stored. Pure helpers, so the rule and the request's query are tested without a browser.
import type { RecordingStopReason } from '@crove/meeting-recorder';

const VIDEO_NAME = /\.(?:mp4|mov|m4v)$/i;

// A video by its type or its name. An audio type (audio/mp4, .m4a) is never one: its audio is uploaded as it is.
export function needsAudioExtraction(file: { type: string; name: string }): boolean {
  if (/^audio\//i.test(file.type)) return false;
  return /^video\//i.test(file.type) || VIDEO_NAME.test(file.name);
}

// The query of the raw-body upload: the kind and the length go in it, because the body is only the file.
export function mediaUploadQuery(input: { kind: 'audio' | 'video'; lengthSeconds?: number; stopReason?: RecordingStopReason; extractAudio?: boolean }): string {
  const query = new URLSearchParams({ kind: input.kind });
  if (input.lengthSeconds !== undefined) query.set('lengthSeconds', String(input.lengthSeconds));
  if (input.stopReason) query.set('stopReason', input.stopReason);
  if (input.extractAudio) query.set('extract', 'audio');
  return query.toString();
}
