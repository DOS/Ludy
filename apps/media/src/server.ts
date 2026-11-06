// SPDX-License-Identifier: AGPL-3.0-only
// HTTP server for crove-media sandbox (AI Meeting Notes M3, #2577).
// Runs media processing in isolated tasks with strict concurrency, disk streaming,
// timeouts, safe format allowlists, and typed responses.
import { Hono, type Context } from 'hono';
import { createReadStream, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  MEDIA_ERROR_STATUS,
  MEDIA_LIMITS,
  MEDIA_TIMING,
  type MediaErrorResponse,
  type MediaNormalizeResult,
  type MediaProbeResult,
  type MediaProcessResult,
  type MediaResponse,
  type MediaSplitResult,
} from './types.ts';
import {
  createTempDir,
  MediaExecutionError,
  normalizeAudioFile,
  probeFile,
  processMediaFile,
  repackageVideoFile,
  splitAudioFile,
} from './ffmpeg.ts';

export interface MediaAppOptions {
  concurrency?: number;
  maxQueue?: number;
  bodyIdleTimeoutMs?: number;
  bodyTimeoutMs?: number;
  maxInputBytes?: number;
  processTimeoutMs?: number;

  // Custom runners for testing HTTP/concurrency layers independently of ffmpeg
  runProbe?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<MediaProbeResult>;
  runNormalize?: (bytes: Uint8Array, signal?: AbortSignal, options?: { bitrateKbps?: number }) => Promise<MediaNormalizeResult>;
  runSplit?: (bytes: Uint8Array, signal?: AbortSignal, options?: { maxSegmentSeconds?: number; bitrateKbps?: number }) => Promise<MediaSplitResult>;
  runRepackageVideo?: (bytes: Uint8Array, signal?: AbortSignal, options?: { dropAudio?: boolean }) => Promise<{ durationSeconds: number; format: string; hasAudio: boolean }>;
  runProcess?: (bytes: Uint8Array, signal?: AbortSignal, options?: { maxSegmentSeconds?: number; bitrateKbps?: number }) => Promise<MediaProcessResult>;
}

export type BodyFailure = 'too_large' | 'aborted' | 'idle' | 'deadline';

export interface BodyLimits {
  maxBytes: number;
  idleTimeoutMs: number;
  timeoutMs: number;
}

export async function streamBodyToFile(
  request: Request,
  targetPath: string,
  limits: BodyLimits,
  signal: AbortSignal,
): Promise<'ok' | BodyFailure | 'empty'> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limits.maxBytes) return 'too_large';
  if (signal.aborted) return 'aborted';

  const reader = request.body?.getReader();
  if (!reader) return 'empty';

  let fh: FileHandle | null = null;
  let total = 0;
  let ended: BodyFailure | null = null;

  const end = async (reason: BodyFailure) => {
    ended ??= reason;
    try {
      await reader.cancel();
    } catch {}
  };

  const onAbort = () => void end('aborted');
  signal.addEventListener('abort', onAbort, { once: true });

  let idle = setTimeout(() => void end('idle'), limits.idleTimeoutMs);
  const deadline = setTimeout(() => void end('deadline'), limits.timeoutMs);

  try {
    fh = await open(targetPath, 'w', 0o600);
    for (;;) {
      const { done, value } = await reader.read();
      if (ended) return ended;
      if (signal.aborted) return 'aborted';
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      clearTimeout(idle);
      idle = setTimeout(() => void end('idle'), limits.idleTimeoutMs);

      total += value.byteLength;
      if (total > limits.maxBytes) {
        await end('too_large');
        return 'too_large';
      }

      let off = 0;
      while (off < value.byteLength) {
        const { bytesWritten } = await fh.write(value, off, value.byteLength - off);
        off += bytesWritten;
      }
    }
  } catch (error) {
    if (ended) return ended;
    if (signal.aborted) return 'aborted';
    throw error;
  } finally {
    clearTimeout(idle);
    clearTimeout(deadline);
    signal.removeEventListener('abort', onAbort);
    if (fh) {
      try {
        await fh.close();
      } catch {}
    }
    if (ended || total === 0) {
      try {
        rmSync(targetPath, { force: true });
      } catch {}
    }
  }

  if (ended) return ended;
  if (total === 0) return 'empty';

  return 'ok';
}

export function createLimiter(concurrency: number, maxQueue: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function acquire<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw new MediaExecutionError('timeout', 'Request was aborted');
    }

    if (active >= concurrency) {
      if (queue.length >= maxQueue) {
        throw new MediaExecutionError('busy', 'crove-media service is busy; try again later');
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const idx = queue.indexOf(run);
          if (idx !== -1) queue.splice(idx, 1);
          reject(new MediaExecutionError('timeout', 'Request aborted while waiting in queue'));
        };
        const run = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        queue.push(run);
      });
    } else {
      active++;
    }

    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) {
        // Direct handoff: keep active unchanged
        next();
      } else {
        active--;
      }
    }
  };
}

