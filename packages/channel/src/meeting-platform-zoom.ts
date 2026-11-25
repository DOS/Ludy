// SPDX-License-Identifier: AGPL-3.0-only
// The Zoom adapter of the recording import (meetings integrations C3, issue #3175, plan docs/plan/meetings-integrations.md section 6.3), written from Zoom's own API documentation (Cloud Recording
// endpoints, the OAuth refresh grant) and tested only against recorded fixtures and a mocked fetch: nothing here has ever called a real Zoom host. It plugs into the C1 core (`meeting-platform.ts`):
// the member's connection lists the recordings Zoom finished, and the worker job downloads one only after the member's click.
//
// - The app is a USER-MANAGED OAuth app (authorization code with PKCE), so a connection reads only the recordings of the Zoom user who connected it. A Server-to-Server app is account-level and
//   could read every user's recordings, which would break "a recording belongs to the member who imported it".
// - List: GET /v2/users/me/recordings for the last 14 days (Zoom allows one month at most), paged by next_page_token, at most 100 recordings, newest first. A recording is the meeting INSTANCE (its uuid).
//   The audio-only M4A file is preferred; an MP4 is the fallback; a transcript (VTT) is only noted.
// - Download: the adapter only DESCRIBES the request (the worker job performs it through the egress guard). At click time it asks GET /v2/meetings/{uuid}/recordings for a fresh `download_url` (Zoom
//   makes it per request) and returns it with the member's access token as the bearer. The address must be https on zoom.us or one of its subdomains, and the guard's first host is that exact host:
//   the token cannot go to another host on the first request, and the job's per-hop allowlist (zoom.us and its subdomains) refuses a redirect anywhere else. A webhook's own `download_url` and
//   `download_token` are never used (the webhook is only a doorbell, see the plan).
// - Tokens live only in the credential the job opens (ADR-0025); an error carries a short code, never a token, the platform's response body or its words.
import { MeetingPlatformError, MEETING_PLATFORM_LIST_MAX, normalizeMeetingPlatformCall } from './meeting-platform.ts';
import type {
  MeetingPlatformAccount,
  MeetingPlatformAdapter,
  MeetingPlatformAuthorizeInput,
  MeetingPlatformCall,
  MeetingPlatformCredential,
  MeetingPlatformDownload,
  MeetingPlatformFormat,
  MeetingPlatformListed,
  MeetingPlatformOAuth,
  MeetingPlatformTranscript,
  MeetingPlatformTranscriptEntry,
} from './meeting-platform.ts';
import { zoomAccountKey } from './meeting-platform-zoom-webhook.ts';
import { parseTeamsVtt } from './meeting-platform-teams.ts';
import { allowlistedFetch, type Fetch } from './oauth.ts';

export const ZOOM_API_HOST = 'api.zoom.us';
export const ZOOM_OAUTH_HOST = 'zoom.us';
// The hosts the adapter's own calls may reach: the REST API and the token endpoint.
export const ZOOM_HOSTS = [ZOOM_API_HOST, ZOOM_OAUTH_HOST] as const;
// The recording files are served from zoom.us and its subdomains (`us02web.zoom.us`, ...). Zoom publishes no fixed list, so this is the one rule: the host or a subdomain of it.
export const ZOOM_DOWNLOAD_SUFFIX = 'zoom.us';

// How far back a list may reach. The sweep asks for 14 days; Zoom refuses a range over one month.
const MAX_RANGE_DAYS = 30;
const PAGE_SIZE = 100;
// A list never reads more than this many pages, whatever Zoom says. Zoom documents no order for the pages, so with more than 500 meetings in the window some could be left out; the answer is sorted and cut afterwards.
const MAX_PAGES = 5;
const TITLE_MAX = 200;
// A transcript file larger than this is refused before it is read (a real one is a few hundred KB; the Teams adapter's cap is the same).
export const ZOOM_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
// The speaker a Zoom transcript line names is the text before the first colon, if it is short; a longer prefix is part of what was said.
const SPEAKER_PREFIX_MAX = 80;

export interface ZoomAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface ZoomMeetingPlatformOptions {
  // Tests: the transport. Every call goes through the host allowlist whatever this is.
  fetch?: Fetch | undefined;
  now?: (() => Date) | undefined;
  timeoutMs?: number | undefined;
}

