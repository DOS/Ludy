// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BLOB_CHUNK_SIZE,
  CIPHER_CHUNK_FULL_SIZE,
  blobChunkAad,
  createBlobEncryptor,
  decryptBlobBuffer,
  decryptBlobChunks,
  deriveMediaWrapKey,
  encryptBlobBuffer,
  generateMediaDataKey,
  mapPlaintextRangeToChunks,
  mediaKeyAad,
  plaintextLengthFromCiphertextLength,
  unwrapMediaKey,
  wrapMediaKey,
  type BlobMediaBinding,
  type MediaKeyBinding,
} from '../src/blob-cipher.ts';

const ROOT_KEY = randomBytes(32);
const WRONG_ROOT_KEY = randomBytes(32);

const BINDING: MediaKeyBinding = {
  orgId: '01a19b3a-2d5f-773b-a8ba-a1345bd79da7',
  meetingId: '01a19b3a-2d5f-773b-a8ba-a1345bd79da8',
  kind: 'audio',
  keyId: 'key-1',
};

const BLOB_BINDING: BlobMediaBinding = {
  orgId: BINDING.orgId,
  meetingId: BINDING.meetingId,
  kind: BINDING.kind,
};

describe('blob-cipher media key wrapping', () => {
  it('derives a deterministic 32-byte wrap key from root key', () => {
    const key1 = deriveMediaWrapKey(ROOT_KEY);
    const key2 = deriveMediaWrapKey(ROOT_KEY);
    expect(key1).toHaveLength(32);
    expect(key1.equals(key2)).toBe(true);
    expect(deriveMediaWrapKey(WRONG_ROOT_KEY).equals(key1)).toBe(false);
  });

  it('generates, wraps, and unwraps a media data key with AAD binding', () => {
    const dataKey = generateMediaDataKey();
    expect(dataKey).toHaveLength(32);

    const wrapped = wrapMediaKey(dataKey, BINDING, ROOT_KEY);
    // 12 bytes IV + 16 bytes auth tag + 32 bytes ciphertext = 60 bytes
    expect(wrapped).toHaveLength(60);

    const unwrapped = unwrapMediaKey(wrapped, BINDING, ROOT_KEY);
    expect(unwrapped.equals(dataKey)).toBe(true);
  });

  it('fails unwrapping if binding attributes mismatch', () => {
    const dataKey = generateMediaDataKey();
    const wrapped = wrapMediaKey(dataKey, BINDING, ROOT_KEY);

    expect(() =>
      unwrapMediaKey(wrapped, { ...BINDING, meetingId: '01a19b3a-2d5f-773b-a8ba-a1345bd79da9' }, ROOT_KEY),
    ).toThrow();

    expect(() =>
      unwrapMediaKey(wrapped, { ...BINDING, kind: 'video' }, ROOT_KEY),
    ).toThrow();

    expect(() =>
      unwrapMediaKey(wrapped, { ...BINDING, keyId: 'key-2' }, ROOT_KEY),
    ).toThrow();

    expect(() =>
      unwrapMediaKey(wrapped, BINDING, WRONG_ROOT_KEY),
    ).toThrow();
  });

  it('fails unwrapping if ciphertext or tag is modified', () => {
    const dataKey = generateMediaDataKey();
    const wrapped = wrapMediaKey(dataKey, BINDING, ROOT_KEY);
    const tampered = Buffer.from(wrapped);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;

    expect(() => unwrapMediaKey(tampered, BINDING, ROOT_KEY)).toThrow();
  });
});