function answer<T>(c: Context, response: MediaResponse<T>) {
  if (response.ok) {
    return c.json(response, 200);
  }
  const status = MEDIA_ERROR_STATUS[response.code] ?? 500;
  return c.json(response, status as any);
}

function errorResponse(code: MediaErrorResponse['code'], message: string): MediaErrorResponse {
  return { ok: false, code, error: message };
}

function parseBitrate(queryVal: string | undefined): number {
  const val = Number(queryVal);
  if (!Number.isFinite(val) || val <= 0) return MEDIA_LIMITS.defaultOpusBitrateKbps;
  return Math.max(6, Math.min(64, Math.round(val)));
}

function parseSegmentSeconds(queryVal: string | undefined): number {
  const val = Number(queryVal);
  if (!Number.isFinite(val) || val <= 0) return MEDIA_LIMITS.defaultSegmentSeconds;
  return Math.max(MEDIA_LIMITS.minSegmentSeconds, Math.min(3600, Math.round(val)));
}

export function createMediaApp(options: MediaAppOptions = {}): Hono {
  const app = new Hono();
  const concurrency = options.concurrency ?? MEDIA_TIMING.concurrency;
  const maxQueue = options.maxQueue ?? MEDIA_TIMING.maxQueue;
  const maxInputBytes = options.maxInputBytes ?? MEDIA_LIMITS.maxVideoBytes;
  const bodyIdleTimeoutMs = options.bodyIdleTimeoutMs ?? MEDIA_TIMING.bodyIdleTimeoutMs;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? MEDIA_TIMING.bodyTimeoutMs;
  const processTimeoutMs = options.processTimeoutMs ?? MEDIA_TIMING.processTimeoutMs;

  const acquire = createLimiter(concurrency, maxQueue);

  app.get('/healthz', (c) => c.json({ ok: true, service: 'crove-media' }, 200));

  async function handleOperation<T>(
    c: Context,
    maxBytes: number,
    fn: (inputPath: string, dir: string, signal: AbortSignal) => Promise<T>,
  ) {
    const declared = Number(c.req.raw.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return answer(c, errorResponse('too_large', `Payload exceeds maximum of ${maxBytes} bytes`));
    }

    const requestSignal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(processTimeoutMs)]);
    const opLimits: BodyLimits = {
      maxBytes,
      idleTimeoutMs: bodyIdleTimeoutMs,
      timeoutMs: bodyTimeoutMs,
    };

    try {
      const result = await acquire(async () => {
        const dir = createTempDir();
        const inputPath = join(dir, 'input.bin');

        try {
          const streamResult = await streamBodyToFile(c.req.raw, inputPath, opLimits, requestSignal);

          if (streamResult === 'too_large') {
            return errorResponse('too_large', `Payload exceeds maximum of ${maxBytes} bytes`);
          }
          if (streamResult === 'aborted') {
            return errorResponse('timeout', 'Request was aborted');
          }
          if (streamResult === 'idle' || streamResult === 'deadline') {
            return errorResponse('bad_request', `Body upload failed: ${streamResult}`);
          }
          if (streamResult === 'empty') {
            return errorResponse('bad_request', 'Empty media payload');
          }

          const out = await fn(inputPath, dir, requestSignal);
          return { ok: true as const, result: out };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, requestSignal);

      return answer(c, result);
    } catch (err: unknown) {
      if (err instanceof MediaExecutionError) {
        return answer(c, errorResponse(err.code, err.message));
      }
      return answer(c, errorResponse('internal_error', 'Internal media processing error'));
    }
  }

  app.post('/probe', (c) =>
    handleOperation(c, maxInputBytes, async (inputPath, _dir, signal) => {
      if (options.runProbe) {
        const bytes = readFileSync(inputPath);
        return options.runProbe(bytes, signal);
      }
      return probeFile(inputPath, { signal, timeoutMs: processTimeoutMs });
    }),
  );

  app.post('/normalize', (c) => {
    const bitrateKbps = parseBitrate(c.req.query('bitrate_kbps'));
    const maxBytes = Math.min(maxInputBytes, MEDIA_LIMITS.maxAudioBytes);
    return handleOperation(c, maxBytes, async (inputPath, dir, signal) => {
      if (options.runNormalize) {
        const bytes = readFileSync(inputPath);
        return options.runNormalize(bytes, signal, { bitrateKbps });
      }
      const outputPath = join(dir, 'normalized.opus');
      return normalizeAudioFile(inputPath, outputPath, { signal, bitrateKbps, timeoutMs: processTimeoutMs });
    });
  });

  app.post('/split', (c) => {
    const maxSegmentSeconds = parseSegmentSeconds(c.req.query('max_segment_seconds'));
    const bitrateKbps = parseBitrate(c.req.query('bitrate_kbps'));
    const maxBytes = Math.min(maxInputBytes, MEDIA_LIMITS.maxAudioBytes);
    return handleOperation(c, maxBytes, async (inputPath, dir, signal) => {
      if (options.runSplit) {
        const bytes = readFileSync(inputPath);
        return options.runSplit(bytes, signal, { maxSegmentSeconds, bitrateKbps });
      }
      return splitAudioFile(inputPath, dir, { signal, maxSegmentSeconds, bitrateKbps, timeoutMs: processTimeoutMs });
    });
  });

  app.post('/repackage-video', async (c) => {
    const declared = Number(c.req.raw.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxInputBytes) {
      return answer(c, errorResponse('too_large', `Payload exceeds maximum of ${maxInputBytes} bytes`));
    }

    const dropAudio = c.req.query('drop_audio') !== 'false';
    const requestSignal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(processTimeoutMs)]);
    const opLimits: BodyLimits = {
      maxBytes: maxInputBytes,
      idleTimeoutMs: bodyIdleTimeoutMs,
      timeoutMs: bodyTimeoutMs,
    };

    try {
      const acquireResult = await acquire(async () => {
        const dir = createTempDir();
        const inputPath = join(dir, 'input.bin');
        const outputPath = join(dir, 'repackaged.bin');

        try {
          const streamResult = await streamBodyToFile(c.req.raw, inputPath, opLimits, requestSignal);
          if (streamResult === 'too_large') {
            rmSync(dir, { recursive: true, force: true });
            return { ok: false as const, response: errorResponse('too_large', `Payload exceeds maximum of ${maxInputBytes} bytes`) };
          }
          if (streamResult === 'aborted') {
            rmSync(dir, { recursive: true, force: true });
            return { ok: false as const, response: errorResponse('timeout', 'Request was aborted') };
          }
          if (streamResult === 'idle' || streamResult === 'deadline') {
            rmSync(dir, { recursive: true, force: true });
            return { ok: false as const, response: errorResponse('bad_request', `Body upload failed: ${streamResult}`) };
          }
          if (streamResult === 'empty') {
            rmSync(dir, { recursive: true, force: true });
            return { ok: false as const, response: errorResponse('bad_request', 'Empty media payload') };
          }

          if (options.runRepackageVideo) {
            const bytes = readFileSync(inputPath);
            await options.runRepackageVideo(bytes, requestSignal, { dropAudio });
            writeFileSync(outputPath, new Uint8Array([1, 2, 3]));
          } else {
            await repackageVideoFile(inputPath, outputPath, {
              dropAudio,
              signal: requestSignal,
              timeoutMs: processTimeoutMs,
            });
          }

          // Unlink raw input immediately to conserve disk space
          try {
            rmSync(inputPath, { force: true });
          } catch {}

          return { ok: true as const, dir, outputPath };
        } catch (err) {
          rmSync(dir, { recursive: true, force: true });
          throw err;
        }
      }, requestSignal);

      if (!acquireResult.ok) {
        return answer(c, acquireResult.response);
      }

      const { dir, outputPath } = acquireResult;
      let nodeStream: ReturnType<typeof createReadStream>;
      try {
        nodeStream = createReadStream(outputPath);
      } catch (err) {
        rmSync(dir, { recursive: true, force: true });
        throw err;
      }

      const onAbort = () => {
        nodeStream.destroy();
      };
      c.req.raw.signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        c.req.raw.signal.removeEventListener('abort', onAbort);
        rmSync(dir, { recursive: true, force: true });
      };

      nodeStream.on('close', cleanup);
      nodeStream.on('error', cleanup);

      c.header('content-type', 'application/octet-stream');
      return c.body(Readable.toWeb(nodeStream) as ReadableStream, 200);
    } catch (err: unknown) {
      if (err instanceof MediaExecutionError) {
        return answer(c, errorResponse(err.code, err.message));
      }
      return answer(c, errorResponse('internal_error', 'Internal media processing error'));
    }
  });

  app.post('/process', (c) => {
    const maxSegmentSeconds = parseSegmentSeconds(c.req.query('max_segment_seconds'));
    const bitrateKbps = parseBitrate(c.req.query('bitrate_kbps'));
    return handleOperation(c, maxInputBytes, async (inputPath, dir, signal) => {
      if (options.runProcess) {
        const bytes = readFileSync(inputPath);
        return options.runProcess(bytes, signal, { maxSegmentSeconds, bitrateKbps });
      }
      return processMediaFile(inputPath, dir, { signal, maxSegmentSeconds, bitrateKbps, timeoutMs: processTimeoutMs });
    });
  });

  return app;
}
