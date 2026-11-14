// SPDX-License-Identifier: AGPL-3.0-only
// The route side of "join the live pieces into the recording" (issue #3126, ADR-0052 L4a). The recorder's click arrives in the recorder's own session, so every read
// here is the recorder's own, as a playback is: the plan (the pieces, their files and wrapped keys) is a query in the recorder's context; the pieces are decrypted one at a
// time (a piece is at most a mebibyte) and streamed in order into sealMedia under a FRESH audio key, so the result is ciphertext only and no plaintext file exists; crove-media
// then measures the sealed blob read back window by window, exactly as an upload's is; and meetings.live.assemble_record records it and discards the pieces in one transaction.
// The pieces are consecutive slices of one stream, so the join is their bytes in order (crove-media has no network and refuses the concat demuxer on purpose: nothing but
// bytes is joined here). A gap in the numbers is reported in the answer and never fails the join; piece 0 (the container header) must exist, the plan refuses without it.
import {
  BlobNotFoundError,
  DomainError,
  decryptBlobBuffer,
  generateMediaDataKey,
  plaintextLengthFromCiphertextLength,
  readVerified,
  unwrapMediaKeyWithSubkey,
  wrapMediaKeyWithSubkey,
  type BlobMediaBinding,
  type BlobStore,
  type CredentialBroker,
  type Runtime,
  type UserActor,
} from '@crove/kernel-runtime';
import { LIVE_CHUNK_MAX_BYTES, LIVE_CHUNK_MAX_TOTAL_BYTES, type LiveAssemblePlan, type LiveAssemblePlanPiece, type MeetingLiveAssembled } from '@crove/kernel-contract';
import { decryptedWindows, unavailable, type MediaMeasurer } from './meetings-measure.ts';
import { sealMedia } from './media-seal.ts';

export interface LiveAssembleDeps {
  runtime: Runtime;
  store: BlobStore;
  broker: CredentialBroker;
  measurer: MediaMeasurer;
  // The most plaintext a meeting's audio holds (the plan's audio cap); the pieces' own total (LIVE_CHUNK_MAX_TOTAL_BYTES) also applies.
  maxBytes: number;
  // The longest the join may take to read and seal its pieces (default ASSEMBLE_DEADLINE_MS), checked between pieces; crove-media bounds its own measuring. A join past it is refused and nothing is kept.
  deadlineMs?: number;
  now?: () => number;
}

export const ASSEMBLE_DEADLINE_MS = 10 * 60_000;

// A piece is at most LIVE_CHUNK_MAX_BYTES of plaintext plus the cipher's own overhead: the cap keeps a wrong row from filling memory.
const PIECE_CIPHERTEXT_MAX = LIVE_CHUNK_MAX_BYTES + 64 * 1024;
const WRAP_INFO = 'crove.meetings.v1|wrap';

const unreadable = (seq: number) => new DomainError('LIVE_PIECE_UNREADABLE', 409, `Live piece ${seq} could not be read from the store, so the pieces cannot be joined`);

// The plaintext of the pieces, in order, one at a time. Each piece is wiped after the sealing has copied it (the encryptor holds its own copy).
async function* piecesInOrder(deps: LiveAssembleDeps, orgId: string, meetingId: string, pieces: LiveAssemblePlanPiece[], deadline: number): AsyncGenerator<Uint8Array> {
  const { broker } = deps;
  const now = deps.now ?? Date.now;
  for (const piece of pieces) {
    if (now() > deadline) throw new DomainError('LIVE_ASSEMBLE_TIMEOUT', 503, 'Joining the live pieces took too long; try again');
    const subkey = broker.deriveKey ? broker.deriveKey(piece.keyId, WRAP_INFO) : broker.derive && broker.keyId === piece.keyId ? broker.derive(WRAP_INFO) : null;
    if (!subkey) throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media decryption key unavailable');
    const binding: BlobMediaBinding = { orgId, meetingId, kind: `live:${piece.seq}` };
    let dataKey: Buffer | null = null;
    try {
      dataKey = unwrapMediaKeyWithSubkey(Buffer.from(piece.wrappedKey), { ...binding, keyId: piece.keyId }, subkey);
      const ciphertext = await readVerified(deps.store, { key: piece.storageKey, generation: piece.generation, sha256: piece.sha256 }, PIECE_CIPHERTEXT_MAX).catch((error: unknown) => {
        if (error instanceof BlobNotFoundError) throw unreadable(piece.seq);
        throw error;
      });
      const plain = decryptBlobBuffer(Buffer.from(ciphertext), dataKey, binding);
      const bytes = new Uint8Array(plain);
      plain.fill(0);
      // sealMedia's encryptor copies what it is pushed and its sniff reads at most 12 bytes (always inside piece 0), so wiping a piece once the generator resumes is safe.
      try {
        yield bytes;
      } finally {
        bytes.fill(0);
      }
    } finally {
      dataKey?.fill(0);
      subkey.fill(0);
    }
  }
}

