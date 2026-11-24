// SPDX-License-Identifier: AGPL-3.0-only
// Electron Windows desktop capture backend (ADR-0055 slice 3, #4516): runs ludy-wasapi-loopback.exe --pid <pid> for
// per-app process loopback (detecting Win10 < build 20348 via exit code 42 -> ProcessLoopbackUnsupportedError with zero silent
// fallback), routes PCM frames into a hidden sandboxed capture worker BrowserWindow for AudioWorklet mixing + mic capture + MediaRecorder.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CaptureModule, CapturePiece, CaptureSource, CaptureStartOptions } from './interface.ts';
import { ProcessLoopbackUnsupportedError } from './interface.ts';
import { createSilenceMonitor } from './levels.ts';
import { resolveHelperExePath } from './windows.ts';
import { PCM_WORKLET_NAME } from './ui/pcm-worklet.ts';
import { AUDIO_MIME_CANDIDATES } from './ui/worker.ts';
import { CONSENT_UI_ORIGIN } from './ui/consent-ui.ts';
import { formatPillClock } from './ui/pill-ui.ts';

export const CAPTURE_UI_SPECS = {
  origin: CONSENT_UI_ORIGIN,
  worklet: PCM_WORKLET_NAME,
  mimeCandidates: AUDIO_MIME_CANDIDATES,
  formatClock: formatPillClock,
} as const;

export interface ElectronWorkerBridge {
  openWorkerWindow(): Promise<{
    webContentsId: number;
    sendStart(cfg: { source: CaptureSource; mode: 'wasapi' | 'system-fallback' | 'mic-only'; liveNotes: boolean }): void;
    sendStop(): void;
    sendPcm(buf: ArrayBuffer): void;
    close(): void;
  }>;
  armSystemFallback(): void;
  disarmSystemFallback(): void;
  onWorkerReady(cb: (res: { ok: boolean; error?: string; micMissing?: boolean }) => void): () => void;
  onWorkerStopped(cb: () => void): () => void;
  onWorkerChunk(cb: (chunk: { kind: 'main' | 'live'; seq: number; bytes: ArrayBuffer; mimeType: string; offsetMs: number; durationMs: number }) => void): () => void;
  onWorkerLevels(cb: (levels: { loopbackRms: number; micRms: number }) => void): () => void;
  onWorkerEnded(cb: (reason: 'device_lost' | 'unknown') => void): () => void;
}

class AsyncPieceQueue implements AsyncIterable<CapturePiece> {
  private readonly items: CapturePiece[] = [];
  private readonly waiters: Array<(result: IteratorResult<CapturePiece>) => void> = [];
  private closed = false;

  push(piece: CapturePiece): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: piece, done: false });
    else this.items.push(piece);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CapturePiece> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<CapturePiece>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface DesktopCaptureDeps {
  isPackaged: boolean;
  resourcesPath: string;
  bridge: ElectronWorkerBridge;
  log?: (line: string) => void;
  spawnHelper?: (exePath: string, args: readonly string[]) => ChildProcessWithoutNullStreams;
  resolveHelperPath?: (options: { isPackaged: boolean; resourcesPath: string }) => string | null;
  startupTimeoutMs?: number;
}

export function createPcmFrameChunker(onFrame: (buf: ArrayBuffer) => void) {
  let remainder = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): void {
      if (chunk.byteLength === 0) return;
      let combined: Uint8Array;
      if (remainder.byteLength > 0) {
        combined = new Uint8Array(remainder.byteLength + chunk.byteLength);
        combined.set(remainder, 0);
        combined.set(chunk, remainder.byteLength);
      } else {
        combined = chunk;
      }
      const aligned = combined.byteLength - (combined.byteLength % 4);
      if (aligned > 0) {
        const frameBuf = new Uint8Array(aligned);
        frameBuf.set(combined.subarray(0, aligned));
        onFrame(frameBuf.buffer);
      }
      remainder = aligned < combined.byteLength ? Uint8Array.from(combined.subarray(aligned)) : new Uint8Array(0);
    },
    reset(): void {
      remainder = new Uint8Array(0);
    },
  };
}

