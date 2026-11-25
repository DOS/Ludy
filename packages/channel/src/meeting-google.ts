// SPDX-License-Identifier: AGPL-3.0-only
// Google Meet as a meeting platform (meetings integrations C2, issue #3174, plan docs/plan/meetings-integrations.md section 6.1): the TRANSCRIPT-ONLY half. The Meet REST API serves the text of a
// conference's own transcript (`conferenceRecords.transcripts.entries`) with the sensitive scope `meetings.space.readonly`, so this adapter needs no Drive scope and no security assessment. The audio
// path (the recording file in the organizer's Drive) is not read with a restricted scope: the owner chose the Picker route (2026-11-25, ADR-0025 amendment). It is built here behind `recordings`, which nothing sets yet:
// the member picks one recording in Google Picker (`drive.file`) and the server then reads only that file. Without `recordings` this adapter is transcript only, as before.
//
// Everything the adapter says about a transcript is GOOGLE's transcription, never Ludy's: the result carries `source: 'google_meet'` so the data and the screen can say so.
//
// One Google client: a token is refreshed by the calendar adapter's own refresh (`GoogleCalendarAdapter.refresh`, the same OAuth client and sealed-secret shape), passed in as `refresher`. This file only
// calls `meet.googleapis.com`, through an allowlisted fetch (ADR-0025); an error message carries a short code and the HTTP status, never a token or a response body.
import { revokeGoogleGrantBestEffort } from './google-oauth.ts';
import { MEETING_PLATFORM_LIST_MAX, MeetingPlatformError, meetingPlatformCallOf, normalizeMeetingPlatformCall } from './meeting-platform.ts';
import type { MeetingPlatformAccount, MeetingPlatformAdapter, MeetingPlatformAuthorizeInput, MeetingPlatformCall, MeetingPlatformCredential, MeetingPlatformDownload, MeetingPlatformFormat, MeetingPlatformListed, MeetingPlatformOAuth, MeetingPlatformTranscript, MeetingPlatformTranscriptEntry } from './meeting-platform.ts';
import { allowlistedFetch, type Fetch } from './oauth.ts';

export const GOOGLE_MEET_HOSTS = ['meet.googleapis.com'] as const;
// The hosts of the connect step only (the code exchange and the one read of who the grant belongs to); the conference reads never go there.
export const GOOGLE_MEET_OAUTH_HOSTS = ['oauth2.googleapis.com', 'www.googleapis.com'] as const;
// The narrowest scope that reads conference records and transcript entries (sensitive, not restricted).
export const GOOGLE_MEET_SPACE_READ_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';
// What the connect dialog asks for: who the account is (`openid`, `email`) and the Meet transcript read. No Drive scope, no calendar scope: the recording file is not read (C-OA1, #3177).
export const GOOGLE_MEET_AUTH_SCOPES = ['openid', 'email', GOOGLE_MEET_SPACE_READ_SCOPE] as const;

// The scope of the Picker route (non-sensitive): the member gives this app access to the one recording file they pick in Google Picker, and the server's token then reads that file. Not part of
// GOOGLE_MEET_AUTH_SCOPES until the connect asks for it (the pick-command step); the restricted Drive scopes (`drive.readonly`, `drive.meet.readonly`) are never used.
export const GOOGLE_MEET_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
// Where a picked recording is downloaded from: the Drive API's media endpoint, the first host only (the bearer token goes there and nowhere else). A redirect may land on Google's content hosts; whether it
// does is [unverified] until a live run (ADR-0025 amendment), and the guard never sends the token to a redirect target.
export const GOOGLE_DRIVE_DOWNLOAD_HOST = 'www.googleapis.com';
export const GOOGLE_DRIVE_REDIRECT_SUFFIX = 'googleusercontent.com';

