// SPDX-License-Identifier: AGPL-3.0-only
// The capture module's door (ADR-0055 section 4). Slice 2 ships the shell without capture: the interface is declared here and its
// only implementation (stub.ts) refuses. Slice 3 (the Meetings line) fills it, so the shell and the audio core can change
// independently, and the shell could move to another framework without touching the audio core.
//
//   start(source, meetingKey)  begins capturing `source` for the meeting `meetingKey` (the one-meeting rule of slice 1 decides who may).
//   pieces                     the recorded pieces, in order, as an async iterable that ends after stop().
//   stop()                     ends the capture and lets `pieces` finish.
export type CaptureSource = 'system-audio' | 'microphone' | 'system-audio-and-microphone';

export interface CapturePiece {
  // 0 for the first piece of a capture.
  sequence: number;
  // Milliseconds since the capture started.
  offsetMs: number;
  mimeType: string;
  data: Uint8Array;
}

export interface CaptureModule {
  start(source: CaptureSource, meetingKey: string): Promise<void>;
  readonly pieces: AsyncIterable<CapturePiece>;
  stop(): Promise<void>;
}