/** Joins the live pieces of one meeting into its recording, as the recorder. Throws a DomainError the route returns as is. */
export async function assembleLivePieces(deps: LiveAssembleDeps, input: { actor: UserActor; orgId: string; meetingId: string }): Promise<MeetingLiveAssembled> {
  const { runtime, store, broker, measurer } = deps;
  const { actor, orgId, meetingId } = input;
  // The length of the recording is measured in crove-media after sealing, so without it nothing is read or stored (#2985).
  if (!measurer.configured) throw unavailable();
  const plan = await runtime.query<LiveAssemblePlan>('meetings.live.assemble_plan', { meetingId }, { actor, orgId });
  if (plan.pieces.length === 0) throw new DomainError('LIVE_NO_PIECES', 404, 'This meeting kept no live pieces to join');
  // Known before a byte is read: each piece's plaintext length follows from its stored size, so the sealing can declare the whole length and refuse a piece that decrypts
  // to anything else.
  const expectedLength = plan.pieces.reduce((sum, p) => sum + plaintextLengthFromCiphertextLength(p.sizeBytes), 0);
  const cap = Math.min(deps.maxBytes, LIVE_CHUNK_MAX_TOTAL_BYTES);
  if (expectedLength > cap) throw new DomainError('FILE_TOO_LARGE', 413, 'The live pieces are larger than a recording may be');

  const deadline = (deps.now ?? Date.now)() + (deps.deadlineMs ?? ASSEMBLE_DEADLINE_MS);
  const keyId = broker.keyId;
  if (!keyId || (!broker.derive && !broker.deriveKey)) throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media encryption key unavailable');
  const wrapSubkey = broker.deriveKey ? broker.deriveKey(keyId, WRAP_INFO) : broker.derive && broker.keyId === keyId ? broker.derive(WRAP_INFO) : null;
  if (!wrapSubkey) throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media encryption key derivation failed');
  const dataKey = generateMediaDataKey();
  try {
    const binding: BlobMediaBinding = { orgId, meetingId, kind: 'audio' };
    const wrappedKey = wrapMediaKeyWithSubkey(dataKey, { ...binding, keyId }, wrapSubkey);
    const sealed = await sealMedia({ source: piecesInOrder(deps, orgId, meetingId, plan.pieces, deadline), expectedLength, kind: 'audio', dataKey, binding, maxBytes: cap, store, orgId });
    let lengthSeconds: number;
    try {
      lengthSeconds = await measurer.measure('audio', decryptedWindows(store, { storageKey: sealed.key, generation: sealed.generation, sizeBytes: sealed.size }, dataKey, binding));
    } catch (error) {
      if (sealed.created) await store.delete(sealed.key).catch((err) => console.error('[http] live assemble cleanup failed', err));
      throw error;
    }
    try {
      return await runtime.execute<MeetingLiveAssembled>(
        'meetings.live.assemble_record',
        {
          meetingId,
          keyId,
          wrappedKeyHex: wrappedKey.toString('hex'),
          storageKey: sealed.key,
          generation: sealed.generation,
          sizeBytes: sealed.size,
          sha256: sealed.sha256,
          contentType: sealed.contentType,
          lengthSeconds,
          pieces: plan.pieces.length,
          lastSeq: plan.lastSeq,
          leftOut: plan.leftOut,
        },
        { actor, orgId },
      );
    } catch (error) {
      // Refused (a final upload landed first, the set changed): the sealed bytes have no row, so drop them.
      if (sealed.created) await store.delete(sealed.key).catch((err) => console.error('[http] live assemble cleanup failed', err));
      throw error;
    }
  } finally {
    dataKey.fill(0);
    wrapSubkey.fill(0);
  }
}
