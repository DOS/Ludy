// SPDX-License-Identifier: AGPL-3.0-only
// Audio level calculation & silent-track detection for loopback and microphone tracks (ADR-0055 sections 4 and 6).
// Samples RMS over windows (default 500 ms) so a dead/silent loopback or mic track notifies the recorder within 3 to 5 seconds.

export interface SilenceMonitorOptions {
  // Minimum RMS above which a frame counts as active audio.
  silenceThreshold?: number;
  // Number of silent ticks before reporting a silent track (e.g., 7 ticks * 500 ms = 3.5 s).
  ticksBeforeAlert?: number;
  checkLoopback: boolean;
  checkMic: boolean;
}

export type SilentAlertKind = 'silent-loopback' | 'silent-mic';

export interface SilenceSnapshot {
  loopbackSilent: boolean;
  micSilent: boolean;
  loopbackRms: number;
  micRms: number;
  newlyTriggered: SilentAlertKind[];
}

export function rmsInt16Interleaved(pcm: Uint8Array): number {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const norm = view.getInt16(i * 2, true) / 32768;
    sumSq += norm * norm;
  }
  return Math.sqrt(sumSq / sampleCount);
}

export function rmsFloat32(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}

export function createSilenceMonitor(options: SilenceMonitorOptions) {
  const threshold = options.silenceThreshold ?? 1e-4;
  const ticksBeforeAlert = options.ticksBeforeAlert ?? 7;
  let loopbackSilentTicks = 0;
  let micSilentTicks = 0;
  let loopbackAlerted = false;
  let micAlerted = false;

  return {
    recordTick(loopbackRms: number, micRms: number): SilenceSnapshot {
      const newlyTriggered: SilentAlertKind[] = [];
      if (options.checkLoopback) {
        if (loopbackRms <= threshold) {
          loopbackSilentTicks += 1;
          if (!loopbackAlerted && loopbackSilentTicks >= ticksBeforeAlert) {
            loopbackAlerted = true;
            newlyTriggered.push('silent-loopback');
          }
        } else {
          loopbackSilentTicks = 0;
          loopbackAlerted = false;
        }
      }
      if (options.checkMic) {
        if (micRms <= threshold) {
          micSilentTicks += 1;
          if (!micAlerted && micSilentTicks >= ticksBeforeAlert) {
            micAlerted = true;
            newlyTriggered.push('silent-mic');
          }
        } else {
          micSilentTicks = 0;
          micAlerted = false;
        }
      }
      return {
        loopbackSilent: loopbackAlerted,
        micSilent: micAlerted,
        loopbackRms,
        micRms,
        newlyTriggered,
      };
    },
    reset(): void {
      loopbackSilentTicks = 0;
      micSilentTicks = 0;
      loopbackAlerted = false;
      micAlerted = false;
    },
  };
}