interface ZoomFile {
  id?: unknown;
  file_type?: unknown;
  file_extension?: unknown;
  file_size?: unknown;
  download_url?: unknown;
  status?: unknown;
  recording_type?: unknown;
  recording_start?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const filesOf = (meeting: Record<string, unknown>): ZoomFile[] => (Array.isArray(meeting.recording_files) ? meeting.recording_files.filter(isRecord) : []);
const ymd = (date: Date) => date.toISOString().slice(0, 10);

// The files that are finished (Zoom lists a file it is still processing with another status).
const completed = (files: ZoomFile[]) => files.filter((f) => text(f.status).toLowerCase() === 'completed');
// The one file of a kind, or undefined: more than one file of a kind is a recording made in segments, which `partsOf` orders and the job joins (#3175).
const only = (files: ZoomFile[]): ZoomFile | undefined => (files.length === 1 ? files[0] : undefined);
// The most parts one recording is joined from (the sandbox's own limit, packages/media-contract MEDIA_LIMITS.maxJoinParts): a call in more segments than this is not offered.
export const ZOOM_PARTS_MAX = 16;
const startOf = (file: ZoomFile): number => (typeof file.recording_start === 'string' ? Date.parse(file.recording_start) : Number.NaN);
// The files of one kind in the order they were recorded. One file is its own list. Several files (the host stopped and started the recording, one file per segment) are a list only when every one says when it
// started (Zoom's `recording_start`), no two are the same file, and there are at most ZOOM_PARTS_MAX of them: otherwise the order of the call is not known, joining them could scramble it, and the recording is not
// offered by that kind at all (an empty list).
const partsOf = (files: ZoomFile[]): ZoomFile[] => {
  if (files.length <= 1) return files;
  if (files.length > ZOOM_PARTS_MAX || files.some((f) => Number.isNaN(startOf(f)))) return [];
  const ids = files.map((f) => text(f.id));
  if (ids.some((id) => id === '') || new Set(ids).size !== ids.length) return [];
  // Two files that began at the same moment are two views of one stretch of the call, not consecutive segments: joining them would say it twice.
  if (new Set(files.map(startOf)).size !== files.length) return [];
  return [...files].sort((a, b) => startOf(a) - startOf(b) || text(a.id).localeCompare(text(b.id)));
};
// A kind with a file Zoom is still processing is not offered yet: the finished ones alone would be a call with a segment missing, joined without a sign of the gap.
const settled = (files: ZoomFile[]): ZoomFile[] => (completed(files).length === files.length ? files : []);
// The audio-only files: the shared M4A Zoom makes when the host records audio-only files, in recording order.
const audioParts = (files: ZoomFile[]) => partsOf(settled(files.filter((f) => text(f.recording_type) === 'audio_only' && (text(f.file_type).toUpperCase() === 'M4A' || text(f.file_extension).toUpperCase() === 'M4A'))));
// The video kinds, best first: the speaker view with the shared screen is the one a minutes taker wants; the first kind present is the one used, in recording order.
const VIDEO_KINDS = ['shared_screen_with_speaker_view', 'shared_screen_with_gallery_view', 'active_speaker', 'gallery_view', 'shared_screen'] as const;
const videoParts = (files: ZoomFile[]) => {
  const mp4s = files.filter((f) => text(f.recording_type) !== 'audio_only' && (text(f.file_type).toUpperCase() === 'MP4' || text(f.file_extension).toUpperCase() === 'MP4'));
  const kind = VIDEO_KINDS.find((k) => mp4s.some((f) => text(f.recording_type) === k));
  if (kind) return partsOf(settled(mp4s.filter((f) => text(f.recording_type) === kind)));
  // No known kind: one file is the recording; several files of a kind we do not know are as likely views of one stretch as segments, so they are not joined, and files of different kinds never are.
  return mp4s.length === 1 ? partsOf(settled(mp4s)) : [];
};
const isTranscript = (f: ZoomFile) => text(f.recording_type) === 'audio_transcript' || text(f.file_type).toUpperCase() === 'TRANSCRIPT';
// The one finished transcript file, or undefined: two of them are two parts of one call, and half a transcript is not offered as a whole.
const transcriptOf = (files: ZoomFile[]) => only(completed(files).filter(isTranscript));
// A kind of audio or video file that Zoom made in several segments (the host stopped and started the recording). Such a recording has more of the call than any one file, so it is never offered by its transcript alone.
const segmented = (files: ZoomFile[]) => {
  const counts = new Map<string, number>();
  for (const f of completed(files)) {
    if (isTranscript(f) || !['MP4', 'M4A'].includes(text(f.file_type).toUpperCase())) continue;
    counts.set(text(f.recording_type), (counts.get(text(f.recording_type)) ?? 0) + 1);
  }
  return [...counts.values()].some((n) => n > 1);
};
const sizeOf = (file: ZoomFile | undefined): number => (file && typeof file.file_size === 'number' && Number.isFinite(file.file_size) && file.file_size > 0 ? Math.floor(file.file_size) : 0);

/**
 * The lines of Zoom's transcript file (WebVTT, `audio_transcript`): each cue reads `Speaker Name: what was said`. Zoom's own transcription, never Ludy's. The cue and time reading is the Teams reader's
 * (linear scans, tags dropped, entities decoded, bounded); what is Zoom's here is the speaker, taken from the text before the first colon when that is short and has no digit-only or sentence shape. A cue with no such
 * prefix has no speaker. [Unverified until the first live run (#3178): that a Zoom VTT names its speakers this way.]
 */
export function parseZoomVtt(vtt: string): { entries: MeetingPlatformTranscriptEntry[]; truncated: boolean } {
  const { entries, truncated } = parseTeamsVtt(vtt);
  return {
    truncated,
    entries: entries.map((entry) => {
      if (entry.speaker !== null) return entry;
      const colon = entry.text.indexOf(': ');
      if (colon < 1 || colon > SPEAKER_PREFIX_MAX) return entry;
      const name = entry.text.slice(0, colon).trim();
      const said = entry.text.slice(colon + 2).trim();
      // A prefix that is a figure ("10:30", "3: ...") or ends a sentence is not a name.
      if (name === '' || said === '' || /^[\d\s.,]+$/u.test(name) || /[.!?]$/u.test(name)) return entry;
      return { ...entry, speaker: name, text: said };
    }),
  };
}

// A title the database can hold: no NUL, cut at TITLE_MAX UTF-16 units.
const titleOf = (topic: unknown): string => text(topic).replaceAll('\u0000', '').slice(0, TITLE_MAX);

const zoomCallOf = (value: unknown): MeetingPlatformCall | null => {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  return raw === '' ? null : normalizeMeetingPlatformCall({ platform: 'zoom', id: raw });
};

// What the list shows of one meeting instance, or null when there is nothing a person could import (nothing finished, or only files of no use such as chat and timeline).
function listedOf(meeting: Record<string, unknown>): MeetingPlatformListed | null {
  const uuid = text(meeting.uuid);
  if (uuid === '' || uuid.length > 200) return null;
  const started = new Date(text(meeting.start_time));
  if (Number.isNaN(started.getTime())) return null;
  const files = filesOf(meeting);
  const audio = audioParts(files);
  const video = videoParts(files);
  const transcript = transcriptOf(files);
  if (audio.length === 0 && video.length === 0 && !transcript) return null;
  // Segments that cannot be joined (their order is unknown, or there are too many) are not made up for by a transcript of one part of the call, or of the whole: the recording is not offered.
  if (audio.length === 0 && video.length === 0 && segmented(files)) return null;
  const minutes = Number(meeting.duration);
  // The size of the files the job will fetch (the audio parts when there are any, else the video parts), not of every file: the job refuses a declared size over its cap before any call. One part with no size makes the total unknown.
  const chosen = audio.length > 0 ? audio : video;
  const sizes = chosen.map(sizeOf);
  const size = sizes.every((n) => n > 0) ? sizes.reduce((sum, n) => sum + n, 0) : 0;
  const call = zoomCallOf(meeting.id);
  return {
    id: uuid,
    title: titleOf(meeting.topic),
    startedAt: started.toISOString(),
    lengthSeconds: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null,
    sizeBytes: size > 0 ? size : null,
    hasAudio: audio.length > 0,
    hasVideo: video.length > 0,
    hasTranscript: transcript !== undefined,
    ...(call ? { call } : {}),
  };
}

// A meeting uuid in a path: Zoom wants it double-encoded when it begins with "/" or contains "//".
const meetingPathId = (uuid: string) => (uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(encodeURIComponent(uuid)) : encodeURIComponent(uuid));

// The short code for a Zoom status. 401 is the token (the job expires the connection), 404 a recording that is gone, 429 and 5xx a platform that is busy or down, any other 4xx a refusal.
function statusError(status: number): MeetingPlatformError {
  if (status === 401) return new MeetingPlatformError('connection_expired');
  if (status === 404) return new MeetingPlatformError('recording_gone');
  if (status === 429 || status >= 500) return new MeetingPlatformError('platform_unavailable');
  return new MeetingPlatformError('platform_refused');
}

// The download address of a file, or null when it is not one the importer may use: https, no credentials in it, on zoom.us or a subdomain.
export function zoomDownloadUrl(candidate: unknown): { url: string; host: string } | null {
  if (typeof candidate !== 'string' || candidate.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname.toLowerCase();
  if (host !== ZOOM_DOWNLOAD_SUFFIX && !host.endsWith(`.${ZOOM_DOWNLOAD_SUFFIX}`)) return null;
  return { url: url.toString(), host };
}

export class ZoomMeetingPlatform implements MeetingPlatformAdapter, MeetingPlatformOAuth {
  readonly provider = 'zoom' as const;
  readonly oauthProvider = 'zoom_recordings' as const;
  // Zoom's user-managed OAuth app takes PKCE with the client secret (docs: authorization code flow); the verifier is kept in the attempt like a calendar's.
  readonly pkce = true;
  readonly hosts: readonly string[] = ZOOM_HOSTS;
  private readonly config: ZoomAppConfig;
  private readonly http: Fetch;
  private readonly now: () => Date;

  constructor(config: ZoomAppConfig, options: ZoomMeetingPlatformOptions = {}) {
    this.config = config;
    this.http = allowlistedFetch(ZOOM_HOSTS, options.fetch, options.timeoutMs);
    this.now = options.now ?? (() => new Date());
  }

  // One call, as JSON. A network failure or a malformed answer is `platform_unavailable`; a status is mapped by `statusError`.
  private async call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.http(url, init);
    } catch {
      throw new MeetingPlatformError('platform_unavailable');
    }
    if (response.status < 200 || response.status >= 300) throw statusError(response.status);
    try {
      const body: unknown = await response.json();
      if (isRecord(body)) return body;
    } catch {
      // Falls through: not JSON.
    }
    throw new MeetingPlatformError('platform_unavailable');
  }

