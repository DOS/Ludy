// SPDX-License-Identifier: AGPL-3.0-only
// Live notes capture, the client side (ADR-0052 section 2, L4a, #3109). A recorder who ticked "Ghi chú trực tiếp" also
// sends pieces of about 15 seconds of the audio to the server while the meeting is recorded. This file holds the parts
// that need no browser: the sender (one piece at a time, in order, a few retries, bounded memory), the wrapper around a
// second, audio-only MediaRecorder, and the stop order. The full recording the screen uploads at the end stays the
// authoritative copy, so nothing here may lose it, delay it for good or throw into the recorder: every failure ends as
// a dropped piece and the recording goes on.
import { pickRecorderMime } from './index.ts';

// The server's limits for one piece (seq 0 to 999, 1 to 120 seconds).
export const LIVE_MAX_SEQ = 999;
export const LIVE_TIMESLICE_MS = 15_000;
const MAX_LENGTH_SECONDS = 120;

export interface LivePiece {
  seq: number;
  lengthSeconds: number;
  blob: Blob;
}

// The length a piece is sent with: the recorder clock's duration rounded up, at least 1, at most 120.
export function liveLengthSeconds(durationMs: number): number {
  const seconds = Number.isFinite(durationMs) ? Math.ceil(durationMs / 1000) : 1;
  return Math.min(MAX_LENGTH_SECONDS, Math.max(1, seconds));
}

// The statuses the server answers when it will never take a piece of this recording (not enabled, closed, no consent,
// retention passed, too large, malformed). A network failure, 429 and 5xx are retried; so is any error with no status.
const PERMANENT_STATUSES: readonly number[] = [400, 403, 404, 409, 413];

// `send` fails with an error that carries the HTTP status in `status` (LudyError and ApiError both do).
export function isPermanentLiveError(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && PERMANENT_STATUSES.includes(status);
}

export interface LiveSenderStatus {
  sent: number;
  dropped: number;
  // True once the server refused for good, the time to finish ran out, or the sender was closed.
  stopped: boolean;
}

export interface LiveSenderOptions {
  send(piece: LivePiece): Promise<void>;
  // Retries after the first attempt (default 3: waits of 1 s, 2 s and 4 s).
  maxRetries?: number;
  baseDelayMs?: number;
  // Pieces kept waiting while one is being sent (default 8); the oldest are dropped past that.
  maxQueue?: number;
  // The wait between attempts; tests replace it.
  sleep?(ms: number): Promise<void>;
  isPermanent?(error: unknown): boolean;
}

export interface LiveSender {
  // Never throws. The piece gets its seq now, so a dropped piece leaves a gap and the order stays.
  push(blob: Blob, durationMs: number): void;
  // Waits for the queue to drain or the time to run out, then closes the sender. Always resolves.
  finish(options?: { timeoutMs?: number }): Promise<void>;
  status(): LiveSenderStatus;
}

export function createLiveSender(options: LiveSenderOptions): LiveSender {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxQueue = options.maxQueue ?? 8;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isPermanent = options.isPermanent ?? isPermanentLiveError;
  const queue: LivePiece[] = [];
  let nextSeq = 0;
  let sent = 0;
  let dropped = 0;
  let stopped = false;
  let running = false;
  const idleWaiters: Array<() => void> = [];

  const settleIdle = () => {
    if (running || queue.length > 0) return;
    for (const wake of idleWaiters.splice(0)) wake();
  };
  const stopForGood = () => {
    stopped = true;
    dropped += queue.length;
    queue.length = 0;
  };

  const deliver = async (piece: LivePiece): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await options.send(piece);
        sent += 1;
        return;
      } catch (error) {
        if (isPermanent(error)) {
          dropped += 1;
          stopForGood();
          return;
        }
        if (attempt >= maxRetries || stopped) {
          dropped += 1;
          return;
        }
      }
      await sleep(baseDelayMs * 2 ** attempt).catch(() => undefined);
      if (stopped) {
        dropped += 1;
        return;
      }
    }
  };

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (!stopped) {
        const piece = queue.shift();
        if (!piece) break;
        await deliver(piece);
      }
    } catch {
      // deliver never throws; this keeps the loop from ever rejecting into the caller.
    } finally {
      running = false;
      settleIdle();
    }
  };

  return {
    push(blob, durationMs) {
      try {
        if (stopped || blob.size === 0) return;
        if (nextSeq > LIVE_MAX_SEQ) {
          dropped += 1;
          return;
        }
        queue.push({ seq: nextSeq, lengthSeconds: liveLengthSeconds(durationMs), blob });
        nextSeq += 1;
        while (queue.length > maxQueue) {
          queue.shift();
          dropped += 1;
        }
        void run();
      } catch {
        dropped += 1;
      }
    },
    async finish({ timeoutMs = 10_000 } = {}) {
      if (!running && queue.length === 0) {
        stopped = true;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = new Promise<void>((resolve) => idleWaiters.push(resolve));
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      });
      await Promise.race([drained, timedOut]);
      clearTimeout(timer);
      // Whatever is still waiting is dropped and a piece still in flight is not retried: the final upload goes next.
      stopForGood();
    },
    status: () => ({ sent, dropped, stopped }),
  };
}

