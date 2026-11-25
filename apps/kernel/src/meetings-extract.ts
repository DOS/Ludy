// SPDX-License-Identifier: AGPL-3.0-only
// A video file uploaded as a meeting's audio keeps only its audio (#3337, docs/plan/meetings.md §5.5). The upload seals the video under a key that
// lives only in memory, streams it back to crove-media (the sandbox: ffmpeg, no network), which returns mono Opus, and deletes the sealed video;
// the caller then seals only that Opus as the recording, so the video is never stored. Whatever the sandbox says is untrusted: the client
// validates it with a strict schema, and only a duration in range is accepted.
import { randomBytes } from 'node:crypto';
import { createMediaExtractClient, createMediaJoinClient, MEDIA_LIMITS, MEDIA_TIMING, MediaClientError, type JoinPartSource, type MediaExtractClient, type MediaJoinClient } from '@ludy/media-contract/extract';
import { DomainError, type BlobMediaBinding, type BlobStore } from '@ludy/kernel-runtime';
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
  // The parts of one recording (a Zoom call recorded in several segments, #3175) joined in order into one Opus: each part declares its length, the sandbox gets them as one framed body. Absent on a
  // deployment whose sandbox predates the call (or in a test that does not use it): the recording is then refused like a video with no sandbox.
  join?(parts: readonly JoinPartSource[]): Promise<{ audio: Uint8Array; durationSeconds: number }>;
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

export function createMediaAudioExtractor(client: MediaExtractClient & Partial<MediaJoinClient>, options: { timeoutMs?: number } = {}): MediaAudioExtractor {
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  // A hard deadline over the whole call, whatever the client does: when it passes, the call is aborted (which closes the source).
  async function guarded(run: (signal: AbortSignal) => Promise<{ audio: Uint8Array; durationSeconds: number }>): Promise<{ audio: Uint8Array; durationSeconds: number }> {
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
      const call = run(controller.signal);
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
  }
  const joinAudio = client.joinAudio?.bind(client);
  return {
    configured: true,
    extract: (source) => guarded((signal) => client.extractAudio(source, signal)),
    ...(joinAudio ? { join: (parts: readonly JoinPartSource[]) => guarded((signal) => joinAudio(parts, signal)) } : {}),
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
  const clientOptions = timeoutMs === undefined ? {} : { timeoutMs };
  return createMediaAudioExtractor({ ...createMediaExtractClient(url, clientOptions), ...createMediaJoinClient(url, clientOptions) }, clientOptions);
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
// deleted when this call ends, on success and on every refusal; a crash leaves only ciphertext whose key existed only in memory, under tmp/<org_id>/, which the daily retention job deletes once it is a few hours old (#3341).
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
      // Under tmp/, so a crash before the `finally` leaves an object the retention job sweeps (#3341).
      temporary: true,
    });
    stored = sealed;
    return await input.extractor.extract(decryptedWindows(input.store, { storageKey: sealed.key, generation: sealed.generation, sizeBytes: sealed.size }, key, binding));
  } finally {
    if (stored?.created) await input.store.delete(stored.key).catch((err) => console.error('[meetings] temporary video cleanup failed', err));
    key.fill(0);
  }
}

export interface PartsJoin {
  // The parts in the order they are to be joined. Each is OPENED when its turn comes (so no connection waits idle behind the parts before it) and gives its bytes as they arrive with the length it declared
  // (checked while it streams); `release` closes it and is called when the part has been sealed or failed.
  parts: ReadonlyArray<() => Promise<{ source: AsyncIterable<Uint8Array>; expectedLength: number; release: () => void }>>;
  kind: 'audio' | 'video';
  // The cap on the parts together, counted as each is sealed.
  maxBytes: number;
  store: BlobStore;
  orgId: string;
  meetingId: string;
  extractor: MediaAudioExtractor;
  // A test hook: the throwaway key (default 32 random bytes).
  newKey?: () => Buffer;
}

// The audio of a recording that came in parts, with no part kept. Each part is sealed in turn under ONE throwaway key that exists only in this call's memory (the same discipline as the video of an upload:
// never wrapped, never written to media_key, zeroed at the end, the sealed objects under tmp/ so a crash leaves only ciphertext the retention job sweeps), then the parts are read back in order, decrypted a
// window at a time, into one framed call to the sandbox. The sealed parts are deleted when the call ends, on success and on every refusal. A part that fails fails the whole join: a partial recording is never returned.
export async function joinAudioFromParts(input: PartsJoin): Promise<{ audio: Uint8Array; durationSeconds: number }> {
  const join = input.extractor.join;
  if (!join) throw unavailable();
  const key = (input.newKey ?? (() => randomBytes(32)))();
  const binding: BlobMediaBinding = { orgId: input.orgId, meetingId: input.meetingId, kind: input.kind };
  const stored: Array<{ key: string; created: boolean }> = [];
  try {
    const sealed: Array<{ key: string; generation: string | null; size: number; plaintextBytes: number }> = [];
    let total = 0;
    for (const open of input.parts) {
      const part = await open();
      try {
        const one = await sealMedia({
          source: part.source,
          expectedLength: part.expectedLength,
          kind: input.kind,
          dataKey: key,
          binding,
          maxBytes: input.maxBytes - total,
          store: input.store,
          orgId: input.orgId,
          temporary: true,
        });
        stored.push({ key: one.key, created: one.created });
        total += one.plaintextBytes;
        sealed.push(one);
      } finally {
        part.release();
      }
    }
    return await join.call(
      input.extractor,
      sealed.map((one) => ({ length: one.plaintextBytes, source: decryptedWindows(input.store, { storageKey: one.key, generation: one.generation, sizeBytes: one.size }, key, binding) })),
    );
  } finally {
    for (const one of stored) if (one.created) await input.store.delete(one.key).catch((err) => console.error('[meetings] temporary part cleanup failed', err));
    key.fill(0);
  }
}
