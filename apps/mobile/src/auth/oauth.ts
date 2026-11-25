// SPDX-License-Identifier: AGPL-3.0-only
// Signing in with DOS ID, the identity provider's OAuth App (issue #4880, ADR-0028 amendment 2026-11-24, ADR-0059 point 4).
// The same flow as the web app (apps/app/src/lib/oauth-login.ts), for a public client on a phone: OAuth authorization code with
// PKCE (S256) and `state`, opened in the system browser (ASWebAuthenticationSession on iOS, a Custom Tab on Android), never in
// a webview of this app. The app redeems the code at the provider's token endpoint for an access and a refresh token; the kernel
// accepts the access token only when its `client_id` claim is the deployment's AUTH_OAUTH_CLIENT_ID.
//
// What is kept where:
// - The state and the code verifier live in memory only, in one PendingSignIn object that completeSignIn consumes: a callback
//   is read once, a second or replayed callback finds nothing, and nothing of a sign-in survives a restart of the app.
// - A started sign-in is good for 10 minutes. The callback must arrive at the exact redirect URI and carry the state this
//   sign-in made (exact match). The code goes only to the token endpoint of the endpoints it was started with, with no cookies,
//   no cache and no redirect followed.
// - What comes back is not trusted for more than it is: a JSON object with a non-empty access and refresh token, and an access
//   token that names this client. The kernel verifies the token; the app never reads a claim for a decision but `client_id`
//   (is this token for us) and `exp` (when to refresh).
// Nothing here is logged, and no token appears in an error.
import { OAUTH_SCOPE, REDIRECT_URI } from '../config.ts';
import { base64urlDecode, pkceChallenge, randomToken, type CryptoPort } from './pkce.ts';

export interface OauthEndpoints {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
}

export interface PendingSignIn {
  state: string;
  verifier: string;
  startedAt: number;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  // Epoch milliseconds the access token ends, from its `exp` claim (or `expires_in`).
  expiresAt: number;
}

export type SignInFailure = 'missing' | 'expired' | 'denied' | 'state' | 'code' | 'redirect' | 'exchange' | 'response';

export const SIGN_IN_MAX_AGE_MS = 10 * 60_000;
// What a code may look like on the way back: a one-time token, never more than this and never anything but these characters.
const CODE_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Starts a sign-in: the address of the provider's authorize endpoint and the secrets the callback will need (kept by the caller,
// in memory, until completeSignIn). Built from the endpoint alone: nothing already in its query can stand in for a parameter.
export async function startSignIn(endpoints: OauthEndpoints, deps: { crypto: CryptoPort; now: () => number }): Promise<{ url: string; pending: PendingSignIn }> {
  const state = randomToken(deps.crypto);
  const verifier = randomToken(deps.crypto);
  const target = new URL(endpoints.authorizeUrl);
  target.search = '';
  target.hash = '';
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('client_id', endpoints.clientId);
  target.searchParams.set('redirect_uri', REDIRECT_URI);
  target.searchParams.set('scope', OAUTH_SCOPE);
  target.searchParams.set('state', state);
  target.searchParams.set('code_challenge', await pkceChallenge(deps.crypto, verifier));
  target.searchParams.set('code_challenge_method', 'S256');
  return { url: target.toString(), pending: { state, verifier, startedAt: deps.now() } };
}

interface Callback {
  code: string | null;
  state: string | null;
  denied: boolean;
}