  private get(url: string, credential: MeetingPlatformCredential, signal?: AbortSignal) {
    return this.call(url, { method: 'GET', headers: { authorization: `Bearer ${credential.accessToken}`, accept: 'application/json' }, ...(signal ? { signal } : {}) });
  }

  async list(credential: MeetingPlatformCredential, since: Date, signal?: AbortSignal): Promise<MeetingPlatformListed[]> {
    const now = this.now();
    const earliest = new Date(now.getTime() - MAX_RANGE_DAYS * 86_400_000);
    const from = since.getTime() < earliest.getTime() ? earliest : since;
    const listed: MeetingPlatformListed[] = [];
    let token = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ from: ymd(from), to: ymd(now), page_size: String(PAGE_SIZE) });
      if (token !== '') query.set('next_page_token', token);
      const body = await this.get(`https://${ZOOM_API_HOST}/v2/users/me/recordings?${query.toString()}`, credential, signal);
      for (const meeting of Array.isArray(body.meetings) ? body.meetings.filter(isRecord) : []) {
        const entry = listedOf(meeting);
        if (entry && new Date(entry.startedAt).getTime() >= since.getTime()) listed.push(entry);
      }
      token = text(body.next_page_token);
      if (token === '') break;
    }
    return listed.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MEETING_PLATFORM_LIST_MAX);
  }

  async prepareDownload(credential: MeetingPlatformCredential, recordingId: string, format: MeetingPlatformFormat, signal?: AbortSignal): Promise<MeetingPlatformDownload> {
    // An id is a meeting uuid from the list; `.` and `..` would climb the path, and are no recording.
    if (recordingId === '' || recordingId === '.' || recordingId === '..') throw new MeetingPlatformError('recording_gone');
    const body = await this.get(`https://${ZOOM_API_HOST}/v2/meetings/${meetingPathId(recordingId)}/recordings`, credential, signal);
    const files = filesOf(body);
    // One file only: a recording in segments is fetched by `prepareParts`.
    const file = only(format === 'audio' ? audioParts(files) : videoParts(files));
    if (!file) throw new MeetingPlatformError(format === 'audio' ? 'no_audio' : 'platform_refused', `the recording has no ${format} file`);
    const target = zoomDownloadUrl(file.download_url);
    if (!target) throw new MeetingPlatformError('platform_refused', 'the recording file is not on a Zoom host');
    const size = sizeOf(file);
    return {
      url: target.url,
      headers: { authorization: `Bearer ${credential.accessToken}` },
      format,
      contentType: format === 'audio' ? 'audio/mp4' : 'video/mp4',
      sizeBytes: size > 0 ? size : null,
      // The guard's first host is exactly this host; a redirect may go to zoom.us or a subdomain and nowhere else.
      hosts: [target.host],
      hostSuffixes: [ZOOM_DOWNLOAD_SUFFIX],
    };
  }

  // The files of a recording made in segments, in the order they were recorded, each described the way a single file is (a fresh address at click time, the member's token as the bearer, the first host exact,
  // redirects only inside zoom.us, its own size). Empty for a recording of one file (`prepareDownload` takes that one); the job joins two or more through crove-media (#3175).
  async prepareParts(credential: MeetingPlatformCredential, recordingId: string, format: MeetingPlatformFormat, signal?: AbortSignal): Promise<MeetingPlatformDownload[]> {
    if (recordingId === '' || recordingId === '.' || recordingId === '..') throw new MeetingPlatformError('recording_gone');
    const body = await this.get(`https://${ZOOM_API_HOST}/v2/meetings/${meetingPathId(recordingId)}/recordings`, credential, signal);
    const files = filesOf(body);
    const parts = format === 'audio' ? audioParts(files) : videoParts(files);
    if (parts.length < 2) return [];
    return parts.map((file) => {
      const target = zoomDownloadUrl(file.download_url);
      if (!target) throw new MeetingPlatformError('platform_refused', 'a recording file is not on a Zoom host');
      const size = sizeOf(file);
      return {
        url: target.url,
        headers: { authorization: `Bearer ${credential.accessToken}` },
        format,
        contentType: format === 'audio' ? 'audio/mp4' : 'video/mp4',
        sizeBytes: size > 0 ? size : null,
        hosts: [target.host],
        hostSuffixes: [ZOOM_DOWNLOAD_SUFFIX],
      };
    });
  }

  // The transcript file of one recording, described the way a recording's file is (a fresh address at click time, the member's token as the bearer, the first host exact, redirects only inside zoom.us). Only a single
  // finished transcript file is taken: two of them are two parts of one call, and reading one would hand over half of it with no sign.
  async transcriptFile(credential: MeetingPlatformCredential, recordingId: string, signal?: AbortSignal): Promise<MeetingPlatformDownload> {
    if (recordingId === '' || recordingId === '.' || recordingId === '..') throw new MeetingPlatformError('recording_gone');
    const body = await this.get(`https://${ZOOM_API_HOST}/v2/meetings/${meetingPathId(recordingId)}/recordings`, credential, signal);
    const transcripts = completed(filesOf(body)).filter(isTranscript);
    const file = only(transcripts);
    if (!file) throw new MeetingPlatformError('no_transcript', transcripts.length > 1 ? 'the recording has several transcript files' : 'the recording has no transcript file');
    if (sizeOf(file) > ZOOM_TRANSCRIPT_MAX_BYTES) throw new MeetingPlatformError('too_large');
    const target = zoomDownloadUrl(file.download_url);
    if (!target) throw new MeetingPlatformError('platform_refused', 'the transcript file is not on a Zoom host');
    return {
      url: target.url,
      headers: { authorization: `Bearer ${credential.accessToken}` },
      format: 'transcript',
      contentType: 'text/vtt',
      sizeBytes: sizeOf(file) > 0 ? sizeOf(file) : null,
      hosts: [target.host],
      hostSuffixes: [ZOOM_DOWNLOAD_SUFFIX],
    };
  }

  // Zoom's transcript from the file's bytes. No line at all is `no_transcript`.
  parseTranscript(bytes: Uint8Array): MeetingPlatformTranscript {
    if (bytes.byteLength > ZOOM_TRANSCRIPT_MAX_BYTES) throw new MeetingPlatformError('too_large');
    const { entries, truncated } = parseZoomVtt(new TextDecoder('utf-8').decode(bytes));
    if (entries.length === 0) throw new MeetingPlatformError('no_transcript');
    return { source: 'zoom', language: null, truncated, entries };
  }

  // The Zoom authorize address. The permissions are the ones the Marketplace app declares, not a parameter of the request, so there is no `scope` here (docs/runbooks/meetings-zoom.md lists them).
  authorizeUrl(input: MeetingPlatformAuthorizeInput): string {
    const query = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: input.redirectUri, state: input.state });
    if (input.codeChallenge) {
      query.set('code_challenge', input.codeChallenge);
      query.set('code_challenge_method', 'S256');
    }
    return `https://${ZOOM_OAUTH_HOST}/oauth/authorize?${query.toString()}`;
  }

  // The code grant, then the one read of who the grant belongs to. A code Zoom refuses (used, expired, a redirect address that is not the app's) or a client it does not know is `platform_refused`; a platform
  // that did not answer is `platform_unavailable`. The account is keyed by the Zoom user's id (stable when the email changes), lowercased because the connection's key is stored lowercased and the tokens are sealed for that exact key; the email is the display name.
  async exchange(input: { code: string; redirectUri: string; codeVerifier: string | null }, signal?: AbortSignal): Promise<MeetingPlatformAccount> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri });
    if (input.codeVerifier) form.set('code_verifier', input.codeVerifier);
    let grant: Record<string, unknown>;
    try {
      grant = await this.call(`https://${ZOOM_OAUTH_HOST}/oauth/token`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // Here a 401 is the app's own credentials, not a member's token that expired.
      if (error instanceof MeetingPlatformError && error.code === 'connection_expired') throw new MeetingPlatformError('platform_refused');
      throw error;
    }
    const accessToken = text(grant.access_token);
    const refreshToken = text(grant.refresh_token);
    // Zoom always sends a refresh token; without one the connection would die an hour later, so the member is told now.
    if (accessToken === '' || refreshToken === '') throw new MeetingPlatformError('platform_unavailable');
    const seconds = Number(grant.expires_in);
    const expiresAt = new Date(this.now().getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000);
    let me: Record<string, unknown>;
    try {
      me = await this.get(`https://${ZOOM_API_HOST}/v2/users/me`, { accessToken }, signal);
    } catch (error) {
      if (error instanceof MeetingPlatformError && error.code === 'connection_expired') throw new MeetingPlatformError('platform_refused');
      throw error;
    }
    const email = text(me.email).trim().toLowerCase();
    // No address or id means the app lacks the permission to read the profile: nothing identifies the account, so nothing is stored.
    const id = zoomAccountKey(text(me.id));
    if (email === '' || email.length > 200 || id === '' || id.length > 200) throw new MeetingPlatformError('platform_refused', 'Zoom did not return the account address or id');
    const name = [text(me.display_name), `${text(me.first_name)} ${text(me.last_name)}`.trim(), email].find((n) => n.trim() !== '') ?? email;
    const scopes = text(grant.scope)
      .split(/\s+/)
      .filter((s) => s !== '' && s.length <= 200)
      .slice(0, 20);
    return {
      externalAccount: id,
      displayName: name.trim().slice(0, 200),
      scopes,
      expiresAt,
      secret: JSON.stringify({ accessToken, refreshToken, expiresAt: expiresAt.toISOString() }),
    };
  }

  // Zoom rotates the refresh token on every refresh, so the new one is returned and replaces the old. A grant Zoom no longer honours (revoked, expired, the app removed) is `refused`: the job expires the connection.
  async refresh(credential: MeetingPlatformCredential, signal?: AbortSignal): Promise<MeetingPlatformCredential | { refused: true }> {
    if (!credential.refreshToken) return { refused: true };
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    let body: Record<string, unknown>;
    try {
      body = await this.call(`https://${ZOOM_OAUTH_HOST}/oauth/token`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refreshToken }).toString(),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // The token endpoint answers 400 for a grant it will not renew and 401 for a client it does not know: either way the member must connect again.
      if (error instanceof MeetingPlatformError && (error.code === 'connection_expired' || error.code === 'platform_refused')) return { refused: true };
      throw error;
    }
    const accessToken = text(body.access_token);
    if (accessToken === '') throw new MeetingPlatformError('platform_unavailable');
    const seconds = Number(body.expires_in);
    return {
      accessToken,
      refreshToken: text(body.refresh_token) || credential.refreshToken,
      expiresAt: new Date(this.now().getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000),
    };
  }
}
