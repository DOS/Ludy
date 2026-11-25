// SPDX-License-Identifier: AGPL-3.0-only
// Microsoft Outlook calendar through Microsoft Graph (Meetings B3, issue #3167; #3267), the same shape as the Google adapter: the member connects their own account through the Microsoft identity
// platform (OAuth 2.0 authorization code with PKCE, delegated permissions), the kernel seals the tokens, the worker renews them and reads the member's own primary calendar.
//
// It uses an app registration the operator makes for it: CALENDAR_MICROSOFT_CLIENT_ID and CALENDAR_MICROSOFT_CLIENT_SECRET (and CALENDAR_MICROSOFT_TENANT, `common` when not given).
//
// Permissions. One delegated calendar permission, MICROSOFT_CALENDAR_READ_SCOPE, asked for at the connect, plus openid, profile, email and offline_access (a refresh token and the account's
// address from the ID token). Microsoft has no permission that reads busy times without event details, so the connect carries the title-level grant from the start; what Ludy reads and keeps is
// gated by its own code and the member's switch: the busy read selects start, end and showAs only, and titles, join addresses and invitee counts are fetched only for a connection whose switch
// is on (the caller of `events`). When `onlineMeeting.joinUrl` is missing, `location.displayName` is checked solely in memory for an allowlisted Zoom, Google Meet or Teams https join URL and
// is never kept as text (no room name or street address is kept). No `body`, `bodyPreview`, organizer or attachment is ever asked for, and no raw location text, description, attachment or
// invitee address is ever kept.
//
// Not offered here: writing events (the booking write-back is Google's) and revoking a grant (Microsoft has no token revocation endpoint for this; a disconnect removes the connection and the
// member removes the app's access in their Microsoft account, which the screen says).
import { ConnectorError, allowlistedFetch, type ExchangeInput, type Fetch } from './oauth.ts';
import {
  joinUrlOf,
  seriesOf,
  titleOf,
  type BusyInterval,
  type CalendarAccount,
  type CalendarAdapter,
  type CalendarAgendaEvent,
  type CalendarAuthorizeInput,
  type CalendarBusyResult,
  type CalendarEventsResult,
  type CalendarRefreshResult,
  type CalendarWriteResult,
} from './calendar-google.ts';

export const MICROSOFT_CALENDAR_HOSTS = ['login.microsoftonline.com', 'graph.microsoft.com'] as const;
// The delegated Graph permission that reads the member's own events. To be confirmed against Microsoft's permissions reference before the app is registered (docs/runbooks/calendar-oauth.md):
// it is the narrowest calendar read, and what it returns (subject, times, online meeting) decides whether it is enough.
export const MICROSOFT_CALENDAR_READ_SCOPE = 'Calendars.ReadBasic';
const AUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;
// A tenant segment of the authority: a well-known one, a directory id or a verified domain. Nothing else reaches the URL.
const TENANT = /^(?:common|organizations|consumers|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63})$/;

export interface MicrosoftCalendarAppConfig {
  clientId: string;
  clientSecret: string;
  // The authority's tenant: `common` (work, school and personal accounts) when not given.
  tenant?: string;
}

export interface MicrosoftCalendarSecret {
  accessToken: string;
  refreshToken: string;
}

export function microsoftCalendarSecretOf(secret: string): MicrosoftCalendarSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<MicrosoftCalendarSecret>;
    return typeof s.accessToken === 'string' && s.accessToken && typeof s.refreshToken === 'string' && s.refreshToken ? { accessToken: s.accessToken, refreshToken: s.refreshToken } : null;
  } catch {
    return null;
  }
}

// An answer of Microsoft that was not a success: the HTTP status, the OAuth error (`invalid_grant`, `consent_required`...) or Graph's error code (`InvalidAuthenticationToken`, `ErrorAccessDenied`...),
// and the AADSTS numbers the token endpoint puts in error_codes. Never holds a token.
class MicrosoftCalendarError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  readonly codes: readonly number[];
  constructor(status: number, body: Record<string, unknown> | null) {
    const graph = body?.error !== null && typeof body?.error === 'object' ? (body.error as { code?: unknown }) : null;
    const reason = typeof graph?.code === 'string' ? graph.code : typeof body?.error === 'string' ? body.error : undefined;
    const codes = Array.isArray(body?.error_codes) ? (body.error_codes as unknown[]).filter((c): c is number => typeof c === 'number') : aadstsOf(body?.error_description);
    // The message is the status and the codes, never Microsoft's own words: its descriptions and Graph's messages can carry the member's address (a sign-in name) and identifiers, and this text reaches the server log.
    super(`Microsoft answered ${status}${reason ? ` (${reason.slice(0, 80)}${codes.length > 0 ? `, AADSTS${codes.slice(0, 3).join(', AADSTS')}` : ''})` : ''}`);
    this.name = 'MicrosoftCalendarError';
    this.status = status;
    this.reason = reason;
    this.codes = codes;
  }
}