describe('blob-cipher buffer encryption and decryption', () => {
  it('encrypts and decrypts empty buffer', () => {
    const dataKey = generateMediaDataKey();
    const empty = Buffer.alloc(0);
    const encrypted = encryptBlobBuffer(empty, dataKey, BLOB_BINDING);
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = decryptBlobBuffer(encrypted, dataKey, BLOB_BINDING);
    expect(decrypted).toHaveLength(0);
  });

  it('encrypts and decrypts payload smaller than single chunk', () => {
    const dataKey = generateMediaDataKey();
    const payload = Buffer.from('Hello, AI Meeting Notes audio payload!', 'utf8');
    const encrypted = encryptBlobBuffer(payload, dataKey, BLOB_BINDING);
    const decrypted = decryptBlobBuffer(encrypted, dataKey, BLOB_BINDING);
    expect(decrypted.toString('utf8')).toBe(payload.toString('utf8'));
  });

  it('encrypts and decrypts multi-chunk payload across chunk boundaries', () => {
    const dataKey = generateMediaDataKey();
    const size = BLOB_CHUNK_SIZE * 2 + 1234;
    const payload = randomBytes(size);
    const encrypted = encryptBlobBuffer(payload, dataKey, BLOB_BINDING);
    const decrypted = decryptBlobBuffer(encrypted, dataKey, BLOB_BINDING);
    expect(decrypted.equals(payload)).toBe(true);
  });

  it('refuses decryption when binding or key is invalid', () => {
    const dataKey = generateMediaDataKey();
    const payload = Buffer.from('sensitive media', 'utf8');
    const encrypted = encryptBlobBuffer(payload, dataKey, BLOB_BINDING);

    const wrongKey = generateMediaDataKey();
    expect(() => decryptBlobBuffer(encrypted, wrongKey, BLOB_BINDING)).toThrow();

    expect(() =>
      decryptBlobBuffer(encrypted, dataKey, { ...BLOB_BINDING, kind: 'video' }),
    ).toThrow();
  });

  it('refuses decryption of truncated ciphertext', () => {
    const dataKey = generateMediaDataKey();
    const truncatedHeader = Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00]);
    expect(() => decryptBlobBuffer(truncatedHeader, dataKey, BLOB_BINDING)).toThrow();
  });

  it('validates AAD non-empty and NUL byte assertions', () => {
    expect(() => mediaKeyAad({ ...BINDING, orgId: '' })).toThrow();
    expect(() => mediaKeyAad({ ...BINDING, meetingId: 'bad\u0000id' })).toThrow();
    expect(() => blobChunkAad({ ...BLOB_BINDING, orgId: '' }, 0, false)).toThrow();
    expect(() => blobChunkAad({ ...BLOB_BINDING, kind: 'audio\u0000' as any }, 0, false)).toThrow();
    expect(() => blobChunkAad(BLOB_BINDING, -1, false)).toThrow();
  });

  it('calculates plaintext length from ciphertext length in O(1)', () => {
    const dataKey = generateMediaDataKey();
    for (const size of [0, 10, 1000, BLOB_CHUNK_SIZE, BLOB_CHUNK_SIZE + 500, BLOB_CHUNK_SIZE * 3 + 42]) {
      const payload = randomBytes(size);
      const encrypted = encryptBlobBuffer(payload, dataKey, BLOB_BINDING);
      expect(plaintextLengthFromCiphertextLength(encrypted.length)).toBe(size);
    }
  });

  it('decrypts bounded chunk ranges without full payload in memory', () => {
    const dataKey = generateMediaDataKey();
    const size = BLOB_CHUNK_SIZE * 3 + 12345;
    const payload = randomBytes(size);
    const encrypted = encryptBlobBuffer(payload, dataKey, BLOB_BINDING);

    // Test a range spanning chunk 1 to chunk 2
    const start = BLOB_CHUNK_SIZE + 100;
    const end = BLOB_CHUNK_SIZE * 2 + 500;
    const range = mapPlaintextRangeToChunks(start, end, encrypted.length);
    expect(range.firstChunk).toBe(1);
    expect(range.lastChunk).toBe(2);

    const ciphertextSlice = encrypted.subarray(range.ctStart, range.ctEnd + 1);
    const decryptedChunks = decryptBlobChunks(
      ciphertextSlice,
      dataKey,
      BLOB_BINDING,
      range.firstChunk,
      range.lastChunk,
      range.totalChunks,
    );
    const slice = decryptedChunks.subarray(range.offsetInFirstChunk, range.offsetInFirstChunk + range.requestedLength);
    expect(slice.equals(payload.subarray(start, end + 1))).toBe(true);
  });
});

