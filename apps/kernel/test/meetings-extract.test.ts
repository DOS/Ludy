// SPDX-License-Identifier: AGPL-3.0-only
// A video uploaded as a meeting's audio keeps only the audio extracted in crove-media (#3337): what the sandbox says is checked
// before it is trusted, and every failure of the call is a clean refusal.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaClientError, type MediaExtractClient } from '@crove/media-contract/extract';
import { DomainError, LocalDiskStore } from '@crove/kernel-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMediaAudioExtractor, extractAudioFromVideo, mediaAudioExtractorFor, type MediaAudioExtractor } from '../src/meetings-extract.ts';

const opus = new Uint8Array([79, 103, 103, 83, 1, 2, 3]);

function client(answer: () => Promise<{ audio: Uint8Array; durationSeconds: number }>): MediaExtractClient & { drained: Uint8Array[] } {
  const drained: Uint8Array[] = [];
  return {
    drained,
    extractAudio: async (source) => {
      for await (const piece of source) drained.push(piece);
      return answer();
    },
  };
}

async function* pieces(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1, 2]);
  yield new Uint8Array([3]);
}

describe('createMediaAudioExtractor', () => {
  it('sends the pieces to the sandbox and returns the extracted audio with its length', async () => {
    const c = client(async () => ({ audio: opus, durationSeconds: 1800.4 }));
    const out = await createMediaAudioExtractor(c).extract(pieces());
    expect(out).toEqual({ audio: opus, durationSeconds: 1800.4 });
    expect(c.drained.map((p) => [...p])).toEqual([[1, 2], [3]]);
  });

  it('allows the sandbox tolerance of 60 s over the longest recording, and no more', async () => {
    await expect(createMediaAudioExtractor(client(async () => ({ audio: opus, durationSeconds: 7260 }))).extract(pieces())).resolves.toBeDefined();
    await expect(createMediaAudioExtractor(client(async () => ({ audio: opus, durationSeconds: 7261 }))).extract(pieces())).rejects.toMatchObject({ code: 'MEDIA_TOO_LONG', status: 413 });
  });

  it('refuses a result with no length', async () => {
    await expect(createMediaAudioExtractor(client(async () => ({ audio: opus, durationSeconds: 0 }))).extract(pieces())).rejects.toMatchObject({ code: 'MEDIA_PROBE_FAILED', status: 422 });
  });

  it('maps a video with no audio to NO_AUDIO_TRACK, in English and Vietnamese', async () => {
    const error = await createMediaAudioExtractor(client(async () => { throw new MediaClientError('no_audio_stream', 422, 'none'); })).extract(pieces()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: 'NO_AUDIO_TRACK', status: 422 });
    expect((error as DomainError).message).toMatch(/audio track.*\(.*âm thanh.*\)/);
  });

  it('maps a file the sandbox cannot read, or finds too large, to a clean refusal', async () => {
    const answering = (error: unknown) => createMediaAudioExtractor(client(async () => { throw error; }));
    await expect(answering(new MediaClientError('malformed_media', 422, 'bad')).extract(pieces())).rejects.toMatchObject({ code: 'MEDIA_PROBE_FAILED', status: 422 });
    await expect(answering(new MediaClientError('too_large', 413, 'big')).extract(pieces())).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 });
  });

  it('maps everything else to "unavailable"', async () => {
    const answering = (error: unknown) => createMediaAudioExtractor(client(async () => { throw error; }));
    for (const error of [new MediaClientError('busy', 503, 'busy'), new MediaClientError('bad_request', 400, 'x'), new MediaClientError('internal_error', 500, 'x'), new TypeError('fetch failed'), new Error('zod')]) {
      await expect(answering(error).extract(pieces())).rejects.toMatchObject({ code: 'MEDIA_PROBE_UNAVAILABLE', status: 503 });
    }
  });
});

