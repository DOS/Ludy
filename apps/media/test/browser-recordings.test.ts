// SPDX-License-Identifier: AGPL-3.0-only
// What each browser's MediaRecorder produces normalizes through crove-media (AI Meeting Notes M7, #2581): WebM/Opus
// (Chrome, Edge, Firefox), Ogg/Opus (Firefox, audio only), fragmented MP4/AAC (Safari), the same with video, and a
// recording cut off mid-write (the recovered one after a crash). The files are synthesized with ffmpeg in the shapes
// those recorders write (no duration header, fragments); the real-browser output itself is not produced here.
// Skipped where ffmpeg is not installed; the crove-media image job runs the same cases in the container (smoke.mjs).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeAudioFile } from '../src/ffmpeg.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'crove-browser-rec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FRAGMENTED = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'];
const audioIn = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12'];
const videoIn = ['-f', 'lavfi', '-i', 'testsrc=duration=6:size=1280x720:rate=15', '-f', 'lavfi', '-i', 'sine=duration=6'];

const CASES: ReadonlyArray<{ name: string; file: string; args: string[] }> = [
  { name: 'Chrome, Edge, Firefox audio (audio/webm;codecs=opus)', file: 'audio.webm', args: [...audioIn, '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm'] },
  { name: 'Firefox audio (audio/ogg;codecs=opus)', file: 'audio.ogg', args: [...audioIn, '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg'] },
  { name: 'Safari audio (audio/mp4, AAC, fragmented)', file: 'audio.mp4', args: [...audioIn, '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-f', 'mp4', ...FRAGMENTED] },
  { name: 'Chrome, Edge, Firefox video (video/webm, VP8 and Opus)', file: 'video.webm', args: [...videoIn, '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-f', 'webm'] },
  { name: 'Safari video (video/mp4, H.264 and AAC, fragmented)', file: 'video.mp4', args: [...videoIn, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', ...FRAGMENTED] },
];

describe.skipIf(!hasFfmpeg)('browser recordings normalize to mono Opus', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const input = join(dir, c.file);
      execFileSync('ffmpeg', ['-y', '-v', 'error', ...c.args, input]);
      const result = await normalizeAudioFile(input, `${input}.opus`);
      expect(result.format).toBe('opus');
      expect(result.channels).toBe(1);
      expect(result.durationSeconds).toBeGreaterThan(5);
      expect(statSync(`${input}.opus`).size).toBeGreaterThan(1000);
    }, 60_000);
  }

  it('a WebM cut off mid-recording (a recovered one) still normalizes the part that was saved', async () => {
    const input = join(dir, 'cut.webm');
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...audioIn, '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', input]);
    truncateSync(input, Math.floor(readFileSync(input).byteLength * 0.6));
    const result = await normalizeAudioFile(input, `${input}.opus`);
    expect(result.format).toBe('opus');
    expect(result.durationSeconds).toBeGreaterThan(2);
  }, 60_000);
});
