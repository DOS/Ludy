// SPDX-License-Identifier: AGPL-3.0-only
// Meeting platform adapters (meetings integrations C1, issue #3173, plan docs/plan/meetings-integrations.md section 6.1): a member connects a platform and imports the recordings it finished.
// C2 (Google Meet), C3 (Zoom) and C4 (Teams) each only ADD an adapter here and a key in `meetingPlatformAdapters`. C1 ships the platform-neutral interface and an offline sandbox, like the channel layer's
// `sandbox` (ADR-0025): no network, so the whole flow runs on a laptop and in tests.
//
// The adapter never opens a download itself. The worker job performs every download through the shared egress guard (`guardedStream` of @ludy/kernel-runtime), so `prepareDownload` only DESCRIBES the
// request. Tokens never leave the job: an error message never carries a token or the platform's response body.
//
// The provider and error-code unions below repeat those of `@ludy/kernel-contract` (meeting-platform.ts); this package does not depend on the contract, and the kernel's tests hold the two equal.

import { GoogleCalendarAdapter } from './calendar-google.ts';
import { GoogleMeetAdapter, type GoogleMeetAppConfig } from './meeting-google.ts';
import { TeamsMeetingPlatform, type TeamsAppConfig } from './meeting-platform-teams.ts';
import { ZoomMeetingPlatform, type ZoomAppConfig } from './meeting-platform-zoom.ts';

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
  | 'timeout'
  | 'no_transcript'
  // Microsoft Teams (C4): a tenant administrator has not turned on Graph access to meeting transcripts, or speaker names; only the administrator can fix either.
  | 'transcripts_disabled'
  | 'speakers_disabled';

export type MeetingPlatformCallPlatform = 'google_meet' | 'zoom' | 'microsoft_teams';

export interface MeetingPlatformCall {
  platform: MeetingPlatformCallPlatform;
  id: string;
}

const GOOGLE_MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
const ZOOM_MEETING_NUMBER = /^\d{9,11}$/;
const TEAMS_THREAD_ID = /^19:meeting_[a-z0-9_-]+@thread\.(?:v2|skype)$/i;
const TEAMS_MEET_NUMBER = /^\d{9,15}$/;

// Canonical call identifier validation & extraction matching `@ludy/kernel-contract`'s `captureCallOf`
// (`packages/channel` does not depend on `@ludy/kernel-contract`; parity tests pin the two equal).
export function normalizeMeetingPlatformCall(call: { platform: string; id: string }): MeetingPlatformCall | null {
  const id = call.id.trim();
  if (call.platform === 'google_meet') {
    return GOOGLE_MEET_CODE.test(id) ? { platform: 'google_meet', id: id.toLowerCase() } : null;
  }
  if (call.platform === 'zoom') {
    return ZOOM_MEETING_NUMBER.test(id) ? { platform: 'zoom', id } : null;
  }
  if (call.platform === 'microsoft_teams') {
    if (TEAMS_THREAD_ID.test(id)) return { platform: 'microsoft_teams', id: id.toLowerCase() };
    return TEAMS_MEET_NUMBER.test(id) ? { platform: 'microsoft_teams', id } : null;
  }
  return null;
}

export function meetingPlatformCallOf(joinUrl: string): MeetingPlatformCall | null {
  let url: URL;
  try {
    url = new URL(joinUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, '');
  if (host === 'meet.google.com') {
    const m = /^\/([^/]+)$/.exec(path);
    return m ? normalizeMeetingPlatformCall({ platform: 'google_meet', id: m[1] as string }) : null;
  }
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) {
    const m = /^\/(?:j|wc\/join)\/(\d+)$/.exec(path);
    return m ? normalizeMeetingPlatformCall({ platform: 'zoom', id: m[1] as string }) : null;
  }
  if (host === 'teams.microsoft.com') {
    const thread = /^\/l\/meetup-join\/([^/]+)(?:\/|$)/.exec(path);
    if (thread) {
      try {
        return normalizeMeetingPlatformCall({ platform: 'microsoft_teams', id: decodeURIComponent(thread[1] as string) });
      } catch {
        return null;
      }
    }
    const meet = /^\/meet\/(\d+)$/.exec(path);
    return meet ? normalizeMeetingPlatformCall({ platform: 'microsoft_teams', id: meet[1] as string }) : null;
  }
  return null;
}

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
  // Canonical call identity (`platform` + `id`, never a raw join URL or password query) when the platform gives one.
  call?: MeetingPlatformCall | null | undefined;
}

export interface MeetingPlatformCredential {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: Date | undefined;
}

export type MeetingPlatformFormat = 'audio' | 'video';

// What a download is: a recording's audio or video, or (Zoom, #3175) the platform's own transcript as a small text file.
export type MeetingPlatformDownloadFormat = MeetingPlatformFormat | 'transcript';

