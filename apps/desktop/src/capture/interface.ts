// SPDX-License-Identifier: AGPL-3.0-only
// The capture module's boundary (ADR-0055 section 4 & slice 3, #4516): separates shell lifecycle/auth from platform
// audio capture. Keeps Slice 2's CaptureModule signature intact and adds optional desktop process-target & level events.
export type CaptureSource = 'system-audio' | 'microphone' | 'system-audio-and-microphone';

export interface CapturePiece {
  // 0 for the first piece of a capture.
  sequence: number;
  // Milliseconds since the capture started.
  offsetMs: number;
  mimeType: string;
  data: Uint8Array;
}

export interface CaptureStartOptions {
  // Native target process id for Win32 WASAPI per-app loopback.
  targetPid?: number;
  // Only true after the member explicitly confirmed whole-system audio fallback on Win10 < build 20348.
  allowSystemFallback?: boolean;
  onLiveChunk?: (piece: { bytes: Uint8Array; mimeType: string; durationMs: number }) => void;
  onSilentAlert?: (kind: 'silent-loopback' | 'silent-mic') => void;
  onMicMissing?: () => void;
  onUnexpectedEnd?: (reason: 'device_lost' | 'unknown') => void;
}

export interface CaptureModule {
  start(source: CaptureSource, meetingKey: string, options?: CaptureStartOptions): Promise<void>;
  readonly pieces: AsyncIterable<CapturePiece>;
  stop(): Promise<void>;
}

export const PROCESS_LOOPBACK_UNSUPPORTED = 'PROCESS_LOOPBACK_UNSUPPORTED';

export class ProcessLoopbackUnsupportedError extends Error {
  readonly code = PROCESS_LOOPBACK_UNSUPPORTED;
  constructor() {
    super('Windows trên máy này chưa hỗ trợ ghi âm riêng từng ứng dụng (cần Windows 10 build 20348+ hoặc Windows 11).');
    this.name = 'ProcessLoopbackUnsupportedError';
  }
}
