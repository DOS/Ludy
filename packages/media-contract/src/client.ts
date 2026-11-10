// SPDX-License-Identifier: AGPL-3.0-only
// Client for calling the crove-media HTTP service.
// Used by worker tasks (AI Meeting Notes M4, #2578) and test harnesses.
import {
  MEDIA_LIMITS,
  MEDIA_TIMING,
  zMediaErrorResponse,
  zMediaNormalizeResult,
  zMediaProbeResult,
  zMediaProcessResult,
  zMediaSplitResult,
  type MediaErrorCode,
  type MediaNormalizeResult,
  type MediaProbeResult,
  type MediaProcessResult,
  type MediaSplitResult,
} from './types.ts';

export class MediaClientError extends Error {
  readonly code: MediaErrorCode;
  readonly status: number;

  constructor(code: MediaErrorCode, status: number, message: string) {
    const cleanMessage = String(message || 'Unknown error').slice(0, 500);
    super(cleanMessage);
    this.name = 'MediaClientError';
    this.code = code;
    this.status = status;
  }
}

export interface MediaClient {
  probe(bytes: Uint8Array, signal?: AbortSignal): Promise<MediaProbeResult>;
  // The same probe with the media sent as it is produced (a decrypting reader), so the caller never holds the file whole.
  probeStream(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<MediaProbeResult>;
  normalize(bytes: Uint8Array, options?: { bitrateKbps?: number }, signal?: AbortSignal): Promise<MediaNormalizeResult>;
  split(bytes: Uint8Array, options?: { maxSegmentSeconds?: number; bitrateKbps?: number }, signal?: AbortSignal): Promise<MediaSplitResult>;
  repackageVideo(bytes: Uint8Array, options?: { dropAudio?: boolean }, signal?: AbortSignal): Promise<Uint8Array>;
  process(
    bytes: Uint8Array,
    options?: { maxSegmentSeconds?: number; bitrateKbps?: number },
    signal?: AbortSignal,
  ): Promise<MediaProcessResult>;
}

// A pull-driven web stream over an async iterable: the next piece is read only when the request can take it.
function streamOf(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await iterator.next();
        if (step.done) controller.close();
        else controller.enqueue(step.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.().catch(() => undefined);
    },
  });
}

export function createMediaClient(baseUrl: string): MediaClient {
  let base = baseUrl;
  while (base.endsWith('/')) {
    base = base.slice(0, -1);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(base);
  } catch {
    throw new Error(`Invalid crove-media base URL: ${base}`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`crove-media base URL must use http or https protocol: ${base}`);
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error(`crove-media base URL must not contain credentials, query, or hash: ${base}`);
  }

  async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    let total = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new MediaClientError('too_large', response.status, `Response exceeded maximum of ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  async function call<T>(
    endpoint: string,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
    schema: { parse: (val: unknown) => T },
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${base}${endpoint}`;
    const streaming = !(bytes instanceof Uint8Array);
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      body: (streaming ? streamOf(bytes) : bytes) as unknown as BodyInit,
      headers: {
        'content-type': 'application/octet-stream',
      },
      redirect: 'error',
    };
    if (streaming) init.duplex = 'half';
    init.signal = signal ?? AbortSignal.timeout(MEDIA_TIMING.processTimeoutMs + 15_000);
    const response = await fetch(url, init);

    const text = await readBoundedText(response, 192 * 1024 * 1024);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MediaClientError(
        'internal_error',
        response.status,
        `crove-media request to ${endpoint} returned non-JSON response (HTTP ${response.status})`,
      );
    }

    if (!response.ok) {
      const errorParsed = zMediaErrorResponse.safeParse(json);
      if (errorParsed.success) {
        throw new MediaClientError(errorParsed.data.code, response.status, errorParsed.data.error);
      }
      throw new MediaClientError('internal_error', response.status, 'crove-media request failed');
    }

    const payload = json as { ok: boolean; result: unknown };
    if (payload.ok !== true) {
      throw new MediaClientError('internal_error', response.status, 'Invalid response payload from crove-media');
    }
    return schema.parse(payload.result);
  }

  return {
    async probe(bytes: Uint8Array, signal?: AbortSignal): Promise<MediaProbeResult> {
      return call('/probe', bytes, zMediaProbeResult, signal);
    },

    async probeStream(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<MediaProbeResult> {
      return call('/probe', chunks, zMediaProbeResult, signal);
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
        body: bytes as unknown as BodyInit,
        headers: {
          'content-type': 'application/octet-stream',
        },
        redirect: 'error',
      };
      init.signal = signal ?? AbortSignal.timeout(MEDIA_TIMING.processTimeoutMs + 15_000);
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
