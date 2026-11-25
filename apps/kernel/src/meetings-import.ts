// SPDX-License-Identifier: AGPL-3.0-only
// The download of one platform recording to staging (meetings integrations C1, issue #3173, plan docs/plan/meetings-integrations.md section 6.1). One job per recording the member chose to
// import ("Nhập"): it opens the member's sealed platform token (only a job opens one, ADR-0025), asks the platform adapter how to fetch the file, downloads it through the egress guard (guardedStream:
// public addresses only, the adapter's hosts, a size cap counted while streaming), and writes the bytes under the staging key kept on the recording's row. It never seals or records anything: the
// member's own request does that next, through the route an upload uses (claim, seal with the meeting key, measure in crove-media, record), so no meeting key or definer changes here.
//
// - Nothing is downloaded before the click: the job exists only for a row the member's command moved to `importing`.
// - The platform's own copy is never touched; no participant list is read; the title is never read by the job.
// - Audio first. A recording with an audio file is fetched as audio and held in memory (the blob store has no streaming write to a staging key), under MEETING_PLATFORM_IMPORT_MAX_BYTES; a bigger file
//   fails `too_large` before or while it is read.
// - A recording with only a video file (C2a, #3306) is streamed, never held: the download is sealed as it arrives under a throwaway key that exists only in this process (the same path an uploaded video
//   takes, `extractAudioFromVideo`), crove-media reads it back at local speed and returns mono Opus, and only that audio is staged. The video has its own cap (MEETING_PLATFORM_VIDEO_MAX_BYTES),
//   the audio cap is unchanged, and the sealed video is deleted when the call ends. It is not piped into crove-media straight from the platform, on purpose: crove-media takes its one slot before it reads the
//   body and bounds the whole call by its process timeout (#2989), so a slow platform download would hold the slot and be cut off at 5 minutes. Without an extractor (no MEDIA_URL) a video-only recording
//   still fails `no_audio`.
// - A recording with only the platform's own transcript (C2, #3174: no audio file, no video file) is not downloaded at all: the adapter reads the transcript through its own API hosts, the job bounds every line
//   again (the text is tainted) and stages the lines as JSON under the same staging key, with the same lifecycle (claim, sweep, deletion) as staged audio. The member's own request claims it and writes it as
//   the recorder's draft (POST /api/meetings/:id/transcript-import); no audio is kept and no model is called.
// - Zoom's own transcript (C3, #3175, gap 2) is a FILE on Zoom's download hosts, not an API answer. The adapter describes it (`transcriptFile`) and the job fetches it exactly as it fetches a recording, through the
//   egress guard (public addresses, the adapter's first host, the member's token to that host only) but under the transcript file's own small cap (TRANSCRIPT_FILE_MAX_BYTES), then the adapter reads the bytes
//   (`parseTranscript`) and the same bounding and staging as above follow. An adapter with `transcript` (Meet, Teams) never reaches this branch.
// - A transient failure (the platform or the network) throws so the queue retries; the last try, and every permanent failure, is recorded on the row as a short code, never the platform's message.
import {
  MEETING_PLATFORM_IMPORT_MAX_BYTES,
  MEETING_PLATFORM_TRANSCRIPT_MAX_BYTES,
  MEETING_PLATFORM_VIDEO_MAX_BYTES,
  TRANSCRIPT_SEGMENTS_MAX,
  TRANSCRIPT_SPEAKER_MAX,
  TRANSCRIPT_TEXT_MAX,
  type MeetingPlatformErrorCode,
  type MeetingPlatformProvider,
  type TranscriptSegmentInput,
} from '@ludy/kernel-contract';
import type { MeetingPlatformAdapter, MeetingPlatformDownload, MeetingPlatformTranscript } from '@ludy/channel';
import { MeetingPlatformError } from '@ludy/channel';
import { DomainError, EgressError, guardedStream, type BlobStore, type CredentialBroker, type EgressStream, type EgressStreamOptions, type Runtime } from '@ludy/kernel-runtime';
import { freshCredential } from './meeting-platform-credential.ts';
import { MEDIA_JOIN_FRAME, MEDIA_LIMITS } from '@ludy/media-contract/extract';
import { extractAudioFromVideo, joinAudioFromParts, MEDIA_JOIN_UNAVAILABLE, type MediaAudioExtractor } from './meetings-extract.ts';
import { MEDIA_PROBE_FAILED, MEDIA_PROBE_UNAVAILABLE, MEDIA_TOO_LONG } from './meetings-measure.ts';

