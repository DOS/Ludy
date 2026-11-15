// SPDX-License-Identifier: AGPL-3.0-only
// Meeting platform adapters (meetings integrations C1, issue #3173, plan docs/plan/meetings-integrations.md section 6.1): a member connects a platform and imports the recordings it finished.
// C2 (Google Meet), C3 (Zoom) and C4 (Teams) each only ADD an adapter here and a key in `meetingPlatformAdapters`. C1 ships the platform-neutral interface and an offline sandbox, like the channel layer's
// `sandbox` (ADR-0025): no network, so the whole flow runs on a laptop and in tests.
//
// The adapter never opens a download itself. The worker job performs every download through the shared egress guard (`guardedStream` of @crove/kernel-runtime), so `prepareDownload` only DESCRIBES the
// request. Tokens never leave the job: an error message never carries a token or the platform's response body.
//
// The provider and error-code unions below repeat those of `@crove/kernel-contract` (meeting-platform.ts); this package does not depend on the contract, and the kernel's tests hold the two equal.

export type MeetingPlatformProvider = 'sandbox' | 'google_meet' | 'zoom' | 'microsoft_teams';
export type MeetingPlatformErrorCode =
  | 'download_failed'
  | 'platform_unavailable'
  | 'platform_refused'
  | 'connection_expired'
  | 'recording_gone'
  | 'too_large'
  | 'too_long'
  | 'no_audio'
  | 'invalid_media'
  | 'normalize_failed'
  | 'not_claimed'
  | 'claim_failed'
  | 'timeout';

// What the adapter lists for one recording, as `zMeetingPlatformListed` of the contract reads it (`startedAt` an ISO instant with an offset).
export interface MeetingPlatformListed {
  id: string;
  title: string;
  startedAt: string;
  lengthSeconds: number | null;
  sizeBytes: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  hasTranscript: boolean;
}

export interface MeetingPlatformCredential {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: Date | undefined;
}

export type MeetingPlatformFormat = 'audio' | 'video';

export interface MeetingPlatformDownload {
  url: string;
  headers: Record<string, string>;
  format: MeetingPlatformFormat;
  contentType?: string | undefined;
  sizeBytes?: number | null | undefined;
  // The exact hosts the egress guard may talk to first.
  hosts: readonly string[];
  // CDN suffixes the guard allows (a platform's file usually sits on one, reached by a redirect; the headers of the request go only to the first host, never to a redirect target).
  hostSuffixes: readonly string[];
  // The offline sandbox only; the job reads these bytes instead of opening a connection (`url` is then `sandbox://local/<id>` and `hosts` is empty).
  inline?: { bytes: Uint8Array; contentType: string } | undefined;
}

export interface MeetingPlatformAdapter {
  readonly provider: MeetingPlatformProvider;
  // The API hosts this adapter may call itself (its fetch is bound to them, ADR-0025).
  readonly hosts: readonly string[];
  // At most 100 recordings that are finished and started at or after `since`, newest first.
  list(credential: MeetingPlatformCredential, since: Date, signal?: AbortSignal): Promise<MeetingPlatformListed[]>;
  prepareDownload(credential: MeetingPlatformCredential, recordingId: string, format: MeetingPlatformFormat, signal?: AbortSignal): Promise<MeetingPlatformDownload>;
  // `refused`: the platform will not renew the grant, the job expires the connection.
  refresh?(credential: MeetingPlatformCredential, signal?: AbortSignal): Promise<MeetingPlatformCredential | { refused: true }>;
}

/**
 * Why a platform call failed, as a short code: `platform_unavailable` (network or 5xx), `platform_refused` (4xx other than expiry), `connection_expired` (the token was refused, the job expires the
 * connection), `recording_gone` (404), `no_audio` (the recording has no such track). The message never contains a token or the platform's response body.
 */
export class MeetingPlatformError extends Error {
  readonly code: MeetingPlatformErrorCode;
  constructor(code: MeetingPlatformErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'MeetingPlatformError';
    this.code = code;
  }
}

export const MEETING_PLATFORM_LIST_MAX = 100;

// 2 seconds of mono 8 kHz 16-bit PCM silence: a real, valid WAV (44-byte RIFF header, then 32000 bytes of zero samples).
export function silentWav(seconds = 2, sampleRate = 8000): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = Math.round(seconds * sampleRate) * bytesPerSample;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  tag(36, 'data');
  view.setUint32(40, dataSize, true);
  return out;
}

