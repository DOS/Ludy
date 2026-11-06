// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const IV_LENGTH = 12; // 96-bit nonce
const TAG_LENGTH = 16; // 128-bit GCM auth tag
const KEY_LENGTH = 32; // 256-bit key
export const BLOB_CHUNK_SIZE = 64 * 1024; // 64 KiB chunks
export const CHUNK_OVERHEAD = IV_LENGTH + TAG_LENGTH; // 28 bytes
export const CIPHER_CHUNK_FULL_SIZE = BLOB_CHUNK_SIZE + CHUNK_OVERHEAD; // 65564 bytes
const VERSION = 0x01;
const HEADER_LENGTH = 5; // 1 byte version + 4 bytes chunkSize

export interface MediaKeyBinding {
  orgId: string;
  meetingId: string;
  kind: 'audio' | 'video';
  keyId: string;
}

export type BlobMediaBinding = Omit<MediaKeyBinding, 'keyId'>;

export function mediaKeyAad(binding: MediaKeyBinding): Buffer {
  if (!binding.orgId || !binding.meetingId || !binding.kind || !binding.keyId) {
    throw new Error('mediaKeyAad binding fields must be non-empty');
  }
  if (
    binding.orgId.includes('\u0000') ||
    binding.meetingId.includes('\u0000') ||
    binding.kind.includes('\u0000') ||
    binding.keyId.includes('\u0000')
  ) {
    throw new Error('mediaKeyAad binding fields must not contain NUL bytes');
  }
  return Buffer.from(
    ['crove.meeting_media.v1', binding.orgId, binding.meetingId, binding.kind, binding.keyId].join('\u0000'),
    'utf8',
  );
}

export function blobChunkAad(binding: BlobMediaBinding, chunkIndex: number, isLast: boolean): Buffer {
  if (!binding.orgId || !binding.meetingId || !binding.kind) {
    throw new Error('blobChunkAad binding fields must be non-empty');
  }
  if (
    binding.orgId.includes('\u0000') ||
    binding.meetingId.includes('\u0000') ||
    binding.kind.includes('\u0000')
  ) {
    throw new Error('blobChunkAad binding fields must not contain NUL bytes');
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('blobChunkAad chunkIndex must be a non-negative integer');
  }
  return Buffer.from(
    ['crove.meeting_media.blob.v1', binding.orgId, binding.meetingId, binding.kind, String(chunkIndex), isLast ? '1' : '0'].join('\u0000'),
    'utf8',
  );
}

export function deriveMediaWrapKey(rootKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', rootKey, Buffer.alloc(0), 'crove.meetings.v1|wrap', KEY_LENGTH));
}

