// SPDX-License-Identifier: AGPL-3.0-only
// Sealing meeting media as it streams (#2780): the format on disk is the blob cipher's, nothing is left behind by a refusal,
// the cap counts while the bytes arrive, and a large upload does not grow the process by anything near its size.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlobTooLargeError,
  DomainError,
  LocalDiskStore,
  decryptBlobBuffer,
  generateMediaDataKey,
  plaintextLengthFromCiphertextLength,
  sha256Hex,
  type BlobMediaBinding,
} from '@crove/kernel-runtime';
import { onepiece, sealMedia, streamPieces } from '../src/media-seal.ts';

const orgId = randomUUID();
const binding: BlobMediaBinding = { orgId, meetingId: randomUUID(), kind: 'audio' };
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01]);

describe('sealMedia', () => {
  let root = '';
  let store: LocalDiskStore;
  const filesLeft = async () => readdir(join(root, 'org', orgId)).catch(() => [] as string[]);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crove-media-seal-'));
    store = new LocalDiskStore(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function* pieces(...list: Uint8Array[]) {
    for (const piece of list) yield piece;
  }
  const run = (source: AsyncIterable<Uint8Array>, over: { maxBytes?: number; kind?: 'audio' | 'video' } = {}) =>
    sealMedia({ source, kind: over.kind ?? 'audio', dataKey, binding, maxBytes: over.maxBytes ?? 10_000_000, store, orgId });
  const dataKey = generateMediaDataKey();

  it('stores ciphertext in the blob cipher format under its own content address, and the plaintext comes back', async () => {
    const plaintext = Buffer.concat([WEBM, randomBytes(200_000)]);
    // Pieces that split the container prefix, and a chunk boundary.
    const sealed = await run(pieces(plaintext.subarray(0, 5), plaintext.subarray(5, 70_000), plaintext.subarray(70_000)));
    const stored = Buffer.from(await store.get(sealed.key));
    expect(sealed).toMatchObject({ contentType: 'audio/webm', plaintextBytes: plaintext.length, size: stored.length, sha256: sha256Hex(stored) });
    expect(sealed.key).toBe(`org/${orgId}/${sealed.sha256}`);
    expect(plaintextLengthFromCiphertextLength(stored.length)).toBe(plaintext.length);
    expect(decryptBlobBuffer(stored, dataKey, binding).equals(plaintext)).toBe(true);
    expect((await filesLeft()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('takes a source in one piece and from a web stream', async () => {
    const plaintext = Buffer.concat([WEBM, randomBytes(1000)]);
    const a = await run(onepiece(plaintext));
    const b = await run(streamPieces(new Blob([plaintext]).stream() as ReadableStream<Uint8Array>));
    for (const sealed of [a, b]) expect(decryptBlobBuffer(Buffer.from(await store.get(sealed.key)), dataKey, binding).equals(plaintext)).toBe(true);
    // Random IVs: the same plaintext seals to two different objects.
    expect(a.key).not.toBe(b.key);
  });

  it('refuses a body that is not a media container, an empty one and one shorter than a header, and writes nothing', async () => {
    const before = await filesLeft();
    await expect(run(pieces(Buffer.from('this is plain text, not media')))).rejects.toMatchObject({ code: 'INVALID_MEDIA_CONTAINER' });
    await expect(run(pieces(Buffer.from('short')))).rejects.toMatchObject({ code: 'INVALID_MEDIA_CONTAINER' });
    await expect(run(pieces())).rejects.toMatchObject({ code: 'NO_FILE' });
    await expect(run(pieces(new Uint8Array(0)))).rejects.toMatchObject({ code: 'NO_FILE' });
    // A video container is not accepted as audio-only types are, and a video kind accepts only video containers.
    await expect(run(pieces(Buffer.concat([Buffer.from('OggS'), randomBytes(100)])), { kind: 'video' })).rejects.toMatchObject({ code: 'INVALID_MEDIA_CONTAINER' });
    expect(await filesLeft()).toEqual(before);
  });

  it('stops at the cap while the bytes arrive, closes the source, and leaves nothing behind', async () => {
    const before = await filesLeft();
    let closed = false;
    let read = 0;
    async function* endless() {
      try {
        yield WEBM;
        for (;;) {
          read += 1;
          yield Buffer.alloc(1024 * 1024, 7);
        }
      } finally {
        closed = true;
      }
    }
    await expect(run(endless(), { maxBytes: 5 * 1024 * 1024 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 });
    expect(closed).toBe(true);
    // It stopped reading at the cap, not after the whole (endless) body.
    expect(read).toBeLessThanOrEqual(6);
    expect(await filesLeft()).toEqual(before);
  });

  it('maps a source that refuses its own size to FILE_TOO_LARGE, and drops a write whose source fails midway', async () => {
    const before = await filesLeft();
    async function* tooBig() {
      yield WEBM;
      throw new BlobTooLargeError('staging/x', 1);
    }
    await expect(run(tooBig())).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    async function* broken() {
      yield WEBM;
      yield randomBytes(100_000);
      throw new Error('connection reset');
    }
    await expect(run(broken())).rejects.toThrow('connection reset');
    expect(await filesLeft()).toEqual(before);
    expect(DomainError).toBeDefined();
  });

  it('writes through a store without a streamed write (held whole, put at the end)', async () => {
    const puts = new Map<string, Uint8Array>();
    const plain = { put: async (k: string, b: Uint8Array) => (puts.set(k, b), 'content:x'), get: async () => new Uint8Array(), delete: async (k: string) => void puts.delete(k) };
    const plaintext = Buffer.concat([WEBM, randomBytes(70_000)]);
    const sealed = await sealMedia({ source: onepiece(plaintext), kind: 'audio', dataKey, binding, maxBytes: 1_000_000, store: plain, orgId });
    expect(decryptBlobBuffer(Buffer.from(puts.get(sealed.key)!), dataKey, binding).equals(plaintext)).toBe(true);
  });

  it('seals 512 MiB without the process growing by anything near that, and the plaintext length is what was sent', async () => {
    const piece = Buffer.alloc(1024 * 1024, 0x5a);
    async function* big() {
      yield Buffer.concat([WEBM, piece]);
      for (let i = 1; i < 512; i += 1) yield piece;
    }
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss - before)), 20);
    let sealed;
    try {
      sealed = await run(big(), { maxBytes: 600 * 1024 * 1024, kind: 'video' });
    } finally {
      clearInterval(sampler);
    }
    expect(sealed.plaintextBytes).toBe(512 * 1024 * 1024 + WEBM.length);
    expect(plaintextLengthFromCiphertextLength(sealed.size)).toBe(sealed.plaintextBytes);
    // The blob is 512 MiB: a buffered path holds it several times over. Streamed, the growth is a few pieces and parts.
    expect(peak).toBeLessThan(160 * 1024 * 1024);
    await store.delete(sealed.key);
  }, 180_000);
});
