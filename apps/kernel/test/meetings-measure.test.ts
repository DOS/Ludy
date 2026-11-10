// SPDX-License-Identifier: AGPL-3.0-only
// The length of meeting media is measured in crove-media, never taken from the client (#2985): the sealed blob is read back and
// decrypted window by window, and what the sandbox says is checked before it is trusted.
import { randomBytes } from 'node:crypto';
import { MediaClientError, type MediaClient, type MediaProbeResult } from '@crove/media-contract';
import { DomainError, encryptBlobBuffer, BLOB_CHUNK_SIZE, type BlobStore } from '@crove/kernel-runtime';
import { describe, expect, it } from 'vitest';
import { createMediaMeasurer, decryptedWindows, mediaMeasurerFor } from '../src/meetings-measure.ts';

const binding = { orgId: 'org-1', meetingId: 'meeting-1', kind: 'audio' } as const;

function probe(over: Partial<MediaProbeResult> = {}): MediaProbeResult {
  return {
    durationSeconds: 1800.4,
    format: 'ogg',
    hasAudio: true,
    hasVideo: false,
    audioCodec: 'opus',
    audioChannels: 1,
    audioSampleRate: 48000,
    videoCodec: null,
    videoWidth: null,
    videoHeight: null,
    ...over,
  };
}

function client(answer: () => Promise<MediaProbeResult>): MediaClient & { drained: Uint8Array[] } {
  const drained: Uint8Array[] = [];
  const fail = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    drained,
    probe: async (bytes) => {
      drained.push(bytes);
      return answer();
    },
    probeStream: async (chunks) => {
      for await (const piece of chunks) drained.push(piece);
      return answer();
    },
    normalize: fail,
    split: fail,
    repackageVideo: fail,
    process: fail,
  };
}

function storeOf(blob: Uint8Array, ranged: boolean): BlobStore {
  const base = {
    get: async (_key: string, _generation?: string | null, maxBytes?: number) => {
      if (maxBytes !== undefined && blob.length > maxBytes) throw new Error('too large');
      return blob;
    },
  };
  return (ranged ? { ...base, getRange: async (_k: string, start: number, end: number) => blob.subarray(start, end + 1) } : base) as unknown as BlobStore;
}

describe('decryptedWindows', () => {
  // Three whole 64 KiB chunks and a part of a fourth, read in windows that are not a chunk multiple apart.
  const plain = randomBytes(BLOB_CHUNK_SIZE * 3 + 777);
  const dataKey = randomBytes(32);
  const sealed = new Uint8Array(encryptBlobBuffer(plain, dataKey, binding));

  for (const ranged of [true, false]) {
    it(`returns the plaintext in order, ${ranged ? 'by ranged reads' : 'from a whole read'}`, async () => {
      const pieces: Uint8Array[] = [];
      for await (const piece of decryptedWindows(storeOf(sealed, ranged), { storageKey: 'k', generation: null, sizeBytes: sealed.length }, dataKey, binding, BLOB_CHUNK_SIZE + 5)) {
        expect(piece.length).toBeLessThanOrEqual(BLOB_CHUNK_SIZE + 5);
        pieces.push(piece);
      }
      expect(Buffer.concat(pieces).equals(plain)).toBe(true);
    });
  }

  it('does not decrypt for another meeting or a changed byte', async () => {
    const read = async (blob: Uint8Array, bound: typeof binding | { orgId: string; meetingId: string; kind: 'audio' }) => {
      for await (const piece of decryptedWindows(storeOf(blob, true), { storageKey: 'k', generation: null, sizeBytes: blob.length }, dataKey, bound)) void piece;
    };
    await expect(read(sealed, { ...binding, meetingId: 'meeting-2' })).rejects.toThrow();
    const flipped = new Uint8Array(sealed);
    flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 1;
    await expect(read(flipped, binding)).rejects.toThrow();
  });
});

describe('createMediaMeasurer', () => {
  it('uses the measured length, rounded up, and ignores anything else', async () => {
    const c = client(async () => probe({ durationSeconds: 1800.4 }));
    async function* pieces() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }
    expect(await createMediaMeasurer(c).measure('audio', pieces())).toBe(1801);
    expect(c.drained.map((p) => p.length)).toEqual([2, 1]);
  });

  it('measures bytes in memory the same way', async () => {
    expect(await createMediaMeasurer(client(async () => probe({ durationSeconds: 59.2 }))).measureBytes('audio', new Uint8Array([1]))).toBe(60);
  });

  it('counts a length under a second as one second, so a row is never zero long', async () => {
    expect(await createMediaMeasurer(client(async () => probe({ durationSeconds: 0.2 }))).measureBytes('audio', new Uint8Array([1]))).toBe(1);
  });

  it('refuses a recording longer than the plan allows', async () => {
    await expect(createMediaMeasurer(client(async () => probe({ durationSeconds: 7201 }))).measureBytes('audio', new Uint8Array([1]))).rejects.toMatchObject({ code: 'MEDIA_TOO_LONG', status: 413 });
  });

  it('refuses a file without the stream of its kind', async () => {
    await expect(createMediaMeasurer(client(async () => probe({ hasAudio: false }))).measureBytes('audio', new Uint8Array([1]))).rejects.toMatchObject({ code: 'MEDIA_PROBE_FAILED', status: 422 });
    await expect(createMediaMeasurer(client(async () => probe({ hasVideo: false }))).measureBytes('video', new Uint8Array([1]))).rejects.toMatchObject({ code: 'MEDIA_PROBE_FAILED', status: 422 });
  });

  it('maps a hostile file to a clean refusal, and a sandbox that is down to "unavailable"', async () => {
    const answering = (error: unknown) => createMediaMeasurer(client(async () => Promise.reject(error)));
    await expect(answering(new MediaClientError('malformed_media', 422, 'bad')).measureBytes('audio', new Uint8Array([1]))).rejects.toMatchObject({ code: 'MEDIA_PROBE_FAILED', status: 422 });
    await expect(answering(new MediaClientError('too_large', 413, 'big')).measureBytes('audio', new Uint8Array([1]))).rejects.toMatchObject({ code: 'MEDIA_TOO_LONG', status: 413 });
    for (const error of [new MediaClientError('busy', 503, 'busy'), new MediaClientError('timeout', 504, 'slow'), new MediaClientError('internal_error', 500, 'x'), new TypeError('fetch failed')]) {
      await expect(answering(error).measureBytes('audio', new Uint8Array([1]))).rejects.toMatchObject({ code: 'MEDIA_PROBE_UNAVAILABLE', status: 503 });
    }
  });

  it('never puts what the sandbox said in the refusal', async () => {
    const error = await createMediaMeasurer(client(async () => Promise.reject(new MediaClientError('malformed_media', 422, 'secret-detail /data/scratch/x')))).measureBytes('audio', new Uint8Array([1])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(String((error as Error).message)).not.toContain('secret-detail');
  });
});

describe('mediaMeasurerFor', () => {
  it('is not configured without MEDIA_URL and refuses every call as unavailable', async () => {
    const none = mediaMeasurerFor(undefined);
    expect(none.configured).toBe(false);
    await expect(none.measureBytes('audio', new Uint8Array([1]))).rejects.toMatchObject({ code: 'MEDIA_PROBE_UNAVAILABLE', status: 503 });
    await expect(none.measure('audio', (async function* () { yield new Uint8Array([1]); })())).rejects.toMatchObject({ code: 'MEDIA_PROBE_UNAVAILABLE' });
  });

  it('is configured with a URL', () => {
    expect(mediaMeasurerFor('http://crove-media:8095').configured).toBe(true);
  });
});
