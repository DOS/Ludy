// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const IV_LENGTH = 12; // 96-bit nonce
const TAG_LENGTH = 16; // 128-bit GCM auth tag
const KEY_LENGTH = 32; // 256-bit key
export const BLOB_CHUNK_SIZE = 64 * 1024; // 64 KiB chunks
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
  return Buffer.from(
    ['crove.meeting_media.v1', binding.orgId, binding.meetingId, binding.kind, binding.keyId].join('\u0000'),
    'utf8',
  );
}

export function blobChunkAad(binding: BlobMediaBinding, chunkIndex: number, isLast: boolean): Buffer {
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
