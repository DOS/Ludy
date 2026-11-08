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
  const totalBytes = plaintext.length;
  const numChunks = totalBytes === 0 ? 1 : Math.ceil(totalBytes / BLOB_CHUNK_SIZE);
  const out = Buffer.allocUnsafe(HEADER_LENGTH + numChunks * CHUNK_OVERHEAD + totalBytes);
  out.writeUInt8(VERSION, 0);
  out.writeUInt32BE(BLOB_CHUNK_SIZE, 1);

  if (totalBytes === 0) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(blobChunkAad(binding, 0, true));
    cipher.final();
    const tag = cipher.getAuthTag();
    iv.copy(out, HEADER_LENGTH);
    tag.copy(out, HEADER_LENGTH + IV_LENGTH);
    return out;
  }

  let offset = 0;
  let outOffset = HEADER_LENGTH;
  let chunkIndex = 0;
  while (offset < totalBytes) {
    const end = Math.min(offset + BLOB_CHUNK_SIZE, totalBytes);
    const chunkPlaintext = plaintext.subarray(offset, end);
    const isLast = end >= totalBytes;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(blobChunkAad(binding, chunkIndex, isLast));
    const ctPart1 = cipher.update(chunkPlaintext);
    const ctPart2 = cipher.final();
    const tag = cipher.getAuthTag();

    iv.copy(out, outOffset);
    outOffset += IV_LENGTH;
    tag.copy(out, outOffset);
    outOffset += TAG_LENGTH;
    ctPart1.copy(out, outOffset);
    outOffset += ctPart1.length;
    ctPart2.copy(out, outOffset);
    outOffset += ctPart2.length;

    offset = end;
    chunkIndex += 1;
  }

  if (outOffset !== out.length) {
    throw new Error('Ciphertext output size mismatch');
  }
  return out;
}

// Encrypts a blob as it arrives, in the same format encryptBlobBuffer writes (the 5-byte header, then per chunk: 12-byte IV,
// 16-byte tag, ciphertext), so decryptBlobBuffer, decryptBlobChunks and the Range mapping read it unchanged. A chunk's AAD says
// whether it is the last, so a full chunk is sealed only once more plaintext has arrived (or finish() says there is none): the
// encryptor holds at most one chunk of plaintext plus the piece being pushed, whatever the blob's size.
//
// The caller declares the length it expects. A stream that stops early still ends in a chunk that is "last", so without the
// declared length a body cut short would seal into a shorter file that decrypts cleanly: push() refuses more than the declared
// length and finish() refuses fewer. Any error (a refusal, a failed seal) ends the encryptor: every later call throws, and what
// it held is wiped.
//
// The encryptor keeps a reference to dataKey, not a copy: the caller wipes the key only after finish() returned or the
// encryptor failed, never before (a wiped key would seal garbage).
export interface BlobEncryptor {
  // Plaintext in; ciphertext pieces out, in order (the header comes with the first call).
  push(plaintext: Uint8Array): Buffer[];
  // Seals what is left as the last chunk, after checking the declared length. Call once, after the last push.
  finish(): Buffer[];
}

export function createBlobEncryptor(dataKey: Buffer, binding: BlobMediaBinding, expectedLength: number): BlobEncryptor {
  if (dataKey.length !== KEY_LENGTH) {
    throw new Error('Data key must be 32 bytes');
  }
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
    throw new Error('Blob encryptor expectedLength must be a non-negative integer');
  }
  // The binding is checked once, here (blobChunkAad refuses empty or NUL-bearing fields), and kept as a frozen copy: a caller
  // that changes its object later cannot change what the chunks are bound to.
  blobChunkAad(binding, 0, true);
  const bound: BlobMediaBinding = Object.freeze({ orgId: binding.orgId, meetingId: binding.meetingId, kind: binding.kind });
  // The one chunk held back, filled in place: its own copy, so the caller may reuse the buffer it pushed.
  const held = Buffer.allocUnsafe(BLOB_CHUNK_SIZE);
  let heldLength = 0;
  let pushed = 0;
  let chunkIndex = 0;
  let started = false;
  // Set by finish() and by any error: nothing more is accepted.
  let ended = false;
  const end = () => {
    ended = true;
    held.fill(0);
    heldLength = 0;
  };
  const seal = (plaintext: Buffer, isLast: boolean): Buffer => {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(blobChunkAad(bound, chunkIndex, isLast));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    chunkIndex += 1;
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  };
  const header = (): Buffer[] => {
    if (started) return [];
    started = true;
    const head = Buffer.alloc(HEADER_LENGTH);
    head.writeUInt8(VERSION, 0);
    head.writeUInt32BE(BLOB_CHUNK_SIZE, 1);
    return [head];
  };
  return {
    push(plaintext) {
      if (ended) throw new Error('Blob encryptor already finished or failed');
      try {
        if (pushed + plaintext.length > expectedLength) throw new Error('Blob encryptor was given more than its declared length');
        const out = header();
        let offset = 0;
        while (offset < plaintext.length) {
          // The held chunk is full and more plaintext has come: it is not the last.
          if (heldLength === BLOB_CHUNK_SIZE) {
            out.push(seal(held, false));
            heldLength = 0;
          }
          const take = Math.min(BLOB_CHUNK_SIZE - heldLength, plaintext.length - offset);
          held.set(plaintext.subarray(offset, offset + take), heldLength);
          heldLength += take;
          offset += take;
        }
        pushed += plaintext.length;
        return out;
      } catch (error) {
        end();
        throw error;
      }
    },
    finish() {
      if (ended) throw new Error('Blob encryptor already finished or failed');
      try {
        // A body that stopped early is not a shorter blob: it is refused.
        if (pushed !== expectedLength) throw new Error(`Blob encryptor was given ${pushed} bytes, not its declared ${expectedLength}`);
        const out = header();
        // An empty blob is one empty last chunk, as encryptBlobBuffer writes it.
        out.push(seal(held.subarray(0, heldLength), true));
        return out;
      } finally {
        end();
      }
    },
  };
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
