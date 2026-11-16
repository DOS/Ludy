// SPDX-License-Identifier: AGPL-3.0-only
// POST /extract-audio with real ffmpeg (#3337): a video file (a local Zoom or Teams MP4 in miniature) comes back as mono Opus only, and a video with no
// audio track is refused as no_audio_stream. Skipped where ffmpeg is not installed; the HTTP and cap behaviour is covered with injected runners in media.test.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { zMediaNormalizeResult } from '../src/types.ts';
import { createMediaApp } from '../src/server.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'crove-extract-audio-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const videoIn = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10'];
const audioIn = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'];

function synth(name: string, args: string[]): Blob {
  const file = join(dir, name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, file]);
  return new Blob([readFileSync(file)]);
}

describe.skipIf(!hasFfmpeg)('POST /extract-audio with ffmpeg', () => {
  it('keeps only the audio of an MP4 with a video track', async () => {
    const mp4 = synth('meeting.mp4', [...videoIn, ...audioIn, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mp4']);
    const app = createMediaApp();
    const res = await app.request('/extract-audio', { method: 'POST', body: mp4 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: unknown };
    const result = zMediaNormalizeResult.parse(body.result);
    expect(result.durationSeconds).toBeGreaterThan(2);
    const opus = Buffer.from(result.audioBase64, 'base64');
    expect(opus.subarray(0, 4).toString('latin1')).toBe('OggS');
    expect(opus.length).toBeLessThan(mp4.size);
  });

  it('refuses a video with no audio track as no_audio_stream', async () => {
    const mp4 = synth('silent.mp4', [...videoIn, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-f', 'mp4']);
    const app = createMediaApp();
    const res = await app.request('/extract-audio', { method: 'POST', body: mp4 });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, code: 'no_audio_stream' });
  });
});
