// SPDX-License-Identifier: AGPL-3.0-only
// Google Calendar free/busy (issue #2123, part of #1374), written from the Google Calendar API (freeBusy.query) and
// Google OAuth 2.0 docs. It uses an OAuth web client the operator makes for it: CALENDAR_GOOGLE_CLIENT_ID and
// CALENDAR_GOOGLE_CLIENT_SECRET, never the YouTube or Business Profile project's.
//
// Connect: Google's consent screen for calendar.freebusy (busy intervals only: no titles, no attendees) plus the
// account's email, with offline access so a refresh token comes back. The access token lives an hour; the sync renews
// it a few minutes before it runs out. One grant is one Google account, its primary calendar.
// Busy: POST /calendar/v3/freeBusy for the primary calendar over a range; the answer is a list of start and end
// instants and nothing else.
import { ConnectorError, allowlistedFetch, type AuthorizeInput, type ExchangeInput, type Fetch } from './oauth.ts';

export const GOOGLE_CALENDAR_HOSTS = ['oauth2.googleapis.com', 'www.googleapis.com'] as const;
export const GOOGLE_CALENDAR_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
// Write-back (#2124): insert, change and delete events. Asked for only when the member opts in; the grant says what it carries.
export const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
// Reading the member's own meetings (Meetings B1, #3165): the events of the calendars the member owns, read only. Asked for only when the member turns "Cho Ludy đọc tên và giờ cuộc họp
// trong lịch" on; the grant says what it carries, and the connection reads busy times alone until then. The name and the category of this scope (sensitive, not restricted) are to be
// confirmed on the Cloud Console consent screen when it is added to the production client (docs/runbooks/calendar-oauth.md).
export const GOOGLE_CALENDAR_EVENTS_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
const AUTH_SCOPES = ['openid', 'email', GOOGLE_CALENDAR_FREEBUSY_SCOPE] as const;

export interface GoogleCalendarAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface CalendarAccount {
  // The account's address, lowercased.
  externalAccount: string;
  displayName: string;
  scopes: string[];
  expiresAt: Date | null;
  // The tokens as the kernel seals them; never logged.
  secret: string;
}

export interface BusyInterval {
  start: string;
  end: string;
}

// refused: the provider will not serve this grant any more (revoked or expired), the member reconnects; failed: it did
// not answer well (a quota, an outage), the next sync tries again.
export type CalendarBusyResult = { busy: BusyInterval[] } | { refused: string } | { failed: string };
// What one write to the provider came to: ok (for an event that asked for a conference, with `meetUrl`: the join link the provider made, or null when the event was
// written without one, the provider having refused or not finished it: the booking's Meet then failed); gone (the event is not there: the member deleted it, or it never was);
// refused (the token is dead: renew it once, then expire the connection); scope (the grant lacks the events permission);
// failed (a quota, an outage: the next sweep tries again).
// `transient` marks a failure that says nothing about the event (the network, a server error, a rate or quota limit): the
// worker leaves the rest of the batch for the next sweep and does not count it against the event.
export type CalendarWriteResult = { ok: true; meetUrl?: string | null } | { gone: true } | { refused: string } | { scope: true } | { failed: string; transient?: true };
export interface CalendarEventWrite {
  // The provider event id, chosen by the kernel and the same on every try, so a retry cannot make a second event.
  externalId: string;
  summary: string;
  startsAt: string;
  endsAt: string;
  // Ask the provider to make a conference for the event, a Google Meet (C7, #1375): the answer carries its join link.
  conference?: boolean;
}
export interface CalendarAuthorizeInput extends AuthorizeInput {
  // Also ask for the permission to write events (a member who turns write-back on).
  writeBack?: boolean;
  // Also ask for the permission to read the member's own events (a member who turns the meetings read on, B1).
  readEvents?: boolean;
}