export function generateMediaDataKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function wrapMediaKeyWithSubkey(dataKey: Buffer, binding: MediaKeyBinding, subkey: Buffer): Buffer {
  if (dataKey.length !== KEY_LENGTH) {
    throw new Error('Data key must be 32 bytes');
  }
  if (subkey.length !== KEY_LENGTH) {
    throw new Error('Wrap subkey must be 32 bytes');
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', subkey, iv);
  cipher.setAAD(mediaKeyAad(binding));
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function unwrapMediaKeyWithSubkey(wrapped: Buffer, binding: MediaKeyBinding, subkey: Buffer): Buffer {
  if (wrapped.length !== IV_LENGTH + TAG_LENGTH + KEY_LENGTH) {
    throw new Error('Invalid wrapped key length: expected 60 bytes');
  }
  if (subkey.length !== KEY_LENGTH) {
    throw new Error('Wrap subkey must be 32 bytes');
  }
  const iv = wrapped.subarray(0, IV_LENGTH);
  const tag = wrapped.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = wrapped.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', subkey, iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(mediaKeyAad(binding));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function wrapMediaKey(dataKey: Buffer, binding: MediaKeyBinding, rootKey: Buffer): Buffer {
  return wrapMediaKeyWithSubkey(dataKey, binding, deriveMediaWrapKey(rootKey));
}

export function unwrapMediaKey(wrapped: Buffer, binding: MediaKeyBinding, rootKey: Buffer): Buffer {
  return unwrapMediaKeyWithSubkey(wrapped, binding, deriveMediaWrapKey(rootKey));
}

export function plaintextLengthFromCiphertextLength(ciphertextLength: number): number {
  const minLength = HEADER_LENGTH + CHUNK_OVERHEAD;
  if (ciphertextLength < minLength) {
    throw new Error('Invalid blob ciphertext: too short');
  }
  const payload = ciphertextLength - HEADER_LENGTH;
  if (payload === CHUNK_OVERHEAD) {
    return 0; // Empty file
  }
  const fullChunks = Math.floor(payload / CIPHER_CHUNK_FULL_SIZE);
  const remainder = payload % CIPHER_CHUNK_FULL_SIZE;
  if (remainder === 0) {
    return fullChunks * BLOB_CHUNK_SIZE;
  }
  if (remainder < CHUNK_OVERHEAD) {
    throw new Error('Invalid blob ciphertext: corrupt chunk size');
  }
  return fullChunks * BLOB_CHUNK_SIZE + (remainder - CHUNK_OVERHEAD);
}

export interface ChunkRangeMap {
  firstChunk: number;
  lastChunk: number;
  totalChunks: number;
  ctStart: number;
  ctEnd: number;
  offsetInFirstChunk: number;
  requestedLength: number;
}

export function mapPlaintextRangeToChunks(
  start: number,
  end: number,
  ciphertextLength: number,
): ChunkRangeMap {
  const totalPlaintextLength = plaintextLengthFromCiphertextLength(ciphertextLength);
  if (totalPlaintextLength === 0 || start < 0 || end < start || start >= totalPlaintextLength) {
    throw new RangeError('Requested range is not satisfiable');
  }
  const clampedEnd = Math.min(end, totalPlaintextLength - 1);
  const requestedLength = clampedEnd - start + 1;
  const totalChunks = totalPlaintextLength === 0 ? 1 : Math.ceil(totalPlaintextLength / BLOB_CHUNK_SIZE);

  const firstChunk = Math.floor(start / BLOB_CHUNK_SIZE);
  const lastChunk = Math.floor(clampedEnd / BLOB_CHUNK_SIZE);

  const ctStart = HEADER_LENGTH + firstChunk * CIPHER_CHUNK_FULL_SIZE;
  const isLastChunkInFile = lastChunk === totalChunks - 1;
  const ctEnd = isLastChunkInFile
    ? ciphertextLength - 1
    : HEADER_LENGTH + (lastChunk + 1) * CIPHER_CHUNK_FULL_SIZE - 1;

  const offsetInFirstChunk = start % BLOB_CHUNK_SIZE;

  return {
    firstChunk,
    lastChunk,
    totalChunks,
    ctStart,
    ctEnd,
    offsetInFirstChunk,
    requestedLength,
  };
}

export function decryptBlobChunks(
  ciphertextSlice: Buffer,
  dataKey: Buffer,
  binding: BlobMediaBinding,
  firstChunkIndex: number,
  lastChunkIndex: number,
  totalChunks: number,
): Buffer {
  if (dataKey.length !== KEY_LENGTH) {
    throw new Error('Data key must be 32 bytes');
  }
  const plainChunks: Buffer[] = [];
  let offset = 0;
  for (let chunkIndex = firstChunkIndex; chunkIndex <= lastChunkIndex; chunkIndex += 1) {
    const isLast = chunkIndex === totalChunks - 1;
    if (offset + CHUNK_OVERHEAD > ciphertextSlice.length) {
      throw new Error('Truncated blob chunk in slice');
    }
    const iv = ciphertextSlice.subarray(offset, offset + IV_LENGTH);
    const tag = ciphertextSlice.subarray(offset + IV_LENGTH, offset + CHUNK_OVERHEAD);
    offset += CHUNK_OVERHEAD;

    let ctLength: number;
    if (chunkIndex === lastChunkIndex && offset < ciphertextSlice.length && (ciphertextSlice.length - offset) < BLOB_CHUNK_SIZE) {
      ctLength = ciphertextSlice.length - offset;
    } else {
      ctLength = Math.min(BLOB_CHUNK_SIZE, ciphertextSlice.length - offset);
    }
    const ct = ciphertextSlice.subarray(offset, offset + ctLength);
    offset += ctLength;

    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_LENGTH });
    decipher.setAAD(blobChunkAad(binding, chunkIndex, isLast));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    plainChunks.push(pt);
  }
  return Buffer.concat(plainChunks);
}