const API = 'https://meet.googleapis.com/v2';
// Pages of conference records read per listing (100 each): the newest 300 conferences in the window are looked at, and at most MEETING_PLATFORM_LIST_MAX with a finished transcript are returned.
const RECORD_PAGES = 3;
const PAGE_SIZE = 100;
const LOOKUP_PARALLEL = 4;
// One conference rarely has more than a few thousand lines; a longer one is cut here and says so (`truncated`).
export const GOOGLE_MEET_TRANSCRIPT_MAX_ENTRIES = 5000;
const ENTRY_TEXT_MAX = 4000;
const NAME_MAX = 100;
// Meet limits a conference to 24 hours: a line stamped later than that is bad data and is clamped, so no number downstream is enormous.
const SECONDS_MAX = 24 * 3600;
const SPACE_NAME = /^spaces\/[A-Za-z0-9_-]{1,128}$/;
const RECORDING_NAME = /^conferenceRecords\/([A-Za-z0-9_-]{1,128})\/recordings\/([A-Za-z0-9_-]{1,128})$/;
// A Drive file id: letters, digits, `-` and `_` (a longer or odd one is not a file id and never goes into a URL).
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;
const TRANSCRIPT_NAME = /^conferenceRecords\/([A-Za-z0-9_-]{1,128})\/transcripts\/([A-Za-z0-9_-]{1,128})$/;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// What the refresh of the Google calendar adapter answers, as this file needs it (the calendar adapter satisfies it).
export interface GoogleTokenRefresher {
  refresh(secret: string): Promise<{ secret: string; expiresAt: Date | null } | { refused: string } | { failed: string }>;
}