export function createDesktopCaptureModule(deps: DesktopCaptureDeps): CaptureModule {
  const log = deps.log ?? (() => undefined);
  const spawnHelper = deps.spawnHelper ?? ((exePath, args) => spawn(exePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  const findHelper = deps.resolveHelperPath ?? resolveHelperExePath;
  const startupTimeoutMs = deps.startupTimeoutMs ?? 10_000;
  let helper: ChildProcessWithoutNullStreams | null = null;
  let queue: AsyncPieceQueue | null = null;
  let activeCleanup: Array<() => void> = [];
  let stopFn: (() => Promise<void>) | null = null;

  const cleanupAll = () => {
    for (const fn of activeCleanup.splice(0)) {
      try {
        fn();
      } catch {
        // ignore cleanup error
      }
    }
    if (helper) {
      try {
        helper.stdin.end();
        helper.kill();
      } catch {
        // ignore kill error
      }
      helper = null;
    }
    deps.bridge.disarmSystemFallback();
  };

  return {
    async start(source: CaptureSource, _meetingKey: string, options?: CaptureStartOptions): Promise<void> {
      if (stopFn) throw new Error('capture already running');
      const useWasapi = source !== 'microphone' && options?.targetPid !== undefined && !options.allowSystemFallback;
      const mode: 'wasapi' | 'system-fallback' | 'mic-only' = source === 'microphone' ? 'mic-only' : useWasapi ? 'wasapi' : 'system-fallback';

      if (useWasapi) {
        const exePath = findHelper({ isPackaged: deps.isPackaged, resourcesPath: deps.resourcesPath });
        if (!exePath) {
          throw new ProcessLoopbackUnsupportedError();
        }
        helper = spawnHelper(exePath, ['--pid', String(options!.targetPid)]);
        await new Promise<void>((resolve, reject) => {
          const proc = helper!;
          let settled = false;
          let stderr = '';
          const finishOk = () => {
            if (settled) return;
            settled = true;
            clearTimeout(startupTimer);
            detachStartup();
            resolve();
          };
          const finishErr = (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(startupTimer);
            detachStartup();
            cleanupAll();
            reject(err);
          };
          const onStderr = (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
            if (stderr.includes('PROCESS_LOOPBACK_UNSUPPORTED')) {
              finishErr(new ProcessLoopbackUnsupportedError());
              return;
            }
            if (/\bWASAPI_READY\b/.test(stderr)) {
              finishOk();
            }
          };
          const onError = () => finishErr(new ProcessLoopbackUnsupportedError());
          const onExit = (code: number | null) => {
            if (!settled) {
              if (code === 42 || stderr.includes('PROCESS_LOOPBACK_UNSUPPORTED')) {
                finishErr(new ProcessLoopbackUnsupportedError());
              } else {
                finishErr(new Error(`WASAPI loopback exited (${String(code)}): ${stderr.trim() || 'unknown'}`));
              }
            }
          };
          const detachStartup = () => {
            proc.stderr.off('data', onStderr);
            proc.off('error', onError);
            proc.off('exit', onExit);
          };
          proc.stderr.on('data', onStderr);
          proc.once('error', onError);
          proc.once('exit', onExit);
          const startupTimer = setTimeout(() => {
            finishErr(new Error(`WASAPI loopback helper timed out waiting for WASAPI_READY (${startupTimeoutMs} ms)`));
          }, startupTimeoutMs);
        });
      } else if (mode === 'system-fallback') {
        if (!options?.allowSystemFallback) {
          throw new ProcessLoopbackUnsupportedError();
        }
        deps.bridge.armSystemFallback();
      }

      const pieceQueue = new AsyncPieceQueue();
      queue = pieceQueue;

      const monitor = createSilenceMonitor({
        checkLoopback: source !== 'microphone',
        checkMic: source !== 'system-audio',
        ticksBeforeAlert: 7,
      });

      try {
        const worker = await deps.bridge.openWorkerWindow();
        activeCleanup.push(() => worker.close());

        if (helper) {
          const proc = helper;
          const chunker = createPcmFrameChunker((buf) => worker.sendPcm(buf));
          const onStdout = (chunk: Buffer) => chunker.push(chunk);
          const onStderr = (d: Buffer) => log(`wasapi: ${d.toString('utf8').trim()}`);
          const onClose = (code: number | null) => {
            if (stopFn) {
              log(`wasapi helper exited mid-capture (code ${String(code)})`);
              options?.onUnexpectedEnd?.('unknown');
            }
          };
          proc.stdout.on('data', onStdout);
          proc.stderr.on('data', onStderr);
          proc.once('close', onClose);
          activeCleanup.push(() => {
            chunker.reset();
            proc.stdout.off('data', onStdout);
            proc.stderr.off('data', onStderr);
            proc.off('close', onClose);
          });
        }

        const offChunk = deps.bridge.onWorkerChunk((chunk) => {
          const bytes = new Uint8Array(chunk.bytes);
          if (chunk.kind === 'main') {
            pieceQueue.push({ sequence: chunk.seq, offsetMs: chunk.offsetMs, mimeType: chunk.mimeType, data: bytes });
          } else {
            options?.onLiveChunk?.({ bytes, mimeType: chunk.mimeType, durationMs: chunk.durationMs });
          }
        });
        const offLevels = deps.bridge.onWorkerLevels((levels) => {
          const snap = monitor.recordTick(levels.loopbackRms, levels.micRms);
          for (const alert of snap.newlyTriggered) {
            options?.onSilentAlert?.(alert);
          }
        });
        const offEnded = deps.bridge.onWorkerEnded((reason) => {
          options?.onUnexpectedEnd?.(reason);
        });
        activeCleanup.push(offChunk, offLevels, offEnded);

        await new Promise<void>((resolve, reject) => {
          const offReady = deps.bridge.onWorkerReady((res) => {
            offReady();
            if (!res.ok) {
              reject(new Error(res.error ?? 'CAPTURE_WORKER_FAILED'));
              return;
            }
            if (res.micMissing) options?.onMicMissing?.();
            resolve();
          });
          worker.sendStart({ source, mode, liveNotes: Boolean(options?.onLiveChunk) });
        });

        let stopping: Promise<void> | null = null;
        stopFn = () => {
          if (stopping) return stopping;
          stopping = (async () => {
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, 4000);
              const offStopped = deps.bridge.onWorkerStopped(() => {
                clearTimeout(timeout);
                offStopped();
                resolve();
              });
              worker.sendStop();
            });
            cleanupAll();
            pieceQueue.close();
            queue = null;
            stopFn = null;
          })();
          return stopping;
        };
      } catch (error) {
        cleanupAll();
        pieceQueue.close();
        queue = null;
        stopFn = null;
        throw error;
      }
    },
    get pieces(): AsyncIterable<CapturePiece> {
      if (!queue) throw new Error('capture is not running');
      return queue;
    },
    async stop(): Promise<void> {
      if (stopFn) await stopFn();
      else cleanupAll();
    },
  };
}
