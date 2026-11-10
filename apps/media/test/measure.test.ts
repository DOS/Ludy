// SPDX-License-Identifier: AGPL-3.0-only
// The length of a recording is what its stream holds, not what its container declares (#2985): a browser's streamed WebM declares
// none, and a header is the sender's word. Skipped where ffmpeg is not installed; the crove-media image job runs the same in the container.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { measureFile, probeFile } from '../src/ffmpeg.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'crove-measure-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Written to a pipe, as MediaRecorder streams it: nothing can seek back to write a duration.
function piped(name: string, args: string[]): string {
  const bytes = execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, '-f', args.includes('mp4') ? 'mp4' : 'webm', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe.skipIf(!hasFfmpeg)('measureFile', () => {
  it('reads the length of a streamed WebM that declares none', async () => {
    const path = piped('stream.webm', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-ac', '1', '-c:a', 'libopus']);
    // The probe trusts the container and finds nothing; the measure reads the stream.
    expect((await probeFile(path)).durationSeconds).toBe(0);
    const measured = await measureFile(path);
    expect(measured.hasAudio).toBe(true);
    expect(measured.durationSeconds).toBeGreaterThan(6.5);
    expect(measured.durationSeconds).toBeLessThan(7.5);
  }, 60_000);

  it('reads a video with no audio track by its packets', async () => {
    const path = piped('video-only.webm', ['-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=10', '-c:v', 'libvpx', '-b:v', '200k']);
    const measured = await measureFile(path);
    expect(measured.hasVideo).toBe(true);
    expect(measured.hasAudio).toBe(false);
    expect(measured.durationSeconds).toBeGreaterThan(4.5);
    expect(measured.durationSeconds).toBeLessThan(5.5);
  }, 60_000);

  it('is not fooled by a header that says less than the stream holds', async () => {
    // A seekable file: ffmpeg writes the true duration. Overwrite the Segment duration bytes with a one-second value.
    const real = join(dir, 'real.webm');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9', '-ac', '1', '-c:a', 'libopus', real]);
    expect((await probeFile(real)).durationSeconds).toBeGreaterThan(8.5);
    const lie = join(dir, 'lie.webm');
    // Matroska Duration element (0x4489) holds a float: patch every occurrence in the first 4 KiB to 1000 ms (a 4-byte float is 0x447A0000).
    const bytes = Buffer.from(execFileSync('cat', [real]));
    for (let i = 0; i < Math.min(bytes.length - 7, 4096); i += 1) {
      if (bytes[i] === 0x44 && bytes[i + 1] === 0x89 && (bytes[i + 2] === 0x84 || bytes[i + 2] === 0x88)) {
        if (bytes[i + 2] === 0x84) bytes.writeFloatBE(1000, i + 3);
        else bytes.writeDoubleBE(1000, i + 3);
      }
    }
    writeFileSync(lie, bytes);
    expect((await probeFile(lie)).durationSeconds).toBeLessThan(2);
    const measured = await measureFile(lie);
    expect(measured.durationSeconds).toBeGreaterThan(8.5);
  }, 60_000);

  it('is not fooled by timestamps that wrap or restart (#2985)', async () => {
    const real = join(dir, 'long.webm');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-ac', '1', '-c:a', 'libopus', real]);
    // Timestamps that wrap every 5 s: the output time stalls near 5 s while all 30 s are still decoded.
    const wrapped = join(dir, 'wrapped.webm');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', real, '-c:a', 'copy', '-bsf:a', 'setts=ts=mod(PTS\\,5000)', wrapped]);
    const wrappedSeconds = (await measureFile(wrapped)).durationSeconds;
    expect(wrappedSeconds).toBeGreaterThan(29);
    expect(wrappedSeconds).toBeLessThan(31);
    // Two recordings joined end to end (a recovered MediaRecorder file can have this shape): 60 s, not 30.
    const joined = join(dir, 'joined.webm');
    writeFileSync(joined, Buffer.concat([readFileSync(real), readFileSync(real)]));
    const joinedSeconds = (await measureFile(joined)).durationSeconds;
    expect(joinedSeconds).toBeGreaterThan(59);
    expect(joinedSeconds).toBeLessThan(61);
  }, 120_000);

  it('refuses garbage as unreadable', async () => {
    const path = join(dir, 'garbage.webm');
    writeFileSync(path, Buffer.from('not a media file at all, just text '.repeat(50)));
    await expect(measureFile(path)).rejects.toMatchObject({ code: 'malformed_media' });
  }, 60_000);
});
