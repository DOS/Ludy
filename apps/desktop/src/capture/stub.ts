// SPDX-License-Identifier: AGPL-3.0-only
// The only capture module in this slice: it refuses every call, so nothing in the shell records or opens the microphone.
import type { CaptureModule, CapturePiece, CaptureSource } from './interface.ts';

export const CAPTURE_NOT_AVAILABLE = 'CAPTURE_NOT_AVAILABLE';

export class CaptureNotAvailableError extends Error {
  readonly code = CAPTURE_NOT_AVAILABLE;
  constructor() {
    super('Ludy Desktop chưa có tính năng ghi âm cuộc họp (chưa được cài). Meeting capture is not available in this version of Ludy Desktop.');
    this.name = 'CaptureNotAvailableError';
  }
}

export const captureStub: CaptureModule = {
  start(_source: CaptureSource, _meetingKey: string): Promise<void> {
    return Promise.reject(new CaptureNotAvailableError());
  },
  get pieces(): AsyncIterable<CapturePiece> {
    throw new CaptureNotAvailableError();
  },
  stop(): Promise<void> {
    return Promise.reject(new CaptureNotAvailableError());
  },
};
