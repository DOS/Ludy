// SPDX-License-Identifier: AGPL-3.0-only
// Google Meet as a meeting platform (meetings integrations C2, issue #3174, plan docs/plan/meetings-integrations.md section 6.1): the TRANSCRIPT-ONLY half. The Meet REST API serves the text of a
// conference's own transcript (`conferenceRecords.transcripts.entries`) with the sensitive scope `meetings.space.readonly`, so this adapter needs no Drive scope and no security assessment. The audio
// path (the recording file in the organizer's Drive, `drive.meet.readonly`, a restricted scope) is NOT written here: the owner has not decided C-OA1 (#3177).
//
// Everything the adapter says about a transcript is GOOGLE's transcription, never Ludy's: the result carries `source: 'google_meet'` so the data and the screen can say so.
//
// One Google client: a token is refreshed by the calendar adapter's own refresh (`GoogleCalendarAdapter.refresh`, the same OAuth client and sealed-secret shape), passed in as `refresher`. This file only
// calls `meet.googleapis.com`, through an allowlisted fetch (ADR-0025); an error message carries a short code and the HTTP status, never a token or a response body.
import { MEETING_PLATFORM_LIST_MAX, MeetingPlatformError } from './meeting-platform.ts';
import type { MeetingPlatformAdapter, MeetingPlatformCredential, MeetingPlatformDownload, MeetingPlatformFormat, MeetingPlatformListed, MeetingPlatformTranscript, MeetingPlatformTranscriptEntry } from './meeting-platform.ts';
import { allowlistedFetch, type Fetch } from './oauth.ts';

export const GOOGLE_MEET_HOSTS = ['meet.googleapis.com'] as const;
// The narrowest scope that reads conference records and transcript entries (sensitive, not restricted).
export const GOOGLE_MEET_SPACE_READ_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';

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
const TRANSCRIPT_NAME = /^conferenceRecords\/([A-Za-z0-9_-]{1,128})\/transcripts\/([A-Za-z0-9_-]{1,128})$/;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// What the refresh of the Google calendar adapter answers, as this file needs it (the calendar adapter satisfies it).
export interface GoogleTokenRefresher {
  refresh(secret: string): Promise<{ secret: string; expiresAt: Date | null } | { refused: string } | { failed: string }>;
}

export interface GoogleMeetOptions {
  refresher: GoogleTokenRefresher;
  fetch?: Fetch | undefined;
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

export class GoogleMeetAdapter implements MeetingPlatformAdapter {
  readonly provider = 'google_meet' as const;
  readonly hosts: readonly string[] = GOOGLE_MEET_HOSTS;
  private readonly fetch: Fetch;
  private readonly refresher: GoogleTokenRefresher;

  constructor(options: GoogleMeetOptions) {
    this.fetch = allowlistedFetch(GOOGLE_MEET_HOSTS, options.fetch);
    this.refresher = options.refresher;
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
    const records: { name: string; start: number; end: number }[] = [];
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
        records.push({ name, start, end });
      }
      pageToken = text(body.nextPageToken);
      if (!pageToken) break;
    }
    records.sort((a, b) => b.start - a.start);
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
        if (name === null) continue;
        found[index] = {
          id: name,
          title: 'Google Meet',
          startedAt: new Date(record.start).toISOString(),
          lengthSeconds: Math.round((record.end - record.start) / 1000),
          sizeBytes: null,
          hasAudio: false,
          hasVideo: false,
          hasTranscript: true,
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOOKUP_PARALLEL, records.length) }, () => worker()));
    return found.filter((x): x is MeetingPlatformListed => x !== null).slice(0, MEETING_PLATFORM_LIST_MAX);
  }

  // The audio path is deliberately not built (C-OA1, #3177): the recording file needs a restricted Drive scope.
  async prepareDownload(_credential: MeetingPlatformCredential, _recordingId: string, _format: MeetingPlatformFormat, _signal?: AbortSignal): Promise<MeetingPlatformDownload> {
    throw new MeetingPlatformError('platform_refused', 'Google Meet offers the transcript only');
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
