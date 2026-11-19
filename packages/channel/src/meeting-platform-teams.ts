// SPDX-License-Identifier: AGPL-3.0-only
// The Microsoft Teams adapter of the recording import (meetings integrations C4, issue #3176, plan docs/plan/meetings-integrations.md section 6.4), written from Microsoft's own Graph and Entra documentation
// (read 2026-11-18, quoted on the issue) and tested only against recorded fixtures and a mocked fetch: nothing here has ever called a real Microsoft host. It plugs into the C1 core (`meeting-platform.ts`):
// the member's connection lists the Teams meetings of the last days that have a recording or a transcript, and the worker job downloads a recording only after the member's click.
//
// - A DELEGATED work or school account (authorization code with PKCE, the multi-tenant `organizations` endpoint). Graph's bulk lists (`getAllRecordings`, `getAllTranscripts`) take application permissions
//   only, so the list goes the supported delegated way: the member's calendar (`/me/calendarView`), each online meeting by its join address (`/me/onlineMeetings?$filter=JoinWebUrl eq ...`), then that
//   meeting's `recordings` and `transcripts`. Only SCHEDULED meetings (an event on the calendar) can be reached this way; a "Meet now" call never appears.
// - Scopes, the narrowest the calls above need: `Calendars.ReadBasic`, `OnlineMeetings.Read` (a member may consent to both), `OnlineMeetingRecording.Read.All` and `OnlineMeetingTranscript.Read.All` (these
//   two need a tenant ADMIN's consent), `offline_access` for the refresh token, `openid profile` for the id_token that names the account (so no `User.Read` and no Graph call to find out who connected).
// - A recording downloads only for its ORGANIZER ("Meeting participants don't have permission to download meeting recordings"), so a recording is offered only for a meeting the member organized. A
//   meeting with more than one recording (the host stopped and started) is not offered: importing one segment would hand over a partial recording with no sign of it (the same rule as Zoom's).
// - The adapter only DESCRIBES a download (the worker job performs it through the egress guard, so an address that is not Graph's is refused): the first host is exactly `graph.microsoft.com`, the bearer
//   goes only there, and a redirect may go to `sharepoint.com` or its subdomains and nowhere else. Microsoft does not document a redirect for this call; the allowance is the documented OneDrive pattern.
// - The transcript is read by the adapter itself (`text/vtt` with `<v Speaker>` voice tags): it is MICROSOFT's transcription, never Ludy's, and the result says so.
// - Tokens live only in the credential the job opens (ADR-0025); an error carries a short code, never a token, Microsoft's response body or its words.
import { MEETING_PLATFORM_LIST_MAX, MeetingPlatformConsentError, MeetingPlatformError } from './meeting-platform.ts';
import type {
  MeetingPlatformAccount,
  MeetingPlatformAdapter,
  MeetingPlatformAuthorizeInput,
  MeetingPlatformCredential,
  MeetingPlatformDownload,
  MeetingPlatformFormat,
  MeetingPlatformListed,
  MeetingPlatformOAuth,
  MeetingPlatformTranscript,
  MeetingPlatformTranscriptEntry,
} from './meeting-platform.ts';
import { allowlistedFetch, type Fetch } from './oauth.ts';

export const TEAMS_GRAPH_HOST = 'graph.microsoft.com';
export const TEAMS_LOGIN_HOST = 'login.microsoftonline.com';
// The hosts the adapter's own calls may reach: Graph and the Entra token endpoint.
export const TEAMS_HOSTS = [TEAMS_GRAPH_HOST, TEAMS_LOGIN_HOST] as const;
// A recording's bytes may be handed over by a redirect to the organizer's OneDrive or the channel's SharePoint; nothing else is allowed.
export const TEAMS_DOWNLOAD_SUFFIX = 'sharepoint.com';
// The delegated permissions of the app, in the order the consent dialog shows them. Two of them need a tenant administrator (docs/runbooks/meetings-teams.md).
export const TEAMS_SCOPES = ['openid', 'profile', 'offline_access', 'Calendars.ReadBasic', 'OnlineMeetings.Read', 'OnlineMeetingRecording.Read.All', 'OnlineMeetingTranscript.Read.All'] as const;

