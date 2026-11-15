// SPDX-License-Identifier: AGPL-3.0-only
// The Microsoft Outlook calendar adapter against recorded-shape answers (Microsoft identity platform and Graph; no live call): the connect dialog, the token exchange and its refusals (the
// admin-consent one in particular), the rotating refresh token, the busy times, the events the app keeps (no description, attachment or invitee address), and what the adapter never asks for.
import { describe, expect, it } from 'vitest';
import { ConnectorError, MICROSOFT_CALENDAR_READ_SCOPE, MicrosoftCalendarAdapter, agendaEventOfGraph, aadstsOf, grantedScopesOf, idTokenClaims, microsoftCalendarSecretOf, needsAdminConsent, type Fetch } from '../src/index.ts';

const APP = { clientId: '00000000-0000-4000-8000-000000000001', clientSecret: 'test-microsoft-secret-not-real' };
const SECRET = JSON.stringify({ accessToken: 'eyJ.access-1', refreshToken: 'M.refresh-1' });
const REDIRECT = 'https://ludy.example/calendar/oauth/microsoft_calendar/callback';
const NOW = new Date('2026-11-14T03:00:00Z');

const idToken = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

interface Call {
  route: string;
  url: URL;
  auth: string | null;
  prefer: string | null;
  form: Record<string, string> | null;
}
function microsoft(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    calls.push({ route, url, auth: headers.get('authorization'), prefer: headers.get('prefer'), form: typeof raw === 'string' ? Object.fromEntries(new URLSearchParams(raw)) : null });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { code: 'NoAnswer', message: `no answer for ${route}` } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const TOKEN = 'POST login.microsoftonline.com/common/oauth2/v2.0/token';
const VIEW = 'GET graph.microsoft.com/v1.0/me/calendarView';
const goodToken = (extra: Record<string, unknown> = {}) => ({
  body: {
    access_token: 'eyJ.access-2',
    refresh_token: 'M.refresh-2',
    expires_in: 3599,
    scope: `openid profile email ${MICROSOFT_CALENDAR_READ_SCOPE}`,
    id_token: idToken({ aud: APP.clientId, email: 'Lan.Nguyen@Congty.example', name: 'Nguyễn Lan' }),
    ...extra,
  },
});

describe('MicrosoftCalendarAdapter, the connect dialog', () => {
  it('asks for the one calendar permission, offline access and the account, with PKCE, on the configured tenant', () => {
    const url = new URL(new MicrosoftCalendarAdapter(APP).authorizeUrl({ state: 'st', redirectUri: REDIRECT, codeChallenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'profile', 'email', 'offline_access', MICROSOFT_CALENDAR_READ_SCOPE]);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('response_mode')).toBe('query');
    // No write or broader permission is ever named, whatever the caller asks for.
    const more = new URL(new MicrosoftCalendarAdapter(APP).authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: 'c', writeBack: true, readEvents: true }));
    expect(more.searchParams.get('scope')).toBe(url.searchParams.get('scope'));
    expect(url.searchParams.get('scope')).not.toMatch(/ReadWrite|Read\.All|Read\.Shared|Mail|Files/);
  });

  it('uses the tenant it is given, and refuses one that is not a tenant', () => {
    const pinned = new URL(new MicrosoftCalendarAdapter({ ...APP, tenant: 'contoso.example' }).authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: 'c' }));
    expect(pinned.pathname).toBe('/contoso.example/oauth2/v2.0/authorize');
    expect(new MicrosoftCalendarAdapter({ ...APP, tenant: 'organizations' })).toBeTruthy();
    for (const bad of ['../evil', 'a/b', 'x y', 'https://evil.example', 'common?x=1']) expect(() => new MicrosoftCalendarAdapter({ ...APP, tenant: bad })).toThrow(/tenant/);
    expect(() => new MicrosoftCalendarAdapter({ ...APP, clientId: '' })).toThrow();
    expect(() => new MicrosoftCalendarAdapter({ ...APP, clientSecret: '' })).toThrow();
  });
});

