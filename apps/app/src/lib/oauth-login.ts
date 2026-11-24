// SPDX-License-Identifier: AGPL-3.0-only
// Signing in through the identity provider's OAuth App (issue #4704, ADR-0028 amendment 2026-11-24). The provider is a Supabase
// Auth project with its OAuth 2.1 server on: the app sends the browser to its authorize endpoint with a PKCE challenge (S256) and
// the client id of the deployment's OAuth App, the provider signs the person in on its own page and sends the browser back to
// this app's redirect URI with a one-time code, and the app redeems the code at the provider's token endpoint (a public
// client: no secret) for an access and a refresh token, which it hands to auth-js like any session.
//
// What is kept where, and for how long (the same rules as lib/hosted-login.ts):
// - The state and the code verifier live in sessionStorage only (this tab, never localStorage, never a cookie, never in a
//   URL), under one key, and are removed the moment the callback is read, before anything is sent: a code is redeemed at
//   most once from this tab, a failure means starting again, and a second tab or a replayed callback finds nothing.
// - A started sign-in is good for 10 minutes; an older one is refused.
// - The callback must carry the state this tab made (exact match) and arrive at the exact redirect URI it was started with.
//   The code is sent only to the token endpoint the kernel configured, with no cookies, no referrer, no redirect followed and
//   no cache.
// - What comes back is not trusted for more than it is: a JSON object with a non-empty access and refresh token, and an
//   access token that names this app's client (its `client_id` claim is read, not verified: the kernel verifies it).
// A session of an OAuth client is refreshed at the token endpoint with the client id (`oauthRefreshFetch`): Supabase Auth
// refuses its plain /token refresh for such a session. Nothing here is logged.
import { pkceChallenge, randomToken, safeReturnPath, type HostedFailure, type HostedStorage } from './hosted-login.ts';

export interface OauthSignInConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  // The words on the button (AUTH_OAUTH_NAME); null: a generic label.
  name: string | null;
}

export const OAUTH_STORAGE_KEY = 'ludy-oauth-login';
export const OAUTH_CALLBACK_PATH = '/oauth-login/callback';
export const OAUTH_SCOPE = 'openid email profile';
export const OAUTH_MAX_AGE_MS = 10 * 60_000;
// What a code may look like on the way back: a one-time token, never more than this and never anything but these characters.
const CODE_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface Pending {
  state: string;
  verifier: string;
  redirectUri: string;
  startedAt: number;
  returnPath: string;
}

export type OauthResult = { ok: true; accessToken: string; refreshToken: string; returnPath: string } | { ok: false; reason: HostedFailure };

export function oauthRedirectUri(origin: string): string {
  return `${origin}${OAUTH_CALLBACK_PATH}`;
}

// Starts a sign-in: keeps what the callback needs, and returns the address of the provider's authorize endpoint.
export async function startOauthLogin(
  config: OauthSignInConfig,
  deps: { origin: string; returnPath: string; storage: HostedStorage; now?: () => number; token?: () => string },
): Promise<string> {
  const token = deps.token ?? randomToken;
  const state = token();
  const verifier = token();
  const redirectUri = oauthRedirectUri(deps.origin);
  const pending: Pending = { state, verifier, redirectUri, startedAt: (deps.now ?? Date.now)(), returnPath: safeReturnPath(deps.returnPath) };
  deps.storage.setItem(OAUTH_STORAGE_KEY, JSON.stringify(pending));
  // Built from the endpoint alone: nothing already in its query can stand in for a parameter set here.
  const target = new URL(config.authorizeUrl);
  target.search = '';
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('client_id', config.clientId);
  target.searchParams.set('redirect_uri', redirectUri);
  target.searchParams.set('scope', OAUTH_SCOPE);
  target.searchParams.set('state', state);
  target.searchParams.set('code_challenge', await pkceChallenge(verifier));
  target.searchParams.set('code_challenge_method', 'S256');
  return target.toString();
}

export interface OauthCallback {
  code: string | null;
  state: string | null;
  denied: boolean;
}

// The callback's parameters, when this address is the sign-in's return; null for every other address. The caller takes them out
// of the address bar before anything else reads it.
export function readOauthCallback(location: Pick<Location, 'pathname' | 'search'>): OauthCallback | null {
  if (location.pathname !== OAUTH_CALLBACK_PATH) return null;
  const params = new URLSearchParams(location.search);
  return { code: params.get('code'), state: params.get('state'), denied: params.has('error') };
}

function readPending(storage: HostedStorage): Pending | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(OAUTH_STORAGE_KEY);
  } catch {
    return null;
  } finally {
    // Gone before it is used: the verifier is never kept past its one callback, whatever happens next.
    try {
      storage.removeItem(OAUTH_STORAGE_KEY);
    } catch {
      // A storage that refuses a removal has refused the write too, so nothing was kept.
    }
  }
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<Pending>;
    if (typeof value.state !== 'string' || typeof value.verifier !== 'string' || typeof value.redirectUri !== 'string' || typeof value.startedAt !== 'number') return null;
    return { state: value.state, verifier: value.verifier, redirectUri: value.redirectUri, startedAt: value.startedAt, returnPath: safeReturnPath(typeof value.returnPath === 'string' ? value.returnPath : '/') };
  } catch {
    return null;
  }
}

// The payload of a JWT, decoded and not verified; null when it is not one.
export function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part || token.split('.').length !== 3) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