// The callback address taken apart by hand (a phone's URL class is the least trustworthy part of a custom-scheme address): the
// part before the query must be the redirect URI exactly, and a parameter named twice is ambiguous and refused. null: not our
// redirect.
export function parseCallback(callbackUrl: string): Callback | null {
  const match = /^([^?#]*)(?:\?([^#]*))?(?:#.*)?$/.exec(callbackUrl);
  if (!match || match[1] !== REDIRECT_URI) return null;
  const seen = new Map<string, string>();
  for (const pair of (match[2] ?? '').split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
      value = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return { code: null, state: null, denied: false };
    }
    if (seen.has(key)) return { code: null, state: null, denied: false };
    seen.set(key, value);
  }
  return { code: seen.get('code') ?? null, state: seen.get('state') ?? null, denied: seen.has('error') };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The payload of a JWT, decoded and not verified; null when it is not one.
export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const bytes = base64urlDecode(parts[1]);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

const TOKEN_REQUEST = { credentials: 'omit', cache: 'no-store', redirect: 'error' } as const;
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

// Reads a token endpoint answer: a JSON object with an access and a refresh token, the access token issued to this client.
async function readTokens(response: Response, clientId: string, now: number): Promise<Tokens | null> {
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
  const claims = jwtClaims(accessToken);
  // A token for another client is not this app's sign-in, whatever answered with it.
  const claimed = claims?.['client_id'];
  if (typeof claimed !== 'string' || claimed.toLowerCase() !== clientId.toLowerCase()) return null;
  const exp = typeof claims?.['exp'] === 'number' && Number.isFinite(claims['exp']) ? claims['exp'] * 1000 : null;
  const fromExpiresIn = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null;
  const expiresAt = exp ?? fromExpiresIn;
  // No end date at all: treat it as ending now, so the next use refreshes instead of trusting a token of unknown age.
  return { accessToken, refreshToken, expiresAt: expiresAt ?? now };
}

export interface OauthDeps {
  fetchFn: typeof fetch;
  now: () => number;
}

// Redeems the code the callback brought. `pending` is consumed by the caller before this runs (a callback is read once). Every
// refusal is one of SignInFailure; none says more to the person than "did not complete".
export async function completeSignIn(
  callbackUrl: string,
  pending: PendingSignIn | null,
  endpoints: OauthEndpoints,
  deps: OauthDeps,
): Promise<{ ok: true; tokens: Tokens } | { ok: false; reason: SignInFailure }> {
  if (!pending) return { ok: false, reason: 'missing' };
  const now = deps.now();
  if (now - pending.startedAt > SIGN_IN_MAX_AGE_MS || pending.startedAt > now + 60_000) return { ok: false, reason: 'expired' };
  const callback = parseCallback(callbackUrl);
  if (!callback) return { ok: false, reason: 'redirect' };
  if (callback.denied) return { ok: false, reason: 'denied' };
  if (!callback.state || !STATE_PATTERN.test(pending.state) || !constantTimeEqual(callback.state, pending.state)) return { ok: false, reason: 'state' };
  if (!callback.code || !CODE_PATTERN.test(callback.code)) return { ok: false, reason: 'code' };
  try {
    const response = await deps.fetchFn(endpoints.tokenUrl, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ grant_type: 'authorization_code', code: callback.code, code_verifier: pending.verifier, redirect_uri: REDIRECT_URI, client_id: endpoints.clientId }),
      ...TOKEN_REQUEST,
    });
    if (!response.ok) return { ok: false, reason: 'exchange' };
    const tokens = await readTokens(response, endpoints.clientId, deps.now());
    return tokens ? { ok: true, tokens } : { ok: false, reason: 'response' };
  } catch {
    return { ok: false, reason: 'exchange' };
  }
}

// `rejected`: the endpoint refused the refresh token itself (400 invalid_grant: revoked, expired, already used); the session is
// over. `unavailable`: anything else (no network, a 5xx, a rate limit, an answer that is not tokens); the session is kept and the
// refresh tried again later.
export type RefreshResult = { ok: true; tokens: Tokens } | { ok: false; reason: 'rejected' | 'unavailable' };

// Trades a refresh token for new tokens. Supabase Auth rotates the refresh token on every use: the answer holds a new one and the
// old one stops working, so the caller must keep the new one before it does anything else (session.ts).
export async function refreshTokens(endpoints: OauthEndpoints, refreshToken: string, deps: OauthDeps): Promise<RefreshResult> {
  let response: Response;
  try {
    response = await deps.fetchFn(endpoints.tokenUrl, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: endpoints.clientId }),
      ...TOKEN_REQUEST,
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!response.ok) {
    const error = await response.json().then((body: unknown) => (body as { error?: unknown } | null)?.error, () => undefined);
    return { ok: false, reason: response.status === 400 && error === 'invalid_grant' ? 'rejected' : 'unavailable' };
  }
  const tokens = await readTokens(response, endpoints.clientId, deps.now());
  return tokens ? { ok: true, tokens } : { ok: false, reason: 'unavailable' };
}

// The endpoints a server's `/api/config` names, or null when it does not offer DOS ID sign-in or names something unsafe. Both
// endpoints must be on one https origin (http only for a developer's own machine) with no credentials, so the code and the
// refresh token can only go to the provider the server named once, and never to a second host.
export function endpointsFromConfig(config: unknown): OauthEndpoints | null {
  const root = config as { signIn?: unknown; oauthSignIn?: unknown } | null;
  if (!root || root.signIn !== 'oauth') return null;
  const view = root.oauthSignIn as { clientId?: unknown; authorizeUrl?: unknown; tokenUrl?: unknown } | null;
  if (!view || typeof view.clientId !== 'string' || typeof view.authorizeUrl !== 'string' || typeof view.tokenUrl !== 'string') return null;
  if (!CLIENT_ID_PATTERN.test(view.clientId)) return null;
  const authorize = safeEndpoint(view.authorizeUrl);
  const token = safeEndpoint(view.tokenUrl);
  if (!authorize || !token || authorize.origin !== token.origin) return null;
  return { clientId: view.clientId.toLowerCase(), authorizeUrl: authorize.href, tokenUrl: token.href };
}

function safeEndpoint(raw: string): URL | null {
  if (raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username !== '' || url.password !== '' || url.hash !== '') return null;
  return url;
}
