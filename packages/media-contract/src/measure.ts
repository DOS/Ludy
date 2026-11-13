// SPDX-License-Identifier: AGPL-3.0-only
// The narrow crove-media client of the kernel (#2985): the probe and the measure, nothing else. The kernel's upload and transcription
// paths import only this entry (`@crove/media-contract/measure`), so the code they reach has no normalize, split or process call; the full
// client (client.ts) stays for the worker's other uses and the evaluation.
import { MEDIA_LIMITS, zMediaProbeResult, type MediaProbeResult } from './types.ts';
import { createTransport, MediaClientError } from './transport.ts';

export { MEDIA_LIMITS, MediaClientError };
export type { MediaProbeResult };

export interface MediaMeasureClient {
  probe(bytes: Uint8Array, signal?: AbortSignal): Promise<MediaProbeResult>;
  // The same probe with the media sent as it is produced (a decrypting reader), so the caller never holds the file whole.
  probeStream(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<MediaProbeResult>;
  // The probe with the length read from the stream itself (the end of what it holds), not from what the container declares: the only length
  // a meter may charge. `measure` takes the bytes, `measureStream` the pieces as they are produced.
  measure(bytes: Uint8Array, signal?: AbortSignal): Promise<MediaProbeResult>;
  measureStream(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<MediaProbeResult>;
}

export function createMediaMeasureClient(baseUrl: string, options: { timeoutMs?: number } = {}): MediaMeasureClient {
  const { call } = createTransport(baseUrl, options);
  return {
    probe: (bytes, signal) => call('/probe', bytes, zMediaProbeResult, signal),
    probeStream: (chunks, signal) => call('/probe', chunks, zMediaProbeResult, signal),
    measure: (bytes, signal) => call('/measure', bytes, zMediaProbeResult, signal),
    measureStream: (chunks, signal) => call('/measure', chunks, zMediaProbeResult, signal),
  };
}