const TOKEN_REQUEST = { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

// Reads a token endpoint answer: a JSON object with an access and a refresh token, the access token issued to this client.
async function readTokens(response: Response, clientId: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number | null } | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const { access_token: accessToken, refresh_token: refreshToken, token_type: tokenType, expires_in: expiresIn } = (body ?? {}) as Record<string, unknown>;
  if (typeof accessToken !== 'string' || accessToken === '' || accessToken.length > 8192) return null;
  if (typeof refreshToken !== 'string' || refreshToken === '' || refreshToken.length > 1024) return null;
  if (tokenType !== undefined && (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer')) return null;
  // A token for another client is not this app's sign-in, whatever answered with it.
  const claimed = jwtClaims(accessToken)?.['client_id'];
  if (typeof claimed !== 'string' || claimed.toLowerCase() !== clientId.toLowerCase()) return null;
  return { accessToken, refreshToken, expiresIn: typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null };
}

// Redeems the code the callback brought. Every refusal is one of HostedFailure; none says more to the user than "did not complete".
export async function completeOauthLogin(
  callback: OauthCallback,
  deps: { config: OauthSignInConfig; origin: string; storage: HostedStorage; fetchFn: typeof fetch; now?: () => number },
): Promise<OauthResult> {
  const pending = readPending(deps.storage);
  if (!pending) return { ok: false, reason: 'missing' };
  if ((deps.now ?? Date.now)() - pending.startedAt > OAUTH_MAX_AGE_MS || pending.startedAt > (deps.now ?? Date.now)() + 60_000) return { ok: false, reason: 'expired' };
  if (callback.denied) return { ok: false, reason: 'denied' };
  if (!callback.state || !STATE_PATTERN.test(pending.state) || callback.state !== pending.state) return { ok: false, reason: 'state' };
  if (!callback.code || !CODE_PATTERN.test(callback.code)) return { ok: false, reason: 'code' };
  if (pending.redirectUri !== oauthRedirectUri(deps.origin)) return { ok: false, reason: 'redirect' };
  let tokens: Awaited<ReturnType<typeof readTokens>>;
  try {
    const response = await deps.fetchFn(deps.config.tokenUrl, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ grant_type: 'authorization_code', code: callback.code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, client_id: deps.config.clientId }),
      ...TOKEN_REQUEST,
    });
    if (!response.ok) return { ok: false, reason: 'exchange' };
    tokens = await readTokens(response, deps.config.clientId);
  } catch {
    return { ok: false, reason: 'exchange' };
  }
  if (!tokens) return { ok: false, reason: 'response' };
  return { ok: true, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, returnPath: pending.returnPath };
}

// What auth-js reads of a session's user, from the access token's own claims: the refresh at the OAuth token endpoint answers
// tokens only, and auth-js keeps a user with the session.
function userOf(claims: Record<string, unknown>): Record<string, unknown> {
  const issuedAt = typeof claims['iat'] === 'number' ? new Date(claims['iat'] * 1000).toISOString() : new Date().toISOString();
  return {
    id: claims['sub'],
    aud: claims['aud'],
    role: claims['role'],
    email: claims['email'],
    phone: typeof claims['phone'] === 'string' ? claims['phone'] : '',
    app_metadata: claims['app_metadata'] ?? {},
    user_metadata: claims['user_metadata'] ?? {},
    is_anonymous: false,
    created_at: issuedAt,
  };
}

// A `fetch` for auth-js that sends a refresh to the OAuth token endpoint and answers in the shape of Supabase Auth's own: for a
// session of an OAuth client Supabase Auth refuses `POST {authUrl}/token?grant_type=refresh_token` and wants the client id at
// the token endpoint. Every other request goes through unchanged. A refused refresh is passed on with its status, so auth-js
// ends the session as it does for any refresh token that no longer works; a network failure is thrown, so auth-js retries.
export function oauthRefreshFetch(base: typeof fetch, options: { authUrl: string; config: OauthSignInConfig }): typeof fetch {
  const refreshPath = `${new URL(options.authUrl).pathname.replace(/\/+$/, '')}/token`;
  const origin = new URL(options.authUrl).origin;
  const isRefresh = (url: URL, method: string) => method === 'POST' && url.origin === origin && url.pathname === refreshPath && url.searchParams.get('grant_type') === 'refresh_token';
  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), origin);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (!isRefresh(url, method)) return base(input, init);
    let refreshToken: unknown;
    try {
      const text = typeof init?.body === 'string' ? init.body : request ? await request.clone().text() : '';
      refreshToken = (JSON.parse(text) as { refresh_token?: unknown }).refresh_token;
    } catch {
      refreshToken = undefined;
    }
    if (typeof refreshToken !== 'string' || refreshToken === '') return new Response('{"error":"invalid_request","error_description":"refresh_token is required"}', { status: 400, headers: { 'content-type': 'application/json' } });
    const answer = await base(options.config.tokenUrl, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: options.config.clientId }),
      ...TOKEN_REQUEST,
    });
    if (!answer.ok) return answer;
    const tokens = await readTokens(answer, options.config.clientId);
    const claims = tokens ? jwtClaims(tokens.accessToken) : null;
    if (!tokens || !claims) return new Response('{"error":"server_error","error_description":"unexpected token response"}', { status: 502, headers: { 'content-type': 'application/json' } });
    return new Response(
      JSON.stringify({
        access_token: tokens.accessToken,
        token_type: 'bearer',
        expires_in: tokens.expiresIn ?? Math.max(1, (typeof claims['exp'] === 'number' ? claims['exp'] : 0) - Math.floor(Date.now() / 1000)),
        refresh_token: tokens.refreshToken,
        user: userOf(claims),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}