// A minimal MP4 `ftyp` box (`....ftypisom`, brands isom and mp41): all the container sniff needs is the first 12 bytes.
export function minimalMp4(): Uint8Array {
  return Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);
}

export interface SandboxMeetingRecording {
  id: string;
  title: string;
  startedAt: Date;
  lengthSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  hasTranscript: boolean;
  audio?: Uint8Array | undefined;
  video?: Uint8Array | undefined;
}

export interface SandboxMeetingPlatformOptions {
  // Seed the two default recordings (default true).
  seed?: boolean | undefined;
  now?: (() => Date) | undefined;
}

// The offline sandbox platform: an in-memory fixture store, for tests and the dev stack. A restart forgets what `add` stored.
export class SandboxMeetingPlatform implements MeetingPlatformAdapter {
  readonly provider = 'sandbox' as const;
  readonly hosts: readonly string[] = [];
  private readonly recordings = new Map<string, SandboxMeetingRecording>();

  constructor(options: SandboxMeetingPlatformOptions = {}) {
    if (options.seed === false) return;
    const now = (options.now ?? (() => new Date()))().getTime();
    this.add({ id: 'sandbox-rec-audio', title: 'Weekly sync (audio)', startedAt: new Date(now - 3_600_000), lengthSeconds: 2, hasAudio: true, hasVideo: false, hasTranscript: false, audio: silentWav() });
    this.add({ id: 'sandbox-rec-video', title: 'Product demo (video only)', startedAt: new Date(now - 7_200_000), lengthSeconds: 2, hasAudio: false, hasVideo: true, hasTranscript: false, video: minimalMp4() });
  }

  add(recording: SandboxMeetingRecording): void {
    this.recordings.set(recording.id, recording);
  }

  async list(_credential: MeetingPlatformCredential, since: Date, _signal?: AbortSignal): Promise<MeetingPlatformListed[]> {
    return [...this.recordings.values()]
      .filter((r) => r.startedAt.getTime() >= since.getTime())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, MEETING_PLATFORM_LIST_MAX)
      .map((r) => ({
        id: r.id,
        title: r.title.slice(0, 200),
        startedAt: r.startedAt.toISOString(),
        lengthSeconds: r.lengthSeconds,
        sizeBytes: (r.audio?.byteLength ?? 0) + (r.video?.byteLength ?? 0) || null,
        hasAudio: r.hasAudio,
        hasVideo: r.hasVideo,
        hasTranscript: r.hasTranscript,
      }));
  }

  async prepareDownload(_credential: MeetingPlatformCredential, recordingId: string, format: MeetingPlatformFormat, _signal?: AbortSignal): Promise<MeetingPlatformDownload> {
    const recording = this.recordings.get(recordingId);
    if (!recording) throw new MeetingPlatformError('recording_gone');
    const bytes = format === 'audio' ? recording.audio : recording.video;
    const has = format === 'audio' ? recording.hasAudio : recording.hasVideo;
    if (!has || !bytes) throw new MeetingPlatformError(format === 'audio' ? 'no_audio' : 'platform_refused', `the recording has no ${format} track`);
    const contentType = format === 'audio' ? 'audio/wav' : 'video/mp4';
    return { url: `sandbox://local/${encodeURIComponent(recording.id)}`, headers: {}, format, contentType, sizeBytes: bytes.byteLength, hosts: [], hostSuffixes: [], inline: { bytes, contentType } };
  }
}

export interface MeetingPlatformAdaptersConfig {
  // The offline sandbox is on unless this is `false`.
  sandbox?: boolean | undefined;
  // A shared sandbox store (tests and the dev stack add fixtures to it); a fresh seeded one when omitted.
  sandboxPlatform?: SandboxMeetingPlatform | undefined;
}

// The adapters a deployment has, by provider; a provider without one has no key. C2 to C4 add theirs here.
export function meetingPlatformAdapters(config: MeetingPlatformAdaptersConfig = {}): Partial<Record<MeetingPlatformProvider, MeetingPlatformAdapter>> {
  const adapters: Partial<Record<MeetingPlatformProvider, MeetingPlatformAdapter>> = {};
  if (config.sandbox !== false) adapters.sandbox = config.sandboxPlatform ?? new SandboxMeetingPlatform();
  return adapters;
}