// One event of the member's own calendar, as much as B1 keeps: what a person needs to recognize the meeting and nothing about who else is in it. `invitees` is a count; no address, description
// or attachment is ever asked for. `joinUrl` is a Meet, Zoom or Teams address or null.
export interface CalendarAgendaEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  joinUrl: string | null;
  invitees: number;
}
// scope: the grant lacks the events-read permission (the member untick it, or connected before it existed).
export type CalendarEventsResult = { events: CalendarAgendaEvent[] } | { refused: string } | { scope: true } | { failed: string };
export type CalendarRefreshResult = { secret: string; expiresAt: Date | null } | { refused: string } | { failed: string };

// What one outside calendar provider offers the kernel: the connect dialog, a renewed token, and busy times.
export interface CalendarAdapter {
  readonly provider: 'google' | 'microsoft' | 'caldav';
  // The OAuth provider id of the connect dialog (the oauth_state row and the redirect URI carry it).
  readonly oauthProvider: 'google_calendar' | 'microsoft_calendar';
  readonly pkce: boolean;
  authorizeUrl(input: CalendarAuthorizeInput): string;
  // Throws ConnectorError for a provider answer; never puts a token or the code in the error.
  exchange(input: ExchangeInput): Promise<CalendarAccount>;
  refresh(secret: string): Promise<CalendarRefreshResult>;
  // timeoutMs: how long the one call may take (30 seconds when not given); the live check of a slot asks for a short one.
  busy(secret: string, from: Date, to: Date, timeoutMs?: number): Promise<CalendarBusyResult>;
  // Takes the grant away at the provider (a disconnect): the whole grant, not only this token. A grant the provider no
  // longer knows counts as revoked. failed: the provider did not answer well; the worker tries again later.
  // revoked=false names why nothing was revoked (the secret holds no token).
  revoke(secret: string): Promise<{ revoked: true } | { revoked: false; reason: string } | { failed: string }>;
  // The member's own events from `from` to `to` (B1): timed events only, no cancelled one, none the member declined. At most 300; a longer list is cut and says so by its length.
  events(secret: string, from: Date, to: Date, timeoutMs?: number): Promise<CalendarEventsResult>;
  // Write-back: make the booking's event exist as given (insert, or change it when it is there), and take it away. Both
  // idempotent by the event's id; a conference asked for is made once, by a request named after the event's id.
  writeEvent(secret: string, event: CalendarEventWrite): Promise<CalendarWriteResult>;
  removeEvent(secret: string, externalId: string): Promise<CalendarWriteResult>;
}

export interface GoogleCalendarSecret {
  accessToken: string;
  refreshToken: string;
}

export function googleCalendarSecretOf(secret: string): GoogleCalendarSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<GoogleCalendarSecret>;
    return typeof s.accessToken === 'string' && s.accessToken && typeof s.refreshToken === 'string' && s.refreshToken ? { accessToken: s.accessToken, refreshToken: s.refreshToken } : null;
  } catch {
    return null;
  }
}

class GoogleCalendarError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, body: Record<string, unknown> | null) {
    const error = body?.error;
    const nested = error !== null && typeof error === 'object' ? (error as { message?: unknown; status?: unknown; errors?: { reason?: unknown }[] }) : null;
    super(typeof nested?.message === 'string' ? nested.message : typeof body?.error_description === 'string' ? body.error_description : `Google answered ${status}`);
    this.name = 'GoogleCalendarError';
    this.status = status;
    const reason = nested?.errors?.find((e) => typeof e?.reason === 'string')?.reason ?? nested?.status ?? (typeof error === 'string' ? error : undefined);
    this.reason = typeof reason === 'string' ? reason : undefined;
  }
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

const expiryOf = (a: TokenAnswer, now = Date.now()) => {
  const seconds = Number(a.expires_in);
  return new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000);
};

// A Google Meet join link, and nothing else (the booking's own check says the same).
const MEET_URL = /^https:\/\/meet\.google\.com\/(lookup\/)?[a-z0-9-]{3,64}$/;
// How many times a conference that Google has not finished is looked at again, and how long between looks.
const MEET_LOOKS = 2;
const MEET_LOOK_MS = 800;