describe('the deadline of an extraction', () => {
  it('ends a call that never answers with MEDIA_EXTRACT_TIMEOUT and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const stuck: MediaExtractClient = {
      extractAudio: (_source, given) => {
        signal = given;
        return new Promise(() => undefined);
      },
    };
    const iterable = pieces();
    await expect(createMediaAudioExtractor(stuck, { timeoutMs: 20 }).extract(iterable)).rejects.toMatchObject({ code: 'MEDIA_EXTRACT_TIMEOUT', status: 503 });
    expect(signal?.aborted).toBe(true);
  });

  it('maps a TimeoutError or AbortError of the client and a timeout answer of the sandbox to the same refusal', async () => {
    const answering = (error: unknown) => createMediaAudioExtractor(client(async () => { throw error; }));
    for (const error of [new DOMException('t', 'TimeoutError'), new DOMException('a', 'AbortError'), new MediaClientError('timeout', 504, 'slow')]) {
      await expect(answering(error).extract(pieces())).rejects.toMatchObject({ code: 'MEDIA_EXTRACT_TIMEOUT', status: 503 });
    }
  });

  it('does not fire after a call that answered in time', async () => {
    const quick = createMediaAudioExtractor(client(async () => ({ audio: opus, durationSeconds: 5 })), { timeoutMs: 20 });
    await expect(quick.extract(pieces())).resolves.toMatchObject({ durationSeconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
});

describe('extractAudioFromVideo', () => {
  const orgId = randomUUID();
  const meetingId = randomUUID();
  const MP4_HEAD = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);
  const video = Buffer.concat([MP4_HEAD, Buffer.alloc(200_000, 7)]);
  let root = '';
  let store: LocalDiskStore;
  let deleted: string[] = [];
  let stored: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crove-extract-video-'));
    const disk = new LocalDiskStore(root);
    store = Object.create(disk, {
      delete: {
        value: async (key: string) => {
          deleted.push(key);
          return disk.delete(key);
        },
      },
      beginStagedWrite: {
        value: async (directory: string) => {
          const write = await disk.beginStagedWrite(directory);
          return {
            write: (bytes: Uint8Array) => write.write(bytes),
            abort: () => write.abort(),
            commit: async (...args: Parameters<typeof write.commit>) => {
              const result = await write.commit(...args);
              stored.push(result.key);
              return result;
            },
          };
        },
      },
    }) as LocalDiskStore;
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const filesLeft = async () => readdir(join(root, 'org', orgId)).catch(() => [] as string[]);
  async function* pieces(...list: Uint8Array[]) {
    for (const piece of list) yield piece;
  }
  const keyOf = () => {
    const key = Buffer.alloc(32, 9);
    return { key, newKey: () => key };
  };
  // An extractor that reads what it is given, as crove-media would, and answers or refuses as the test says.
  const reading = (answer: (read: Buffer) => { audio: Uint8Array; durationSeconds: number }): MediaAudioExtractor => ({
    configured: true,
    extract: async (source) => {
      const parts: Uint8Array[] = [];
      for await (const piece of source) parts.push(piece);
      return answer(Buffer.concat(parts));
    },
  });
  const run = (extractor: MediaAudioExtractor, over: { length?: number; maxBytes?: number; source?: AsyncIterable<Uint8Array>; newKey?: () => Buffer } = {}) =>
    extractAudioFromVideo({
      source: over.source ?? pieces(video.subarray(0, 100), video.subarray(100)),
      expectedLength: over.length ?? video.length,
      maxBytes: over.maxBytes ?? 10_000_000,
      store,
      orgId,
      meetingId,
      extractor,
      ...(over.newKey ? { newKey: over.newKey } : {}),
    });
  const reset = () => {
    deleted = [];
    stored = [];
  };

  it('streams the video back decrypted, returns the audio, deletes the sealed video and zeroes the throwaway key', async () => {
    reset();
    const { key, newKey } = keyOf();
    let seen: Buffer | undefined;
    const out = await run(reading((read) => { seen = read; return { audio: opus, durationSeconds: 3 }; }), { newKey });
    expect(out).toEqual({ audio: opus, durationSeconds: 3 });
    expect(seen?.equals(video)).toBe(true);
    expect(stored).toHaveLength(1);
    expect(deleted).toEqual(stored);
    expect(await filesLeft()).toEqual([]);
    expect(key.equals(Buffer.alloc(32))).toBe(true);
  });

  it('deletes the sealed video and zeroes the key when the sandbox refuses or fails', async () => {
    for (const error of [new DomainError('NO_AUDIO_TRACK', 422, 'none'), new Error('boom')]) {
      reset();
      const { key, newKey } = keyOf();
      await expect(run({ configured: true, extract: async (source) => { for await (const piece of source) void piece; throw error; } }, { newKey })).rejects.toBe(error);
      expect(stored).toHaveLength(1);
      expect(deleted).toEqual(stored);
      expect(await filesLeft()).toEqual([]);
      expect(key.equals(Buffer.alloc(32))).toBe(true);
    }
  });

  it('refuses a file that is not a video container, stores nothing and zeroes the key without calling the sandbox', async () => {
    reset();
    const { key, newKey } = keyOf();
    let called = false;
    const notVideo = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(100)]);
    await expect(run({ configured: true, extract: async () => { called = true; return { audio: opus, durationSeconds: 1 }; } }, { source: pieces(notVideo), length: notVideo.length, newKey })).rejects.toMatchObject({ code: 'INVALID_MEDIA_CONTAINER' });
    expect(called).toBe(false);
    expect(stored).toEqual([]);
    expect(await filesLeft()).toEqual([]);
    expect(key.equals(Buffer.alloc(32))).toBe(true);
  });

  it('refuses over the video cap and a body that does not match its declared length, leaving nothing', async () => {
    for (const over of [{ maxBytes: 1000 }, { length: video.length + 5 }, { length: video.length - 5 }]) {
      reset();
      const { key, newKey } = keyOf();
      await expect(run(reading(() => ({ audio: opus, durationSeconds: 1 })), { ...over, newKey })).rejects.toBeInstanceOf(DomainError);
      expect(await filesLeft()).toEqual([]);
      expect(key.equals(Buffer.alloc(32))).toBe(true);
    }
  });

  it('uses a different throwaway key each time by default', async () => {
    reset();
    await run(reading(() => ({ audio: opus, durationSeconds: 1 })));
    await run(reading(() => ({ audio: opus, durationSeconds: 1 })));
    expect(new Set(stored).size).toBe(2);
    expect(await filesLeft()).toEqual([]);
  });
});

describe('mediaAudioExtractorFor', () => {
  it('is not configured without MEDIA_URL and refuses every call as unavailable', async () => {
    const none = mediaAudioExtractorFor(undefined);
    expect(none.configured).toBe(false);
    await expect(none.extract(pieces())).rejects.toMatchObject({ code: 'MEDIA_PROBE_UNAVAILABLE', status: 503 });
  });

  it('is configured with a MEDIA_URL', () => {
    expect(mediaAudioExtractorFor('http://media.test:8095', 1000).configured).toBe(true);
  });
});
