// SPDX-License-Identifier: AGPL-3.0-only
// The audio extraction client (#3337): the answer of crove-media is untrusted and parsed strictly; its error codes surface as MediaClientError.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaExtractClient, createMediaJoinClient } from '../src/extract.ts';
import { MediaClientError } from '../src/transport.ts';

const result = (over: Record<string, unknown> = {}) => ({
  durationSeconds: 12.5,
  format: 'opus',
  channels: 1,
  sampleRate: 48000,
  bitrateKbps: 24,
  audioBase64: Buffer.from('opus-bytes').toString('base64'),
  ...over,
});

async function* pieces(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1, 2, 3]);
  yield new Uint8Array([4, 5]);
}

function stubFetch(status: number, body: unknown, seen?: { url?: string | undefined; method?: string | undefined; body?: Uint8Array | undefined }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (seen) {
        seen.url = url;
        seen.method = init.method;
        const chunks: Uint8Array[] = [];
        const reader = (init.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          chunks.push(step.value);
        }
        seen.body = Buffer.concat(chunks);
      }
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('createMediaExtractClient', () => {
  it('streams the source to /extract-audio and decodes the Opus', async () => {
    const seen: { url?: string | undefined; method?: string | undefined; body?: Uint8Array | undefined } = {};
    stubFetch(200, { ok: true, result: result() }, seen);
    const out = await createMediaExtractClient('http://media.test:8095/').extractAudio(pieces());
    expect(seen.url).toBe('http://media.test:8095/extract-audio');
    expect(seen.method).toBe('POST');
    expect([...(seen.body ?? [])]).toEqual([1, 2, 3, 4, 5]);
    expect(Buffer.from(out.audio).toString()).toBe('opus-bytes');
    expect(out.durationSeconds).toBe(12.5);
  });

  it('rejects audio that is not valid base64', async () => {
    stubFetch(200, { ok: true, result: result({ audioBase64: 'not*base64!' }) });
    await expect(createMediaExtractClient('http://media.test').extractAudio(pieces())).rejects.toMatchObject({
      name: 'MediaClientError',
      code: 'internal_error',
    });
  });

  it('rejects an empty audio result', async () => {
    stubFetch(200, { ok: true, result: result({ audioBase64: '' }) });
    await expect(createMediaExtractClient('http://media.test').extractAudio(pieces())).rejects.toBeInstanceOf(MediaClientError);
  });

  it('maps an error answer to a MediaClientError with its code', async () => {
    stubFetch(422, { ok: false, code: 'no_audio_stream', error: 'Input media contains no audio stream to normalize' });
    await expect(createMediaExtractClient('http://media.test').extractAudio(pieces())).rejects.toMatchObject({
      code: 'no_audio_stream',
      status: 422,
    });
  });

  it('refuses a result that does not match the contract', async () => {
    stubFetch(200, { ok: true, result: result({ format: 'mp3' }) });
    await expect(createMediaExtractClient('http://media.test').extractAudio(pieces())).rejects.toThrow();
  });
});

describe('createMediaJoinClient (#3175)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the parts as one framed body to /join-audio and returns the audio and its length', async () => {
    const seen: { url?: string | undefined; method?: string | undefined; body?: Uint8Array | undefined } = {};
    stubFetch(200, { ok: true, result: result() }, seen);
    const out = await createMediaJoinClient('http://media:8095/').joinAudio([
      { length: 3, source: (async function* () { yield new Uint8Array([1, 2, 3]); })() },
      { length: 2, source: (async function* () { yield new Uint8Array([4]); yield new Uint8Array([5]); })() },
    ]);
    expect(seen.url).toBe('http://media:8095/join-audio');
    expect(seen.method).toBe('POST');
    expect([...(seen.body ?? [])]).toEqual([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 2, 4, 5]);
    expect(out.durationSeconds).toBe(12.5);
    expect(Buffer.from(out.audio).toString()).toBe('opus-bytes');
  });

  it('surfaces the codes of the sandbox as MediaClientError', async () => {
    stubFetch(422, { ok: false, code: 'no_audio_stream', error: 'A part of the recording contains no audio stream to join' });
    await expect(createMediaJoinClient('http://media:8095').joinAudio([{ length: 1, source: pieces2() }])).rejects.toMatchObject({ name: 'MediaClientError', code: 'no_audio_stream' });
  });
});

async function* pieces2(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([9]);
}
