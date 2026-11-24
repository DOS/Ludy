// SPDX-License-Identifier: AGPL-3.0-only
// Hidden capture worker renderer (ludy-desktop://ui/worker.html): mixes WASAPI per-app PCM worklet (or explicit fallback
// system loopback) with microphone getUserMedia, meters RMS every 500 ms for silent-track detection, and encodes WebM/Ogg Opus pieces.
import { PCM_WORKLET_NAME } from './pcm-worklet.ts';

export const AUDIO_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'] as const;

export function pickDesktopAudioMime(isSupported: (t: string) => boolean): string | undefined {
  return AUDIO_MIME_CANDIDATES.find((t) => isSupported(t));
}

function rmsFloat(samples: Float32Array<ArrayBuffer>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

interface WorkerBridge {
  onWorkerStart(cb: (cfg: { source: string; mode: 'wasapi' | 'system-fallback' | 'mic-only'; liveNotes: boolean }) => void): () => void;
  onWorkerStop(cb: () => void): () => void;
  onWorkerPcm(cb: (buf: ArrayBuffer) => void): () => void;
  workerReady(res: { ok: boolean; error?: string; micMissing?: boolean; mimeType?: string }): void;
  workerStopped(): void;
  workerChunk(chunk: { kind: 'main' | 'live'; seq: number; bytes: ArrayBuffer; mimeType: string; offsetMs: number; durationMs: number }): void;
  workerLevels(levels: { loopbackRms: number; micRms: number }): void;
  workerUnexpectedEnd(reason: 'device_lost' | 'unknown'): void;
}

export function bootCaptureWorker(): void {
  const bridge = (window as unknown as { ludyDesktopBridge?: WorkerBridge }).ludyDesktopBridge;
  if (!bridge) return;

  let cleanupFns: Array<() => void> = [];
  let stopping = false;

  const teardown = () => {
    for (const fn of cleanupFns.splice(0)) {
      try {
        fn();
      } catch {
        // ignore cleanup error
      }
    }
  };

  bridge.onWorkerStart(async (cfg) => {
    teardown();
    stopping = false;
    try {
      const ctx = new AudioContext({ sampleRate: 48000 });
      const mix = ctx.createMediaStreamDestination();
      let loopbackAnalyser: AnalyserNode | null = null;
      let micAnalyser: AnalyserNode | null = null;
      let micMissing = false;

      if (cfg.mode === 'wasapi') {
        await ctx.audioWorklet.addModule('./pcm-worklet.js');
        const worklet = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        loopbackAnalyser = ctx.createAnalyser();
        loopbackAnalyser.fftSize = 1024;
        worklet.connect(loopbackAnalyser);
        worklet.connect(mix);
        const offPcm = bridge.onWorkerPcm((buf) => {
          worklet.port.postMessage(buf, [buf]);
        });
        cleanupFns.push(() => {
          offPcm();
          worklet.disconnect();
        });
      } else if (cfg.mode === 'system-fallback') {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        for (const vt of display.getVideoTracks()) {
          vt.stop();
          display.removeTrack(vt);
        }
        const audioTracks = display.getAudioTracks();
        if (audioTracks.length === 0) throw new Error('SYSTEM_LOOPBACK_NO_AUDIO');
        for (const at of audioTracks) {
          at.addEventListener('ended', () => {
            if (!stopping) bridge.workerUnexpectedEnd('unknown');
          });
        }
        const source = ctx.createMediaStreamSource(display);
        loopbackAnalyser = ctx.createAnalyser();
        loopbackAnalyser.fftSize = 1024;
        source.connect(loopbackAnalyser);
        source.connect(mix);
        cleanupFns.push(() => {
          for (const t of display.getTracks()) t.stop();
        });
      }

      if (cfg.source !== 'system-audio') {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).catch(() => null);
        if (!mic) {
          micMissing = true;
          if (cfg.source === 'microphone') throw new Error('MICROPHONE_UNAVAILABLE');
        } else {
          for (const mt of mic.getAudioTracks()) {
            mt.addEventListener('ended', () => {
              if (!stopping) bridge.workerUnexpectedEnd('device_lost');
            });
          }
          const micSource = ctx.createMediaStreamSource(mic);
          micAnalyser = ctx.createAnalyser();
          micAnalyser.fftSize = 1024;
          micSource.connect(micAnalyser);
          micSource.connect(mix);
          cleanupFns.push(() => {
            for (const t of mic.getTracks()) t.stop();
          });
        }
      }

      const mimeType = pickDesktopAudioMime((t) => MediaRecorder.isTypeSupported(t));
      const mainRecorder = new MediaRecorder(mix.stream, mimeType ? { mimeType } : undefined);
      const liveRecorder = cfg.liveNotes
        ? new MediaRecorder(mix.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 })
        : null;
      const startedAt = Date.now();
      let mainSeq = 0;
      let liveSeq = 0;
      let lastLiveAt = startedAt;
      const pendingReads = new Set<Promise<void>>();
      const trackRead = (p: Promise<void>) => {
        pendingReads.add(p);
        void p.finally(() => pendingReads.delete(p));
      };

      const mainStopped = new Promise<void>((resolve) => mainRecorder.addEventListener('stop', () => resolve(), { once: true }));
      const liveStopped = liveRecorder
        ? new Promise<void>((resolve) => liveRecorder.addEventListener('stop', () => resolve(), { once: true }))
        : Promise.resolve();

      mainRecorder.ondataavailable = (ev) => {
        if (ev.data.size === 0) return;
        const seq = mainSeq++;
        const offsetMs = Date.now() - startedAt;
        trackRead(
          ev.data.arrayBuffer().then((bytes) => {
            bridge.workerChunk({ kind: 'main', seq, bytes, mimeType: mainRecorder.mimeType || mimeType || 'audio/webm', offsetMs, durationMs: 5000 });
          }),
        );
      };
      if (liveRecorder) {
        liveRecorder.ondataavailable = (ev) => {
          if (ev.data.size === 0) return;
          const nowTs = Date.now();
          const durationMs = Math.max(1000, nowTs - lastLiveAt);
          lastLiveAt = nowTs;
          const seq = liveSeq++;
          trackRead(
            ev.data.arrayBuffer().then((bytes) => {
              bridge.workerChunk({ kind: 'live', seq, bytes, mimeType: liveRecorder.mimeType || mimeType || 'audio/webm', offsetMs: nowTs - startedAt, durationMs });
            }),
          );
        };
      }

      const loopbackBuf = new Float32Array(1024);
      const micBuf = new Float32Array(1024);
      const levelTimer = setInterval(() => {
        let lbRms = 1;
        let mRms = 1;
        if (loopbackAnalyser) {
          loopbackAnalyser.getFloatTimeDomainData(loopbackBuf);
          lbRms = rmsFloat(loopbackBuf);
        }
        if (micAnalyser) {
          micAnalyser.getFloatTimeDomainData(micBuf);
          mRms = rmsFloat(micBuf);
        }
        bridge.workerLevels({ loopbackRms: lbRms, micRms: mRms });
      }, 500);

      cleanupFns.push(() => clearInterval(levelTimer));
      cleanupFns.push(() => void ctx.close());

      const offStop = bridge.onWorkerStop(async () => {
        stopping = true;
        if (liveRecorder && liveRecorder.state !== 'inactive') liveRecorder.stop();
        if (mainRecorder.state !== 'inactive') mainRecorder.stop();
        await Promise.all([mainStopped, liveStopped]);
        while (pendingReads.size > 0) {
          await Promise.allSettled(pendingReads);
        }
        teardown();
        bridge.workerStopped();
      });
      cleanupFns.push(offStop);

      mainRecorder.start(5000);
      liveRecorder?.start(15000);
      bridge.workerReady({ ok: true, micMissing, mimeType: mainRecorder.mimeType || mimeType || 'audio/webm' });
    } catch (error) {
      teardown();
      bridge.workerReady({ ok: false, error: error instanceof Error ? error.message : 'CAPTURE_WORKER_FAILED' });
    }
  });
}

if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
  bootCaptureWorker();
}
