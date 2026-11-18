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
// - A transient failure (the platform or the network) throws so the queue retries; the last try, and every permanent failure, is recorded on the row as a short code, never the platform's message.
import {
  meetingPlatformBinding,
  MEETING_PLATFORM_IMPORT_MAX_BYTES,
  MEETING_PLATFORM_VIDEO_MAX_BYTES,
  type MeetingPlatformErrorCode,
  type MeetingPlatformProvider,
} from '@crove/kernel-contract';
import type { MeetingPlatformAdapter, MeetingPlatformCredential, MeetingPlatformDownload } from '@crove/channel';
import { MeetingPlatformError } from '@crove/channel';
import { DomainError, EgressError, guardedStream, type BlobStore, type CredentialBroker, type EgressStream, type EgressStreamOptions, type Runtime } from '@crove/kernel-runtime';
import { extractAudioFromVideo, type MediaAudioExtractor } from './meetings-extract.ts';
import { MEDIA_PROBE_FAILED, MEDIA_PROBE_UNAVAILABLE, MEDIA_TOO_LONG } from './meetings-measure.ts';

const ACTOR = { type: 'system' as const, component: 'meetings.import' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
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

interface SealedCredential {
  keyId: string;
  envelope: string;
  provider: string;
  externalAccount: string;
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

async function openCredential(deps: MeetingsImportDeps, job: MeetingsImportJob): Promise<MeetingPlatformCredential> {
  const sealed = await deps.runtime.query<SealedCredential>('kernel.meeting_platform.credential', { connectionId: job.connectionId }, { actor: ACTOR, orgId: job.orgId });
  const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, meetingPlatformBinding(job.orgId, sealed.provider as MeetingPlatformProvider, sealed.externalAccount));
  const parsed = JSON.parse(secret) as { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
  if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') throw new MeetingPlatformError('connection_expired');
  return {
    accessToken: parsed.accessToken,
    ...(typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {}),
    ...(typeof parsed.expiresAt === 'string' ? { expiresAt: new Date(parsed.expiresAt) } : {}),
  };
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
    if (response.status === 401 || response.status === 403) throw new MeetingPlatformError('connection_expired');
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

// The platform's file, in memory, counted against the cap as it arrives.
async function fetchBytes(deps: MeetingsImportDeps, download: MeetingPlatformDownload, signal?: AbortSignal): Promise<Uint8Array> {
  if (download.inline) {
    if (download.inline.bytes.byteLength > MEETING_PLATFORM_IMPORT_MAX_BYTES) throw new MeetingPlatformError('too_large');
    return download.inline.bytes;
  }
  const { response, declared, release } = await openDownload(deps, download, MEETING_PLATFORM_IMPORT_MAX_BYTES, signal);
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
      if (total > MEETING_PLATFORM_IMPORT_MAX_BYTES) throw new MeetingPlatformError('too_large');
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
    // A size the platform declared over the cap of the file it will be fetched as (the audio cap when there is nothing to fetch), then no audio file to take and no way to extract one: refused before any network call.
    const format = job.hasAudio ? 'audio' : job.hasVideo && deps.extractor?.configured ? 'video' : null;
    if (job.sizeBytes !== null && job.sizeBytes > (format === 'video' ? MEETING_PLATFORM_VIDEO_MAX_BYTES : MEETING_PLATFORM_IMPORT_MAX_BYTES)) return await fail('too_large');
    if (format === null) return await fail('no_audio');
    const credential = await openCredential(deps, job);
    const download = await adapter.prepareDownload(credential, job.externalId, format, attempt.signal);
    const bytes = download.format === 'video' ? await audioOfVideo(deps, job, download, attempt.signal) : await fetchBytes(deps, download, attempt.signal);
    if (bytes.byteLength === 0) throw new MeetingPlatformError('download_failed');
    // The audio cap is the same whether the audio came as a file or out of a video.
    if (bytes.byteLength > MEETING_PLATFORM_IMPORT_MAX_BYTES) throw new MeetingPlatformError('too_large');
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
