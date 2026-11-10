// SPDX-License-Identifier: AGPL-3.0-only
// The length of meeting media is measured by crove-media (the sandbox), never taken from the client (issue #2985, plan
// docs/plan/meetings.md §15 M3/M4): a client that reports a short length would otherwise get long audio transcribed while the AI
// budget is charged for the short one. The upload seals the media first, then this module reads the sealed blob back in windows,
// decrypts each one in memory and streams it to the sandbox's probe, so the plaintext never reaches the kernel's disk or its logs and is
// never held whole. Whatever the sandbox says is untrusted: the client validates it with strict schemas and only a duration in range
// and the right kind of stream are accepted.
import {
  createMediaClient,
  MEDIA_LIMITS,
  MediaClientError,
  type MediaClient,
  type MediaProbeResult,
} from '@crove/media-contract';
import {
  DomainError,
  decryptBlobChunks,
  mapPlaintextRangeToChunks,
  plaintextLengthFromCiphertextLength,
  type BlobMediaBinding,
  type BlobStore,
} from '@crove/kernel-runtime';

// One window of plaintext at a time (the same size the playback route reads).
export const MEASURE_WINDOW_BYTES = 4 * 1024 * 1024;

export interface SealedBlobRef {
  storageKey: string;
  generation: string | null;
  // The stored (ciphertext) size.
  sizeBytes: number;
}

// Decrypts a sealed blob window by window. The generator ends early (and the caller wipes nothing here: the key is the caller's)
// when the consumer stops reading, so a refused probe leaves nothing decrypted behind but the window in flight.
export async function* decryptedWindows(
  store: BlobStore,
  ref: SealedBlobRef,
  dataKey: Buffer,
  binding: BlobMediaBinding,
  windowBytes: number = MEASURE_WINDOW_BYTES,
): AsyncGenerator<Uint8Array> {
  const total = plaintextLengthFromCiphertextLength(ref.sizeBytes);
  for (let start = 0; start < total; start += windowBytes) {
    const end = Math.min(total - 1, start + windowBytes - 1);
    const map = mapPlaintextRangeToChunks(start, end, ref.sizeBytes);
    const sliceLength = map.ctEnd - map.ctStart + 1;
    const ciphertext = store.getRange
      ? await store.getRange(ref.storageKey, map.ctStart, map.ctEnd, ref.generation, sliceLength)
      : (await store.get(ref.storageKey, ref.generation, ref.sizeBytes)).subarray(map.ctStart, map.ctEnd + 1);
    const window = decryptBlobChunks(Buffer.from(ciphertext), dataKey, binding, map.firstChunk, map.lastChunk, map.totalChunks);
    yield new Uint8Array(window.subarray(map.offsetInFirstChunk, map.offsetInFirstChunk + map.requestedLength));
  }
}

export interface MediaMeasurer {
  // False without MEDIA_URL: the upload refuses before it reads a byte, instead of after a 2 GB transfer.
  readonly configured: boolean;
  // The whole seconds (rounded up, at least 1) the sandbox measured in the media. Throws a DomainError the caller returns as is.
  measure(kind: 'audio' | 'video', source: AsyncIterable<Uint8Array>): Promise<number>;
  // The same for media already in memory (a chunk the transcription decrypted).
  measureBytes(kind: 'audio' | 'video', bytes: Uint8Array): Promise<number>;
}

export const MEDIA_PROBE_UNAVAILABLE = 'MEDIA_PROBE_UNAVAILABLE';
export const MEDIA_PROBE_FAILED = 'MEDIA_PROBE_FAILED';
export const MEDIA_TOO_LONG = 'MEDIA_TOO_LONG';

export const unavailable = () =>
  new DomainError(MEDIA_PROBE_UNAVAILABLE, 503, 'The media service that measures recordings is not available, so this recording cannot be stored (Dịch vụ đo thời lượng bản ghi chưa sẵn sàng)');
const failed = (why: string) => new DomainError(MEDIA_PROBE_FAILED, 422, `The recording could not be read as ${why} (Không đọc được bản ghi)`);
const tooLong = () =>
  new DomainError(MEDIA_TOO_LONG, 413, `The recording is longer than ${MEDIA_LIMITS.maxDurationSeconds / 3600} hours (Bản ghi dài quá ${MEDIA_LIMITS.maxDurationSeconds / 3600} giờ)`);

// What a failed call to the sandbox means for the user. A sandbox that is down, busy or timing out is "unavailable" (the upload is
// refused and nothing is stored; a retry may work); a file it could not read is "failed"; a stream that is too long or too large for it is "too long".
function refusal(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof MediaClientError) {
    if (error.code === 'malformed_media' || error.code === 'no_audio_stream' || error.code === 'no_video_stream') return failed('media');
    if (error.code === 'too_large') return tooLong();
    return unavailable();
  }
  // A network failure, or an answer that is not the contract's (a ZodError): the same as a service that did not answer.
  return unavailable();
}

function accepted(kind: 'audio' | 'video', probe: MediaProbeResult): number {
  if (kind === 'audio' && !probe.hasAudio) throw failed('audio');
  if (kind === 'video' && !probe.hasVideo) throw failed('video');
  // The sandbox's own tolerance for packetization and padding (60 s) is allowed: a 2 hour recording is not refused for 30 s of padding.
  if (probe.durationSeconds > MEDIA_LIMITS.maxDurationSeconds + 60) throw tooLong();
  // A stream that reached no time at all has no length to charge: never one second for it.
  if (!(probe.durationSeconds > 0)) throw failed('media');
  return Math.ceil(probe.durationSeconds);
}

export function createMediaMeasurer(client: MediaClient): MediaMeasurer {
  return {
    configured: true,
    async measure(kind, source) {
      let probe: MediaProbeResult;
      try {
        probe = await client.measureStream(source);
      } catch (error) {
        throw refusal(error);
      }
      return accepted(kind, probe);
    },
    async measureBytes(kind, bytes) {
      let probe: MediaProbeResult;
      try {
        probe = await client.measure(bytes);
      } catch (error) {
        throw refusal(error);
      }
      return accepted(kind, probe);
    },
  };
}

// The measurer of a deployment: none without MEDIA_URL, and then every call refuses as unavailable.
export function mediaMeasurerFor(url: string | undefined, timeoutMs?: number): MediaMeasurer {
  if (!url) {
    const none = async (): Promise<never> => {
      throw unavailable();
    };
    return { configured: false, measure: none, measureBytes: none };
  }
  return createMediaMeasurer(createMediaClient(url, timeoutMs === undefined ? {} : { timeoutMs }));
}
