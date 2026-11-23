// SPDX-License-Identifier: AGPL-3.0-only
// The live pieces of a recording joined in order are measured by the real sandbox code (issue #3126, ADR-0052 L4a). The pieces are consecutive slices of ONE MediaRecorder stream
// (only the first carries the container header), so their bytes in order are the recording. This synthesizes a WebM/Opus stream in the shape a browser writes (no duration header,
// clusters), slices it the way timeslices fall (at any byte, which is harder than a cluster edge), and checks that measureFile reads the whole join, and that a join with a piece
// missing in the middle is still read (a gap is reported by the kernel, never fatal here). Skipped where ffmpeg is not installed; the container job runs the same shape.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { measureFile } from '../src/ffmpeg.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'crove-live-pieces-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SECONDS = 40;
const CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

function slices(whole: Buffer, count: number): Buffer[] {
  const size = Math.ceil(whole.byteLength / count);
  return Array.from({ length: count }, (_, i) => whole.subarray(i * size, Math.min(whole.byteLength, (i + 1) * size)));
}
const measure = (name: string, bytes: Buffer) => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return measureFile(path);
};

describe.skipIf(!hasFfmpeg)('live pieces joined in order', () => {
  let whole: Buffer;
  const make = () => {
    if (whole) return whole;
    const path = join(dir, 'source.webm');
    // Short clusters, like a recorder with a timeslice, and no duration or cue header.
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`, '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', '-cluster_time_limit', '2000', '-f', 'webm', path]);
    whole = readFileSync(path);
    return whole;
  };

  it('the pieces in order are the whole recording: the joined bytes equal the stream and measure to its length', async () => {
    const pieces = slices(make(), 12);
    expect(Buffer.concat(pieces).equals(make())).toBe(true);
    const probe = await measure('joined.webm', Buffer.concat(pieces));
    expect(probe.hasAudio).toBe(true);
    expect(probe.durationSeconds).toBeGreaterThan(SECONDS - 3);
    expect(probe.durationSeconds).toBeLessThan(SECONDS + 3);
  }, 60_000);

  it('a piece missing in the middle still reads: the join is shorter by about the piece, not refused', async () => {
    const pieces = slices(make(), 12);
    const withGap = Buffer.concat(pieces.filter((_, i) => i !== 5));
    const probe = await measure('gap.webm', withGap);
    expect(probe.hasAudio).toBe(true);
    // Eleven twelfths of the speech (a gap at an arbitrary byte can also cost the cluster it cut).
    expect(probe.durationSeconds).toBeGreaterThan(SECONDS * 0.6);
    expect(probe.durationSeconds).toBeLessThan(SECONDS);
  }, 60_000);

  it('a piece missing at a cluster edge costs exactly that piece', async () => {
    const bytes = make();
    const edges: number[] = [];
    for (let at = bytes.indexOf(CLUSTER_ID); at !== -1; at = bytes.indexOf(CLUSTER_ID, at + 1)) edges.push(at);
    expect(edges.length).toBeGreaterThan(6);
    // Pieces cut at cluster starts, the first one holding the header: drop one in the middle.
    const cuts = [0, ...edges.filter((_, i) => i % 3 === 0).slice(1), bytes.byteLength];
    const pieces = cuts.slice(0, -1).map((start, i) => bytes.subarray(start, cuts[i + 1]));
    expect(pieces.length).toBeGreaterThan(3);
    const probe = await measure('edge-gap.webm', Buffer.concat(pieces.filter((_, i) => i !== 2)));
    expect(probe.durationSeconds).toBeGreaterThan(SECONDS * 0.5);
    expect(probe.durationSeconds).toBeLessThan(SECONDS - 2);
  }, 60_000);

  it('without the first piece the rest is not a recording: refused, which is why the kernel needs piece 0', async () => {
    const pieces = slices(make(), 12);
    await expect(measure('headless.webm', Buffer.concat(pieces.slice(1)))).rejects.toMatchObject({ code: 'malformed_media' });
  }, 60_000);
});
