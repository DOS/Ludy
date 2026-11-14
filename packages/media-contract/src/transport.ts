// SPDX-License-Identifier: AGPL-3.0-only
// The HTTP transport of the crove-media clients: the base URL checks, bounded reads, streamed request bodies and the strict
// answer parsing, shared by the full client (client.ts) and the narrow one the kernel uses (measure.ts, #2985).
import { MEDIA_TIMING, zMediaErrorResponse, type MediaErrorCode } from './types.ts';

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

export interface MediaTransport {
  base: string;
  callTimeoutMs: number;
  readBoundedText(response: Response, maxBytes: number): Promise<string>;
  call<T>(endpoint: string, bytes: Uint8Array | AsyncIterable<Uint8Array>, schema: { parse: (val: unknown) => T }, signal?: AbortSignal): Promise<T>;
}

// timeoutMs: how long one call may take (the sandbox's own MEDIA_TIMEOUT_MS plus its queue and a margin); default the contract's.
export function createTransport(baseUrl: string, options: { timeoutMs?: number } = {}): MediaTransport {
  const callTimeoutMs = options.timeoutMs ?? MEDIA_TIMING.processTimeoutMs + 15_000;
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
      body: (streaming ? streamOf(bytes) : bytes) as unknown as NonNullable<RequestInit['body']>,
      headers: {
        'content-type': 'application/octet-stream',
      },
      redirect: 'error',
    };
    if (streaming) init.duplex = 'half';
    init.signal = signal ?? AbortSignal.timeout(callTimeoutMs);
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

  return { base, callTimeoutMs, readBoundedText, call };
}
