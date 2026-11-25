// SPDX-License-Identifier: AGPL-3.0-only
// POST /join-audio (#3175): the parts of one recording (a Zoom call made in several segments) travel as one framed body and come back as ONE mono Opus, in order, whatever each part's format. The framing is
// strict (a count outside 1 to 16, a part of no bytes, a length past the end of the body or a byte after the last part is a bad_request), a part with no audio is refused, and the body cap and the duration cap of the
// other audio endpoints hold. The join itself needs ffmpeg and is skipped where it is not installed; the framing needs none.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterAll, describe, expect, it } from 'vitest';
import { framedParts, createMediaJoinClient, type JoinPartSource } from '@ludy/media-contract/extract';
import { zMediaNormalizeResult } from '../src/types.ts';
import { createMediaApp } from '../src/server.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'crove-join-audio-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function synth(name: string, args: string[]): Uint8Array {
  const file = join(dir, name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, file]);
  return new Uint8Array(readFileSync(file));
}
const tone = (name: string, hz: number, seconds: number, extra: string[] = []) => synth(name, ['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}`, ...extra]);

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  // Two pieces, so a part is not always one chunk.
  const half = Math.max(1, Math.floor(bytes.length / 2));
  yield bytes.subarray(0, half);
  if (half < bytes.length) yield bytes.subarray(half);
}
const part = (bytes: Uint8Array): JoinPartSource => ({ length: bytes.length, source: once(bytes) });
async function body(parts: JoinPartSource[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of framedParts(parts)) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}
const post = (app: ReturnType<typeof createMediaApp>, bytes: Uint8Array) => app.request('/join-audio', { method: 'POST', body: new Blob([bytes as BlobPart]) });
const frames = (count: number, lengths: number[], tail = 0) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(count);
  const out = [head];
  for (const length of lengths) {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(length));
    out.push(len, Buffer.alloc(Math.min(length, 64), 1));
  }
  if (tail > 0) out.push(Buffer.alloc(tail, 2));
  return new Uint8Array(Buffer.concat(out));
};

describe('the framing', () => {
  it('writes a count, then each part as its length and bytes', async () => {
    const framed = await body([part(new Uint8Array([1, 2, 3])), part(new Uint8Array([4, 5]))]);
    expect([...framed]).toEqual([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 2, 4, 5]);
  });

  it('refuses a part that produces another number of bytes than it declared, and a count outside 1 to 16', async () => {
    await expect(body([{ length: 5, source: once(new Uint8Array([1, 2, 3])) }])).rejects.toThrow('fewer');
    await expect(body([{ length: 2, source: once(new Uint8Array([1, 2, 3])) }])).rejects.toThrow('more');
    await expect(body([])).rejects.toThrow(RangeError);
    await expect(body(Array.from({ length: 17 }, () => part(new Uint8Array([1]))))).rejects.toThrow(RangeError);
    await expect(body([{ length: 0, source: once(new Uint8Array()) }])).rejects.toThrow(RangeError);
  });
});

describe('POST /join-audio refuses a body that is not framed exactly', () => {
  const app = createMediaApp();
  for (const [name, bytes] of [
    ['a count of none', frames(0, [])],
    ['seventeen parts', frames(17, Array.from({ length: 17 }, () => 4))],
    ['a body that ends inside the count', new Uint8Array([0, 0])],
    ['a length that runs past the end', (() => { const b = frames(1, [4]); return b.subarray(0, b.length - 1); })()],
    ['a part of no bytes', frames(1, [0])],
    ['a byte after the last part', frames(1, [4], 1)],
  ] as const) {
    it(`${name} is a bad_request`, async () => {
      const res = await post(app, bytes);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('bad_request');
    });
  }

  it('an empty body is a bad_request and a body over the cap is too_large', async () => {
    expect((await app.request('/join-audio', { method: 'POST' })).status).toBe(400);
    // The join's cap is half the input cap (the parts are copied out of the body).
    const small = createMediaApp({ maxInputBytes: 100 });
    expect((await post(small, new Uint8Array(60))).status).toBe(413);
    expect((await post(small, frames(1, [4]))).status).not.toBe(413);
  });
});