const GRAPH = `https://${TEAMS_GRAPH_HOST}/v1.0`;
const AUTHORITY = `https://${TEAMS_LOGIN_HOST}/organizations/oauth2/v2.0`;
// How far back a list may reach: a meeting is reachable until 60 days after its scheduled time.
const MAX_RANGE_DAYS = 60;
const EVENT_PAGES = 4;
const EVENT_PAGE_SIZE = 50;
// The meetings looked up one by one (three calls each); the newest ones first.
const LOOKUP_MAX = 60;
const LOOKUP_PARALLEL = 4;
const TITLE_MAX = 200;
export const TEAMS_TRANSCRIPT_MAX_ENTRIES = 5000;
// A transcript file larger than this is refused unread (5000 lines of 4000 characters would be about 20 MB; a real one is far smaller).
export const TEAMS_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
const ENTRY_TEXT_MAX = 4000;
const NAME_MAX = 100;
const SECONDS_MAX = 24 * 3600;
// A Graph id in a path: letters, digits, `_`, `-` and `=` (base64url), never a separator.
const GRAPH_ID = /^[A-Za-z0-9_=-]{1,1024}$/;

export interface TeamsAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface TeamsMeetingPlatformOptions {
  // Tests: the transport. Every call goes through the host allowlist whatever this is.
  fetch?: Fetch | undefined;
  now?: (() => Date) | undefined;
  timeoutMs?: number | undefined;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const cleaned = (value: string, max: number): string => value.replace(CONTROL, '').replace(LONE_SURROGATE, '\uFFFD').trim().slice(0, max);

// What the member sees as the title: no control character, cut at TITLE_MAX UTF-16 units.
const titleOf = (subject: unknown): string => cleaned(text(subject), TITLE_MAX);

// The short code for a Graph answer. 401 is the token (the job expires the connection), 404 a meeting or file that is gone, 429 and 5xx a service that is busy or down. A 403 names its reason when Microsoft
// does: the tenant switch for transcripts (`GraphAccessToTranscriptsDisabled`) and the speaker names switch (`SpeakerAttributionNotAllowed`) are the two a person can fix, by asking their administrator;
// any other 403 (a consent that is missing, a recording of a meeting someone else organized) is a refusal and does NOT expire the connection.
function statusError(status: number, inner: string): MeetingPlatformError {
  if (status === 401) return new MeetingPlatformError('connection_expired');
  if (status === 403 && inner === 'GraphAccessToTranscriptsDisabled') return new MeetingPlatformError('transcripts_disabled');
  if (status === 403 && inner === 'SpeakerAttributionNotAllowed') return new MeetingPlatformError('speakers_disabled');
  if (status === 404) return new MeetingPlatformError('recording_gone');
  if (status === 429 || status >= 500) return new MeetingPlatformError('platform_unavailable');
  return new MeetingPlatformError('platform_refused');
}

// The inner error code of a Graph error body (`error.innerError.code`), or '' when there is none.
function innerCodeOf(body: unknown): string {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const inner = error !== null && isRecord(error.innerError) ? error.innerError : null;
  return inner !== null ? text(inner.code).slice(0, 100) : '';
}

// ---- The transcript in WebVTT, read by linear scans (no backtracking pattern runs on text Microsoft sent) ----
function seconds(stamp: string): number | null {
  const parts = stamp.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) return null;
    total = total * 60 + n;
  }
  return total;
}
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&lrm;': '', '&rlm;': '' };
// Voice tags (`<v Name>`) are read first; every other tag is dropped, then the entities Teams writes are decoded (the five of WebVTT, the apostrophe, no-break space and the two direction marks).
function cueBody(lines: string[]): { speaker: string | null; said: string } {
  let speaker: string | null = null;
  let out = '';
  for (const line of lines) {
    let rest = line;
    let plain = '';
    while (rest.length > 0) {
      const open = rest.indexOf('<');
      if (open < 0) {
        plain += rest;
        break;
      }
      plain += rest.slice(0, open);
      const close = rest.indexOf('>', open);
      if (close < 0) {
        plain += rest.slice(open);
        break;
      }
      const tag = rest.slice(open + 1, close);
      if (speaker === null && (tag.startsWith('v ') || tag.startsWith('v\t'))) speaker = cleaned(tag.slice(2).replace(/&[a-z#0-9]+;/g, (e) => ENTITIES[e] ?? e), NAME_MAX) || null;
      rest = rest.slice(close + 1);
    }
    out += `${out === '' ? '' : ' '}${plain}`;
  }
  return { speaker, said: cleaned(out.replace(/&[a-z#0-9]+;/g, (e) => ENTITIES[e] ?? e).replace(/\s+/g, ' '), ENTRY_TEXT_MAX) };
}

/** The lines of a WebVTT transcript: seconds from its start, the speaker where a voice tag names one, and the text. A cue with no text or no readable time is skipped; more than `max` lines are cut and `truncated` says so. */
export function parseTeamsVtt(vtt: string, max: number = TEAMS_TRANSCRIPT_MAX_ENTRIES): { entries: MeetingPlatformTranscriptEntry[]; truncated: boolean } {
  const entries: MeetingPlatformTranscriptEntry[] = [];
  const lines = vtt.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  let truncated = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const arrow = line.indexOf('-->');
    if (arrow < 0) {
      i += 1;
      continue;
    }
    const start = seconds(line.slice(0, arrow));
    // The end stamp may be followed by cue settings (`align:start`): only the first word is the time.
    const end = seconds(line.slice(arrow + 3).trim().split(/\s+/)[0] ?? '');
    const body: string[] = [];
    i += 1;
    while (i < lines.length && (lines[i] as string).trim() !== '') {
      body.push(lines[i] as string);
      i += 1;
    }
    if (start === null) continue;
    const { speaker, said } = cueBody(body);
    if (said === '') continue;
    if (entries.length >= max) {
      truncated = true;
      break;
    }
    const startSeconds = Math.min(SECONDS_MAX, Math.max(0, Math.round(start)));
    entries.push({ startSeconds, endSeconds: Math.min(SECONDS_MAX, Math.max(startSeconds, Math.round(end ?? start))), speaker, text: said });
  }
  return { entries, truncated };
}

/** What the redirect back to the app says about a refusal at Microsoft's own consent page: `admin_consent_required` (AADSTS90094, AADSTS90095, AADSTS65001 or `consent_required`), `denied` (the member said no) or `other`. */
export function teamsConnectProblem(error: string | null, description: string | null): 'admin_consent_required' | 'denied' | 'other' {
  const e = (error ?? '').toLowerCase();
  const d = description ?? '';
  if (e === 'consent_required' || /AADSTS(90094|90095|65001)\b/.test(d)) return 'admin_consent_required';
  if (e === 'access_denied') return 'denied';
  return 'other';
}

// The claims of an id_token that the token endpoint just gave over TLS (no signature check is needed for a token received directly from the issuer, OIDC Core 3.1.3.7): the account's ids and names.
function claimsOf(idToken: unknown): Json | null {
  if (typeof idToken !== 'string') return null;
  const part = idToken.split('.')[1];
  if (!part || part.length > 20_000) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Graph's next-page link of the calendar, or a refusal: the bearer goes with it, so it must be Graph's own calendar view over https, with no port and no credentials in the address.
function nextCalendarPage(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new MeetingPlatformError('platform_unavailable');
  }
  if (url.protocol !== 'https:' || url.hostname !== TEAMS_GRAPH_HOST || url.port !== '' || url.username !== '' || url.password !== '' || url.pathname !== '/v1.0/me/calendarView') throw new MeetingPlatformError('platform_unavailable');
  return url.toString();
}

// What identifies one meeting in the list: the online meeting object, and the occurrence (start and end, whole seconds). A recurring series has one join address and one object whose files are those of
// every occurrence, so a file belongs to an occurrence by the time it was made. `~` is outside the characters of a Graph id.
const OCCURRENCE = /^([A-Za-z0-9_=-]{1,900})~(\d{9,11})~(\d{9,11})$/;
const SLACK_MS = 30 * 60_000;
const keyOf = (meeting: string, start: number, end: number): string => `${meeting}~${Math.round(start / 1000)}~${Math.round(end / 1000)}`;
function parseKey(key: string): { meeting: string; start: number; end: number } {
  const m = OCCURRENCE.exec(key);
  const start = Number(m?.[2]) * 1000;
  const end = Number(m?.[3]) * 1000;
  if (!m?.[1] || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 24 * 3_600_000) throw new MeetingPlatformError('recording_gone');
  return { meeting: m[1], start, end };
}
// The files (recordings or transcripts) of an answer that were made during the occurrence, give or take the slack.
function madeDuring(body: Json | null, occurrence: { start: number; end: number }): Json[] {
  return list(body?.value).filter((file) => {
    const made = Date.parse(text(file.createdDateTime));
    return Number.isFinite(made) && made >= occurrence.start - SLACK_MS && made <= occurrence.end + SLACK_MS;
  });
}

export class TeamsMeetingPlatform implements MeetingPlatformAdapter, MeetingPlatformOAuth {
  readonly provider = 'microsoft_teams' as const;
  readonly oauthProvider = 'teams_recordings' as const;
  // A confidential multi-tenant app takes PKCE beside its secret; the verifier is kept in the attempt like Zoom's.
  readonly pkce = true;
  readonly hosts: readonly string[] = TEAMS_HOSTS;
  private readonly config: TeamsAppConfig;
  private readonly http: Fetch;
  private readonly now: () => Date;

  constructor(config: TeamsAppConfig, options: TeamsMeetingPlatformOptions = {}) {
    this.config = config;
    this.http = allowlistedFetch(TEAMS_HOSTS, options.fetch, options.timeoutMs);
    this.now = options.now ?? (() => new Date());
  }

  // One Graph read. `status` and the parsed body come back whatever the status, so the caller decides; a network failure is `platform_unavailable`. The body is read only to find a code, never kept in an error.
  private async read(url: string, credential: MeetingPlatformCredential, signal?: AbortSignal, accept = 'application/json'): Promise<{ status: number; response: Response }> {
    let response: Response;
    try {
      response = await this.http(url, { method: 'GET', headers: { authorization: `Bearer ${credential.accessToken}`, accept, prefer: 'outlook.timezone="UTC"' }, ...(signal ? { signal } : {}) });
    } catch {
      throw new MeetingPlatformError('platform_unavailable');
    }
    return { status: response.status, response };
  }

  private async json(url: string, credential: MeetingPlatformCredential, signal?: AbortSignal): Promise<Json> {
    const { status, response } = await this.read(url, credential, signal);
    if (status < 200 || status >= 300) throw statusError(status, innerCodeOf(await response.json().catch(() => null)));
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body)) throw new MeetingPlatformError('platform_unavailable');
    return body;
  }

  // `null` for a 403 or 404 (and, where asked, a 400) on this one resource (one meeting's files are not the member's, or are gone), so one meeting cannot hide the others; a 401 or a busy service still fails the whole call.
  private async jsonOrNull(url: string, credential: MeetingPlatformCredential, signal?: AbortSignal, alsoSkip400 = false): Promise<Json | null> {
    const { status, response } = await this.read(url, credential, signal);
    if (status === 403 || status === 404 || (alsoSkip400 && status === 400)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (status < 200 || status >= 300) throw statusError(status, innerCodeOf(await response.json().catch(() => null)));
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body)) throw new MeetingPlatformError('platform_unavailable');
    return body;
  }

  // The finished online meetings of the member's calendar in the window, newest first: the calendar event (title, times, whether the member organized it) and the join address.
  private async events(credential: MeetingPlatformCredential, since: Date, signal?: AbortSignal) {
    const now = this.now();
    const earliest = new Date(now.getTime() - MAX_RANGE_DAYS * 86_400_000);
    const from = since.getTime() < earliest.getTime() ? earliest : since;
    const query = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: now.toISOString(),
      $select: 'subject,start,end,isOnlineMeeting,onlineMeetingProvider,isOrganizer,isCancelled,onlineMeeting',
      $orderby: 'start/dateTime desc',
      $top: String(EVENT_PAGE_SIZE),
    });
    let url: string | null = `${GRAPH}/me/calendarView?${query.toString()}`;
    const found: Array<{ title: string; start: number; end: number; organizer: boolean; joinUrl: string }> = [];
    for (let page = 0; page < EVENT_PAGES && url !== null; page += 1) {
      const body = await this.json(url, credential, signal);
      for (const event of list(body.value)) {
        // Only a Teams meeting: another provider's join address (Skype, a webinar service) is not an online meeting Graph can look up.
        if (event.isOnlineMeeting !== true || event.isCancelled === true || event.onlineMeetingProvider !== 'teamsForBusiness') continue;
        const joinUrl = text(isRecord(event.onlineMeeting) ? event.onlineMeeting.joinUrl : '');
        // The start and end are UTC wall times without an offset (the request asks for UTC).
        const start = Date.parse(`${text(isRecord(event.start) ? event.start.dateTime : '').replace(/\.\d+$/, '')}Z`);
        const end = Date.parse(`${text(isRecord(event.end) ? event.end.dateTime : '').replace(/\.\d+$/, '')}Z`);
        if (joinUrl === '' || joinUrl.length > 2000 || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now.getTime()) continue;
        found.push({ title: titleOf(event.subject), start, end, organizer: event.isOrganizer === true, joinUrl });
      }
      const next = text(body['@odata.nextLink']);
      url = next === '' ? null : nextCalendarPage(next);
    }
    return found.sort((a, b) => b.start - a.start).slice(0, LOOKUP_MAX);
  }

  // The online meeting object of a join address, or null.
  private async meetingId(credential: MeetingPlatformCredential, joinUrl: string, signal?: AbortSignal): Promise<string | null> {
    const filter = `JoinWebUrl eq '${joinUrl.replaceAll("'", "''")}'`;
    const body = await this.jsonOrNull(`${GRAPH}/me/onlineMeetings?${new URLSearchParams({ $filter: filter, $select: 'id' }).toString()}`, credential, signal, true);
    const id = text(list(body?.value)[0]?.id);
    return GRAPH_ID.test(id) ? id : null;
  }

  async list(credential: MeetingPlatformCredential, since: Date, signal?: AbortSignal): Promise<MeetingPlatformListed[]> {
    const events = await this.events(credential, since, signal);
    // One failure stops the other lookups: they share an abort that follows the caller's.
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) stop.abort();
    // A series has one join address and one object: its look-ups are made once and shared by its occurrences.
    const meetings = new Map<string, Promise<string | null>>();
    const files = new Map<string, Promise<Json | null>>();
    const once = <T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> => {
      let found = cache.get(key);
      if (found === undefined) {
        found = make();
        cache.set(key, found);
      }
      return found;
    };
    const found: Array<MeetingPlatformListed | null> = Array.from({ length: events.length }, () => null);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const event = events[index];
        if (event === undefined) return;
        const meeting = await once(meetings, event.joinUrl, () => this.meetingId(credential, event.joinUrl, stop.signal));
        if (meeting === null) continue;
        // A recording only for a meeting the member organized (Microsoft lets only the organizer download it). A transcript is looked for in every meeting; a refusal there is not an error of the list.
        const recordings = event.organizer ? await once(files, `${meeting}/recordings`, () => this.jsonOrNull(`${GRAPH}/me/onlineMeetings/${meeting}/recordings`, credential, stop.signal)) : null;
        const transcripts = await once(files, `${meeting}/transcripts`, () => this.jsonOrNull(`${GRAPH}/me/onlineMeetings/${meeting}/transcripts`, credential, stop.signal));
        const occurrence = { start: event.start, end: event.end };
        const hasVideo = madeDuring(recordings, occurrence).length === 1;
        const hasTranscript = madeDuring(transcripts, occurrence).length === 1;
        if (!hasVideo && !hasTranscript) continue;
        found[index] = {
          id: keyOf(meeting, event.start, event.end),
          title: event.title,
          startedAt: new Date(event.start).toISOString(),
          lengthSeconds: Math.round((event.end - event.start) / 1000),
          sizeBytes: null,
          // A Teams recording is one MP4 with the sound in it; there is no audio-only file.
          hasAudio: false,
          hasVideo,
          hasTranscript,
        };
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(LOOKUP_PARALLEL, events.length) }, () => worker()));
    } catch (error) {
      stop.abort();
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    const seen = new Set<string>();
    return found
      .filter((x): x is MeetingPlatformListed => x !== null)
      .filter((x) => !seen.has(x.id) && seen.add(x.id))
      .slice(0, MEETING_PLATFORM_LIST_MAX);
  }

  async prepareDownload(credential: MeetingPlatformCredential, recordingId: string, format: MeetingPlatformFormat, signal?: AbortSignal): Promise<MeetingPlatformDownload> {
    const occurrence = parseKey(recordingId);
    if (format === 'audio') throw new MeetingPlatformError('no_audio', 'a Teams recording has no audio-only file');
    // The recording of this occurrence, asked again at the click: exactly one (an occurrence with several is not offered, nor imported).
    const body = await this.json(`${GRAPH}/me/onlineMeetings/${occurrence.meeting}/recordings`, credential, signal);
    const recordings = madeDuring(body, occurrence);
    const only = recordings.length === 1 ? recordings[0] : undefined;
    const file = text(only?.id);
    if (!GRAPH_ID.test(file)) throw new MeetingPlatformError('platform_refused', 'the meeting has no single recording');
    return {
      url: `${GRAPH}/me/onlineMeetings/${occurrence.meeting}/recordings/${file}/content`,
      headers: { authorization: `Bearer ${credential.accessToken}` },
      format,
      contentType: 'video/mp4',
      sizeBytes: null,
      // The guard's first host is exactly Graph's; a redirect may go to SharePoint and nowhere else.
      hosts: [TEAMS_GRAPH_HOST],
      hostSuffixes: [TEAMS_DOWNLOAD_SUFFIX],
    };
  }

  // Microsoft's transcript of one meeting: its lines, in order, with the speakers' names where the tenant lets Graph give them.
  async transcript(credential: MeetingPlatformCredential, recordingId: string, signal?: AbortSignal): Promise<MeetingPlatformTranscript> {
    const occurrence = parseKey(recordingId);
    const body = await this.json(`${GRAPH}/me/onlineMeetings/${occurrence.meeting}/transcripts`, credential, signal);
    const transcripts = madeDuring(body, occurrence);
    const only = transcripts.length === 1 ? transcripts[0] : undefined;
    const file = text(only?.id);
    if (!GRAPH_ID.test(file)) throw new MeetingPlatformError('platform_refused', 'the meeting has no single transcript');
    const { status, response } = await this.read(`${GRAPH}/me/onlineMeetings/${occurrence.meeting}/transcripts/${file}/content`, credential, signal, 'text/vtt');
    if (status < 200 || status >= 300) throw statusError(status, innerCodeOf(await response.json().catch(() => null)));
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > TEAMS_TRANSCRIPT_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new MeetingPlatformError('too_large');
    }
    // Read in pieces, so a file with no declared size cannot fill the memory.
    const reader = response.body?.getReader();
    if (!reader) throw new MeetingPlatformError('platform_unavailable');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let piece: Awaited<ReturnType<typeof reader.read>>;
      try {
        piece = await reader.read();
      } catch {
        throw new MeetingPlatformError('platform_unavailable');
      }
      if (piece.done) break;
      total += piece.value.byteLength;
      if (total > TEAMS_TRANSCRIPT_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new MeetingPlatformError('too_large');
      }
      chunks.push(piece.value);
    }
    const { entries, truncated } = parseTeamsVtt(Buffer.concat(chunks).toString('utf8'));
    if (entries.length === 0) throw new MeetingPlatformError('platform_refused', 'the transcript has no lines');
    return { source: 'microsoft_teams', language: null, truncated, entries };
  }

  // The Entra authorize address (multi-tenant work and school accounts). `prompt` is left out: the consent dialog shows by itself for what the member may consent to, and Microsoft sends a member whose
  // tenant needs an administrator's consent to its own "need admin approval" page.
  authorizeUrl(input: MeetingPlatformAuthorizeInput): string {
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: input.redirectUri,
      response_mode: 'query',
      scope: TEAMS_SCOPES.join(' '),
      state: input.state,
    });
    if (input.codeChallenge) {
      query.set('code_challenge', input.codeChallenge);
      query.set('code_challenge_method', 'S256');
    }
    return `${AUTHORITY}/authorize?${query.toString()}`;
  }

  // One call to the token endpoint. The answer is `{ status, body }`: Entra reports a grant it will not honour as a 400 with `error: invalid_grant`, the caller maps it.
  private async token(form: URLSearchParams, signal?: AbortSignal): Promise<{ status: number; body: Json }> {
    let response: Response;
    try {
      response = await this.http(`${AUTHORITY}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new MeetingPlatformError('platform_unavailable');
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 429 || response.status >= 500) throw new MeetingPlatformError('platform_unavailable');
    return { status: response.status, body: isRecord(body) ? body : {} };
  }

  // The code grant. A code Microsoft refuses (used, expired, a redirect address that is not the app's) or a client it does not know is `platform_refused`. The account is keyed by the tenant and the user
  // object ids from the id_token (stable when the address changes), lowercased because the connection's key is stored lowercased and the tokens are sealed for it.
  async exchange(input: { code: string; redirectUri: string; codeVerifier: string | null }, signal?: AbortSignal): Promise<MeetingPlatformAccount> {
    const form = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      scope: TEAMS_SCOPES.join(' '),
    });
    if (input.codeVerifier) form.set('code_verifier', input.codeVerifier);
    const { status, body } = await this.token(form, signal);
    // A tenant that needs its administrator's consent can answer here as well as at the redirect: said apart, so the member is told whom to ask.
    if (status >= 400 && teamsConnectProblem(text(body.error), text(body.error_description)) === 'admin_consent_required') throw new MeetingPlatformConsentError();
    if (status < 200 || status >= 300) throw new MeetingPlatformError('platform_refused');
    const accessToken = text(body.access_token);
    const refreshToken = text(body.refresh_token);
    // Without a refresh token (the `offline_access` scope was not granted) the connection would die in an hour, so the member is told now.
    if (accessToken === '' || refreshToken === '') throw new MeetingPlatformError('platform_refused', 'Microsoft sent no refresh token');
    const claims = claimsOf(body.id_token);
    const oid = text(claims?.oid).trim().toLowerCase();
    const tid = text(claims?.tid).trim().toLowerCase();
    if (claims === null || !/^[0-9a-f-]{36}$/.test(oid) || !/^[0-9a-f-]{36}$/.test(tid)) throw new MeetingPlatformError('platform_refused', 'Microsoft did not name the account');
    const name = [text(claims.name), text(claims.preferred_username), text(claims.email)].map((n) => cleaned(n, 200)).find((n) => n !== '') ?? `${tid}:${oid}`;
    const lifetime = Number(body.expires_in);
    const expiresAt = new Date(this.now().getTime() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000);
    const scopes = text(body.scope)
      .split(/\s+/)
      .filter((s) => s !== '' && s.length <= 200)
      .slice(0, 20);
    return {
      externalAccount: `${tid}:${oid}`,
      displayName: name,
      scopes,
      expiresAt,
      secret: JSON.stringify({ accessToken, refreshToken, expiresAt: expiresAt.toISOString() }),
    };
  }

  // Entra gives a new refresh token with every refresh ("discard the old refresh token"), so the new one is returned and replaces the old; one that is not sent keeps the old. A grant Entra no longer honours
  // (revoked, expired, the password changed, consent withdrawn, the app removed) is `refused`: the job expires the connection and the member connects again.
  async refresh(credential: MeetingPlatformCredential, signal?: AbortSignal): Promise<MeetingPlatformCredential | { refused: true }> {
    if (!credential.refreshToken) return { refused: true };
    const { status, body } = await this.token(
      new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, grant_type: 'refresh_token', refresh_token: credential.refreshToken, scope: TEAMS_SCOPES.join(' ') }),
      signal,
    );
    // Only a grant Entra will not honour expires the connection. A client Entra rejects (`invalid_client`: the operator's secret expired, say) is the operator's to fix and must not expire every member's connection.
    const error = text(body.error);
    if ((status === 400 || status === 401) && (error === 'invalid_grant' || error === 'interaction_required')) return { refused: true };
    if (status < 200 || status >= 300) throw new MeetingPlatformError('platform_unavailable');
    const accessToken = text(body.access_token);
    if (accessToken === '') throw new MeetingPlatformError('platform_unavailable');
    const lifetime = Number(body.expires_in);
    return {
      accessToken,
      refreshToken: text(body.refresh_token) || credential.refreshToken,
      expiresAt: new Date(this.now().getTime() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000),
    };
  }
}
