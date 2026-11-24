// SPDX-License-Identifier: AGPL-3.0-only
// Desktop live-notes piece sender & local disk chunk store (ADR-0052 L4a & crash-safe recovery).
// Matches packages/meeting-recorder/src/live.ts semantics: sequential 15 s pieces, keeps header seq 0 on overflow,
// retries transient errors (5xx/429/network), stops on permanent 4xx (400/403/404/409/413), and stores full-recording chunks cleanly on disk.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LIVE_MAX_SEQ = 999;
const MAX_LENGTH_SECONDS = 120;
const PERMANENT_STATUSES: readonly number[] = [400, 403, 404, 409, 413];

export interface LivePieceInput {
  seq: number;
  lengthSeconds: number;
  bytes: Uint8Array;
  mimeType: string;
}

export function liveLengthSeconds(durationMs: number): number {
  const seconds = Number.isFinite(durationMs) ? Math.ceil(durationMs / 1000) : 1;
  return Math.min(MAX_LENGTH_SECONDS, Math.max(1, seconds));
}

export function isPermanentLiveError(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && PERMANENT_STATUSES.includes(status);
}

export interface LiveSenderOptions {
  send(piece: LivePieceInput): Promise<void>;
  maxRetries?: number;
  baseDelayMs?: number;
  maxQueue?: number;
  sleep?(ms: number): Promise<void>;
  isPermanent?(error: unknown): boolean;
}

export interface LiveSenderStatus {
  sent: number;
  dropped: number;
  stopped: boolean;
}

export interface LiveSender {
  push(bytes: Uint8Array, mimeType: string, durationMs: number): void;
  finish(options?: { timeoutMs?: number }): Promise<void>;
  status(): LiveSenderStatus;
}

export function createDesktopLiveSender(options: LiveSenderOptions): LiveSender {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxQueue = options.maxQueue ?? 8;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isPermanent = options.isPermanent ?? isPermanentLiveError;
  const queue: LivePieceInput[] = [];
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

  const deliver = async (piece: LivePieceInput): Promise<void> => {
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
    } finally {
      running = false;
      settleIdle();
    }
  };

  return {
    push(bytes, mimeType, durationMs) {
      try {
        if (stopped || bytes.byteLength === 0) return;
        if (nextSeq > LIVE_MAX_SEQ) {
          dropped += 1;
          return;
        }
        queue.push({ seq: nextSeq, lengthSeconds: liveLengthSeconds(durationMs), bytes, mimeType });
        nextSeq += 1;
        while (queue.length > maxQueue) {
          const at = queue.findIndex((p) => p.seq !== 0);
          if (at < 0) break;
          queue.splice(at, 1);
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
      stopForGood();
    },
    status: () => ({ sent, dropped, stopped }),
  };
}

export interface LocalRecordingStore {
  prepareDir(recordingId: string): Promise<void>;
  appendChunk(recordingId: string, seq: number, bytes: Uint8Array): Promise<void>;
  assemble(recordingId: string): Promise<Uint8Array>;
  remove(recordingId: string): Promise<void>;
}

export function createDiskRecordingStore(baseDir: string): LocalRecordingStore {
  const dirFor = (id: string) => join(baseDir, 'recordings', id.replace(/[^A-Za-z0-9_-]/g, '_'));
  return {
    async prepareDir(recordingId) {
      await mkdir(dirFor(recordingId), { recursive: true, mode: 0o700 });
    },
    async appendChunk(recordingId, seq, bytes) {
      const dir = dirFor(recordingId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const name = `${String(seq).padStart(6, '0')}.bin`;
      await writeFile(join(dir, name), bytes, { mode: 0o600 });
    },
    async assemble(recordingId) {
      const dir = dirFor(recordingId);
      const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.bin')).sort();
      if (files.length === 0) return new Uint8Array(0);
      const parts = await Promise.all(files.map((f) => readFile(join(dir, f))));
      return Buffer.concat(parts);
    },
    async remove(recordingId) {
      await rm(dirFor(recordingId), { recursive: true, force: true });
    },
  };
}
