// SPDX-License-Identifier: AGPL-3.0-only
// A video file uploaded as a meeting's audio keeps only its audio (#3337, docs/plan/meetings.md §5.5). The upload seals the video under a key that
// lives only in memory, streams it back to crove-media (the sandbox: ffmpeg, no network), which returns mono Opus, and deletes the sealed video;
// the caller then seals only that Opus as the recording, so the video is never stored. Whatever the sandbox says is untrusted: the client
// validates it with a strict schema, and only a duration in range is accepted.
import { randomBytes } from 'node:crypto';
import { createMediaExtractClient, MEDIA_LIMITS, MEDIA_TIMING, MediaClientError, type MediaExtractClient } from '@crove/media-contract/extract';
import { DomainError, type BlobMediaBinding, type BlobStore } from '@crove/kernel-runtime';
import { decryptedWindows, failed, MEDIA_PROBE_FAILED, tooLong, unavailable } from './meetings-measure.ts';
import { sealMedia } from './media-seal.ts';

const noAudioTrack = () => new DomainError('NO_AUDIO_TRACK', 422, 'The video has no audio track, so there is nothing to keep (Video không có âm thanh)');
const fileTooLarge = () => new DomainError('FILE_TOO_LARGE', 413, 'The file is too large (Tệp quá lớn)');
// 503, not 504: ErrorStatus (packages/kernel-runtime, a protected path) has no 504, and a retry may work like for any unavailable service.
const extractTimeout = () =>
  new DomainError('MEDIA_EXTRACT_TIMEOUT', 503, 'Taking the audio out of the video took too long, so nothing was stored (Lấy âm thanh từ video quá lâu, chưa lưu gì)');

// crove-media's own time for one call plus the margin its transport adds: the hard deadline of an extraction.
export const EXTRACT_TIMEOUT_MS = MEDIA_TIMING.processTimeoutMs + 15_000;

export interface MediaAudioExtractor {
  // False without MEDIA_URL: the upload refuses before it reads a byte, instead of after a 2 GB transfer.
  readonly configured: boolean;
  // The Opus audio of the recording and its length in seconds. Throws a DomainError the caller returns as is.
  extract(source: AsyncIterable<Uint8Array>): Promise<{ audio: Uint8Array; durationSeconds: number }>;
}

// What a failed call to the sandbox means for the user: a file with no audio, a file it could not read, a file too large for it, a call that
// ran out of time, or (a sandbox that is down or busy, a network failure, an answer that is not the contract's) unavailable, which a retry may fix.
function refusal(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return extractTimeout();
  if (error instanceof MediaClientError) {
    if (error.code === 'no_audio_stream') return noAudioTrack();
    if (error.code === 'malformed_media') return failed('media');
    if (error.code === 'too_large') return fileTooLarge();
    if (error.code === 'timeout') return extractTimeout();
  }
  return unavailable();
}

export function createMediaAudioExtractor(client: MediaExtractClient, options: { timeoutMs?: number } = {}): MediaAudioExtractor {
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  return {
    configured: true,
    async extract(source) {
      // A hard deadline over the whole call, whatever the client does: when it passes, the call is aborted (which closes the source).
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(extractTimeout());
        }, timeoutMs);
      });
      let out: { audio: Uint8Array; durationSeconds: number };
      try {
        const call = client.extractAudio(source, controller.signal);
        // When the deadline wins, the call's own later rejection must not surface as an unhandled one.
        call.catch(() => undefined);
        out = await Promise.race([call, deadline]);
      } catch (error) {
        throw refusal(error);
      } finally {
        clearTimeout(timer);
      }
      // The sandbox's own tolerance for packetization and padding (60 s) is allowed, as in the measurer.
      if (out.durationSeconds > MEDIA_LIMITS.maxDurationSeconds + 60) throw tooLong();
      if (!(out.durationSeconds > 0) || out.audio.length === 0) throw new DomainError(MEDIA_PROBE_FAILED, 422, 'The recording could not be read as media (Không đọc được bản ghi)');
      return out;
    },
  };
}

// The extractor of a deployment: none without MEDIA_URL, and then every call refuses as unavailable.
export function mediaAudioExtractorFor(url: string | undefined, timeoutMs?: number): MediaAudioExtractor {
  if (!url) {
    return {
      configured: false,
      extract: async (): Promise<never> => {
        throw unavailable();
      },
    };
  }
  return createMediaAudioExtractor(createMediaExtractClient(url, timeoutMs === undefined ? {} : { timeoutMs }), timeoutMs === undefined ? {} : { timeoutMs });
}

export interface VideoExtraction {
  // The uploaded video as it arrives, and the length it declared (checked while it streams).
  source: AsyncIterable<Uint8Array>;
  expectedLength: number;
  // The video cap in force.
  maxBytes: number;
  store: BlobStore;
  orgId: string;
  meetingId: string;
  extractor: MediaAudioExtractor;
  // A test hook: the throwaway key (default 32 random bytes).
  newKey?: () => Buffer;
}

// The audio of an uploaded video, with the video never kept. The video is sealed first (its container sniffed, the video cap and its declared
// length enforced while it streams) under a throwaway key that exists only in this call's memory: it is never wrapped, never written to
// media_key, and zeroed at the end. That decouples the member's upload speed from crove-media's own body deadline, and the video plaintext
// reaches crove-media straight from memory (decrypted a window at a time), never the kernel's disk. The sealed video never gets a row and is
// deleted when this call ends, on success and on every refusal; a crash leaves only ciphertext whose key existed only in memory.
export async function extractAudioFromVideo(input: VideoExtraction): Promise<{ audio: Uint8Array; durationSeconds: number }> {
  const key = (input.newKey ?? (() => randomBytes(32)))();
  const binding: BlobMediaBinding = { orgId: input.orgId, meetingId: input.meetingId, kind: 'video' };
  let stored: { key: string; generation: string | null; size: number; created: boolean } | undefined;
  try {
    const sealed = await sealMedia({
      source: input.source,
      expectedLength: input.expectedLength,
      kind: 'video',
      dataKey: key,
      binding,
      maxBytes: input.maxBytes,
      store: input.store,
      orgId: input.orgId,
    });
    stored = sealed;
    return await input.extractor.extract(decryptedWindows(input.store, { storageKey: sealed.key, generation: sealed.generation, sizeBytes: sealed.size }, key, binding));
  } finally {
    if (stored?.created) await input.store.delete(stored.key).catch((err) => console.error('[meetings] temporary video cleanup failed', err));
    key.fill(0);
  }
}