describe('MicrosoftCalendarAdapter, the token exchange', () => {
  it('trades the code for the tokens and the account, and keeps the short names of the granted permissions', async () => {
    const { calls, fetchImpl } = microsoft({ [TOKEN]: [goodToken()] });
    const account = await new MicrosoftCalendarAdapter(APP, fetchImpl).exchange({ code: 'the-code', redirectUri: REDIRECT, codeVerifier: 'ver' }, NOW.getTime());
    expect(account.externalAccount).toBe('lan.nguyen@congty.example');
    expect(account.displayName).toBe('Nguyễn Lan');
    expect(account.scopes).toEqual(['openid', 'profile', 'email', MICROSOFT_CALENDAR_READ_SCOPE]);
    expect(account.expiresAt?.toISOString()).toBe('2026-11-14T03:59:59.000Z');
    expect(microsoftCalendarSecretOf(account.secret)).toEqual({ accessToken: 'eyJ.access-2', refreshToken: 'M.refresh-2' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.form).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', code_verifier: 'ver', redirect_uri: REDIRECT, client_id: APP.clientId, client_secret: APP.clientSecret });
    // The token never leaves in a URL.
    expect(calls[0]?.url.search).toBe('');
  });

  it('reads Graph permissions written with their full address as the short names', () => {
    expect(grantedScopesOf(`openid https://graph.microsoft.com/calendars.readbasic email`)).toEqual(['openid', MICROSOFT_CALENDAR_READ_SCOPE, 'email']);
    expect(grantedScopesOf(undefined)).toEqual([]);
  });

  it('refuses a grant without the calendar permission, without an address and without a refresh token', async () => {
    const run = (answer: ReturnType<typeof goodToken>) => new MicrosoftCalendarAdapter(APP, microsoft({ [TOKEN]: [answer] }).fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: 'v' });
    await expect(run(goodToken({ scope: 'openid profile email' }))).rejects.toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
    await expect(run(goodToken({ id_token: idToken({ aud: APP.clientId, name: 'Không email' }) }))).rejects.toMatchObject({ kind: 'denied', code: 'NO_EMAIL' });
    // An ID token for another app is not read.
    await expect(run(goodToken({ id_token: idToken({ aud: 'someone-else', email: 'a@b.example' }) }))).rejects.toMatchObject({ code: 'NO_EMAIL' });
    await expect(run(goodToken({ refresh_token: undefined }))).rejects.toBeInstanceOf(ConnectorError);
  });

  it('says a tenant that needs its administrator needs it, and never takes a plain denial for it', async () => {
    const admin = async (body: Record<string, unknown>) =>
      new MicrosoftCalendarAdapter(APP, microsoft({ [TOKEN]: [{ status: 400, body }] }).fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: 'v' }).then(() => null, (e: unknown) => e as ConnectorError);
    expect(await admin({ error: 'consent_required', error_description: 'AADSTS65001: The user or administrator has not consented to use the application.\r\nTrace ID: 1\r\nCorrelation ID: 2', error_codes: [65001] })).toMatchObject({ kind: 'denied', code: 'ADMIN_CONSENT_REQUIRED' });
    expect(await admin({ error: 'invalid_grant', error_description: 'AADSTS90094: The grant requires admin permission.', error_codes: [90094] })).toMatchObject({ code: 'ADMIN_CONSENT_REQUIRED' });
    expect(await admin({ error: 'access_denied', error_description: 'AADSTS90095: Admin approval is required.', error_codes: [90095] })).toMatchObject({ code: 'ADMIN_CONSENT_REQUIRED' });
    // A code that was already used is the member's to start over, not an administrator's.
    expect(await admin({ error: 'invalid_grant', error_description: 'AADSTS70008: The provided authorization code has expired.', error_codes: [70008] })).toMatchObject({ kind: 'invalid_grant' });
    expect((await admin({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.', error_codes: [7000215] }))?.kind).toBe('provider');
  });

  it('puts no token, code or trace identifier in an error', async () => {
    const error = (await new MicrosoftCalendarAdapter(APP, microsoft({ [TOKEN]: [{ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70008: expired.\r\nTrace ID: 11111111-2222\r\nCorrelation ID: 33333333', error_codes: [70008] } }] }).fetchImpl)
      .exchange({ code: 'SECRET-CODE', redirectUri: REDIRECT, codeVerifier: 'SECRET-VERIFIER' })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toMatch(/SECRET|Trace ID|Correlation/);
  });
});

describe('the ID token and the AADSTS codes', () => {
  it('reads an address from email or the sign-in name, only for this app', () => {
    expect(idTokenClaims(idToken({ aud: APP.clientId, preferred_username: 'Boss@Cty.example', name: 'Sếp' }), APP.clientId)).toEqual({ email: 'boss@cty.example', name: 'Sếp' });
    expect(idTokenClaims(idToken({ aud: APP.clientId, preferred_username: 'not-an-address' }), APP.clientId)).toBeNull();
    expect(idTokenClaims(idToken({ aud: 'other', email: 'a@b.example' }), APP.clientId)).toBeNull();
    expect(idTokenClaims('not.a-jwt', APP.clientId)).toBeNull();
    expect(idTokenClaims(undefined, APP.clientId)).toBeNull();
  });

  it('finds the AADSTS numbers and the admin-consent ones', () => {
    expect(aadstsOf('AADSTS65001: x AADSTS90094: y')).toEqual([65001, 90094]);
    expect(aadstsOf(7)).toEqual([]);
    expect(needsAdminConsent({ reason: 'consent_required', codes: [] })).toBe(true);
    expect(needsAdminConsent({ reason: 'invalid_grant', codes: [90094] })).toBe(true);
    expect(needsAdminConsent({ reason: 'access_denied', codes: [90095] })).toBe(true);
    expect(needsAdminConsent({ reason: 'access_denied', codes: [65004] })).toBe(false);
  });
});

describe('MicrosoftCalendarAdapter, the refresh', () => {
  it('stores the new refresh token of a rotating answer, and keeps the old one when none comes', async () => {
    const { calls, fetchImpl } = microsoft({ [TOKEN]: [{ body: { access_token: 'eyJ.access-3', refresh_token: 'M.refresh-3', expires_in: 3600 } }, { body: { access_token: 'eyJ.access-4', expires_in: 3600 } }] });
    const adapter = new MicrosoftCalendarAdapter(APP, fetchImpl);
    const first = await adapter.refresh(SECRET);
    expect('secret' in first && microsoftCalendarSecretOf(first.secret)).toEqual({ accessToken: 'eyJ.access-3', refreshToken: 'M.refresh-3' });
    const second = await adapter.refresh(SECRET);
    expect('secret' in second && microsoftCalendarSecretOf(second.secret)).toEqual({ accessToken: 'eyJ.access-4', refreshToken: 'M.refresh-1' });
    expect(calls[0]?.form).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'M.refresh-1' });
  });

  it('refuses for a grant that is gone or that now needs something only a new connect gives, and fails softly for the rest', async () => {
    const run = async (status: number, body: unknown) => new MicrosoftCalendarAdapter(APP, microsoft({ [TOKEN]: [{ status, body }] }).fetchImpl).refresh(SECRET);
    expect(await run(400, { error: 'invalid_grant', error_codes: [700082] })).toEqual({ refused: 'invalid_grant' });
    expect(await run(400, { error: 'interaction_required', error_codes: [50076] })).toEqual({ refused: 'interaction_required' });
    expect(await run(400, { error: 'consent_required', error_codes: [65001] })).toEqual({ refused: 'consent_required' });
    expect(await run(503, { error: 'temporarily_unavailable' })).toEqual({ failed: 'temporarily_unavailable' });
    expect(await new MicrosoftCalendarAdapter(APP).refresh('not json')).toEqual({ refused: 'NO_REFRESH_TOKEN' });
  });
});

const graphEvent = (over: Record<string, unknown> = {}) => ({
  id: 'AAMkAGI2',
  subject: 'Họp giao ban',
  start: { dateTime: '2026-11-14T04:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-14T05:00:00.0000000', timeZone: 'UTC' },
  isAllDay: false,
  isCancelled: false,
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d' },
  responseStatus: { response: 'accepted' },
  attendees: [{ emailAddress: { address: 'khach@congty.example', name: 'Khách' } }, { emailAddress: { address: 'dong.nghiep@congty.example' } }],
  ...over,
});

describe('MicrosoftCalendarAdapter, events', () => {
  it('asks Graph for the calendar view in UTC with the narrow field list and reads the events as the app keeps them', async () => {
    const { calls, fetchImpl } = microsoft({ [VIEW]: [{ body: { value: [graphEvent()] } }] });
    const answer = await new MicrosoftCalendarAdapter(APP, fetchImpl).events(SECRET, new Date('2026-11-13T03:00:00Z'), new Date('2026-11-21T03:00:00Z'));
    expect(answer).toEqual({
      events: [{ id: 'AAMkAGI2', title: 'Họp giao ban', startsAt: '2026-11-14T04:00:00.000Z', endsAt: '2026-11-14T05:00:00.000Z', timeZone: 'UTC', joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d', invitees: 2 }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBe('Bearer eyJ.access-1');
    expect(calls[0]?.prefer).toContain('outlook.timezone="UTC"');
    const select = calls[0]?.url.searchParams.get('$select') ?? '';
    // No body, location, organizer, attachment or extended property is asked for.
    expect(select.split(',').sort()).toEqual(['attendees', 'end', 'id', 'isAllDay', 'isCancelled', 'onlineMeeting', 'responseStatus', 'start', 'subject']);
    expect(select).not.toMatch(/body|location|organizer|attachments|extensions|bodyPreview/);
    expect(calls[0]?.url.searchParams.get('startDateTime')).toBe('2026-11-13T03:00:00.000Z');
    expect(calls[0]?.url.searchParams.get('endDateTime')).toBe('2026-11-21T03:00:00.000Z');
    // The token is in the header, never the address.
    expect(calls[0]?.url.href).not.toContain('eyJ.access-1');
  });

  it('puts no \'@\' anywhere in what the adapter returns but the join address, whatever the answer holds', async () => {
    const { fetchImpl } = microsoft({ [VIEW]: [{ body: { value: [graphEvent({ subject: 'Họp giao ban', organizer: { emailAddress: { address: 'chu.tri@congty.example' } }, attendees: [{ emailAddress: { address: 'a@x.example' } }, { emailAddress: { address: 'b@y.example' } }, { emailAddress: { address: 'c@z.example' } }] })] } }] });
    const answer = await new MicrosoftCalendarAdapter(APP, fetchImpl).events(SECRET, new Date('2026-11-13T03:00:00Z'), new Date('2026-11-21T03:00:00Z'));
    expect('events' in answer && answer.events).toHaveLength(1);
    const events = ('events' in answer ? answer.events : []).map((e) => ({ ...e, joinUrl: null }));
    expect(JSON.stringify(events)).not.toContain('@');
    expect('events' in answer && answer.events[0]?.invitees).toBe(3);
  });

  it('keeps no invitee address, description or attachment in what it returns', async () => {
    const event = graphEvent({ body: { content: 'PRIVATE DESCRIPTION', contentType: 'text' }, bodyPreview: 'PRIVATE', hasAttachments: true, attachments: [{ name: 'secret.pdf' }], location: { displayName: 'Phòng họp kín' } });
    const kept = JSON.stringify(agendaEventOfGraph(event));
    expect(kept).not.toMatch(/PRIVATE|secret\.pdf|khach@|dong\.nghiep@|congty\.example|kín/);
    expect(Object.keys(agendaEventOfGraph(event) ?? {}).sort()).toEqual(['endsAt', 'id', 'invitees', 'joinUrl', 'startsAt', 'timeZone', 'title']);
  });

  it('drops all-day, cancelled and declined events and ones without a usable time, and a join address that is not Teams, Zoom or Meet', () => {
    expect(agendaEventOfGraph(graphEvent({ isAllDay: true }))).toBeNull();
    expect(agendaEventOfGraph(graphEvent({ isCancelled: true }))).toBeNull();
    expect(agendaEventOfGraph(graphEvent({ responseStatus: { response: 'declined' } }))).toBeNull();
    expect(agendaEventOfGraph(graphEvent({ start: { dateTime: 'not a time' } }))).toBeNull();
    expect(agendaEventOfGraph(graphEvent({ end: { dateTime: '2026-11-14T03:00:00.0000000' } }))).toBeNull();
    expect(agendaEventOfGraph(graphEvent({ id: '' }))).toBeNull();
    expect(agendaEventOfGraph(graphEvent({ onlineMeeting: { joinUrl: 'https://evil.example/teams.microsoft.com' } }))?.joinUrl).toBeNull();
    expect(agendaEventOfGraph(graphEvent({ onlineMeeting: null }))?.joinUrl).toBeNull();
    expect(agendaEventOfGraph(graphEvent({ attendees: undefined }))?.invitees).toBe(0);
    // A title the database can hold.
    expect(agendaEventOfGraph(graphEvent({ subject: `a\u0000${'x'.repeat(300)}` }))?.title).toHaveLength(200);
  });

  it('reads a time with no offset as UTC, and one with an offset as written', () => {
    expect(agendaEventOfGraph(graphEvent({ start: { dateTime: '2026-11-14T09:00:00.0000000' }, end: { dateTime: '2026-11-14T10:00:00.0000000' } }))?.startsAt).toBe('2026-11-14T09:00:00.000Z');
    expect(agendaEventOfGraph(graphEvent({ start: { dateTime: '2026-11-14T09:00:00+07:00' }, end: { dateTime: '2026-11-14T10:00:00+07:00' } }))?.startsAt).toBe('2026-11-14T02:00:00.000Z');
  });

  it('follows Graph\'s own next link for a second page and stops at two pages and at 300 events, and never follows another host', async () => {
    const many = (n: number, from: number) => Array.from({ length: n }, (_, i) => graphEvent({ id: `e${from + i}` }));
    const next = 'https://graph.microsoft.com/v1.0/me/calendarView?%24skiptoken=abc';
    const { calls, fetchImpl } = microsoft({ [VIEW]: [{ body: { value: many(250, 0), '@odata.nextLink': next } }, { body: { value: many(250, 250), '@odata.nextLink': next } }, { body: { value: [] } }] });
    const answer = await new MicrosoftCalendarAdapter(APP, fetchImpl).events(SECRET, new Date(), new Date());
    expect('events' in answer && answer.events).toHaveLength(300);
    expect(calls).toHaveLength(2);
    const evil = microsoft({ [VIEW]: [{ body: { value: many(2, 0), '@odata.nextLink': 'https://evil.example/steal?x=1' } }] });
    const kept = await new MicrosoftCalendarAdapter(APP, evil.fetchImpl).events(SECRET, new Date(), new Date());
    expect('events' in kept && kept.events).toHaveLength(2);
    expect(evil.calls).toHaveLength(1);
  });

  it('answers in the words the worker acts on: refused for a dead token, scope for a missing permission, failed for the rest', async () => {
    const run = async (status: number, body: unknown) => new MicrosoftCalendarAdapter(APP, microsoft({ [VIEW]: [{ status, body }] }).fetchImpl).events(SECRET, new Date(), new Date());
    expect(await run(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } })).toEqual({ refused: 'invalid_token' });
    expect(await run(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } })).toEqual({ scope: true });
    expect(await run(429, { error: { code: 'TooManyRequests', message: 'x' } })).toEqual({ failed: 'TooManyRequests' });
    expect(await run(404, { error: { code: 'MailboxNotEnabledForRESTAPI', message: 'x' } })).toEqual({ failed: 'MailboxNotEnabledForRESTAPI' });
    expect(await new MicrosoftCalendarAdapter(APP).events('not json', new Date(), new Date())).toEqual({ refused: 'NO_ACCESS_TOKEN' });
    const net: Fetch = async () => {
      throw new Error('connection reset');
    };
    expect(await new MicrosoftCalendarAdapter(APP, net).events(SECRET, new Date(), new Date())).toEqual({ failed: 'NETWORK' });
  });

  it('names its two hosts and no other', async () => {
    const adapter = new MicrosoftCalendarAdapter(APP, microsoft({}).fetchImpl);
    expect(adapter.authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: 'c' })).toMatch(/^https:\/\/login\.microsoftonline\.com\//);
    // A fetch to any other host is refused before it is made.
    const stray = new MicrosoftCalendarAdapter(APP, async () => new Response('{}'));
    const guarded = (stray as unknown as { fetch: Fetch }).fetch;
    await expect(guarded('https://evil.example/x')).rejects.toThrow(/host not allowed/);
    await expect(guarded('http://graph.microsoft.com/v1.0/me')).rejects.toThrow(/host not allowed/);
  });
});

describe('MicrosoftCalendarAdapter, busy times', () => {
  it('reads start, end and the availability flag only, and keeps the busy, tentative and out-of-office ones', async () => {
    const { calls, fetchImpl } = microsoft({
      [VIEW]: [
        {
          body: {
            value: [
              { start: { dateTime: '2026-11-14T04:00:00.0000000' }, end: { dateTime: '2026-11-14T05:00:00.0000000' }, showAs: 'busy', isCancelled: false },
              { start: { dateTime: '2026-11-14T06:00:00.0000000' }, end: { dateTime: '2026-11-14T07:00:00.0000000' }, showAs: 'free', isCancelled: false },
              { start: { dateTime: '2026-11-14T08:00:00.0000000' }, end: { dateTime: '2026-11-14T09:00:00.0000000' }, showAs: 'tentative', isCancelled: false },
              { start: { dateTime: '2026-11-14T10:00:00.0000000' }, end: { dateTime: '2026-11-14T11:00:00.0000000' }, showAs: 'oof', isCancelled: false },
              { start: { dateTime: '2026-11-14T12:00:00.0000000' }, end: { dateTime: '2026-11-14T13:00:00.0000000' }, showAs: 'workingElsewhere', isCancelled: false },
              { start: { dateTime: '2026-11-14T14:00:00.0000000' }, end: { dateTime: '2026-11-14T15:00:00.0000000' }, showAs: 'busy', isCancelled: true },
              { start: { dateTime: 'bad' }, end: { dateTime: '2026-11-14T15:00:00.0000000' }, showAs: 'busy' },
            ],
          },
        },
      ],
    });
    const answer = await new MicrosoftCalendarAdapter(APP, fetchImpl).busy(SECRET, new Date('2026-11-14T00:00:00Z'), new Date('2026-11-15T00:00:00Z'));
    expect(answer).toEqual({
      busy: [
        { start: '2026-11-14T04:00:00.000Z', end: '2026-11-14T05:00:00.000Z' },
        { start: '2026-11-14T08:00:00.000Z', end: '2026-11-14T09:00:00.000Z' },
        { start: '2026-11-14T10:00:00.000Z', end: '2026-11-14T11:00:00.000Z' },
      ],
    });
    // The busy read never asks for a title, an attendee or a join address.
    expect((calls[0]?.url.searchParams.get('$select') ?? '').split(',').sort()).toEqual(['end', 'isCancelled', 'showAs', 'start']);
    expect(calls[0]?.url.search).not.toMatch(/subject|attendees|onlineMeeting|body|organizer/);
  });

  it('fails, rather than answer a shorter list, when the calendar holds more events than the pages do', async () => {
    const page = { value: [{ start: { dateTime: '2026-11-14T04:00:00.0000000' }, end: { dateTime: '2026-11-14T05:00:00.0000000' }, showAs: 'busy' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?%24skiptoken=abc' };
    const { calls, fetchImpl } = microsoft({ [VIEW]: Array.from({ length: 13 }, () => ({ body: page })) });
    expect(await new MicrosoftCalendarAdapter(APP, fetchImpl).busy(SECRET, new Date(), new Date())).toEqual({ failed: 'TOO_MANY_EVENTS' });
    expect(calls).toHaveLength(12);
    // The last page ends the list: nothing is missing.
    const done = microsoft({ [VIEW]: [...Array.from({ length: 11 }, () => ({ body: page })), { body: { value: [] } }] });
    expect('busy' in (await new MicrosoftCalendarAdapter(APP, done.fetchImpl).busy(SECRET, new Date(), new Date()))).toBe(true);
  });

  it('answers refused for a dead token and failed for the rest', async () => {
    const run = async (status: number, body: unknown) => new MicrosoftCalendarAdapter(APP, microsoft({ [VIEW]: [{ status, body }] }).fetchImpl).busy(SECRET, new Date(), new Date());
    expect(await run(401, { error: { code: 'InvalidAuthenticationToken' } })).toEqual({ refused: 'invalid_token' });
    expect(await run(503, { error: { code: 'ServiceNotAvailable' } })).toEqual({ failed: 'ServiceNotAvailable' });
    expect(await new MicrosoftCalendarAdapter(APP).busy('not json', new Date(), new Date())).toEqual({ refused: 'NO_ACCESS_TOKEN' });
  });
});

describe('MicrosoftCalendarAdapter, what it does not do', () => {
  it('says plainly that no grant was revoked at Microsoft, and writes no event', async () => {
    const adapter = new MicrosoftCalendarAdapter(APP);
    expect(await adapter.revoke(SECRET)).toEqual({ revoked: false, reason: 'no_provider_revoke' });
    expect(await adapter.revoke('not json')).toEqual({ revoked: false, reason: 'no_token' });
    expect(await adapter.writeEvent()).toEqual({ failed: 'UNSUPPORTED' });
    expect(await adapter.removeEvent()).toEqual({ failed: 'UNSUPPORTED' });
  });
});
