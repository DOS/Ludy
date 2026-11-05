// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BLOB_CHUNK_SIZE,
  decryptBlobBuffer,
  deriveMediaWrapKey,
  encryptBlobBuffer,
  generateMediaDataKey,
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
});