// The AADSTS numbers a description names.
export function aadstsOf(description: unknown): number[] {
  if (typeof description !== 'string') return [];
  return [...description.matchAll(/AADSTS(\d{3,7})/g)].map((m) => Number(m[1]));
}

// What a tenant that needs its administrator's consent answers: consent_required, or AADSTS65001 (the user or administrator has not consented), AADSTS90094 (the grant requires admin permission) or
// AADSTS90095 (admin approval is required: a tenant with an admin-consent workflow).
export function needsAdminConsent(error: { reason?: string | undefined; codes: readonly number[] }): boolean {
  return error.reason === 'consent_required' || error.codes.includes(65001) || error.codes.includes(90094) || error.codes.includes(90095);
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
}

const expiryOf = (a: TokenAnswer, now = Date.now()) => {
  const seconds = Number(a.expires_in);
  return new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000);
};

// The permissions a token answer lists, as the short names this app uses (Microsoft may write a Graph permission as "https://graph.microsoft.com/Calendars.ReadBasic").
export function grantedScopesOf(scope: unknown): string[] {
  if (typeof scope !== 'string') return [];
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, ''))
    .map((s) => (s.toLowerCase() === MICROSOFT_CALENDAR_READ_SCOPE.toLowerCase() ? MICROSOFT_CALENDAR_READ_SCOPE : s));
}

// What the ID token says of the member: the address and the name. It came straight from the token endpoint over TLS (OpenID Connect lets a client read it without checking the signature then); it
// is accepted only for this app (aud) and only for an address that looks like one.
export function idTokenClaims(idToken: unknown, clientId: string): { email: string; name: string } | null {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (claims.aud !== clientId) return null;
  // The sign-in name first: it is on every account and stays the same, where `email` is optional and an administrator can edit it (a changed address would make a second connection).
  const candidates = [claims.preferred_username, claims.email].filter((c): c is string => typeof c === 'string' && /^[^\s@]+@[^\s@]+$/.test(c.trim()));
  const email = candidates[0]?.trim().toLowerCase();
  if (!email) return null;
  const name = typeof claims.name === 'string' && claims.name.trim() !== '' ? claims.name.trim() : email;
  return { email: email.slice(0, 200), name: name.slice(0, 200) };
}

// The most events one read returns, the pieces it is asked in, and how many pieces at most (a busy calendar's blocks are many more than its meetings).
const EVENTS_MAX = 300;
const PAGE = 250;
const EVENTS_PAGES = 2;
const BUSY_PAGES = 12;
// The fields asked for. The event reads select `location` solely to extract an allowlisted Zoom, Google Meet or Teams join link from `location.displayName` in memory when `onlineMeeting.joinUrl` is absent (raw location text, room names and street addresses are never kept); no `body`, `bodyPreview`, organizer or attachment is ever asked for, and the attendees are asked for only to be counted and are never kept. The busy read selects times and the availability flag alone.
const EVENT_FIELDS = 'id,subject,seriesMasterId,start,end,isAllDay,isCancelled,location,onlineMeeting,responseStatus,attendees';
const BUSY_FIELDS = 'start,end,showAs,isCancelled';

// Trailing punctuation stripped from https:// URL candidates in free-form `location.displayName` text.
const TRAILING_URL_PUNCTUATION = /[>),.;"'\]]+$/;

// Replaces ASCII control characters with spaces so they separate URL tokens cleanly and never enter URL parsing.
function sanitizeLocationText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code <= 0x1f || code === 0x7f ? ' ' : text[i]!;
  }
  return out.trim();
}