// What the capture needs of a MediaRecorder, so it tests without a browser. A real MediaRecorder fits.
export interface LiveMediaRecorder {
  readonly state: string;
  start(timeslice?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
  addEventListener(type: string, listener: (event: any) => void): void; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface LiveCapture {
  // While the main recording is paused no audio is sent.
  pause(): void;
  resume(): void;
  // Stops the live recorder, waits for its last piece and hands it to the sender. Safe to call twice; never throws.
  halt(): Promise<void>;
  // halt, then waits for the sender to drain or `timeoutMs` (default 10 s). Always resolves.
  stopAndFinish(options?: { timeoutMs?: number }): Promise<void>;
  // Stops everything without waiting (the screen was left).
  abandon(): void;
  status(): LiveSenderStatus;
}

export interface LiveCaptureOptions {
  // The box ticked at the consent step. False: nothing is created and nothing is sent.
  enabled: boolean;
  // Builds the audio-only recorder over the audio tracks of the capture stream; may throw or return null.
  makeRecorder(): LiveMediaRecorder | null;
  send(piece: LivePiece): Promise<void>;
  now(): number;
  timesliceMs?: number;
  // A wait for the recorder's `stop` event that never comes (default 5 s).
  stopGraceMs?: number;
  sender?: Omit<LiveSenderOptions, 'send'>;
}

// Starts the live recorder, or returns null (live notes off, or the recorder could not be made or started): the
// recording then simply goes on without live notes.
export function startLiveCapture(options: LiveCaptureOptions): LiveCapture | null {
  if (!options.enabled) return null;
  let recorder: LiveMediaRecorder | null;
  try {
    recorder = options.makeRecorder();
  } catch {
    return null;
  }
  if (!recorder) return null;
  const live = recorder;
  const sender = createLiveSender({ ...options.sender, send: options.send });
  // The duration of a piece is the recorder's own running time, so a pause is not counted.
  let banked = 0;
  let activeSince: number | null = options.now();
  const takeDuration = (): number => {
    const now = options.now();
    const total = banked + (activeSince === null ? 0 : Math.max(0, now - activeSince));
    banked = 0;
    if (activeSince !== null) activeSince = now;
    return total;
  };
  let stoppedEvent: Promise<void> = Promise.resolve();
  try {
    live.addEventListener('dataavailable', (event: { data?: Blob }) => {
      try {
        const duration = takeDuration();
        if (event.data) sender.push(event.data, duration);
      } catch {
        // never into the recorder
      }
    });
    stoppedEvent = new Promise<void>((resolve) => live.addEventListener('stop', () => resolve()));
    live.start(options.timesliceMs ?? LIVE_TIMESLICE_MS);
  } catch {
    try {
      if (live.state !== 'inactive') live.stop();
    } catch {
      // already stopped
    }
    return null;
  }
  let halted: Promise<void> | null = null;
  const stopGraceMs = options.stopGraceMs ?? 5000;
  const halt = (): Promise<void> => {
    halted ??= (async () => {
      try {
        if (live.state !== 'inactive') {
          live.stop();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const grace = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, stopGraceMs);
          });
          await Promise.race([stoppedEvent, grace]);
          clearTimeout(timer);
        }
      } catch {
        // a recorder that will not stop is left; the final upload goes on
      }
    })();
    return halted;
  };
  return {
    pause() {
      try {
        if (live.state !== 'recording') return;
        live.pause();
        banked = takeDuration();
        activeSince = null;
      } catch {
        // keep recording
      }
    },
    resume() {
      try {
        if (live.state !== 'paused') return;
        live.resume();
        activeSince = options.now();
      } catch {
        // keep recording
      }
    },
    halt,
    async stopAndFinish(finishOptions) {
      await halt();
      await sender.finish(finishOptions).catch(() => undefined);
    },
    abandon() {
      try {
        if (live.state !== 'inactive') live.stop();
      } catch {
        // already stopped
      }
      void sender.finish({ timeoutMs: 0 }).catch(() => undefined);
    },
    status: () => sender.status(),
  };
}

// The stop order of a recording: the live pieces first (they are refused once the final recording is stored), then the
// final upload, which runs whatever became of the live sender. `live` is null for a recording without live notes.
export async function uploadAfterLive<T>(live: LiveCapture | null, upload: () => Promise<T>, finishOptions?: { timeoutMs?: number }): Promise<T> {
  if (live) await live.stopAndFinish(finishOptions).catch(() => undefined);
  return upload();
}

// An audio-only recorder over the audio tracks of the capture stream, in the browser. The type is the package's audio
// pick; a stream with no audio track gives null. It is separate from the main recorder, which keeps its own slices.
export function createBrowserLiveRecorder(stream: { getAudioTracks(): MediaStreamTrack[] }): LiveMediaRecorder | null {
  const tracks = stream.getAudioTracks();
  if (tracks.length === 0) return null;
  const mimeType = pickRecorderMime((type) => MediaRecorder.isTypeSupported(type), 'audio');
  return new MediaRecorder(new MediaStream(tracks), { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 });
}