export function encryptBlobBuffer(plaintext: Buffer, dataKey: Buffer, binding: BlobMediaBinding): Buffer {
  if (dataKey.length !== KEY_LENGTH) {
    throw new Error('Data key must be 32 bytes');
  }
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt8(VERSION, 0);
  header.writeUInt32BE(BLOB_CHUNK_SIZE, 1);
  chunks.push(header);

  const totalBytes = plaintext.length;
  if (totalBytes === 0) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(blobChunkAad(binding, 0, true));
    const ct = cipher.final();
    const tag = cipher.getAuthTag();
    chunks.push(iv, tag, ct);
    return Buffer.concat(chunks);
  }

  let offset = 0;
  let chunkIndex = 0;
  while (offset < totalBytes) {
    const end = Math.min(offset + BLOB_CHUNK_SIZE, totalBytes);
    const chunkPlaintext = plaintext.subarray(offset, end);
    const isLast = end >= totalBytes;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(blobChunkAad(binding, chunkIndex, isLast));
    const ct = Buffer.concat([cipher.update(chunkPlaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    chunks.push(iv, tag, ct);
    offset = end;
    chunkIndex += 1;
  }

  return Buffer.concat(chunks);
}

export function decryptBlobBuffer(ciphertext: Buffer, dataKey: Buffer, binding: BlobMediaBinding): Buffer {
  if (dataKey.length !== KEY_LENGTH) {
    throw new Error('Data key must be 32 bytes');
  }
  const minLength = HEADER_LENGTH + IV_LENGTH + TAG_LENGTH;
  if (ciphertext.length < minLength) {
    throw new Error('Invalid blob ciphertext: too short');
  }
  const version = ciphertext.readUInt8(0);
  if (version !== VERSION) {
    throw new Error(`Unsupported blob version: ${version}`);
  }
  const chunkSize = ciphertext.readUInt32BE(1);
  if (chunkSize === 0 || chunkSize > 10 * 1024 * 1024) {
    throw new Error(`Invalid blob chunk size: ${chunkSize}`);
  }

  const plainChunks: Buffer[] = [];
  let offset = HEADER_LENGTH;
  let chunkIndex = 0;
  const chunkOverhead = IV_LENGTH + TAG_LENGTH;

  while (offset < ciphertext.length) {
    if (offset + chunkOverhead > ciphertext.length) {
      throw new Error('Truncated blob chunk header');
    }
    const iv = ciphertext.subarray(offset, offset + IV_LENGTH);
    const tag = ciphertext.subarray(offset + IV_LENGTH, offset + chunkOverhead);
    offset += chunkOverhead;

    const remaining = ciphertext.length - offset;
    const isLast = remaining <= chunkSize;
    const ctLength = isLast ? remaining : chunkSize;
    const ct = ciphertext.subarray(offset, offset + ctLength);
    offset += ctLength;

    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_LENGTH });
    decipher.setAAD(blobChunkAad(binding, chunkIndex, isLast));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    plainChunks.push(pt);
    chunkIndex += 1;
  }

  return Buffer.concat(plainChunks);
}