// Reads ONLY `location.displayName` in memory and returns the first valid allowlisted https Zoom, Google Meet or Teams join URL, or null; raw location text, street addresses, room names and non-allowlisted hosts are never returned.
export function joinUrlFromLocation(location: unknown): string | null {
  if (location === null || typeof location !== 'object' || Array.isArray(location)) return null;
  const displayName = (location as { displayName?: unknown }).displayName;
  if (typeof displayName !== 'string') return null;
  const clean = sanitizeLocationText(displayName);
  if (clean === '') return null;
  if (!/\s/.test(clean)) {
    const direct = joinUrlOf(clean.replace(TRAILING_URL_PUNCTUATION, ''));
    if (direct !== null && direct.length <= 500) return direct;
  }
  for (const match of clean.matchAll(/https:\/\/\S+/gi)) {
    const candidate = match[0].replace(TRAILING_URL_PUNCTUATION, '');
    const joinUrl = joinUrlOf(candidate);
    if (joinUrl !== null && joinUrl.length <= 500) return joinUrl;
  }
  return null;
}

// Graph writes a time as "2026-11-14T09:00:00.0000000" in the zone asked for (UTC, by the Prefer header), with no offset: read as UTC.
function graphInstant(value: unknown): number {
  if (typeof value !== 'string' || value === '') return Number.NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
}

// One event of the answer as B1 keeps it, or null: an all-day event (no time to match a recording to), a cancelled one, one the member declined, or one without a usable id or time.
export function agendaEventOfGraph(event: Record<string, unknown>): CalendarAgendaEvent | null {
  if (typeof event.id !== 'string' || event.id === '' || event.id.length > 1024 || event.isCancelled === true || event.isAllDay === true) return null;
  const start = event.start as { dateTime?: unknown } | undefined;
  const end = event.end as { dateTime?: unknown } | undefined;
  const startMs = graphInstant(start?.dateTime);
  const endMs = graphInstant(end?.dateTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 31 * 86_400_000) return null;
  const response = (event.responseStatus as { response?: unknown } | undefined)?.response;
  if (response === 'declined') return null;
  const meeting = event.onlineMeeting as { joinUrl?: unknown } | null | undefined;
  const attendees = Array.isArray(event.attendees) ? event.attendees.length : 0;
  return {
    id: event.id,
    title: titleOf(event.subject),
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    // Asked in UTC, so the event's own zone is not known; the field is only a label and the screens show the instant in the member's own zone.
    timeZone: 'UTC',
    joinUrl: joinUrlOf(meeting?.joinUrl) ?? joinUrlFromLocation(event.location),
    invitees: Math.min(attendees, 1000),
    series: seriesOf(event.seriesMasterId),
  };
}

export class MicrosoftCalendarAdapter implements CalendarAdapter {
  readonly provider = 'microsoft' as const;
  readonly oauthProvider = 'microsoft_calendar' as const;
  readonly pkce = true;
  private readonly fetch: Fetch;
  private readonly app: MicrosoftCalendarAppConfig;
  private readonly authority: string;

  constructor(app: MicrosoftCalendarAppConfig, fetchImpl?: Fetch) {
    if (!app.clientId) throw new Error('missing Microsoft client id');
    if (!app.clientSecret) throw new Error('missing Microsoft client secret');
    const tenant = app.tenant && app.tenant !== '' ? app.tenant : 'common';
    if (!TENANT.test(tenant)) throw new Error('the Microsoft tenant is common, organizations, consumers, a directory id or a domain');
    this.app = app;
    this.authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
    this.fetch = allowlistedFetch(MICROSOFT_CALENDAR_HOSTS, fetchImpl);
  }

