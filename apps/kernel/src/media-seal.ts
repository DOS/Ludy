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
  store: BlobStore;
  orgId: string;
}

const lengthMismatch = (declared: number, got: number) =>
  new DomainError('BAD_REQUEST', 400, `Tệp có ${got} byte, không khớp kích thước đã khai báo (${declared} byte)`);
const tooLarge = (kind: 'audio' | 'video') => new DomainError('FILE_TOO_LARGE', 413, `Tệp vượt quá giới hạn tối đa (${kind === 'video' ? '2 GB' : '300 MB'})`);

// The pieces of a web stream (a request body, a Blob), whatever the runtime's typing of it.
export async function* streamPieces(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
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
  if (expectedLength > input.maxBytes) throw tooLarge(kind);
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
      if (error instanceof BlobTooLargeError) throw tooLarge(kind);
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
      if (total > input.maxBytes) throw tooLarge(kind);
      if (total > expectedLength) throw lengthMismatch(expectedLength, total);
    }
    if (total === 0) throw new DomainError('NO_FILE', 400, 'Tệp rỗng');
    const head = Buffer.concat(held);
    const contentType = detectMediaContainer(head, kind);
    if (!contentType) throw new DomainError('INVALID_MEDIA_CONTAINER', 400, 'Uploaded media is not a supported audio/video container');

    const write = await stagedWriteFor(input.store, `org/${orgId}`);
    try {
      const encryptor = createBlobEncryptor(input.dataKey, binding, expectedLength);
      const put = async (piece: Uint8Array) => {
        for (const sealed of encryptor.push(piece)) await write.write(sealed);
      };
      for (const piece of held) await put(piece);
      held.length = 0;
      while (!ended) {
        const step = await next();
        if (step.done) break;
        total += step.value.byteLength;
        if (total > input.maxBytes) throw tooLarge(kind);
        if (total > expectedLength) throw lengthMismatch(expectedLength, total);
        await put(step.value);
      }
      // A source that ended short of what it declared (an aborted body) is refused here, before the last chunk is sealed.
      if (total !== expectedLength) throw lengthMismatch(expectedLength, total);
      for (const sealed of encryptor.finish()) await write.write(sealed);
      const stored = await write.commit(({ sha256 }) => fileKey(orgId, sha256), contentType);
      // The object holds as many bytes as the plaintext seals to, or it is not recorded.
      if (plaintextLengthFromCiphertextLength(stored.size) !== total) {
        await input.store.delete(stored.key).catch(() => undefined);
        throw new Error(`sealed media has ${stored.size} bytes, which is not ${total} bytes of plaintext`);
      }
      return { ...stored, contentType, plaintextBytes: total };
    } catch (error) {
      await write.abort();
      throw error;
    }
  } finally {
    // A source that is left early (a refusal, a cap) is closed so nothing keeps reading.
    await iterator.return?.().catch(() => undefined);
  }
}
