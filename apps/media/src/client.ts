// SPDX-License-Identifier: AGPL-3.0-only
// Client for calling the crove-media HTTP service.
// Used by worker tasks (AI Meeting Notes M4, #2578) and test harnesses. The kernel's upload and transcription paths use the narrow
// client of @crove/media-contract (measure.ts) instead and ship none of the normalize, split or repackage calls (#2985).
import {
  MEDIA_LIMITS,
  zMediaErrorResponse,
  zMediaNormalizeResult,
  zMediaProbeResult,
  zMediaProcessResult,
  zMediaSplitResult,
  type MediaNormalizeResult,
  type MediaProbeResult,
  type MediaProcessResult,
  type MediaSplitResult,
} from '@crove/media-contract/types';
import { createTransport, MediaClientError } from '@crove/media-contract/transport';

export { MediaClientError };

export interface MediaClient {
  probe(bytes: Uint8Array, signal?: AbortSignal): Promise<MediaProbeResult>;
  // The same probe with the media sent as it is produced (a decrypting reader), so the caller never holds the file whole.
  probeStream(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<MediaProbeResult>;
  // The probe with the length read from the stream itself (the end of what it holds), not from what the container declares: the only length
  // a meter may charge (#2985). `measure` takes the bytes, `measureStream` the pieces as they are produced.
  measure(bytes: Uint8Array, signal?: AbortSignal): Promise<MediaProbeResult>;
  measureStream(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<MediaProbeResult>;
  normalize(bytes: Uint8Array, options?: { bitrateKbps?: number }, signal?: AbortSignal): Promise<MediaNormalizeResult>;
  split(bytes: Uint8Array, options?: { maxSegmentSeconds?: number; bitrateKbps?: number }, signal?: AbortSignal): Promise<MediaSplitResult>;
  repackageVideo(bytes: Uint8Array, options?: { dropAudio?: boolean }, signal?: AbortSignal): Promise<Uint8Array>;
  process(
    bytes: Uint8Array,
    options?: { maxSegmentSeconds?: number; bitrateKbps?: number },
    signal?: AbortSignal,
  ): Promise<MediaProcessResult>;
}

export function createMediaClient(baseUrl: string, options: { timeoutMs?: number } = {}): MediaClient {
  const { base, callTimeoutMs, readBoundedText, call } = createTransport(baseUrl, options);

  return {
    async probe(bytes: Uint8Array, signal?: AbortSignal): Promise<MediaProbeResult> {
      return call('/probe', bytes, zMediaProbeResult, signal);
    },

    async probeStream(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<MediaProbeResult> {
      return call('/probe', chunks, zMediaProbeResult, signal);
    },

    async measure(bytes: Uint8Array, signal?: AbortSignal): Promise<MediaProbeResult> {
      return call('/measure', bytes, zMediaProbeResult, signal);
    },

    async measureStream(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<MediaProbeResult> {
      return call('/measure', chunks, zMediaProbeResult, signal);
    },

    async normalize(bytes: Uint8Array, options?: { bitrateKbps?: number }, signal?: AbortSignal): Promise<MediaNormalizeResult> {
      const q = options?.bitrateKbps ? `?bitrate_kbps=${options.bitrateKbps}` : '';
      return call(`/normalize${q}`, bytes, zMediaNormalizeResult, signal);
    },

    async split(
      bytes: Uint8Array,
      options?: { maxSegmentSeconds?: number; bitrateKbps?: number },
      signal?: AbortSignal,
    ): Promise<MediaSplitResult> {
      const params = new URLSearchParams();
      if (options?.maxSegmentSeconds) params.set('max_segment_seconds', String(options.maxSegmentSeconds));
      if (options?.bitrateKbps) params.set('bitrate_kbps', String(options.bitrateKbps));
      const q = params.toString() ? `?${params.toString()}` : '';
      return call(`/split${q}`, bytes, zMediaSplitResult, signal);
    },

    async repackageVideo(
      bytes: Uint8Array,
      options?: { dropAudio?: boolean },
      signal?: AbortSignal,
    ): Promise<Uint8Array> {
      const q = options?.dropAudio !== undefined ? `?drop_audio=${options.dropAudio}` : '';
      const url = `${base}/repackage-video${q}`;
      const init: RequestInit = {
        method: 'POST',
        body: bytes as unknown as NonNullable<RequestInit['body']>,
        headers: {
          'content-type': 'application/octet-stream',
        },
        redirect: 'error',
      };
      init.signal = signal ?? AbortSignal.timeout(callTimeoutMs);
      const response = await fetch(url, init);

      if (!response.ok) {
        const text = await readBoundedText(response, 64 * 1024);
        try {
          const json = JSON.parse(text);
          const errorParsed = zMediaErrorResponse.safeParse(json);
          if (errorParsed.success) {
            throw new MediaClientError(errorParsed.data.code, response.status, errorParsed.data.error);
          }
        } catch (e) {
          if (e instanceof MediaClientError) throw e;
        }
        throw new MediaClientError('internal_error', response.status, `crove-media request failed with HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array(0);
      let total = 0;
      const chunks: Uint8Array[] = [];
      const maxBytes = MEDIA_LIMITS.maxVideoBytes;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new MediaClientError('too_large', response.status, 'Repackaged video exceeds size limit');
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },

    async process(
      bytes: Uint8Array,
      options?: { maxSegmentSeconds?: number; bitrateKbps?: number },
      signal?: AbortSignal,
    ): Promise<MediaProcessResult> {
      const params = new URLSearchParams();
      if (options?.maxSegmentSeconds) params.set('max_segment_seconds', String(options.maxSegmentSeconds));
      if (options?.bitrateKbps) params.set('bitrate_kbps', String(options.bitrateKbps));
      const q = params.toString() ? `?${params.toString()}` : '';
      return call(`/process${q}`, bytes, zMediaProcessResult, signal);
    },
  };
}
