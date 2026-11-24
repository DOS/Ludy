// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPTURE_NOT_AVAILABLE, CaptureNotAvailableError, captureStub } from '../src/capture/stub.ts';
import type { CaptureModule } from '../src/capture/interface.ts';

describe('capture module slot', () => {
  const module: CaptureModule = captureStub;
  it('refuses start, stop and pieces with a stable code and a clear message', async () => {
    await expect(module.start('system-audio', 'zoom:123')).rejects.toBeInstanceOf(CaptureNotAvailableError);
    await expect(module.start('microphone', 'm')).rejects.toMatchObject({ code: CAPTURE_NOT_AVAILABLE });
    await expect(module.stop()).rejects.toMatchObject({ code: 'CAPTURE_NOT_AVAILABLE' });
    expect(() => module.pieces).toThrow(CaptureNotAvailableError);
    await expect(module.start('system-audio', 'x')).rejects.toThrow(/chưa có tính năng ghi âm.*not available/s);
  });
});

// Nothing outside src/capture records or opens the microphone: shell source files outside src/capture may never mention the capture APIs.
describe('no capture in the shell', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (dir === src && e.name === 'capture' ? [] : files(join(dir, e.name))) : [join(dir, e.name)]));
  const FORBIDDEN = ['getUserMedia', 'desktopCapturer', 'setDisplayMediaRequestHandler', 'askForMediaAccess', 'getDisplayMedia', 'MediaRecorder', 'MediaDevices', "audio: 'loopback'", 'audio: "loopback"'];
  it('mentions none of the capture APIs', () => {
    const offenders = files(src).flatMap((file) => FORBIDDEN.filter((word) => readFileSync(file, 'utf8').includes(word)).map((word) => `${file}: ${word}`));
    expect(offenders).toEqual([]);
  });
});
