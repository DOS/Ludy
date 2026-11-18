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
import { MeetingPlatformError, MEETING_PLATFORM_LIST_MAX } from './meeting-platform.ts';
import type {
  MeetingPlatformAdapter,
  MeetingPlatformCredential,
  MeetingPlatformDownload,
  MeetingPlatformFormat,
  MeetingPlatformListed,
} from './meeting-platform.ts';
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
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const filesOf = (meeting: Record<string, unknown>): ZoomFile[] => (Array.isArray(meeting.recording_files) ? meeting.recording_files.filter(isRecord) : []);
const ymd = (date: Date) => date.toISOString().slice(0, 10);

// The files that are finished (Zoom lists a file it is still processing with another status).
const completed = (files: ZoomFile[]) => files.filter((f) => text(f.status).toLowerCase() === 'completed');
// The one file of a kind, or undefined. A host who stops and starts recording gets one file PER SEGMENT of the same kind, and importing one of them would hand over a partial recording with no sign of it, so
// a kind with more than one file counts as not importable here (joining the segments needs the audio extraction of crove-media, a later step).
const only = (files: ZoomFile[]): ZoomFile | undefined => (files.length === 1 ? files[0] : undefined);
// The audio-only file: the shared M4A Zoom makes when the host records audio-only files.
const audioOf = (files: ZoomFile[]) => only(completed(files).filter((f) => text(f.recording_type) === 'audio_only' && (text(f.file_type).toUpperCase() === 'M4A' || text(f.file_extension).toUpperCase() === 'M4A')));
// The video kinds, best first: the speaker view with the shared screen is the one a minutes taker wants; the first kind present is the one used, and it must be a single file.
const VIDEO_KINDS = ['shared_screen_with_speaker_view', 'shared_screen_with_gallery_view', 'active_speaker', 'gallery_view', 'shared_screen'] as const;
const videoOf = (files: ZoomFile[]) => {
  const mp4s = completed(files).filter((f) => text(f.recording_type) !== 'audio_only' && (text(f.file_type).toUpperCase() === 'MP4' || text(f.file_extension).toUpperCase() === 'MP4'));
  const kind = VIDEO_KINDS.find((k) => mp4s.some((f) => text(f.recording_type) === k));
  return kind ? only(mp4s.filter((f) => text(f.recording_type) === kind)) : only(mp4s);
};
const transcriptOf = (files: ZoomFile[]) => completed(files).find((f) => text(f.recording_type) === 'audio_transcript' || text(f.file_type).toUpperCase() === 'TRANSCRIPT');
const sizeOf = (file: ZoomFile | undefined): number => (file && typeof file.file_size === 'number' && Number.isFinite(file.file_size) && file.file_size > 0 ? Math.floor(file.file_size) : 0);

// A title the database can hold: no NUL, cut at TITLE_MAX UTF-16 units.
const titleOf = (topic: unknown): string => text(topic).replaceAll('\u0000', '').slice(0, TITLE_MAX);

// What the list shows of one meeting instance, or null when there is nothing a person could import (nothing finished, or only files of no use such as chat and timeline).
function listedOf(meeting: Record<string, unknown>): MeetingPlatformListed | null {
  const uuid = text(meeting.uuid);
  if (uuid === '' || uuid.length > 200) return null;
  const started = new Date(text(meeting.start_time));
  if (Number.isNaN(started.getTime())) return null;
  const files = filesOf(meeting);
  const audio = audioOf(files);
  const video = videoOf(files);
  const transcript = transcriptOf(files);
  if (!audio && !video && !transcript) return null;
  const minutes = Number(meeting.duration);
  // The size of the file the job will fetch (audio when there is one, else the video), not of every file: the job refuses a declared size over its cap before any call.
  const size = audio ? sizeOf(audio) : sizeOf(video);
  return {
    id: uuid,
    title: titleOf(meeting.topic),
    startedAt: started.toISOString(),
    lengthSeconds: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null,
    sizeBytes: size > 0 ? size : null,
    hasAudio: audio !== undefined,
    hasVideo: video !== undefined,
    hasTranscript: transcript !== undefined,
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

export class ZoomMeetingPlatform implements MeetingPlatformAdapter {
  readonly provider = 'zoom' as const;
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
    const file = format === 'audio' ? audioOf(files) : videoOf(files);
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