// The join link of an event as Google answered it: the hangoutLink, else the video entry point of its conference data. Null when there is none, or it is
// not a Meet address. `pending`: Google has the request and has not finished it.
function meetOf(event: Record<string, unknown>): { url: string | null; pending: boolean } {
  const data = event.conferenceData as { entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }>; createRequest?: { status?: { statusCode?: unknown } } } | undefined;
  const candidates = [event.hangoutLink, ...(data?.entryPoints ?? []).filter((p) => p?.entryPointType === 'video').map((p) => p.uri)];
  const url = candidates.find((u): u is string => typeof u === 'string' && MEET_URL.test(u)) ?? null;
  return { url, pending: url === null && data?.createRequest?.status?.statusCode === 'pending' };
}

// A join address B1 keeps: https, and a Meet, Zoom or Teams host. Anything else (a plain link in a location, a tracking redirect) is not kept.
const JOIN_HOSTS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com'];
export function joinUrlOf(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length > 500) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase();
  return JOIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? url.toString() : null;
}

// The most events one read returns and the pieces it is asked in.
const EVENTS_MAX = 300;
const EVENTS_PAGE = 250;
// The fields asked for: no attendee address (only the flags of each attendee, counted), no description, no attachment, no location.
const EVENTS_FIELDS = 'nextPageToken,items(id,status,summary,start,end,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),attendees(self,responseStatus,optional))';