const ACTOR = { type: 'system' as const, component: 'meetings.import' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
// A transcript FILE (Zoom's WebVTT) is read whole into memory: a real one is a few hundred KB, this is far above that and far below an audio file.
export const TRANSCRIPT_FILE_MAX_BYTES = 8 * 1024 * 1024;
// One download, redirects and the body included.
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
// The queue tries a transient failure this many more times (a minute apart, doubling), and a job may run this long.
export const MEETINGS_IMPORT_RETRY_LIMIT = 3;
export const MEETINGS_IMPORT_EXPIRE_SECONDS = 30 * 60;
// How many downloads one worker handles at once. An audio download is held in memory (up to MEETING_PLATFORM_IMPORT_MAX_BYTES, 300 MB), so the peak of a worker is this many times 300 MB when the platform
// declares the size (one buffer, filled as the stream arrives) and up to twice that per download when it does not (the pieces, then their join): 600 MB, at most 1.2 GB with two. A video download holds no
// more than a few chunks and the Opus it returns (about 11 MB an hour); its video sits sealed in the blob store (up to MEETING_PLATFORM_VIDEO_MAX_BYTES) until the call ends. Pinned by a test.
export const MEETINGS_IMPORT_CONCURRENCY = 2;

export interface MeetingsImportJob {
  orgId: string;
  id: string;
  connectionId: string;
  provider: MeetingPlatformProvider;
  externalId: string;
  hasAudio: boolean;
  hasVideo: boolean;
  sizeBytes: number | null;
  stagingKey: string;
}

export interface MeetingsImportDeps {
  // The most bytes crove-media takes in one request (its own MEDIA_MAX_INPUT_BYTES, config.MEDIA_MAX_INPUT_BYTES); unset: the sandbox's default, the video limit. Bounds a join's parts (see joinPartsBudget).
  mediaInputBytes?: number | undefined;
  runtime: Runtime;
  broker: CredentialBroker;
  store: BlobStore;
  adapters: Readonly<Partial<Record<string, MeetingPlatformAdapter>>>;
  // The audio extraction of crove-media for a video-only recording (C2a, #3306); null or not configured (no MEDIA_URL): a video-only recording fails `no_audio`.
  extractor?: MediaAudioExtractor | null;
  // Tests only: the guarded transfer and its options.
  stream?: typeof guardedStream;
  // Tests only (timeouts, a local server): never the security fields, so no caller of the seam can undo the first-host list or the per-hop allowlist.
  streamOptions?: Partial<Omit<EgressStreamOptions, 'firstHosts' | 'hostAllowed'>>;
}

export type MeetingsImportResult = 'staged' | 'failed' | 'skipped';

// How a failed step is told to the member and whether the queue should try again.
function classify(error: unknown): { code: MeetingPlatformErrorCode; retry: boolean } {
  // A sealed token that does not parse (not JSON, a bad envelope) will not parse next time either: the connection needs a new token.
  if (error instanceof SyntaxError) return { code: 'connection_expired', retry: false };
  if (error instanceof MeetingPlatformError) return { code: error.code as MeetingPlatformErrorCode, retry: error.code === 'platform_unavailable' || error.code === 'download_failed' };
  if (error instanceof EgressError) {
    if (error.code === 'too_large') return { code: 'too_large', retry: false };
    // A compressed answer (we ask for identity) is the platform's way of answering, the same on every try, like a blocked address or a redirect loop: refused, no retry.
    if (error.code === 'blocked' || error.code === 'invalid_url' || error.code === 'redirects' || error.code === 'encoding') return { code: 'platform_refused', retry: false };
    return { code: 'platform_unavailable', retry: true };
  }
  if (error instanceof DomainError) {
    // The video path: what sealing the download and the sandbox's extraction say (apps/kernel/src/media-seal.ts, meetings-extract.ts). A file the sandbox cannot read, without audio or too long will not
    // improve on a second try; a sandbox that is down or busy may, and a body that ended short is the platform's connection.
    if (error.code === 'NO_AUDIO_TRACK') return { code: 'no_audio', retry: false };
    // A sandbox that has no /join-audio (an older crove-media): the same answer on every try, so the recording fails at once, as one the sandbox cannot join (deploy crove-media before the kernel).
    if (error.code === MEDIA_JOIN_UNAVAILABLE) return { code: 'no_audio', retry: false };
    if (error.code === 'FILE_TOO_LARGE') return { code: 'too_large', retry: false };
    if (error.code === 'INVALID_MEDIA_CONTAINER' || error.code === MEDIA_PROBE_FAILED) return { code: 'invalid_media', retry: false };
    if (error.code === MEDIA_TOO_LONG) return { code: 'too_long', retry: false };
    if (error.code === 'MEDIA_EXTRACT_TIMEOUT') return { code: 'timeout', retry: false };
    if (error.code === MEDIA_PROBE_UNAVAILABLE) return { code: 'normalize_failed', retry: true };
    if (error.code === 'BAD_REQUEST' || error.code === 'NO_FILE') return { code: 'download_failed', retry: true };
    if (error.code === 'MEETING_PLATFORM_NOT_ACTIVE' || error.code === 'MEETING_PLATFORM_OWNER_LEFT' || error.code === 'MEETING_PLATFORM_NOT_FOUND') return { code: 'connection_expired', retry: false };
  }
  return { code: 'download_failed', retry: true };
}

interface OpenDownload {
  response: EgressStream;
  // The length the platform declared, or null.
  declared: number | null;
  // Closes the connection and drops the abort listener; safe to call twice.
  release(): void;
}

// The connection to the platform's file, checked: the first host is one of the adapter's exact hosts, the answer is a 2xx, and a declared length over the cap is refused before a byte is read. The
// caller reads `response.body` and calls `release()`.
async function openDownload(deps: MeetingsImportDeps, download: MeetingPlatformDownload, maxBytes: number, signal?: AbortSignal): Promise<OpenDownload> {
  const hosts = new Set(download.hosts);
  const suffixes = download.hostSuffixes;
  // The first request goes to one of the adapter's exact hosts; the CDN suffixes are for the hops a redirect leads to (the guard asks its allowlist for every hop, so the first host is checked here).
  let first = '';
  try {
    first = new URL(download.url).hostname.toLowerCase();
  } catch {
    throw new MeetingPlatformError('platform_refused');
  }
  if (!hosts.has(first)) throw new MeetingPlatformError('platform_refused');
  const open = deps.stream ?? guardedStream;
  const response = await open(
    download.url,
    { headers: download.headers },
    {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxBytes,
      httpsOnly: true,
      // The guard refuses a first request outside the adapter's exact hosts (the check above stays as the first line); the suffixes below are for redirect hops only.
      firstHosts: download.hosts,
      redirectHeaders: 'same-host',
      hostAllowed: (host) => hosts.has(host) || suffixes.some((suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`)),
      ...deps.streamOptions,
    },
  );
  // A job the queue gives up on (its expiry) or a worker that stops closes the connection at once.
  const stop = () => response.destroy();
  signal?.addEventListener('abort', stop, { once: true });
  const release = () => {
    signal?.removeEventListener('abort', stop);
    response.destroy();
  };
  try {
    if (signal?.aborted) throw new MeetingPlatformError('platform_unavailable');
    // 401 is the token: the recording fails `connection_expired` and the screen sends the member to connect again. A 403 on a file is this member not being allowed to read this one recording (a
    // co-organizer or a delegate whose calendar says they organized it, a retention or sharing rule): `platform_refused`, so the screen says to check their access and offers no reconnect (#3906).
    if (response.status === 401) throw new MeetingPlatformError('connection_expired');
    if (response.status === 403) throw new MeetingPlatformError('platform_refused');
    if (response.status === 404 || response.status === 410) throw new MeetingPlatformError('recording_gone');
    if (response.status === 429 || response.status >= 500) throw new MeetingPlatformError('platform_unavailable');
    if (response.status < 200 || response.status >= 300) throw new MeetingPlatformError('platform_refused');
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) throw new MeetingPlatformError('too_large');
    return { response, declared: Number.isFinite(declared) && declared >= 0 ? declared : null, release };
  } catch (error) {
    release();
    throw error;
  }
}

// The platform's file, in memory, counted against the cap as it arrives (the audio cap, or the transcript's own).
async function fetchBytes(deps: MeetingsImportDeps, download: MeetingPlatformDownload, signal?: AbortSignal, cap: number = MEETING_PLATFORM_IMPORT_MAX_BYTES): Promise<Uint8Array> {
  if (download.inline) {
    if (download.inline.bytes.byteLength > cap) throw new MeetingPlatformError('too_large');
    return download.inline.bytes;
  }
  const { response, declared, release } = await openDownload(deps, download, cap, signal);
  try {
    // With the size declared, one buffer is filled as the pieces arrive (peak: the file); without it the pieces are joined at the end (peak: twice the file).
    if (declared !== null) {
      const whole = new Uint8Array(declared);
      let at = 0;
      for await (const chunk of response.body) {
        if (signal?.aborted) throw new MeetingPlatformError('platform_unavailable');
        if (at + chunk.byteLength > declared) throw new MeetingPlatformError('download_failed');
        whole.set(chunk, at);
        at += chunk.byteLength;
      }
      if (at !== declared) throw new MeetingPlatformError('download_failed');
      return whole;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new MeetingPlatformError('platform_unavailable');
      total += chunk.byteLength;
      if (total > cap) throw new MeetingPlatformError('too_large');
      chunks.push(chunk);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  } finally {
    release();
  }
}

// The audio of a platform's video file (C2a, #3306), with the video never held in memory: the download is sealed as it arrives, crove-media reads it back and returns mono Opus, and the sealed video is
// deleted when the call ends. The platform must declare the length (the seal is made for a known size, and a body cut short is refused); a file that does not is refused as the platform's answer.
async function audioOfVideo(deps: MeetingsImportDeps, job: MeetingsImportJob, download: MeetingPlatformDownload, signal?: AbortSignal): Promise<Uint8Array> {
  const extractor = deps.extractor;
  if (!extractor?.configured) throw new MeetingPlatformError('no_audio');
  let source: AsyncIterable<Uint8Array>;
  let length: number;
  let release = () => {};
  if (download.inline) {
    const bytes = download.inline.bytes;
    if (bytes.byteLength > MEETING_PLATFORM_VIDEO_MAX_BYTES) throw new MeetingPlatformError('too_large');
    source = (async function* () {
      yield bytes;
    })();
    length = bytes.byteLength;
  } else {
    const opened = await openDownload(deps, download, MEETING_PLATFORM_VIDEO_MAX_BYTES, signal);
    release = opened.release;
    // The length the response declares, else the size the platform listed for the recording (a chunked answer declares none). A listed size that is wrong makes the seal refuse the body (it ends longer or shorter than
    // declared) and the job try again; with neither, the seal cannot be made and the recording fails as the platform's answer.
    const known = opened.declared ?? job.sizeBytes;
    if (known === null) {
      release();
      throw new MeetingPlatformError('platform_refused');
    }
    length = known;
    const body = opened.response.body;
    source = (async function* () {
      for await (const chunk of body) {
        if (signal?.aborted) throw new MeetingPlatformError('platform_unavailable');
        yield chunk;
      }
    })();
  }
  try {
    // The sealed video's binding names the recording: the key lives only in this call, and no meeting is made for it.
    const out = await extractAudioFromVideo({ source, expectedLength: length, maxBytes: MEETING_PLATFORM_VIDEO_MAX_BYTES, store: deps.store, orgId: job.orgId, meetingId: job.id, extractor });
    return out.audio;
  } finally {
    release();
  }
}

// The most bytes the parts of one join may add up to. /join-audio takes at most half of the sandbox's input limit as ONE framed body (its scratch holds the body and one part), so the budget is that half, bounded by the
// format's own cap, minus the frame the parts travel in (a count, then a length per part). A recording over it is refused before a part is opened, not after it was all downloaded and sealed.
export function joinPartsBudget(format: 'audio' | 'video', mediaInputBytes: number | undefined, count: number): number {
  const formatCap = format === 'video' ? MEETING_PLATFORM_VIDEO_MAX_BYTES : MEETING_PLATFORM_IMPORT_MAX_BYTES;
  return Math.max(0, Math.floor(Math.min(formatCap, mediaInputBytes ?? MEDIA_LIMITS.maxVideoBytes) / 2) - (MEDIA_JOIN_FRAME.countBytes + MEDIA_JOIN_FRAME.lengthBytes * count));
}

// The audio of a recording the platform made in several parts (Zoom, #3175): every part is fetched through the guard in order and sealed as it arrives (the parts together counted against the cap of their
// format), crove-media reads them back in one framed call and returns ONE Opus, and the sealed parts are deleted when the call ends. A part that fails fails the whole import, so a partial recording is never
// staged. Each part must declare its length (its response, else the size the platform listed for that file); one that does not is refused as the platform's answer. A sandbox that cannot join, or none, is `no_audio`.
async function audioOfParts(deps: MeetingsImportDeps, job: MeetingsImportJob, parts: readonly MeetingPlatformDownload[], format: 'audio' | 'video', signal?: AbortSignal): Promise<Uint8Array> {
  const extractor = deps.extractor;
  if (!extractor?.configured || !extractor.join) throw new MeetingPlatformError('no_audio');
  const cap = joinPartsBudget(format, deps.mediaInputBytes, parts.length);
  // The sizes the platform listed, added up, over the cap: refused before any file is opened.
  const listed = parts.map((part) => part.sizeBytes ?? null);
  if (listed.every((n): n is number => n !== null) && listed.reduce((sum, n) => sum + n, 0) > cap) throw new MeetingPlatformError('too_large');
  // Each part is opened when its turn comes and closed once it is sealed, so only one connection is open at a time (a part that waited open and idle behind the others could be cut by the platform).
  let declaredTotal = 0;
  const opens = parts.map((part) => async () => {
    if (part.inline) throw new MeetingPlatformError('platform_refused');
    const opened = await openDownload(deps, part, cap - declaredTotal, signal);
    try {
      const known = opened.declared ?? part.sizeBytes ?? null;
      if (known === null || known < 1) throw new MeetingPlatformError('platform_refused');
      declaredTotal += known;
      if (declaredTotal > cap) throw new MeetingPlatformError('too_large');
      const body = opened.response.body;
      return {
        expectedLength: known,
        release: opened.release,
        source: (async function* () {
          for await (const chunk of body) {
            if (signal?.aborted) throw new MeetingPlatformError('platform_unavailable');
            yield chunk;
          }
        })(),
      };
    } catch (error) {
      opened.release();
      throw error;
    }
  });
  const out = await joinAudioFromParts({ parts: opens, kind: format, maxBytes: cap, store: deps.store, orgId: job.orgId, meetingId: job.id, extractor });
  return out.audio;
}

// The lines of a platform's transcript as the staged JSON `{ segments }` (and `truncated: true` when the transcript was cut, #3922), bounded again here: the platform's text is tainted, so every line is cut to the draft's limits, an empty one is dropped, the times are
// clamped to the longest call the draft takes and a line with no speaker gets a neutral label. Nothing of the platform but the lines is staged (no participant list, no title). `no_transcript` when no line is left.
export const UNKNOWN_SPEAKER = 'Người nói';
export function stageTranscript(transcript: MeetingPlatformTranscript): Uint8Array {
  const segments: TranscriptSegmentInput[] = [];
  const clamp = (seconds: number) => Math.min(86_400, Math.max(0, seconds));
  for (const entry of transcript.entries.slice(0, TRANSCRIPT_SEGMENTS_MAX)) {
    // A NUL byte is no text and Postgres refuses it in a text column, which would fail the whole import: it is dropped here.
    const text = entry.text.replaceAll('\u0000', '').trim().slice(0, TRANSCRIPT_TEXT_MAX).trim();
    if (text === '' || !Number.isFinite(entry.startSeconds) || !Number.isFinite(entry.endSeconds)) continue;
    const startSeconds = clamp(entry.startSeconds);
    const speakerLabel = (entry.speaker ?? '').replaceAll('\u0000', '').trim().slice(0, TRANSCRIPT_SPEAKER_MAX).trim() || UNKNOWN_SPEAKER;
    segments.push({ startSeconds, endSeconds: Math.max(startSeconds, clamp(entry.endSeconds)), speakerLabel, text });
  }
  if (segments.length === 0) throw new MeetingPlatformError('no_transcript');
  // Cut by the adapter (its own cap) or by the draft's (the lines beyond TRANSCRIPT_SEGMENTS_MAX are dropped above): the member is told the draft stops early. Absent when whole, so the staged bytes of a whole
  // transcript are what they always were.
  // Lines past the cap count only when one of them would have been a line (an empty or invalid one lost is no loss).
  const lostPastCap = transcript.entries.slice(TRANSCRIPT_SEGMENTS_MAX).some((e) => e.text.replaceAll('\u0000', '').trim() !== '' && Number.isFinite(e.startSeconds) && Number.isFinite(e.endSeconds));
  const cut = transcript.truncated || lostPastCap;
  const bytes = new TextEncoder().encode(JSON.stringify(cut ? { segments, truncated: true } : { segments }));
  if (bytes.byteLength > MEETING_PLATFORM_TRANSCRIPT_MAX_BYTES) throw new MeetingPlatformError('too_large');
  return bytes;
}

// One attempt for one recording. Throws, so the queue retries, only for a transient failure with tries remain; anything else is recorded on the row. Every outcome names the staging key this job was handed and
// changes the row only while it still holds exactly that key (the sweep hands an importing row over every minute until it is staged, and a failed row begun again gets a new key), so a duplicate or stale job
// does nothing and never deletes bytes another job staged.
export async function runMeetingsImport(deps: MeetingsImportDeps, job: MeetingsImportJob, attempt: { retryCount: number; retryLimit: number; signal?: AbortSignal }): Promise<MeetingsImportResult> {
  const ctx = { actor: ACTOR, orgId: job.orgId };
  const holds = await deps.runtime.query<'importing' | 'staged' | 'claimed' | 'none'>('kernel.meeting_platform.import_holds', { recordingId: job.id, stagingKey: job.stagingKey }, ctx);
  // Not this job's turn (another job staged it, the row failed, or it was begun again with another key): nothing is downloaded or touched.
  if (holds !== 'importing') return 'skipped';
  const fail = async (code: MeetingPlatformErrorCode): Promise<'failed'> => {
    await deps.runtime
      .execute('kernel.meeting_platform.import_failed', { recordingId: job.id, code, stagingKey: job.stagingKey }, ctx)
      .catch((error) => console.warn(`[meetings-import] ${job.id.slice(0, 8)} could not record ${code}`, codeOf(error)));
    return 'failed';
  };
  let wrote = false;
  try {
    const adapter = deps.adapters[job.provider];
    if (!adapter) return await fail('platform_unavailable');
    // A recording with neither an audio nor a video file is the transcript's (C2, #3174; the command lets only such a row begin when its provider has a transcript path, and the adapter must have one too).
    const transcriptOnly = !job.hasAudio && !job.hasVideo && (adapter.transcript !== undefined || (adapter.transcriptFile !== undefined && adapter.parseTranscript !== undefined));
    // A size the platform declared over the cap of the file it will be fetched as (the audio cap when there is nothing to fetch), then no audio file to take and no way to extract one: refused before any network call.
    const format = job.hasAudio ? 'audio' : job.hasVideo && deps.extractor?.configured ? 'video' : null;
    if (!transcriptOnly) {
      if (job.sizeBytes !== null && job.sizeBytes > (format === 'video' ? MEETING_PLATFORM_VIDEO_MAX_BYTES : MEETING_PLATFORM_IMPORT_MAX_BYTES)) return await fail('too_large');
      if (format === null) return await fail('no_audio');
    }
    // The token in hand, renewed first when it is about to expire (a provider that rotates its refresh token: kernel.meeting_platform.credential_refresh, one transaction under the connection's lock).
    const credential = await freshCredential(deps, job.orgId, job.connectionId, adapter);
    let bytes: Uint8Array;
    if (transcriptOnly && adapter.transcript) {
      bytes = stageTranscript(await adapter.transcript(credential, job.externalId, attempt.signal));
    } else if (transcriptOnly && adapter.transcriptFile && adapter.parseTranscript) {
      // A transcript file: fetched under the transcript's cap through the guard, read by the adapter, bounded again here like any platform text.
      const download = await adapter.transcriptFile(credential, job.externalId, attempt.signal);
      bytes = stageTranscript(adapter.parseTranscript(await fetchBytes(deps, download, attempt.signal, TRANSCRIPT_FILE_MAX_BYTES)));
    } else {
      // A recording made in segments comes as two or more files (Zoom, #3175): they are joined into one audio. A platform that never splits has no such step, and a recording of one file answers with none.
      const parts = adapter.prepareParts ? await adapter.prepareParts(credential, job.externalId, format as 'audio' | 'video', attempt.signal) : [];
      const download = parts.length < 2 ? await adapter.prepareDownload(credential, job.externalId, format as 'audio' | 'video', attempt.signal) : null;
      bytes = download === null ? await audioOfParts(deps, job, parts, format as 'audio' | 'video', attempt.signal) : download.format === 'video' ? await audioOfVideo(deps, job, download, attempt.signal) : await fetchBytes(deps, download, attempt.signal);
      // The audio cap is the same whether the audio came as a file or out of a video.
      if (bytes.byteLength > MEETING_PLATFORM_IMPORT_MAX_BYTES) throw new MeetingPlatformError('too_large');
    }
    if (bytes.byteLength === 0) throw new MeetingPlatformError('download_failed');
    await deps.store.put(job.stagingKey, bytes, 'application/octet-stream');
    wrote = true;
    const staged = await deps.runtime.execute<{ applied: number }>('kernel.meeting_platform.import_staged', { recordingId: job.id, stagingKey: job.stagingKey }, ctx);
    if (staged.applied === 1) return 'staged';
    // The row no longer waits for these bytes. Delete them only if it holds no other copy under this key: another job's staged bytes (same key) are the member's to claim.
    const now = await deps.runtime.query<'importing' | 'staged' | 'claimed' | 'none'>('kernel.meeting_platform.import_holds', { recordingId: job.id, stagingKey: job.stagingKey }, ctx);
    if (now === 'none') await deps.store.delete(job.stagingKey).catch(() => undefined);
    return 'skipped';
  } catch (error) {
    const { code, retry } = classify(error);
    console.warn(`[meetings-import] ${job.id.slice(0, 8)} not staged`, codeOf(error));
    if (retry && attempt.retryCount < attempt.retryLimit) throw new Error(`meetings import ${job.id.slice(0, 8)} not staged (attempt ${attempt.retryCount + 1})`);
    // A failure after the bytes were written but before the row moved is left to the sweep (the row times out and its key's bytes are deleted there).
    if (wrote) return 'failed';
    return fail(code);
  }
}