export interface MeetingPlatformDownload {
  url: string;
  headers: Record<string, string>;
  format: MeetingPlatformDownloadFormat;
  contentType?: string | undefined;
  sizeBytes?: number | null | undefined;
  // The exact hosts the egress guard may talk to first.
  hosts: readonly string[];
  // CDN suffixes the guard allows (a platform's file usually sits on one, reached by a redirect; the headers of the request go only to the first host, never to a redirect target).
  hostSuffixes: readonly string[];
  // The offline sandbox only; the job reads these bytes instead of opening a connection (`url` is then `sandbox://local/<id>` and `hosts` is empty).
  inline?: { bytes: Uint8Array; contentType: string } | undefined;
}

// One line of a platform's own transcript (C2, #3174): seconds from the start of the call, the speaker's name where the platform gives it, and the text. Tainted data: the job bounds it again.
export interface MeetingPlatformTranscriptEntry {
  startSeconds: number;
  endSeconds: number;
  speaker: string | null;
  text: string;
}

// A platform's transcript of a call. `source` names who made it: this is the PLATFORM's transcription, never Ludy's, and the data and the screens say so. `truncated`: the platform's transcript was longer
// than the adapter reads.
export interface MeetingPlatformTranscript {
  source: 'google_meet' | 'microsoft_teams' | 'zoom';
  language: string | null;
  truncated: boolean;
  entries: MeetingPlatformTranscriptEntry[];
}

export interface MeetingPlatformAdapter {
  readonly provider: MeetingPlatformProvider;
  // The API hosts this adapter may call itself (its fetch is bound to them, ADR-0025).
  readonly hosts: readonly string[];
  // At most 100 recordings that are finished and started at or after `since`, newest first.
  list(credential: MeetingPlatformCredential, since: Date, signal?: AbortSignal): Promise<MeetingPlatformListed[]>;
  prepareDownload(credential: MeetingPlatformCredential, recordingId: string, format: MeetingPlatformFormat, signal?: AbortSignal): Promise<MeetingPlatformDownload>;
  // The platform's own transcript of one recording, for an adapter that has one (Google Meet, C2). The job never opens a transcript download: the adapter calls its own API hosts.
  transcript?(credential: MeetingPlatformCredential, recordingId: string, signal?: AbortSignal): Promise<MeetingPlatformTranscript>;
  // The platform's own transcript when it is a FILE on the platform's download hosts (Zoom, #3175) and not an API answer: `transcriptFile` describes its download exactly as `prepareDownload` describes a recording's (the job
  // fetches it through the egress guard under a small cap, the member's token goes only to the first host), and `parseTranscript` reads the bytes the job got. A transcript is the adapter's own when it has `transcript`, else this pair.
  transcriptFile?(credential: MeetingPlatformCredential, recordingId: string, signal?: AbortSignal): Promise<MeetingPlatformDownload>;
  parseTranscript?(bytes: Uint8Array): MeetingPlatformTranscript;
  // The Drive file a platform wrote one recording to, asked of the platform now (Google Meet's Picker route, #3174): the pick command checks the member's pick against it. Absent for an adapter with no such step.
  recordingFile?(credential: MeetingPlatformCredential, recordingId: string, signal?: AbortSignal): Promise<{ fileId: string } | null>;
  // `refused`: the platform will not renew the grant, the job expires the connection (an adapter may also throw `connection_expired` for the same). It renews ONE token under a lock, in a transaction the database ends if it
  // idles too long: it must honour `signal` and return the NEW refresh token a provider rotates, with the new expiry; a failure to reach the platform throws `platform_unavailable` and changes nothing.
  refresh?(credential: MeetingPlatformCredential, signal?: AbortSignal): Promise<MeetingPlatformCredential | { refused: true }>;
}

// The account a finished OAuth grant belongs to, as the kernel seals and stores it (the connect step; calendar-google.ts has the same shape for calendars).
export interface MeetingPlatformAccount {
  // A stable name of the account, lowercased (the connection's unique key per member and provider, and part of the binding its tokens are sealed for).
  externalAccount: string;
  displayName: string;
  scopes: string[];
  expiresAt: Date | null;
  // The credential JSON the job and the sweep open (`accessToken`, `refreshToken`, `expiresAt`); sealed by the caller and dropped, never logged.
  secret: string;
}

export interface MeetingPlatformAuthorizeInput {
  state: string;
  redirectUri: string;
  codeChallenge: string | null;
}

// The connect dialog of a platform (C3 onwards). A separate interface, because the sandbox has none. `oauthProvider` is the name of the attempt in the shared oauth_state table.
export interface MeetingPlatformOAuth {
  readonly oauthProvider: 'google_recordings' | 'zoom_recordings' | 'teams_recordings';
  readonly pkce: boolean;
  authorizeUrl(input: MeetingPlatformAuthorizeInput): string;
  // Throws MeetingPlatformError for a platform answer (a code the platform refused is `platform_refused`); never puts a token or the code in the error.
  exchange(input: { code: string; redirectUri: string; codeVerifier: string | null }, signal?: AbortSignal): Promise<MeetingPlatformAccount>;
}