// One event of the answer as B1 keeps it, or null: an all-day event (it has no time to match a recording to), a cancelled one, one the member declined, or one without a usable id or time.
export function agendaEventOf(event: Record<string, unknown>): CalendarAgendaEvent | null {
  if (typeof event.id !== 'string' || event.id === '' || event.id.length > 1024 || event.status === 'cancelled') return null;
  const start = event.start as { dateTime?: unknown; timeZone?: unknown } | undefined;
  const end = event.end as { dateTime?: unknown } | undefined;
  if (typeof start?.dateTime !== 'string' || typeof end?.dateTime !== 'string') return null;
  const startMs = Date.parse(start.dateTime);
  const endMs = Date.parse(end.dateTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 31 * 86_400_000) return null;
  const attendees = Array.isArray(event.attendees) ? (event.attendees as Array<{ self?: unknown; responseStatus?: unknown }>) : [];
  if (attendees.some((a) => a?.self === true && a.responseStatus === 'declined')) return null;
  const data = event.conferenceData as { entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }> } | undefined;
  const joinUrl = [event.hangoutLink, ...(data?.entryPoints ?? []).filter((p) => p?.entryPointType === 'video').map((p) => p.uri)].map(joinUrlOf).find((u) => u !== null) ?? null;
  const zone = typeof start.timeZone === 'string' && start.timeZone !== '' && start.timeZone.length <= 64 ? start.timeZone : 'UTC';
  return {
    id: event.id,
    title: (typeof event.summary === 'string' ? event.summary : '').slice(0, 200),
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    timeZone: zone,
    joinUrl,
    invitees: Math.min(attendees.length, 1000),
  };
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly provider = 'google' as const;
  readonly oauthProvider = 'google_calendar' as const;
  readonly pkce = true;
  private readonly fetch: Fetch;
  private readonly app: GoogleCalendarAppConfig;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(app: GoogleCalendarAppConfig, fetchImpl?: Fetch, options: { sleep?: (ms: number) => Promise<void> } = {}) {
    if (!app.clientId) throw new Error('missing Google client id');
    if (!app.clientSecret) throw new Error('missing Google client secret');
    this.app = app;
    this.fetch = allowlistedFetch(GOOGLE_CALENDAR_HOSTS, fetchImpl);
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  authorizeUrl(input: CalendarAuthorizeInput): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.app.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', [...AUTH_SCOPES, ...(input.writeBack ? [GOOGLE_CALENDAR_EVENTS_SCOPE] : []), ...(input.readEvents ? [GOOGLE_CALENDAR_EVENTS_READ_SCOPE] : [])].join(' '));
    url.searchParams.set('state', input.state);
    // Offline access with consent each time, so Google returns a refresh token even for an account connected before.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'false');
    if (input.codeChallenge) {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  private async token(form: Record<string, string>): Promise<TokenAnswer> {
    const response = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...form }).toString(),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) throw new GoogleCalendarError(response.status, json);
    return json as TokenAnswer;
  }

  private async call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, json?: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (json !== undefined) headers['content-type'] = 'application/json; charset=UTF-8';
    const response = await this.fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs), ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new GoogleCalendarError(response.status, body);
    return body ?? {};
  }

  async exchange(input: ExchangeInput, now = Date.now()): Promise<CalendarAccount> {
    const answer = await this.token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}) }).catch((error: unknown) => {
      throw connectorError(error, true);
    });
    if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'Google answered without an access token');
    if (typeof answer.refresh_token !== 'string' || !answer.refresh_token) throw new ConnectorError('provider', 'Google answered without a refresh token');
    const granted = typeof answer.scope === 'string' ? answer.scope.split(' ').filter(Boolean) : [];
    // Google lets the member untick a permission on the consent screen.
    if (!granted.includes(GOOGLE_CALENDAR_FREEBUSY_SCOPE)) throw new ConnectorError('denied', 'Google did not grant the calendar permission this app needs', 'MISSING_PERMISSION');
    const info = await this.call('GET', 'https://www.googleapis.com/oauth2/v3/userinfo', answer.access_token).catch((error: unknown) => {
      throw connectorError(error);
    });
    const email = typeof info.email === 'string' ? info.email.trim().toLowerCase() : '';
    if (!email || info.email_verified === false) throw new ConnectorError('denied', 'Google did not give a verified email for this account', 'NO_EMAIL');
    const secret: GoogleCalendarSecret = { accessToken: answer.access_token, refreshToken: answer.refresh_token };
    return { externalAccount: email.slice(0, 200), displayName: email.slice(0, 200), scopes: granted.slice(0, 20), expiresAt: expiryOf(answer, now), secret: JSON.stringify(secret) };
  }

  async refresh(secret: string): Promise<CalendarRefreshResult> {
    const s = googleCalendarSecretOf(secret);
    if (!s) return { refused: 'NO_REFRESH_TOKEN' };
    try {
      const answer = await this.token({ grant_type: 'refresh_token', refresh_token: s.refreshToken });
      if (typeof answer.access_token !== 'string' || !answer.access_token) return { failed: 'NO_ACCESS_TOKEN' };
      // Google may hand out a new refresh token; otherwise the old one stays.
      const next: GoogleCalendarSecret = { accessToken: answer.access_token, refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : s.refreshToken };
      return { secret: JSON.stringify(next), expiresAt: expiryOf(answer) };
    } catch (error) {
      // invalid_grant: the grant was revoked, or expired (an app in testing mode gets 7-day refresh tokens).
      if (error instanceof GoogleCalendarError && error.reason === 'invalid_grant') return { refused: 'invalid_grant' };
      return { failed: error instanceof GoogleCalendarError ? (error.reason ?? String(error.status)) : 'NETWORK' };
    }
  }

  // The member's own primary calendar from `from` to `to`, recurring events unfolded and sorted by start. One request per 250 events, two at most; the list is cut at 300.
  async events(secret: string, from: Date, to: Date, timeoutMs?: number): Promise<CalendarEventsResult> {
    const s = googleCalendarSecretOf(secret);
    if (!s) return { refused: 'NO_ACCESS_TOKEN' };
    const events: CalendarAgendaEvent[] = [];
    const seen = new Set<string>();
    let pageToken: string | null = null;
    for (let page = 0; page < 2; page += 1) {
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
      url.searchParams.set('timeMin', from.toISOString());
      url.searchParams.set('timeMax', to.toISOString());
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('showDeleted', 'false');
      url.searchParams.set('maxResults', String(EVENTS_PAGE));
      url.searchParams.set('fields', EVENTS_FIELDS);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      let body: Record<string, unknown>;
      try {
        body = await this.call('GET', url.toString(), s.accessToken, undefined, timeoutMs);
      } catch (error) {
        if (!(error instanceof GoogleCalendarError)) return { failed: 'NETWORK' };
        if (error.status === 401) return { refused: 'invalid_token' };
        if (error.status === 403 && (error.reason === 'insufficientPermissions' || error.reason === 'forbidden' || error.reason === 'PERMISSION_DENIED')) return { scope: true };
        return { failed: error.reason ?? String(error.status) };
      }
      for (const item of Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : []) {
        const event = item !== null && typeof item === 'object' ? agendaEventOf(item) : null;
        if (event && !seen.has(event.id)) {
          seen.add(event.id);
          events.push(event);
        }
      }
      pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken !== '' ? body.nextPageToken : null;
      if (!pageToken || events.length >= EVENTS_MAX) break;
    }
    return { events: events.slice(0, EVENTS_MAX) };
  }

  // The answer of a write that did not succeed, as the result the worker acts on.
  private writeFailure(error: unknown): CalendarWriteResult {
    if (!(error instanceof GoogleCalendarError)) return { failed: 'NETWORK', transient: true };
    if (error.status === 401) return { refused: 'invalid_token' };
    if (error.status === 403 && (error.reason === 'insufficientPermissions' || error.reason === 'forbidden' || error.reason === 'PERMISSION_DENIED')) return { scope: true };
    const limited = error.status === 429 || (error.status === 403 && /rate|quota|limit/i.test(error.reason ?? ''));
    const failed = error.reason ?? String(error.status);
    return error.status >= 500 || limited ? { failed, transient: true } : { failed };
  }

  // Inserts the event under the id the kernel chose; Google answers 409 for an id it already has (a retry, or an event it
  // keeps after it was deleted), and the event is then changed to be as given and confirmed again (which also brings a
  // deleted one back). A 404 or 410 on that change means it is gone for good.
  //
  // A conference asked for (C7, #1375) is made inside the same call (conferenceDataVersion=1 and a createRequest of the type hangoutsMeet, whose requestId is
  // the event's id, so asking again for the same event never makes a second Meet). The answer's join link is the result's `meetUrl`; a request Google has
  // not finished is looked at again a couple of times. A 400 on the insert means Google would not make a conference (an account that cannot host Meet): the
  // event is then written without one and `meetUrl` is null, so the booking carries on with its fixed link.
  async writeEvent(secret: string, event: CalendarEventWrite): Promise<CalendarWriteResult> {
    const s = googleCalendarSecretOf(secret);
    if (!s) return { refused: 'NO_ACCESS_TOKEN' };
    // private and opaque: people the member shares their calendar with see a busy block, never the visitor's name.
    const plain = { summary: event.summary, visibility: 'private', transparency: 'opaque', start: { dateTime: event.startsAt, timeZone: 'UTC' }, end: { dateTime: event.endsAt, timeZone: 'UTC' } };
    const conference = event.conference === true;
    const body = conference ? { ...plain, conferenceData: { createRequest: { requestId: event.externalId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : plain;
    const query = conference ? '?conferenceDataVersion=1' : '';
    const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
    const itemUrl = `${base}/${encodeURIComponent(event.externalId)}`;
    const result = async (answer: Record<string, unknown>): Promise<CalendarWriteResult> => {
      if (!conference) return { ok: true };
      let seen = meetOf(answer);
      for (let look = 0; seen.pending && look < MEET_LOOKS; look++) {
        await this.sleep(MEET_LOOK_MS);
        try {
          seen = meetOf(await this.call('GET', `${itemUrl}?conferenceDataVersion=1`, s.accessToken));
        } catch {
          break;
        }
      }
      return { ok: true, meetUrl: seen.url };
    };
    try {
      return await result(await this.call('POST', `${base}${query}`, s.accessToken, { id: event.externalId, ...body }));
    } catch (error) {
      if (!(error instanceof GoogleCalendarError)) return this.writeFailure(error);
      if (error.status === 400 && conference) {
        const written = await this.writeEvent(secret, { ...event, conference: false });
        return 'ok' in written ? { ok: true, meetUrl: null } : written;
      }
      if (error.status !== 409) return this.writeFailure(error);
    }
    try {
      return await result(await this.call('PATCH', `${itemUrl}${query}`, s.accessToken, { ...body, status: 'confirmed' }));
    } catch (error) {
      if (error instanceof GoogleCalendarError && (error.status === 404 || error.status === 410)) return { gone: true };
      return this.writeFailure(error);
    }
  }

  // DELETE the event; one that is not there already is as good.
  async removeEvent(secret: string, externalId: string): Promise<CalendarWriteResult> {
    const s = googleCalendarSecretOf(secret);
    if (!s) return { refused: 'NO_ACCESS_TOKEN' };
    try {
      await this.call('DELETE', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(externalId)}`, s.accessToken);
      return { ok: true };
    } catch (error) {
      if (error instanceof GoogleCalendarError && (error.status === 404 || error.status === 410)) return { gone: true };
      return this.writeFailure(error);
    }
  }

  // https://oauth2.googleapis.com/revoke with the refresh token ends the whole grant (and its access tokens); with only
  // an access token it would end just that one. Google answers 200 when it did, 400 invalid_token for a token it does not
  // know (already revoked, or the member removed the app in their account): both mean the grant is gone.
  async revoke(secret: string): Promise<{ revoked: true } | { revoked: false; reason: string } | { failed: string }> {
    const s = googleCalendarSecretOf(secret);
    if (!s) return { revoked: false, reason: 'no_token' };
    try {
      const response = await this.fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ token: s.refreshToken }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return { revoked: true };
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.status === 400 && body?.error === 'invalid_token') return { revoked: true };
      return { failed: typeof body?.error === 'string' ? body.error : String(response.status) };
    } catch {
      return { failed: 'NETWORK' };
    }
  }

  async busy(secret: string, from: Date, to: Date, timeoutMs?: number): Promise<CalendarBusyResult> {
    const s = googleCalendarSecretOf(secret);
    if (!s) return { refused: 'NO_ACCESS_TOKEN' };
    let body: Record<string, unknown>;
    try {
      body = await this.call('POST', 'https://www.googleapis.com/calendar/v3/freeBusy', s.accessToken, {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: 'primary' }],
      }, timeoutMs);
    } catch (error) {
      if (error instanceof GoogleCalendarError) return error.status === 401 ? { refused: 'invalid_token' } : { failed: error.reason ?? String(error.status) };
      return { failed: 'NETWORK' };
    }
    const primary = (body.calendars as Record<string, { busy?: unknown; errors?: unknown }> | undefined)?.primary;
    if (!primary || (Array.isArray(primary.errors) && primary.errors.length > 0) || !Array.isArray(primary.busy)) return { failed: 'NO_FREEBUSY' };
    const busy: BusyInterval[] = [];
    for (const b of primary.busy as Array<{ start?: unknown; end?: unknown }>) {
      if (typeof b?.start !== 'string' || typeof b.end !== 'string') continue;
      const start = Date.parse(b.start);
      const end = Date.parse(b.end);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) busy.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    }
    return { busy };
  }
}

function connectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof GoogleCalendarError) {
    if (codeStep && error.reason === 'invalid_grant') return new ConnectorError('invalid_grant', 'Google refused the authorization code', error.reason);
    return new ConnectorError(error.status === 403 || error.status === 429 ? 'denied' : 'provider', error.message, error.reason ?? String(error.status));
  }
  return new ConnectorError('provider', `Google could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}
