// SPDX-License-Identifier: AGPL-3.0-only
// Seals meeting media as it arrives (issue #2780, ADR-0047): the plaintext comes in pieces from a staged object, a raw request
// body or an uploaded form; each piece is encrypted chunk by chunk (the blob cipher's format, unchanged) and written through
// the store's streamed write, which hashes the ciphertext and places it under its content address at the end. dataKey is
// wiped by the caller after sealMedia returned or threw, never before: the encryptor holds a reference to it. Memory is a
// chunk of plaintext, a piece, and the store's own part (a piece for local disk, 8 MiB for S3): never the blob.
//
// The container is sniffed from the first bytes before anything is written, the size is capped while the bytes stream, and
// the stored size is checked against the plaintext length before the caller records the file. Whatever fails leaves no
// temporary file or object behind.
import { detectMediaContainer } from '@crove/mod-meetings';
import {
  BlobTooLargeError,
  DomainError,
  createBlobEncryptor,
  fileKey,
  plaintextLengthFromCiphertextLength,
  stagedWriteFor,
  type BlobEncryptor,
  type BlobMediaBinding,
  type BlobStore,
  type StoredBlob,
} from '@crove/kernel-runtime';

// The longest prefix the container check reads (detectMediaContainer looks at 12 bytes).
const SNIFF_BYTES = 12;

export interface SealedMedia extends StoredBlob {
  contentType: string;
  plaintextBytes: number;
}

export interface SealInput {
  source: AsyncIterable<Uint8Array>;
  kind: 'audio' | 'video';
  dataKey: Buffer;
  binding: BlobMediaBinding;
  // The length the source declared (Content-Length, the staged object's size, the form file's size). A source that delivers more
  // or fewer bytes is refused, so a body cut short never seals into a shorter file that decrypts cleanly.
  expectedLength: number;
  // The most plaintext accepted, counted while it streams.
  maxBytes: number;
  // A live piece after the first (ADR-0052 L4a) is a slice in the middle of a recorder stream, with no container header to sniff: it is sealed as opaque bytes and
  // its type is application/octet-stream. The first piece, and every upload of a whole recording, is sniffed as before.
  opaque?: boolean;
  store: BlobStore;
  orgId: string;
}

const lengthMismatch = (declared: number, got: number) =>
  new DomainError('BAD_REQUEST', 400, `Tệp có ${got} byte, không khớp kích thước đã khai báo (${declared} byte)`);
// The size in the refusal is the cap in force (the plan's, or the deployment's lower one for crove-media, #2989), not a fixed text.
export function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${Math.round(mb)} MB`;
}
const tooLarge = (maxBytes: number) => new DomainError('FILE_TOO_LARGE', 413, `Tệp vượt quá giới hạn tối đa (${sizeText(maxBytes)})`);

// The pieces of a web stream (a request body, a Blob), whatever the runtime's typing of it. With stallMs, a stream that delivers
// nothing for that long is cancelled and refused: a client that stops sending (a dead connection, a slow-loris) cannot hold the
// upload, and with it the video slot, for longer. The timer is per piece, so a slow but moving upload is never cut.
export async function* streamPieces(stream: ReadableStream<Uint8Array>, stallMs?: number): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<'stalled'>((resolve) => {
        if (stallMs !== undefined) timer = setTimeout(() => resolve('stalled'), stallMs);
      });
      const step = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (step === 'stalled') {
        // Cancelling ends the pending read, so nothing is left waiting on the dead body.
        await reader.cancel().catch(() => undefined);
        throw new DomainError('BAD_REQUEST', 400, 'Quá lâu không nhận được dữ liệu của tệp, hãy tải lên lại');
      }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// One buffer as a source.
export async function* onepiece(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

export async function sealMedia(input: SealInput): Promise<SealedMedia> {
  const { kind, binding, orgId, expectedLength } = input;
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) throw new Error('sealMedia needs the declared length of the source');
  if (expectedLength > input.maxBytes) throw tooLarge(input.maxBytes);
  const iterator = input.source[Symbol.asyncIterator]();
  let total = 0;
  // Read until the container can be told, holding only those first pieces.
  const held: Uint8Array[] = [];
  let heldBytes = 0;
  let ended = false;
  const next = async (): Promise<IteratorResult<Uint8Array>> => {
    try {
      return await iterator.next();
    } catch (error) {
      if (error instanceof BlobTooLargeError) throw tooLarge(input.maxBytes);
      throw error;
    }
  };
  try {
    while (heldBytes < SNIFF_BYTES) {
      const step = await next();
      if (step.done) {
        ended = true;
        break;
      }
      held.push(step.value);
      heldBytes += step.value.byteLength;
      total += step.value.byteLength;
      if (total > input.maxBytes) throw tooLarge(input.maxBytes);
      if (total > expectedLength) throw lengthMismatch(expectedLength, total);
    }
    if (total === 0) throw new DomainError('NO_FILE', 400, 'Tệp rỗng');
    const head = Buffer.concat(held);
    const contentType = input.opaque ? 'application/octet-stream' : detectMediaContainer(head, kind);
    if (!contentType) throw new DomainError('INVALID_MEDIA_CONTAINER', 400, 'Uploaded media is not a supported audio/video container');

    const write = await stagedWriteFor(input.store, `org/${orgId}`);
    // Declared outside the try so every refusal below ends it and wipes the plaintext it holds.
    let encryptor: BlobEncryptor | undefined;
    try {
      encryptor = createBlobEncryptor(input.dataKey, binding, expectedLength);
      const sealing = encryptor;
      const put = async (piece: Uint8Array) => {
        for (const sealed of sealing.push(piece)) await write.write(sealed);
      };
      for (const piece of held) await put(piece);
      held.length = 0;
      while (!ended) {
        const step = await next();
        if (step.done) break;
        total += step.value.byteLength;
        if (total > input.maxBytes) throw tooLarge(input.maxBytes);
        if (total > expectedLength) throw lengthMismatch(expectedLength, total);
        await put(step.value);
      }
      // A source that ended short of what it declared (an aborted body) is refused here, before the last chunk is sealed.
      if (total !== expectedLength) throw lengthMismatch(expectedLength, total);
      for (const sealed of sealing.finish()) await write.write(sealed);
      const stored = await write.commit(({ sha256 }) => fileKey(orgId, sha256), contentType);
      // The object holds as many bytes as the plaintext seals to, or it is not recorded. A blob left without a row is deleted,
      // but only when this write created it: one that was already there is not ours to delete.
      let sealedLength: number | null = null;
      try {
        sealedLength = plaintextLengthFromCiphertextLength(stored.size);
      } catch {
        // Not a length a blob of this format can have: treated like a mismatch.
      }
      if (sealedLength !== total) {
        if (stored.created) await input.store.delete(stored.key).catch(() => undefined);
        throw new Error(`sealed media has ${stored.size} bytes, which is not ${total} bytes of plaintext`);
      }
      return { ...stored, contentType, plaintextBytes: total };
    } catch (error) {
      encryptor?.abort();
      await write.abort();
      throw error;
    }
  } finally {
    // A source that is left early (a refusal, a cap) is closed so nothing keeps reading.
    await iterator.return?.().catch(() => undefined);
  }
}