export function hasOAuth(adapter: MeetingPlatformAdapter | undefined): adapter is MeetingPlatformAdapter & MeetingPlatformOAuth {
  return adapter !== undefined && typeof (adapter as Partial<MeetingPlatformOAuth>).authorizeUrl === 'function' && typeof (adapter as Partial<MeetingPlatformOAuth>).exchange === 'function';
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

/**
 * A tenant whose administrator has not allowed the app (Microsoft: AADSTS65001, AADSTS90094, AADSTS90095), seen when the connect step exchanges the code. A refusal like any other
 * (`platform_refused`), but one the member can do nothing about, so the screen says so in plain words and nothing is retried. Never carries Microsoft's words.
 */
export class MeetingPlatformConsentError extends MeetingPlatformError {
  constructor() {
    super('platform_refused', 'the tenant administrator has not allowed the app');
    this.name = 'MeetingPlatformConsentError';
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
  // The platform's own transcript of the call (C2, #3174), for a recording that has one; the offline sandbox labels it like Google Meet's.
  transcript?: MeetingPlatformTranscriptEntry[] | undefined;
  call?: MeetingPlatformCall | undefined;
  joinUrl?: string | undefined;
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
      .map((r) => {
        const call = r.call ? normalizeMeetingPlatformCall(r.call) : r.joinUrl ? meetingPlatformCallOf(r.joinUrl) : null;
        return {
          id: r.id,
          title: r.title.slice(0, 200),
          startedAt: r.startedAt.toISOString(),
          lengthSeconds: r.lengthSeconds,
          sizeBytes: (r.audio?.byteLength ?? 0) + (r.video?.byteLength ?? 0) || null,
          hasAudio: r.hasAudio,
          hasVideo: r.hasVideo,
          hasTranscript: r.hasTranscript,
          ...(call ? { call } : {}),
        };
      });
  }

  async transcript(_credential: MeetingPlatformCredential, recordingId: string, _signal?: AbortSignal): Promise<MeetingPlatformTranscript> {
    const recording = this.recordings.get(recordingId);
    if (!recording) throw new MeetingPlatformError('recording_gone');
    if (!recording.hasTranscript || !recording.transcript) throw new MeetingPlatformError('no_transcript');
    return { source: 'google_meet', language: null, truncated: false, entries: recording.transcript.map((entry) => ({ ...entry })) };
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
  // The Zoom adapter (C3, #3175) is there only when the deployment has a Zoom OAuth app (ZOOM_OAUTH_CLIENT_ID and ZOOM_OAUTH_CLIENT_SECRET); without one the provider has no adapter at all.
  zoom?: ZoomAppConfig | undefined;
  // The Teams adapter (C4, #3176) is there only when the deployment has a Microsoft Entra app for it (TEAMS_OAUTH_CLIENT_ID and TEAMS_OAUTH_CLIENT_SECRET); without one the provider has no adapter at all.
  teams?: TeamsAppConfig | undefined;
  // The Google Meet adapter (C2, #3174) is there only when the deployment has a Google OAuth client for it (MEETINGS_GOOGLE_CLIENT_ID and MEETINGS_GOOGLE_CLIENT_SECRET, a client of its own beside the calendar's);
  // without one the provider has no adapter at all. Token renewal goes through the calendar adapter's refresh, made with this client.
  google?: GoogleMeetAppConfig | undefined;
  // The Picker route for the audio of a Meet recording (#3174, ADR-0025 amendment): with it, the Google adapter also offers and reads a recording of a conference that has no transcript. Off unless set; nothing sets it yet, and it must not be set before the pick command gates the start of an import for such a row (the job would otherwise read a Drive file the member never picked, and Drive would answer 404).
  googleRecordings?: boolean | undefined;
  // The offline sandbox is on unless this is `false`.
  sandbox?: boolean | undefined;
  // A shared sandbox store (tests and the dev stack add fixtures to it); a fresh seeded one when omitted.
  sandboxPlatform?: SandboxMeetingPlatform | undefined;
}

// The adapters a deployment has, by provider; a provider without one has no key: Zoom (C3), Teams (C4) and Google Meet (C2) are there when their app is configured.
export function meetingPlatformAdapters(config: MeetingPlatformAdaptersConfig = {}): Partial<Record<MeetingPlatformProvider, MeetingPlatformAdapter>> {
  const adapters: Partial<Record<MeetingPlatformProvider, MeetingPlatformAdapter>> = {};
  if (config.sandbox !== false) adapters.sandbox = config.sandboxPlatform ?? new SandboxMeetingPlatform();
  if (config.zoom) adapters.zoom = new ZoomMeetingPlatform(config.zoom);
  if (config.teams) adapters.microsoft_teams = new TeamsMeetingPlatform(config.teams);
  if (config.google) adapters.google_meet = new GoogleMeetAdapter({ app: config.google, refresher: new GoogleCalendarAdapter(config.google), recordings: config.googleRecordings === true });
  return adapters;
}
