// SPDX-License-Identifier: AGPL-3.0-only
// The hosted login page (issue #2704, docs/contracts/hosted-login.md). The app sends the browser to the identity provider's
// own sign-in page with a PKCE challenge, the page comes back with a one-time code, and the app redeems the code at the
// provider's token endpoint for a standard Supabase Auth session (access and refresh token), which it hands to auth-js.
//
// What is kept where, and for how long:
// - The state and the code verifier live in sessionStorage only (this tab, never localStorage, never a cookie, never in
//   a URL), under one key, and are removed the moment the callback is read, before anything is sent: a code is redeemed
//   at most once from this tab, a failure means starting again, and a second tab or a replayed callback finds nothing.
// - A started login is good for 10 minutes; an older one is refused.
// - The callback must carry the state this tab made (exact match) and arrive at the exact redirect_uri it was started
//   with. The code is sent only over the token endpoint the kernel configured, with no cookies, no referrer, no
//   redirect followed and no cache.
// - Nothing from the page or the endpoint is trusted for more than it is: the token endpoint's answer must be a JSON
//   object with a non-empty access_token and refresh_token, and the kernel verifies the access token like any other.
// Nothing here is logged.

export interface HostedLoginConfig {
  url: string;
  tokenUrl: string;
  name: string | null;
}

export type HostedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const HOSTED_STORAGE_KEY = 'ludy-hosted-login';
export const HOSTED_CALLBACK_PATH = '/auth/hosted-callback';
export const HOSTED_MAX_AGE_MS = 10 * 60_000;
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

export type HostedFailure = 'missing' | 'expired' | 'denied' | 'state' | 'code' | 'redirect' | 'exchange' | 'response';
export type HostedResult = { ok: true; accessToken: string; refreshToken: string; returnPath: string } | { ok: false; reason: HostedFailure };

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// S256 (RFC 7636 section 4.2): base64url(SHA-256(verifier)).
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function hostedRedirectUri(origin: string): string {
  return `${origin}${HOSTED_CALLBACK_PATH}`;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
}

// Only a path of this app, never an address: where the user lands once signed in.
export function safeReturnPath(raw: string): string {
  return raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') && !hasControlCharacter(raw) && !raw.startsWith(HOSTED_CALLBACK_PATH) ? raw : '/';
}

// Starts a login: keeps what the callback needs, and returns the address of the hosted page to go to.
export async function startHostedLogin(
  config: HostedLoginConfig,
  deps: { origin: string; returnPath: string; storage: HostedStorage; now?: () => number; token?: () => string },
): Promise<string> {
  const token = deps.token ?? randomToken;
  const state = token();
  const verifier = token();
  const redirectUri = hostedRedirectUri(deps.origin);
  const pending: Pending = { state, verifier, redirectUri, startedAt: (deps.now ?? Date.now)(), returnPath: safeReturnPath(deps.returnPath) };
  deps.storage.setItem(HOSTED_STORAGE_KEY, JSON.stringify(pending));
  const target = new URL(config.url);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('redirect_uri', redirectUri);
  target.searchParams.set('state', state);
  target.searchParams.set('code_challenge', await pkceChallenge(verifier));
  target.searchParams.set('code_challenge_method', 'S256');
  return target.toString();
}

export interface HostedCallback {
  code: string | null;
  state: string | null;
  denied: boolean;
}

// The callback's parameters, when this address is the hosted login's return; null for every other address. The caller
// takes them out of the address bar before anything else reads it.
export function readHostedCallback(location: Pick<Location, 'pathname' | 'search'>): HostedCallback | null {
  if (location.pathname !== HOSTED_CALLBACK_PATH) return null;
  const params = new URLSearchParams(location.search);
  return { code: params.get('code'), state: params.get('state'), denied: params.has('error') };
}

function readPending(storage: HostedStorage): Pending | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(HOSTED_STORAGE_KEY);
  } catch {
    return null;
  } finally {
    // Gone before it is used: the verifier is never kept past its one callback, whatever happens next.
    try {
      storage.removeItem(HOSTED_STORAGE_KEY);
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

// Redeems the code the callback brought. Every refusal is one of HostedFailure; none says more to the user than "did not complete".
export async function completeHostedLogin(
  callback: HostedCallback,
  deps: { config: HostedLoginConfig; origin: string; storage: HostedStorage; fetchFn: typeof fetch; now?: () => number },
): Promise<HostedResult> {
  const pending = readPending(deps.storage);
  if (!pending) return { ok: false, reason: 'missing' };
  if ((deps.now ?? Date.now)() - pending.startedAt > HOSTED_MAX_AGE_MS || pending.startedAt > (deps.now ?? Date.now)() + 60_000) return { ok: false, reason: 'expired' };
  if (callback.denied) return { ok: false, reason: 'denied' };
  if (!callback.state || !STATE_PATTERN.test(pending.state) || callback.state !== pending.state) return { ok: false, reason: 'state' };
  if (!callback.code || !CODE_PATTERN.test(callback.code)) return { ok: false, reason: 'code' };
  if (pending.redirectUri !== hostedRedirectUri(deps.origin)) return { ok: false, reason: 'redirect' };
  let body: unknown;
  try {
    const response = await deps.fetchFn(deps.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: callback.code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri }),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return { ok: false, reason: 'exchange' };
    body = await response.json();
  } catch {
    return { ok: false, reason: 'exchange' };
  }
  const { access_token: accessToken, refresh_token: refreshToken, token_type: tokenType } = (body ?? {}) as Record<string, unknown>;
  if (typeof accessToken !== 'string' || accessToken === '' || accessToken.length > 8192) return { ok: false, reason: 'response' };
  if (typeof refreshToken !== 'string' || refreshToken === '' || refreshToken.length > 1024) return { ok: false, reason: 'response' };
  if (tokenType !== undefined && (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer')) return { ok: false, reason: 'response' };
  return { ok: true, accessToken, refreshToken, returnPath: pending.returnPath };
}