describe('streaming blob encryptor (#2780)', () => {
  const DATA_KEY = generateMediaDataKey();
  // `declared` is the length the caller expects; it is the real length unless a test says otherwise.
  const streamed = (plaintext: Buffer, piece: number, declared = plaintext.length): Buffer => {
    const encryptor = createBlobEncryptor(DATA_KEY, BLOB_BINDING, declared);
    const out: Buffer[] = [];
    for (let at = 0; at < plaintext.length; at += piece) out.push(...encryptor.push(plaintext.subarray(at, at + piece)));
    out.push(...encryptor.finish());
    return Buffer.concat(out);
  };
  const chunkOf = (ciphertext: Buffer, index: number) => ciphertext.subarray(5 + index * CIPHER_CHUNK_FULL_SIZE, 5 + (index + 1) * CIPHER_CHUNK_FULL_SIZE);
  const rangeRead = (ciphertext: Buffer, start: number, end: number) => {
    const map = mapPlaintextRangeToChunks(start, end, ciphertext.length);
    const window = decryptBlobChunks(ciphertext.subarray(map.ctStart, map.ctEnd + 1), DATA_KEY, BLOB_BINDING, map.firstChunk, map.lastChunk, map.totalChunks);
    return window.subarray(map.offsetInFirstChunk, map.offsetInFirstChunk + map.requestedLength);
  };

  it.each([0, 1, 100, BLOB_CHUNK_SIZE - 1, BLOB_CHUNK_SIZE, BLOB_CHUNK_SIZE + 1, 2 * BLOB_CHUNK_SIZE, 2 * BLOB_CHUNK_SIZE + 5, 5 * BLOB_CHUNK_SIZE + 123])(
    'writes the format of encryptBlobBuffer for %i bytes, whatever the pieces',
    (size) => {
      const plaintext = randomBytes(size);
      const reference = encryptBlobBuffer(plaintext, DATA_KEY, BLOB_BINDING);
      for (const piece of [1 + (size % 7), 1000, BLOB_CHUNK_SIZE, 3 * BLOB_CHUNK_SIZE + 1]) {
        const ciphertext = streamed(plaintext, piece);
        // Same header and same size as the buffered path (the IVs differ: they are random).
        expect(ciphertext.length).toBe(reference.length);
        expect(ciphertext.subarray(0, 5)).toEqual(reference.subarray(0, 5));
        expect(plaintextLengthFromCiphertextLength(ciphertext.length)).toBe(size);
        expect(decryptBlobBuffer(ciphertext, DATA_KEY, BLOB_BINDING)).toEqual(plaintext);
      }
    },
  );

  it.each([4 * BLOB_CHUNK_SIZE + 777, 4 * BLOB_CHUNK_SIZE, 3 * BLOB_CHUNK_SIZE + 1, BLOB_CHUNK_SIZE])(
    'is read by the Range path of playback for %i bytes: windows in the middle, across chunks and through the final chunk',
    (size) => {
      const plaintext = randomBytes(size);
      const ciphertext = streamed(plaintext, 100_000);
      const windows: Array<[number, number]> = [
        [0, 0],
        [BLOB_CHUNK_SIZE - 5, BLOB_CHUNK_SIZE + 5 > size - 1 ? size - 1 : BLOB_CHUNK_SIZE + 5],
        [Math.floor(size / 2), size - 1],
        [size - 1, size - 1],
        // The last chunk alone (a full one when the size is an exact multiple of the chunk size).
        [Math.floor((size - 1) / BLOB_CHUNK_SIZE) * BLOB_CHUNK_SIZE, size - 1],
        [0, size - 1],
      ];
      for (const [start, end] of windows) expect(rangeRead(ciphertext, start, end).equals(plaintext.subarray(start, end + 1))).toBe(true);
    },
  );

  it('still reads what the buffered path wrote before this change: a frozen ciphertext through both decrypt paths, and the buffered output of today', () => {
    // Generated before the streaming encryptor existed (commit f7f7a8a), with the buffered path:
    //   encryptBlobBuffer(Buffer.from('Ludy meeting media written by the buffered path'), Buffer.alloc(32, 7), legacyBinding).toString('hex')
    const legacyKey = Buffer.alloc(32, 7);
    const legacyBinding: BlobMediaBinding = { orgId: 'org-legacy', meetingId: 'meeting-legacy', kind: 'audio' };
    const legacy = Buffer.from(
      '0100010000d479f577ff7056efbb4e448606e2c90e55b04a2cf9ddeb14cff14c93daa62491133dcaba8f3b8f8e16b522ec4fa3f5d26732fbf83d20ea6ae67badce4b0fd11de47af2d41caaf9a7b92aa5',
      'hex',
    );
    expect(decryptBlobBuffer(legacy, legacyKey, legacyBinding).toString('utf8')).toBe('Ludy meeting media written by the buffered path');
    // And through the Range path playback uses.
    const legacyMap = mapPlaintextRangeToChunks(0, 46, legacy.length);
    expect(
      decryptBlobChunks(legacy.subarray(legacyMap.ctStart, legacyMap.ctEnd + 1), legacyKey, legacyBinding, legacyMap.firstChunk, legacyMap.lastChunk, legacyMap.totalChunks).toString('utf8'),
    ).toBe('Ludy meeting media written by the buffered path');
    // A multi-chunk file from the buffered path reads through both decrypt paths.
    const plaintext = randomBytes(3 * BLOB_CHUNK_SIZE + 9);
    const buffered = encryptBlobBuffer(plaintext, DATA_KEY, BLOB_BINDING);
    expect(decryptBlobBuffer(buffered, DATA_KEY, BLOB_BINDING)).toEqual(plaintext);
    expect(rangeRead(buffered, 0, plaintext.length - 1).equals(plaintext)).toBe(true);
  });

  it('holds at most one chunk back: the ciphertext keeps pace with the plaintext pushed', () => {
    const total = 128 * 1024 * 1024;
    const encryptor = createBlobEncryptor(DATA_KEY, BLOB_BINDING, total);
    const piece = Buffer.alloc(1024 * 1024, 0x41);
    let pushed = 0;
    let emitted = 0;
    let maxLag = 0;
    for (let i = 0; i < 128; i += 1) {
      for (const out of encryptor.push(piece)) emitted += out.length;
      pushed += piece.length;
      // Plaintext not yet written as ciphertext: bounded by one chunk, not by what was pushed so far.
      const written = Math.max(0, emitted - 5);
      const sealedPlain = (written / CIPHER_CHUNK_FULL_SIZE) * BLOB_CHUNK_SIZE;
      maxLag = Math.max(maxLag, pushed - sealedPlain);
    }
    expect(pushed).toBe(total);
    expect(maxLag).toBeLessThanOrEqual(BLOB_CHUNK_SIZE + piece.length);
  });

  it('refuses a streamed blob with the last chunk cut, a middle chunk dropped, two chunks swapped, a wrong key or another meeting', () => {
    const ciphertext = streamed(randomBytes(3 * BLOB_CHUNK_SIZE + 5), 50_000);
    // Cut at the last chunk boundary.
    expect(() => decryptBlobBuffer(ciphertext.subarray(0, 5 + 3 * CIPHER_CHUNK_FULL_SIZE), DATA_KEY, BLOB_BINDING)).toThrow();
    // A middle chunk dropped: the chunks after it are read at the wrong index.
    const dropped = Buffer.concat([ciphertext.subarray(0, 5), chunkOf(ciphertext, 0), chunkOf(ciphertext, 2), ciphertext.subarray(5 + 3 * CIPHER_CHUNK_FULL_SIZE)]);
    expect(() => decryptBlobBuffer(dropped, DATA_KEY, BLOB_BINDING)).toThrow();
    // Two full chunks swapped.
    const swapped = Buffer.concat([ciphertext.subarray(0, 5), chunkOf(ciphertext, 1), chunkOf(ciphertext, 0), chunkOf(ciphertext, 2), ciphertext.subarray(5 + 3 * CIPHER_CHUNK_FULL_SIZE)]);
    expect(() => decryptBlobBuffer(swapped, DATA_KEY, BLOB_BINDING)).toThrow();
    expect(() => decryptBlobBuffer(ciphertext, generateMediaDataKey(), BLOB_BINDING)).toThrow();
    expect(() => decryptBlobBuffer(ciphertext, DATA_KEY, { ...BLOB_BINDING, meetingId: 'another-meeting' })).toThrow();
    // And the untouched file reads.
    expect(decryptBlobBuffer(ciphertext, DATA_KEY, BLOB_BINDING).length).toBe(3 * BLOB_CHUNK_SIZE + 5);
  });

  it('refuses a body that ends short of its declared length: 131072 of 196618 bytes do not seal (Platform PO N1)', () => {
    const body = randomBytes(196_618);
    const encryptor = createBlobEncryptor(DATA_KEY, BLOB_BINDING, body.length);
    encryptor.push(body.subarray(0, 65_536));
    encryptor.push(body.subarray(65_536, 131_072));
    // The stream stopped here (an aborted body). finish() must not seal what arrived as if it were the whole.
    expect(() => encryptor.finish()).toThrow(/131072 bytes, not its declared 196618/);
    expect(() => encryptor.push(body.subarray(131_072))).toThrow(/finished or failed/);
    expect(() => encryptor.finish()).toThrow(/finished or failed/);
    // A body longer than declared is refused at the push that passes it.
    const over = createBlobEncryptor(DATA_KEY, BLOB_BINDING, 100);
    expect(() => over.push(Buffer.alloc(101))).toThrow(/more than its declared length/);
    expect(() => over.push(Buffer.alloc(1))).toThrow(/finished or failed/);
    // Nothing declared, nothing sent: an empty blob is still one empty last chunk.
    expect(decryptBlobBuffer(streamed(Buffer.alloc(0), 10), DATA_KEY, BLOB_BINDING).length).toBe(0);
    expect(() => createBlobEncryptor(DATA_KEY, BLOB_BINDING, -1)).toThrow(/expectedLength/);
    expect(() => createBlobEncryptor(DATA_KEY, BLOB_BINDING, 1.5)).toThrow(/expectedLength/);
    expect(() => createBlobEncryptor(DATA_KEY, BLOB_BINDING, Number.NaN)).toThrow(/expectedLength/);
  });

  it('ends for good after finish, and refuses a key of the wrong size', () => {
    const encryptor = createBlobEncryptor(DATA_KEY, BLOB_BINDING, 0);
    encryptor.finish();
    expect(() => encryptor.push(Buffer.from('x'))).toThrow(/finished/);
    expect(() => encryptor.finish()).toThrow(/finished/);
    expect(() => createBlobEncryptor(Buffer.alloc(16), BLOB_BINDING, 0)).toThrow(/32 bytes/);
  });

  it('validates the binding at creation and keeps its own frozen copy of it', () => {
    expect(() => createBlobEncryptor(DATA_KEY, { ...BLOB_BINDING, orgId: '' }, 0)).toThrow(/non-empty/);
    expect(() => createBlobEncryptor(DATA_KEY, { ...BLOB_BINDING, meetingId: 'a\u0000b' }, 0)).toThrow(/NUL/);
    const mine: BlobMediaBinding = { ...BLOB_BINDING };
    const encryptor = createBlobEncryptor(DATA_KEY, mine, 5);
    // Changing the caller's object afterwards changes nothing the chunks are bound to.
    mine.meetingId = 'changed-after-creation';
    const out = Buffer.concat([...encryptor.push(Buffer.from('hello')), ...encryptor.finish()]);
    expect(decryptBlobBuffer(out, DATA_KEY, BLOB_BINDING).toString()).toBe('hello');
    expect(() => decryptBlobBuffer(out, DATA_KEY, mine)).toThrow();
  });

  it('copies what it holds, so the caller may reuse the buffer it pushed', () => {
    const encryptor = createBlobEncryptor(DATA_KEY, BLOB_BINDING, 1010);
    const reused = Buffer.alloc(1000, 0x61);
    const out = [...encryptor.push(reused)];
    reused.fill(0x62);
    out.push(...encryptor.push(Buffer.alloc(10, 0x63)), ...encryptor.finish());
    expect(decryptBlobBuffer(Buffer.concat(out), DATA_KEY, BLOB_BINDING).toString('latin1')).toBe('a'.repeat(1000) + 'c'.repeat(10));
  });
});
