// SPDX-License-Identifier: AGPL-3.0-only
// The connect step of the Google Meet adapter (meetings integrations C2, #3174, PR C): the authorize address, the code exchange, and the registry key. No Google call is ever made: a fake fetch answers the
// token and the userinfo address in the shapes of Google's OAuth 2.0 web server flow and OpenID userinfo, and records anything Google would refuse (another host, a wrong method, a missing bearer token).
import { afterEach, describe, expect, it } from 'vitest';
import {
  GOOGLE_MEET_AUTH_SCOPES,
  GOOGLE_MEET_OAUTH_HOSTS,
  GOOGLE_MEET_SPACE_READ_SCOPE,
  GoogleCalendarAdapter,
  GoogleMeetAdapter,
  MeetingPlatformError,
  hasOAuth,
  meetingPlatformAdapters,
} from '../src/index.ts';

const APP = { clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com', clientSecret: 'meet-client-secret-not-real-0001' };
const REDIRECT = 'https://app.example.test/meetings/oauth/google_meet/callback';
const CODE = 'google-auth-code-not-real-0001';
const VERIFIER = 'v'.repeat(64);
const ACCESS = 'meet-access-token-not-real-0002';
const REFRESH = 'meet-refresh-token-not-real-0002';
const NOW = new Date('2026-11-19T03:00:00Z');

const violations: string[] = [];
afterEach(() => {
  const found = violations.splice(0);
  expect(found).toEqual([]);
});

interface Answer {
  status?: number;
  body?: unknown;
}
// A fake Google for the connect step: the token address (POST) and the userinfo address (GET, bearer token), recording each request.
function google(token: Answer, userinfo: Answer = { body: { sub: '110248495921238986420', email: 'Lan@Example.Test', email_verified: true } }) {
  const seen: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    seen.push({ url, init });
    const reply = (answer: Answer) => new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      if (init?.method !== 'POST') violations.push(`token method ${init?.method}`);
      return reply(token);
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/oauth2/v3/userinfo') {
      if ((init?.headers as Record<string, string> | undefined)?.authorization !== `Bearer ${ACCESS}`) violations.push('userinfo without the bearer token');
      return reply(userinfo);
    }
    violations.push(`unexpected ${url.hostname}${url.pathname}`);
    return new Response('{}', { status: 500 });
  };
  return { fetch, seen };
}
const GRANT = { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: `openid https://www.googleapis.com/auth/userinfo.email ${GOOGLE_MEET_SPACE_READ_SCOPE}`, token_type: 'Bearer' };
const adapterOver = (fake: ReturnType<typeof google>) =>
  new GoogleMeetAdapter({ app: APP, refresher: { refresh: async () => ({ refused: 'x' }) }, fetch: fake.fetch, now: () => NOW });

const refusal = async (promise: Promise<unknown>): Promise<MeetingPlatformError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MeetingPlatformError);
  return error as MeetingPlatformError;
};

describe('the authorize address', () => {
  const adapter = adapterOver(google({}));
  it('asks for the Meet transcript read and who the account is, and nothing else: no Drive, no calendar', () => {
    const url = new URL(adapter.authorizeUrl({ state: 'state-abc', redirectUri: REDIRECT, codeChallenge: 'challenge-xyz' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(APP.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toBe(`openid email ${GOOGLE_MEET_SPACE_READ_SCOPE}`);
    expect(GOOGLE_MEET_AUTH_SCOPES).toEqual(['openid', 'email', GOOGLE_MEET_SPACE_READ_SCOPE]);
    // The connect step may call only Google's token and profile hosts; the conference reads have a host of their own.
    expect(GOOGLE_MEET_OAUTH_HOSTS).toEqual(['oauth2.googleapis.com', 'www.googleapis.com']);
    // Offline access with consent each time, and none of what the member granted this client before.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The address never carries the client secret.
    expect(url.toString()).not.toContain(APP.clientSecret);
    expect(url.toString()).not.toMatch(/drive|calendar/i);
  });
  it('leaves out the challenge when the attempt has none, and says it is a PKCE connect', () => {
    const url = new URL(adapter.authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null }));
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(adapter.pkce).toBe(true);
    expect(adapter.oauthProvider).toBe('google_recordings');
  });
  it('is refused without a client (an adapter built only for the reads)', () => {
    const noApp = new GoogleMeetAdapter({ refresher: { refresh: async () => ({ refused: 'x' }) } });
    expect(() => noApp.authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null })).toThrow(MeetingPlatformError);
  });
});