// The Google OAuth client of the Meet connection (MEETINGS_GOOGLE_CLIENT_ID and MEETINGS_GOOGLE_CLIENT_SECRET): a client of its own, so the calendar's consent screen stays narrow (plan 6.2, C-OA1 item 4).
export interface GoogleMeetAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleMeetOptions {
  refresher: GoogleTokenRefresher;
  fetch?: Fetch | undefined;
  // The client of the connect dialog and the code exchange. Without it the adapter only reads conferences (a test of the reads); the registry always gives it.
  app?: GoogleMeetAppConfig | undefined;
  now?: (() => Date) | undefined;
  // The Picker route (#3174, ADR-0025 amendment): offer the recording of a conference that has no transcript, and read a picked recording from Drive. Off unless the registry turns it on, so the listing and the
  // download of an adapter made without it are exactly the transcript-only ones.
  recordings?: boolean | undefined;
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const cleaned = (value: string, max: number): string => value.replace(CONTROL, '').replace(LONE_SURROGATE, '�').trim().slice(0, max);
const instant = (value: unknown): number | null => {
  const s = text(value);
  const t = s === null ? Number.NaN : Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

function failure(status: number): MeetingPlatformError {
  // 401: the token is bad. 403: this grant cannot read Meet (the scope was not granted or unticked, or the Meet API is off for the project), which only connecting again can fix.
  if (status === 401 || status === 403) return new MeetingPlatformError('connection_expired', `Google refused the grant (${status})`);
  if (status === 404) return new MeetingPlatformError('recording_gone', 'Google has no such conference or transcript');
  if (status === 429 || status >= 500) return new MeetingPlatformError('platform_unavailable', `Google answered ${status}`);
  return new MeetingPlatformError('platform_refused', `Google answered ${status}`);
}

export class GoogleMeetAdapter implements MeetingPlatformAdapter, MeetingPlatformOAuth {
  readonly provider = 'google_meet' as const;
  readonly oauthProvider = 'google_recordings' as const;
  // Google's authorization code flow takes PKCE with the client secret; the verifier is kept in the attempt like a calendar's.
  readonly pkce = true;
  readonly hosts: readonly string[] = GOOGLE_MEET_HOSTS;
  private readonly fetch: Fetch;
  private readonly oauthFetch: Fetch;
  private readonly refresher: GoogleTokenRefresher;
  private readonly app: GoogleMeetAppConfig | undefined;
  private readonly now: () => Date;
  private readonly recordings: boolean;

  constructor(options: GoogleMeetOptions) {
    this.fetch = allowlistedFetch(GOOGLE_MEET_HOSTS, options.fetch);
    this.oauthFetch = allowlistedFetch(GOOGLE_MEET_OAUTH_HOSTS, options.fetch);
    this.refresher = options.refresher;
    this.app = options.app;
    this.now = options.now ?? (() => new Date());
    this.recordings = options.recordings === true;
  }

  private requireApp(): GoogleMeetAppConfig {
    if (!this.app) throw new MeetingPlatformError('platform_refused', 'this Google Meet adapter has no OAuth client');
    return this.app;
  }

  // The Google authorize address: the Meet transcript scope and who the account is, offline access with consent each time (so Google returns a refresh token even for an account connected before), and
  // none of the scopes a member granted to this client before (`include_granted_scopes=false`: the grant is this scope only).
  authorizeUrl(input: MeetingPlatformAuthorizeInput): string {
    const app = this.requireApp();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_MEET_AUTH_SCOPES.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'false');
    if (input.codeChallenge) {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  // One call of the connect step, as JSON. A network failure or an unreadable answer is `platform_unavailable`; a 429 or 5xx too; any other refusal (a code Google will not take, an unknown client, a profile it
  // will not give) is `platform_refused`. Google's own words are never copied into the error (the answer can hold the code).
  private async oauthCall(url: string, init: RequestInit): Promise<Json> {
    let response: Response;
    try {
      response = await this.oauthFetch(url, init);
    } catch {
      throw new MeetingPlatformError('platform_unavailable', 'Google did not answer');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429 || response.status >= 500) throw new MeetingPlatformError('platform_unavailable', `Google answered ${response.status}`);
      throw new MeetingPlatformError('platform_refused', `Google answered ${response.status}`);
    }
    const body = object(await response.json().catch(() => null));
    if (!body) throw new MeetingPlatformError('platform_unavailable', 'Google answered with something unreadable');
    return body;
  }

  // The code grant, then the one read of who the grant belongs to. A grant without the Meet transcript scope (the member unticked it) or without a refresh token (the connection would die in an hour) is refused
  // now, so the member is told while they are here. The account is keyed by Google's stable subject id (an address can change); the address is the name shown.
  async exchange(input: { code: string; redirectUri: string; codeVerifier: string | null }, signal?: AbortSignal): Promise<MeetingPlatformAccount> {
    const app = this.requireApp();
    const form = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri });
    if (input.codeVerifier) form.set('code_verifier', input.codeVerifier);
    const grant = await this.oauthCall('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      ...(signal ? { signal } : {}),
    });
    const accessToken = text(grant.access_token);
    const refreshToken = text(grant.refresh_token);
    if (accessToken === null) throw new MeetingPlatformError('platform_unavailable', 'Google answered without an access token');
    // From here Google has issued a grant. A refusal below leaves nothing in Ludy, so the grant is taken away at Google too (best effort), instead of staying in the member's Google Account unused.
    try {
      if (refreshToken === null) throw new MeetingPlatformError('platform_refused', 'Google answered without a refresh token');
      const granted = (text(grant.scope) ?? '').split(/\s+/).filter((scope) => scope !== '' && scope.length <= 200);
      if (!granted.includes(GOOGLE_MEET_SPACE_READ_SCOPE)) throw new MeetingPlatformError('platform_refused', 'Google did not grant the Meet transcript permission');
      const info = await this.oauthCall('https://www.googleapis.com/oauth2/v3/userinfo', { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, ...(signal ? { signal } : {}) });
      const subject = (text(info.sub) ?? '').trim().toLowerCase();
      const email = (text(info.email) ?? '').trim().toLowerCase();
      // No subject or address (the profile scopes were unticked), or an address Google has not verified: nothing identifies the account, so nothing is stored.
      if (subject === '' || subject.length > 200 || email === '' || email.length > 200 || info.email_verified === false) throw new MeetingPlatformError('platform_refused', 'Google did not return a verified account');
      const seconds = Number(grant.expires_in);
      const expiresAt = new Date(this.now().getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000);
      return { externalAccount: subject, displayName: email, scopes: granted.slice(0, 20), expiresAt, secret: JSON.stringify({ accessToken, refreshToken, expiresAt: expiresAt.toISOString() }) };
    } catch (error) {
      await revokeGoogleGrantBestEffort(this.oauthFetch, refreshToken ?? accessToken, signal);
      throw error;
    }
  }

  // `skipMissing`: a 403 or 404 on this one resource answers null (one conference's transcripts are gone or not the member's) instead of failing the whole call.
  private async must(path: string, params: Record<string, string>, credential: MeetingPlatformCredential, signal?: AbortSignal): Promise<Json> {
    return (await this.get(path, params, credential, signal)) as Json;
  }

  private async get(path: string, params: Record<string, string>, credential: MeetingPlatformCredential, signal?: AbortSignal, skipMissing = false): Promise<Json | null> {
    const url = new URL(`${API}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetch(url.toString(), { method: 'GET', headers: { authorization: `Bearer ${credential.accessToken}`, accept: 'application/json' }, ...(signal ? { signal } : {}) });
    } catch {
      throw new MeetingPlatformError('platform_unavailable', 'Google did not answer');
    }
    if (!response.ok) {
      // The body is never read, but the connection must not wait for the garbage collector.
      await response.body?.cancel().catch(() => undefined);
      if (skipMissing && (response.status === 403 || response.status === 404)) return null;
      throw failure(response.status);
    }
    const body = object(await response.json().catch(() => null));
    if (!body) throw new MeetingPlatformError('platform_unavailable', 'Google answered with something unreadable');
    return body;
  }

  // The conferences of the member (as organizer, per Google's own rule) that ended at or after `since` and have a transcript Google finished writing. The recording file is not offered (no audio path).
  async list(credential: MeetingPlatformCredential, since: Date, signal?: AbortSignal): Promise<MeetingPlatformListed[]> {
    const records: { name: string; start: number; end: number; space: string | null }[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < RECORD_PAGES; page += 1) {
      const params: Record<string, string> = { pageSize: String(PAGE_SIZE), filter: `start_time>="${since.toISOString()}"` };
      if (pageToken) params.pageToken = pageToken;
      const body = await this.must('conferenceRecords', params, credential, signal);
      for (const item of Array.isArray(body.conferenceRecords) ? body.conferenceRecords : []) {
        const record = object(item);
        const name = text(record?.name);
        const start = instant(record?.startTime);
        const end = instant(record?.endTime);
        // A conference still running has no end time: it is listed once it is over.
        if (name === null || start === null || end === null || end < start || !/^conferenceRecords\/[A-Za-z0-9_-]{1,128}$/.test(name)) continue;
        const space = text(record?.space);
        records.push({ name, start, end, space: space !== null && SPACE_NAME.test(space) ? space : null });
      }
      pageToken = text(body.nextPageToken);
      if (!pageToken) break;
    }
    records.sort((a, b) => b.start - a.start);
    const spaces = new Map<string, Promise<MeetingPlatformCall | null>>();
    const spaceCall = (space: string): Promise<MeetingPlatformCall | null> => {
      let cached = spaces.get(space);
      if (cached === undefined) {
        cached = (async () => {
          const spaceBody = await this.get(space, {}, credential, signal, true);
          if (spaceBody === null) return null;
          const code = text(spaceBody.meetingCode);
          if (code !== null) {
            const byCode = normalizeMeetingPlatformCall({ platform: 'google_meet', id: code });
            if (byCode !== null) return byCode;
          }
          const uri = text(spaceBody.meetingUri);
          if (uri !== null) {
            const byUri = meetingPlatformCallOf(uri);
            if (byUri?.platform === 'google_meet') return byUri;
          }
          return null;
        })();
        spaces.set(space, cached);
      }
      return cached;
    };
    const found: (MeetingPlatformListed | null)[] = Array.from({ length: records.length }, () => null);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const record = records[index];
        if (record === undefined) return;
        // One conference that Google no longer shows must not hide the others.
        const body = await this.get(`${record.name}/transcripts`, { pageSize: '10' }, credential, signal, true);
        if (body === null) continue;
        const done = (Array.isArray(body.transcripts) ? body.transcripts : []).map(object).find((t) => t !== null && t.state === 'FILE_GENERATED' && TRANSCRIPT_NAME.test(text(t.name) ?? '') && (text(t.name) ?? '').startsWith(`${record.name}/transcripts/`));
        const name = text(done?.name);
        // A conference with a finished transcript is offered as its transcript (free, nothing to pick). Only one without it may be offered as its recording file, when the Picker route is on.
        const recording = name === null && this.recordings ? await this.recordingOf(record.name, credential, signal) : null;
        const offered = name ?? recording?.name ?? null;
        if (offered === null) continue;
        const call = record.space === null ? null : await spaceCall(record.space);
        found[index] = {
          id: offered,
          title: 'Google Meet',
          startedAt: new Date(record.start).toISOString(),
          lengthSeconds: Math.round((record.end - record.start) / 1000),
          sizeBytes: null,
          hasAudio: false,
          hasVideo: name === null,
          hasTranscript: name !== null,
          ...(call ? { call } : {}),
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOOKUP_PARALLEL, records.length) }, () => worker()));
    return found.filter((x): x is MeetingPlatformListed => x !== null).slice(0, MEETING_PLATFORM_LIST_MAX);
  }

  // The finished recording of a conference and the Drive file it was written to, or null when there is none (or Google no longer shows the conference). `driveDestination.file` is the Drive file id;
  // a state other than FILE_GENERATED has no file yet. A file id that is not one is dropped, so nothing odd is ever put into a URL.
  private async recordingOf(conference: string, credential: MeetingPlatformCredential, signal?: AbortSignal): Promise<{ name: string; fileId: string } | null> {
    const body = await this.get(`${conference}/recordings`, { pageSize: '10' }, credential, signal, true);
    if (body === null) return null;
    for (const item of Array.isArray(body.recordings) ? body.recordings : []) {
      const recording = object(item);
      const name = text(recording?.name);
      const fileId = text(object(recording?.driveDestination)?.file);
      if (recording?.state !== 'FILE_GENERATED' || name === null || fileId === null) continue;
      if (!RECORDING_NAME.test(name) || !name.startsWith(`${conference}/recordings/`) || !DRIVE_FILE_ID.test(fileId)) continue;
      return { name, fileId };
    }
    return null;
  }

  // The Drive file id Meet gave for one listed recording, asked of Meet now (never trusted from the client): the pick command compares the member's pick with it, so a member cannot make the server read a Drive file
  // of their own choice. Null when the recording is gone, not finished, or the Picker route is off.
  async recordingFile(credential: MeetingPlatformCredential, recordingId: string, signal?: AbortSignal): Promise<{ fileId: string } | null> {
    if (!this.recordings) return null;
    const match = RECORDING_NAME.exec(recordingId);
    if (!match) return null;
    const found = await this.recordingOf(`conferenceRecords/${match[1]}`, credential, signal);
    return found !== null && found.name === recordingId ? { fileId: found.fileId } : null;
  }

  // The recording file of a conference, read from Drive with the server's own token: only the file Meet named for this recording (the member picked it in Google Picker, which is what lets `drive.file` read it).
  // It is a video, so the job takes its audio out in crove-media (C2a). The bearer goes to the first host only. Without the Picker route, or for a transcript, there is nothing to download here.
  async prepareDownload(credential: MeetingPlatformCredential, recordingId: string, format: MeetingPlatformFormat, signal?: AbortSignal): Promise<MeetingPlatformDownload> {
    if (!this.recordings) throw new MeetingPlatformError('platform_refused', 'Google Meet offers the transcript only');
    if (!RECORDING_NAME.test(recordingId)) throw new MeetingPlatformError('platform_refused', 'not a recording of Google Meet');
    // A Meet recording is one video file: there is no audio file to fetch.
    if (format === 'audio') throw new MeetingPlatformError('no_audio', 'a Google Meet recording is a video file');
    const file = await this.recordingFile(credential, recordingId, signal);
    if (file === null) throw new MeetingPlatformError('recording_gone', 'Google has no finished recording file for this');
    return {
      url: `https://${GOOGLE_DRIVE_DOWNLOAD_HOST}/drive/v3/files/${encodeURIComponent(file.fileId)}?alt=media`,
      headers: { authorization: `Bearer ${credential.accessToken}` },
      format: 'video',
      contentType: 'video/mp4',
      sizeBytes: null,
      hosts: [GOOGLE_DRIVE_DOWNLOAD_HOST],
      hostSuffixes: [GOOGLE_DRIVE_REDIRECT_SUFFIX],
    };
  }

  // Google's transcript of one conference: its lines, in order, with the speakers' names where Google gives them. Times are seconds from the start of the conference.
  async transcript(credential: MeetingPlatformCredential, recordingId: string, signal?: AbortSignal): Promise<MeetingPlatformTranscript> {
    const match = TRANSCRIPT_NAME.exec(recordingId);
    if (!match) throw new MeetingPlatformError('recording_gone', 'not a transcript of Google Meet');
    const record = `conferenceRecords/${match[1]}`;
    const conference = await this.must(record, {}, credential, signal);
    const origin = instant(conference.startTime);
    if (origin === null) throw new MeetingPlatformError('platform_unavailable', 'Google gave no start time');

    // Participant names, by resource name; a participant that Google does not name is no speaker.
    const names = new Map<string, string>();
    let token: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const body = await this.must(`${record}/participants`, { pageSize: '250', ...(token ? { pageToken: token } : {}) }, credential, signal);
      for (const item of Array.isArray(body.participants) ? body.participants : []) {
        const p = object(item);
        const key = text(p?.name);
        const who = object(p?.signedinUser) ?? object(p?.anonymousUser) ?? object(p?.phoneUser);
        const label = text(who?.displayName);
        if (key !== null && label !== null) names.set(key, cleaned(label, NAME_MAX));
      }
      token = text(body.nextPageToken);
      if (!token) break;
    }

    const entries: MeetingPlatformTranscriptEntry[] = [];
    let language: string | null = null;
    let truncated = false;
    token = null;
    for (let page = 0; page < Math.ceil(GOOGLE_MEET_TRANSCRIPT_MAX_ENTRIES / PAGE_SIZE) + 1; page += 1) {
      const body = await this.must(`${recordingId}/entries`, { pageSize: String(PAGE_SIZE), ...(token ? { pageToken: token } : {}) }, credential, signal);
      for (const item of Array.isArray(body.transcriptEntries) ? body.transcriptEntries : []) {
        const entry = object(item);
        const said = cleaned(text(entry?.text) ?? '', ENTRY_TEXT_MAX);
        const start = instant(entry?.startTime);
        if (said === '' || start === null) continue;
        if (entries.length >= GOOGLE_MEET_TRANSCRIPT_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const end = instant(entry?.endTime) ?? start;
        const startSeconds = Math.min(SECONDS_MAX, Math.max(0, Math.round((start - origin) / 1000)));
        language ??= text(entry?.languageCode)?.slice(0, 35) ?? null;
        entries.push({ startSeconds, endSeconds: Math.min(SECONDS_MAX, Math.max(startSeconds, Math.round((end - origin) / 1000))), speaker: names.get(text(entry?.participant) ?? '') ?? null, text: said });
      }
      token = text(body.nextPageToken);
      if (truncated || !token || entries.length >= GOOGLE_MEET_TRANSCRIPT_MAX_ENTRIES) break;
    }
    // Whatever stopped the loop (the cap, or the page budget when many lines were blank), a page token left over means Google has more lines than were read.
    if (token) truncated = true;
    return { source: 'google_meet', language, truncated, entries };
  }

  // Google renews through the calendar adapter's refresh (one OAuth client). A grant Google will not renew expires the connection; a failure to reach Google is retried later by the job.
  async refresh(credential: MeetingPlatformCredential): Promise<MeetingPlatformCredential | { refused: true }> {
    if (!credential.refreshToken) return { refused: true };
    const result = await this.refresher.refresh(JSON.stringify({ accessToken: credential.accessToken, refreshToken: credential.refreshToken }));
    if ('refused' in result) return { refused: true };
    if ('failed' in result) throw new MeetingPlatformError('platform_unavailable', 'Google did not renew the token');
    let parsed: { accessToken?: unknown; refreshToken?: unknown };
    try {
      parsed = JSON.parse(result.secret) as typeof parsed;
    } catch {
      throw new MeetingPlatformError('platform_unavailable', 'Google renewed the token in a shape this app cannot read');
    }
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) throw new MeetingPlatformError('platform_unavailable', 'Google renewed the token without an access token');
    return { accessToken: parsed.accessToken, refreshToken: typeof parsed.refreshToken === 'string' && parsed.refreshToken ? parsed.refreshToken : credential.refreshToken, expiresAt: result.expiresAt ?? undefined };
  }
}