  authorizeUrl(input: CalendarAuthorizeInput): string {
    const url = new URL(`${this.authority}/authorize`);
    url.searchParams.set('client_id', this.app.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_mode', 'query');
    // The permission is not a second step (Microsoft has no narrower one), so it is asked for at the connect whatever `readEvents` says; what Ludy reads is the member's switch.
    url.searchParams.set('scope', [...AUTH_SCOPES, MICROSOFT_CALENDAR_READ_SCOPE].join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('prompt', 'select_account');
    if (input.codeChallenge) {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  private async token(form: Record<string, string>): Promise<TokenAnswer> {
    const response = await this.fetch(`${this.authority}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...form }).toString(),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) throw new MicrosoftCalendarError(response.status, json);
    return json as TokenAnswer;
  }

  private async get(url: string, token: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const response = await this.fetch(url, {
      method: 'GET',
      // Times in UTC; a page of at most PAGE events.
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', prefer: `outlook.timezone="UTC", odata.maxpagesize=${PAGE}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new MicrosoftCalendarError(response.status, body);
    return body ?? {};
  }

  async exchange(input: ExchangeInput, now = Date.now()): Promise<CalendarAccount> {
    const answer = await this.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      scope: [...AUTH_SCOPES, MICROSOFT_CALENDAR_READ_SCOPE].join(' '),
      ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
    }).catch((error: unknown) => {
      throw connectorError(error, true);
    });
    if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'Microsoft answered without an access token');
    if (typeof answer.refresh_token !== 'string' || !answer.refresh_token) throw new ConnectorError('provider', 'Microsoft answered without a refresh token');
    const granted = grantedScopesOf(answer.scope);
    if (!granted.includes(MICROSOFT_CALENDAR_READ_SCOPE)) throw new ConnectorError('denied', 'Microsoft did not grant the calendar permission this app needs', 'MISSING_PERMISSION');
    const who = idTokenClaims(answer.id_token, this.app.clientId);
    if (!who) throw new ConnectorError('denied', 'Microsoft did not give an email address for this account', 'NO_EMAIL');
    const secret: MicrosoftCalendarSecret = { accessToken: answer.access_token, refreshToken: answer.refresh_token };
    return { externalAccount: who.email, displayName: who.name, scopes: granted.slice(0, 20), expiresAt: expiryOf(answer, now), secret: JSON.stringify(secret) };
  }

  // The refresh token rotates: every answer carries a new one, which replaces the old.
  async refresh(secret: string): Promise<CalendarRefreshResult> {
    const s = microsoftCalendarSecretOf(secret);
    if (!s) return { refused: 'NO_REFRESH_TOKEN' };
    try {
      const answer = await this.token({ grant_type: 'refresh_token', refresh_token: s.refreshToken, scope: [...AUTH_SCOPES, MICROSOFT_CALENDAR_READ_SCOPE].join(' ') });
      if (typeof answer.access_token !== 'string' || !answer.access_token) return { failed: 'NO_ACCESS_TOKEN' };
      const next: MicrosoftCalendarSecret = { accessToken: answer.access_token, refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : s.refreshToken };
      return { secret: JSON.stringify(next), expiresAt: expiryOf(answer) };
    } catch (error) {
      // invalid_grant: revoked, expired (a refresh token unused for 90 days), or the password changed; interaction_required and consent_required: the tenant now asks the member or its administrator for
      // something only a new connect can give.
      if (error instanceof MicrosoftCalendarError && (error.reason === 'invalid_grant' || error.reason === 'interaction_required' || needsAdminConsent(error))) return { refused: error.reason ?? 'invalid_grant' };
      return { failed: error instanceof MicrosoftCalendarError ? (error.reason ?? String(error.status)) : 'NETWORK' };
    }
  }

  // The pages of one calendarView read, following Graph's own next link (checked to be a Graph address) up to `pages`. True when the pages ran out while Graph still had more to give.
  private async view(token: string, from: Date, to: Date, fields: string, pages: number, timeoutMs: number | undefined, each: (item: Record<string, unknown>) => boolean): Promise<boolean> {
    let next: string | null = null;
    for (let page = 0; page < pages; page += 1) {
      let url: string;
      if (next) {
        url = next;
      } else {
        const first = new URL('https://graph.microsoft.com/v1.0/me/calendarView');
        first.searchParams.set('startDateTime', from.toISOString());
        first.searchParams.set('endDateTime', to.toISOString());
        first.searchParams.set('$select', fields);
        first.searchParams.set('$top', String(PAGE));
        first.searchParams.set('$orderby', 'start/dateTime');
        url = first.toString();
      }
      const body = await this.get(url, token, timeoutMs);
      for (const item of Array.isArray(body.value) ? (body.value as unknown[]) : []) {
        if (item !== null && typeof item === 'object' && !each(item as Record<string, unknown>)) return false;
      }
      const link = typeof body['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : null;
      // A next link that is not Graph's own is not followed, and the list is then not whole.
      if (link !== null && !graphLink(link)) return true;
      next = link;
      if (!next) return false;
    }
    return true;
  }

  // The member's own events from `from` to `to`, recurring events unfolded, sorted by start. Two pieces of 250 at most; the list is cut at 300.
  async events(secret: string, from: Date, to: Date, timeoutMs?: number): Promise<CalendarEventsResult> {
    const s = microsoftCalendarSecretOf(secret);
    if (!s) return { refused: 'NO_ACCESS_TOKEN' };
    const events: CalendarAgendaEvent[] = [];
    const seen = new Set<string>();
    try {
      await this.view(s.accessToken, from, to, EVENT_FIELDS, EVENTS_PAGES, timeoutMs, (item) => {
        const event = agendaEventOfGraph(item);
        if (event && !seen.has(event.id)) {
          seen.add(event.id);
          events.push(event);
        }
        return events.length < EVENTS_MAX;
      });
    } catch (error) {
      if (!(error instanceof MicrosoftCalendarError)) return { failed: 'NETWORK' };
      if (error.status === 401) return { refused: 'invalid_token' };
      if (error.status === 403 && (error.reason === 'ErrorAccessDenied' || error.reason === 'Forbidden' || error.reason === 'AccessDenied')) return { scope: true };
      return { failed: error.reason ?? String(error.status) };
    }
    return { events: events.slice(0, EVENTS_MAX) };
  }

  // Busy times: the member's events that are not free (busy, tentative, out of office), with their start and end and nothing else.
  async busy(secret: string, from: Date, to: Date, timeoutMs?: number): Promise<CalendarBusyResult> {
    const s = microsoftCalendarSecretOf(secret);
    if (!s) return { refused: 'NO_ACCESS_TOKEN' };
    const busy: BusyInterval[] = [];
    // One read of [a, b): when the pages run out before the end of the list the range is cut in two and each half is read, down to one day; a day that still does not fit is a failure.
    const collect = async (a: Date, b: Date): Promise<boolean> => {
      const found: BusyInterval[] = [];
      const more = await this.view(s.accessToken, a, b, BUSY_FIELDS, BUSY_PAGES, timeoutMs, (item) => {
        if (item.isCancelled === true) return true;
        const showAs = item.showAs;
        if (showAs !== 'busy' && showAs !== 'tentative' && showAs !== 'oof') return true;
        const start = graphInstant((item.start as { dateTime?: unknown } | undefined)?.dateTime);
        const end = graphInstant((item.end as { dateTime?: unknown } | undefined)?.dateTime);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) found.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
        return true;
      });
      if (!more) {
        busy.push(...found);
        return true;
      }
      if (b.getTime() - a.getTime() <= 86_400_000) return false;
      const middle = new Date(a.getTime() + Math.floor((b.getTime() - a.getTime()) / 2));
      return (await collect(a, middle)) && (await collect(middle, b));
    };
    try {
      // A calendar with more events than the pages hold would leave blocks out, and a missing block lets a booking land on a busy time: that is a failure to try again, never a shorter list.
      if (!(await collect(from, to))) return { failed: 'TOO_MANY_EVENTS' };
    } catch (error) {
      if (error instanceof MicrosoftCalendarError) return error.status === 401 ? { refused: 'invalid_token' } : { failed: error.reason ?? String(error.status) };
      return { failed: 'NETWORK' };
    }
    return { busy };
  }

  // Microsoft's identity platform has no endpoint that ends one app's grant for a member; the connection is removed here and the member removes the app's access in their own Microsoft account
  // (the screen says where). Said as it is, not as a revoke that did not happen.
  async revoke(secret: string): Promise<{ revoked: true } | { revoked: false; reason: string } | { failed: string }> {
    return microsoftCalendarSecretOf(secret) ? { revoked: false, reason: 'no_provider_revoke' } : { revoked: false, reason: 'no_token' };
  }

  // Writing events is Google's (the booking write-back); nothing in the kernel asks a Microsoft connection for it.
  async writeEvent(): Promise<CalendarWriteResult> {
    return { failed: 'UNSUPPORTED' };
  }

  async removeEvent(): Promise<CalendarWriteResult> {
    return { failed: 'UNSUPPORTED' };
  }
}

// A next link Graph gave: https, Graph's own host, no credentials.
function graphLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && url.hostname === 'graph.microsoft.com' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function connectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof MicrosoftCalendarError) {
    // A tenant whose administrator must allow the app first: said plainly by the screen, never retried.
    if (needsAdminConsent(error)) return new ConnectorError('denied', 'The Microsoft tenant needs its administrator to allow this app', 'ADMIN_CONSENT_REQUIRED');
    if (codeStep && error.reason === 'invalid_grant') return new ConnectorError('invalid_grant', 'Microsoft refused the authorization code', error.reason);
    return new ConnectorError(error.status === 403 || error.status === 429 || error.reason === 'access_denied' ? 'denied' : 'provider', error.message, error.reason ?? String(error.status));
  }
  return new ConnectorError('provider', `Microsoft could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}
