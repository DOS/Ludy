// SPDX-License-Identifier: AGPL-3.0-only
// The audio extraction call of crove-media (#3337): a recording that may carry a video track goes in, mono Opus comes out. It is its own
// entry (`@crove/media-contract/extract`) on purpose: the kernel's measure-only entry (measure.ts) stays narrow, with no call that returns
// media, and only the one module that extracts audio from an uploaded video imports this one.
import { MEDIA_LIMITS, MEDIA_TIMING, zMediaNormalizeResult } from './types.ts';
import { createTransport, MediaClientError } from './transport.ts';

export { MEDIA_LIMITS, MEDIA_TIMING, MediaClientError };

export interface MediaExtractClient {
  // The recording is sent as it is produced, so the caller never holds a video whole. The answer is the extracted Opus (small: audio only)
  // and the length the sandbox measured in it.
  extractAudio(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<{ audio: Uint8Array; durationSeconds: number }>;
}

// Strict: only canonical base64 of at least one byte. Buffer.from alone skips bad characters and truncates silently, so the decoded bytes
// must encode back to exactly the text received.
function decodeAudio(value: string): Uint8Array {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new MediaClientError('internal_error', 200, 'crove-media returned audio that is not valid base64');
  }
  if (decoded.length === 0) {
    throw new MediaClientError('internal_error', 200, 'crove-media returned an empty audio result');
  }
  return new Uint8Array(decoded);
}

export function createMediaExtractClient(baseUrl: string, options: { timeoutMs?: number } = {}): MediaExtractClient {
  const { call } = createTransport(baseUrl, options);
  return {
    async extractAudio(source, signal) {
      const result = await call('/extract-audio', source, zMediaNormalizeResult, signal);
      return { audio: decodeAudio(result.audioBase64), durationSeconds: result.durationSeconds };
    },
  };
}