describe.skipIf(!hasFfmpeg)('POST /join-audio with ffmpeg', () => {
  const app = createMediaApp();

  it('joins parts of different formats into one mono Opus whose length is the sum of the parts', async () => {
    const first = tone('one.m4a', 440, 3, ['-c:a', 'aac', '-ar', '44100', '-ac', '2', '-f', 'ipod']);
    const second = tone('two.wav', 880, 2, ['-ar', '16000', '-ac', '1']);
    const third = tone('three.opus', 660, 1, ['-c:a', 'libopus', '-ac', '1']);
    const res = await post(app, await body([part(first), part(second), part(third)]));
    expect(res.status).toBe(200);
    const result = zMediaNormalizeResult.parse(((await res.json()) as { result: unknown }).result);
    expect(Math.abs(result.durationSeconds - 6)).toBeLessThan(0.5);
    expect(Buffer.from(result.audioBase64, 'base64').subarray(0, 4).toString('latin1')).toBe('OggS');
  });

  it('keeps the order of the parts (the join of a 1 s and a 4 s part is not the join of the 4 s and the 1 s in length, and the two differ in content)', async () => {
    const short = tone('s.wav', 440, 1, ['-ar', '48000', '-ac', '1']);
    const long = tone('l.wav', 880, 4, ['-ar', '48000', '-ac', '1']);
    const ab = zMediaNormalizeResult.parse(((await (await post(app, await body([part(short), part(long)]))).json()) as { result: unknown }).result);
    const ba = zMediaNormalizeResult.parse(((await (await post(app, await body([part(long), part(short)]))).json()) as { result: unknown }).result);
    expect(Math.abs(ab.durationSeconds - 5)).toBeLessThan(0.5);
    expect(Math.abs(ba.durationSeconds - 5)).toBeLessThan(0.5);
    expect(ab.audioBase64).not.toBe(ba.audioBase64);
  });

  it('takes the audio of a part that also carries video', async () => {
    const mp4 = synth('v.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mp4']);
    const audio = tone('a.wav', 440, 2, ['-ar', '48000', '-ac', '1']);
    const res = await post(app, await body([part(mp4), part(audio)]));
    expect(res.status).toBe(200);
    const result = zMediaNormalizeResult.parse(((await res.json()) as { result: unknown }).result);
    expect(Math.abs(result.durationSeconds - 4)).toBeLessThan(0.6);
  });

  it('refuses a part with no audio, and a part that is not media at all', async () => {
    const silent = synth('silent.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-f', 'mp4']);
    const audio = tone('ok.wav', 440, 1, ['-ar', '48000', '-ac', '1']);
    const noAudio = await post(app, await body([part(audio), part(silent)]));
    expect(noAudio.status).toBe(422);
    expect(((await noAudio.json()) as { code: string }).code).toBe('no_audio_stream');
    const junk = await post(app, await body([part(audio), part(new Uint8Array(Buffer.from('this is not media at all, only text')))]));
    expect(junk.status).toBe(422);
    expect(((await junk.json()) as { code: string }).code).toBe('malformed_media');
  });

  it('does not let a timestamp jump inside a part stretch the answer: the length is what the parts hold', async () => {
    const jumped = synth('jump.opus', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', '-output_ts_offset', '500']);
    const plain = tone('plain.wav', 880, 2, ['-ar', '48000', '-ac', '1']);
    const res = await post(app, await body([part(jumped), part(plain)]));
    expect(res.status).toBe(200);
    const result = zMediaNormalizeResult.parse(((await res.json()) as { result: unknown }).result);
    expect(Math.abs(result.durationSeconds - 4)).toBeLessThan(0.6);
  });

  it('refuses parts that together are longer than a recording may be', async () => {
    // 4000 s of 8-bit mono at 8 kHz is 32 MB of plain samples: cheap to make and to measure, and two of them are longer than the 7200 s a recording may last.
    const long = (name: string) => synth(name, ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=4000:sample_rate=8000', '-c:a', 'pcm_u8', '-ar', '8000', '-ac', '1']);
    const res = await post(app, await body([part(long('long1.wav')), part(long('long2.wav'))]));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe('too_large');
  }, 120_000);

  it('joins a single part (a recording of one segment) like normalize', async () => {
    const res = await post(app, await body([part(tone('one.wav', 440, 2, ['-ar', '48000', '-ac', '1']))]));
    expect(res.status).toBe(200);
    expect(zMediaNormalizeResult.parse(((await res.json()) as { result: unknown }).result).durationSeconds).toBeGreaterThan(1.5);
  });

  it('answers the client of the contract end to end', async () => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const client = createMediaJoinClient(`http://127.0.0.1:${port}`);
      const out = await client.joinAudio([part(tone('c1.wav', 440, 1, ['-ar', '48000', '-ac', '1'])), part(tone('c2.wav', 550, 1, ['-ar', '48000', '-ac', '1']))]);
      expect(Math.abs(out.durationSeconds - 2)).toBeLessThan(0.5);
      expect(Buffer.from(out.audio.subarray(0, 4)).toString('latin1')).toBe('OggS');
    } finally {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