describe('the code exchange', () => {
  it('sends the code with the client, the redirect address and the verifier, and returns the account keyed by the subject id with the credential the job opens', async () => {
    const fake = google({ body: GRANT });
    const account = await adapterOver(fake).exchange({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER });
    const token = fake.seen[0];
    expect(token?.url.toString()).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(token?.init?.body));
    expect(Object.fromEntries(form)).toEqual({ client_id: APP.clientId, client_secret: APP.clientSecret, grant_type: 'authorization_code', code: CODE, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    expect(account).toMatchObject({ externalAccount: '110248495921238986420', displayName: 'lan@example.test' });
    expect(account.scopes).toContain(GOOGLE_MEET_SPACE_READ_SCOPE);
    expect(account.expiresAt?.toISOString()).toBe(new Date(NOW.getTime() + 3599_000).toISOString());
    expect(JSON.parse(account.secret)).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: account.expiresAt?.toISOString() });
  });

  it('works without a verifier (an attempt that had none) and takes an hour when Google gives no lifetime', async () => {
    const fake = google({ body: { ...GRANT, expires_in: undefined } });
    const account = await adapterOver(fake).exchange({ code: CODE, redirectUri: REDIRECT, codeVerifier: null });
    expect(new URLSearchParams(String(fake.seen[0]?.init?.body)).has('code_verifier')).toBe(false);
    expect(account.expiresAt?.toISOString()).toBe(new Date(NOW.getTime() + 3600_000).toISOString());
  });

  it('refuses a grant without the Meet transcript permission (the member unticked it) before reading the profile', async () => {
    const fake = google({ body: { ...GRANT, scope: 'openid https://www.googleapis.com/auth/userinfo.email' } });
    const error = await refusal(adapterOver(fake).exchange({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER }));
    expect(error.code).toBe('platform_refused');
    expect(fake.seen).toHaveLength(1);
  });

  it('refuses a grant without a refresh token: the connection would die in an hour', async () => {
    const error = await refusal(adapterOver(google({ body: { ...GRANT, refresh_token: undefined } })).exchange({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER }));
    expect(error.code).toBe('platform_refused');
  });

  it('reads the account again as unavailable when Google answers without an access token', async () => {
    const error = await refusal(adapterOver(google({ body: { ...GRANT, access_token: undefined } })).exchange({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER }));
    expect(error.code).toBe('platform_unavailable');
  });

  it('stores nothing for an account Google gives no verified subject and address for', async () => {
    for (const info of [{ email: 'lan@example.test', email_verified: true }, { sub: '1', email_verified: true }, { sub: '1', email: 'lan@example.test', email_verified: false }]) {
      const error = await refusal(adapterOver(google({ body: GRANT }, { body: info })).exchange({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER }));
      expect(error.code).toBe('platform_refused');
    }
  });

  it('tells a refused code from an unavailable Google, and never puts the code, a token or the secret in the error', async () => {
    const cases: Array<[Answer, string]> = [
      [{ status: 400, body: { error: 'invalid_grant', error_description: `bad code ${CODE}` } }, 'platform_refused'],
      [{ status: 401, body: { error: 'invalid_client' } }, 'platform_refused'],
      [{ status: 429, body: {} }, 'platform_unavailable'],
      [{ status: 503, body: {} }, 'platform_unavailable'],
      [{ status: 200, body: 'not an object' }, 'platform_unavailable'],
    ];
    for (const [answer, code] of cases) {
      const error = await refusal(adapterOver(google(answer)).exchange({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER }));
      expect(error.code).toBe(code);
      for (const secret of [CODE, VERIFIER, ACCESS, REFRESH, APP.clientSecret]) expect(error.message).not.toContain(secret);
    }
    const down = new GoogleMeetAdapter({ app: APP, refresher: { refresh: async () => ({ refused: 'x' }) }, fetch: async () => Promise.reject(new Error(`connect failed for ${CODE}`)) });
    const error = await refusal(down.exchange({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER }));
    expect(error.code).toBe('platform_unavailable');
    expect(error.message).not.toContain(CODE);
  });

  it('refuses the profile when Google will not give it', async () => {
    const error = await refusal(adapterOver(google({ body: GRANT }, { status: 403, body: {} })).exchange({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER }));
    expect(error.code).toBe('platform_refused');
  });
});

describe('the credential renews with the Meet client of its own', () => {
  it('asks Google to renew with the Meet client id and secret, not the calendar one', async () => {
    const seen: URLSearchParams[] = [];
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      expect(new URL(input).hostname).toBe('oauth2.googleapis.com');
      seen.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ access_token: 'renewed-access-token-not-real', expires_in: 3599 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const adapter = new GoogleMeetAdapter({ app: APP, refresher: new GoogleCalendarAdapter(APP, fetch), fetch });
    const renewed = await adapter.refresh({ accessToken: ACCESS, refreshToken: REFRESH });
    expect(renewed).toMatchObject({ accessToken: 'renewed-access-token-not-real', refreshToken: REFRESH });
    expect(Object.fromEntries(seen[0] ?? [])).toMatchObject({ client_id: APP.clientId, client_secret: APP.clientSecret, grant_type: 'refresh_token', refresh_token: REFRESH });
  });
});

describe('the registry key', () => {
  it('has a google_meet adapter with a connect dialog only when the deployment has the client, and none otherwise', () => {
    expect(Object.keys(meetingPlatformAdapters({ sandbox: false }))).toEqual([]);
    const adapters = meetingPlatformAdapters({ sandbox: false, google: APP });
    expect(Object.keys(adapters)).toEqual(['google_meet']);
    const google = adapters.google_meet;
    expect(hasOAuth(google)).toBe(true);
    expect(google?.provider).toBe('google_meet');
  });
});
