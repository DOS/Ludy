// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy extension's sign-in (issue #2582, ADR-0047 point 10). The extension opens /-/extension/connect in a browser
// window (chrome.identity.launchWebAuthFlow) with its PKCE challenge, its redirect address and a state. The member signs
// in as usual, chooses the org and approves; the app asks the kernel for a one-time code and sends the window back to the
// extension's redirect address with it. The extension then trades the code and its verifier for a token. The member's
// password and browser session never reach the extension.
import { EXTENSION_SCOPE_IDS, type ExtensionScopeId } from '@crove/kernel-contract';

export const CONNECT_PATH = '/-/extension/connect';
// Chrome and Edge give an extension this redirect address: https://<32 letters a to p>.chromiumapp.org/<path>. Nothing
// else may receive the code.
const REDIRECT = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/[A-Za-z0-9_./-]{0,100}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{1,200}$/;
const KEY = 'crove-pending-extension-connect';
// Long enough to sign in (and pass a second factor); much shorter than the code the kernel then issues lives on.
export const PENDING_CONNECT_TTL_MS = 10 * 60 * 1000;

export interface ConnectRequest {
  codeChallenge: string;
  redirect: string;
  state: string;
  scopes: ExtensionScopeId[];
  deviceName: string;
}

const isScope = (value: string): value is ExtensionScopeId => (EXTENSION_SCOPE_IDS as readonly string[]).includes(value);

// The request an address carries, or null when any part is missing or malformed: the extension's address must be a
// chromiumapp.org one, the challenge a SHA-256 in base64url, the method S256, every scope a known one.
export function parseConnectRequest(search: string): ConnectRequest | null {
  const params = new URLSearchParams(search);
  const codeChallenge = params.get('code_challenge') ?? '';
  const redirect = params.get('redirect_uri') ?? '';
  const state = params.get('state') ?? '';
  if (params.get('code_challenge_method') !== 'S256' || !CHALLENGE.test(codeChallenge) || !REDIRECT.test(redirect) || !STATE.test(state)) return null;
  const asked = (params.get('scope') ?? EXTENSION_SCOPE_IDS[0]).split(/[ ,]+/).filter(Boolean);
  if (asked.length === 0 || asked.length > EXTENSION_SCOPE_IDS.length || !asked.every(isScope)) return null;
  const deviceName = (params.get('device') ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { codeChallenge, redirect, state, scopes: [...new Set(asked)].sort(), deviceName };
}

// Where the window goes next: the extension's address with the one-time code, or with the refusal. The state is returned
// as it came, so the extension can tell its own flow; the org's slug lets it name the org it connected.
export function connectRedirect(request: ConnectRequest, result: { code: string; org: string } | { error: 'access_denied' }): string {
  const url = new URL(request.redirect);
  if ('code' in result) {
    url.searchParams.set('code', result.code);
    url.searchParams.set('org', result.org);
  } else {
    url.searchParams.set('error', result.error);
  }
  url.searchParams.set('state', request.state);
  return url.toString();
}

interface Stored {
  request: ConnectRequest;
  savedAt: number;
}

// The request is kept in this tab only while the member signs in, so the page can pick it up again after /login and
// /mfa, and dropped once answered or after PENDING_CONNECT_TTL_MS.
export function rememberConnect(request: ConnectRequest, now: number = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ request, savedAt: now } satisfies Stored));
  } catch {
    // Storage may be unavailable (private mode): the member opens the extension's sign-in again after signing in.
  }
}

export function pendingConnect(now: number = Date.now()): ConnectRequest | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as Partial<Stored> | null;
    const request = stored?.request;
    const fresh = typeof stored?.savedAt === 'number' && stored.savedAt <= now && now - stored.savedAt < PENDING_CONNECT_TTL_MS;
    // Parsed again from its own parts: whatever storage holds is checked as the address was.
    const checked = request && fresh
      ? parseConnectRequest(
          new URLSearchParams({
            code_challenge: request.codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: request.redirect,
            state: request.state,
            scope: request.scopes.join(' '),
            device: request.deviceName,
          }).toString(),
        )
      : null;
    if (checked) return checked;
    sessionStorage.removeItem(KEY);
    return null;
  } catch {
    return null;
  }
}

export function forgetConnect(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}
