// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy extension's sign-in (issue #2582, ADR-0047 point 10). The extension opens /-/extension/connect in a browser
// tab, or window (chrome.identity.launchWebAuthFlow), with its PKCE challenge, its redirect address and a state. The member signs
// in as usual, chooses the org and approves; the app asks the kernel for a one-time code and sends the window back to the
// extension's redirect address with it. The extension then trades the code and its verifier for a token. The member's
// password and browser session never reach the extension.
import { DESKTOP_CLIENT_ID, EXTENSION_SCOPE_IDS, extensionClientAllowsScopes, type ExtensionClient, type ExtensionScopeId } from '@ludy/kernel-contract';
import { promoteMigratedItem, readLegacyAwareItem, removeMigratedItem, writeMigratedItem } from './storage-migrate.ts';

export const CONNECT_PATH = '/-/extension/connect';
// Chrome and Edge give an extension this redirect address for a browser window (launchWebAuthFlow): https://<32 letters a to p>.chromiumapp.org/<path>.
// An extension that signs in in a normal tab (#4662) gets the member sent to its own landing page instead, chrome-extension://<32 letters a to p>/connected.html:
// that one page, which the extension lists as web accessible to this app's address only. Nothing else may receive the code.
const REDIRECT = /^(?:https:\/\/[a-p]{32}\.chromiumapp\.org\/[A-Za-z0-9_./-]{0,100}|chrome-extension:\/\/[a-p]{32}\/connected\.html)$/;
// Ludy Desktop (ADR-0055 slice 2, #4515) is not a browser extension: it gets the code on a loopback address of the same machine (RFC 8252
// section 7.3), 127.0.0.1 and an unprivileged port, one fixed path. A code sent there is useless without the PKCE verifier only the app holds.
const DESKTOP_REDIRECT = /^http:\/\/127\.0\.0\.1:([0-9]{4,5})\/ludy-desktop\/callback$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{1,200}$/;
const KEY = 'ludy-pending-extension-connect';
const LEGACY_KEY = 'crove-pending-extension-connect';
// Long enough to sign in (and pass a second factor); much shorter than the code the kernel then issues lives on.
export const PENDING_CONNECT_TTL_MS = 10 * 60 * 1000;

export interface ConnectRequest {
  // Who is signing in: the browser extension, or Ludy Desktop (client=desktop in the address, #4515).
  client: ExtensionClient;
  // The extension signing in: the host of its redirect address, one of the ids the deployment allows. For Ludy Desktop, DESKTOP_CLIENT_ID.
  extensionId: string;
  codeChallenge: string;
  redirect: string;
  state: string;
  scopes: ExtensionScopeId[];
  deviceName: string;
}

const isScope = (value: string): value is ExtensionScopeId => (EXTENSION_SCOPE_IDS as readonly string[]).includes(value);

const SCOPE_MODULE: Record<ExtensionScopeId, string> = { meetings: 'meetings', agenda: 'meetings', notes: 'notes' };

/**
 * Narrows requested extension scopes to those whose backing module is enabled for the chosen org (ADR-0053), keeping
 * 'agenda' only while 'meetings' stays enabled.
 */
export function filterScopesForModules(scopes: readonly ExtensionScopeId[], enabledModules: readonly string[]): ExtensionScopeId[] {
  const allowed = new Set(enabledModules);
  const kept = scopes.filter((scope) => allowed.has(SCOPE_MODULE[scope]));
  const hasMeetings = kept.includes('meetings');
  return [...new Set(hasMeetings ? kept : kept.filter((s) => s !== 'agenda'))].sort();
}

// The request an address carries, or null when any part is missing or malformed: the extension's address must be a
// chromiumapp.org one of an extension in `allowedIds` (EXTENSION_IDS, #2740), the challenge a SHA-256 in base64url, the
// method S256, every scope a known one.
export function parseConnectRequest(search: string, allowedIds: readonly string[], options?: { desktopCapture?: boolean }): ConnectRequest | null {
  const params = new URLSearchParams(search);
  const codeChallenge = params.get('code_challenge') ?? '';
  const redirect = params.get('redirect_uri') ?? '';
  const state = params.get('state') ?? '';
  const client = params.get('client');
  if (client !== null && client !== 'desktop') return null;
  if (client === 'desktop') return parseDesktopRequest(params, codeChallenge, redirect, state, Boolean(options?.desktopCapture));
  if (params.get('code_challenge_method') !== 'S256' || !CHALLENGE.test(codeChallenge) || !REDIRECT.test(redirect) || !STATE.test(state)) return null;
  const extensionId = new URL(redirect).hostname.split('.')[0] ?? '';
  if (!allowedIds.includes(extensionId)) return null;
  const asked = (params.get('scope') ?? EXTENSION_SCOPE_IDS[0]).split(/[ ,]+/).filter(Boolean);
  if (asked.length === 0 || asked.length > EXTENSION_SCOPE_IDS.length || !asked.every(isScope)) return null;
  // The agenda scope rides with the meetings scope (B2): alone it could not even be exchanged for a token.
  if (asked.includes('agenda') && !asked.includes('meetings')) return null;
  const deviceName = (params.get('device') ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { client: 'extension', extensionId, codeChallenge, redirect, state, scopes: [...new Set(asked)].sort(), deviceName };
}

// Ludy Desktop's request: the loopback redirect, either no scope (sign-in only) or meetings/agenda when desktop capture is on (#4516).
function parseDesktopRequest(params: URLSearchParams, codeChallenge: string, redirect: string, state: string, desktopCapture: boolean): ConnectRequest | null {
  const port = Number(DESKTOP_REDIRECT.exec(redirect)?.[1]);
  if (params.get('code_challenge_method') !== 'S256' || !CHALLENGE.test(codeChallenge) || !STATE.test(state)) return null;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const asked = (params.get('scope') ?? '').split(/[ ,]+/).filter(Boolean);
  // Capture scopes for Ludy Desktop stay refused unless the deployment turned desktop capture on (#4516).
  if (asked.length > 0 && !desktopCapture) return null;
  if (asked.length > EXTENSION_SCOPE_IDS.length || !asked.every(isScope)) return null;
  if (asked.includes('agenda') && !asked.includes('meetings')) return null;
  if (!extensionClientAllowsScopes('desktop', asked)) return null;
  const deviceName = (params.get('device') ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { client: 'desktop', extensionId: DESKTOP_CLIENT_ID, codeChallenge, redirect, state, scopes: [...new Set(asked)].sort(), deviceName };
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
    writeMigratedItem(sessionStorage, KEY, LEGACY_KEY, JSON.stringify({ request, savedAt: now } satisfies Stored));
  } catch {
    // Storage may be unavailable (private mode): the member opens the extension's sign-in again after signing in.
  }
}

export function pendingConnect(allowedIds: readonly string[], now: number = Date.now(), options?: { desktopCapture?: boolean }): ConnectRequest | null {
  try {
    const entry = readLegacyAwareItem(sessionStorage, KEY, LEGACY_KEY);
    if (!entry) return null;
    const stored = JSON.parse(entry.value) as Partial<Stored> | null;
    const request = stored?.request;
    const fresh = typeof stored?.savedAt === 'number' && stored.savedAt <= now && now - stored.savedAt < PENDING_CONNECT_TTL_MS;
    // Parsed again from its own parts: whatever storage holds is checked as the address was.
    const checked = request && fresh
      ? parseConnectRequest(
          new URLSearchParams({
            ...(request.client === 'desktop' ? { client: 'desktop' } : {}),
            code_challenge: request.codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: request.redirect,
            state: request.state,
            scope: request.scopes.join(' '),
            device: request.deviceName,
          }).toString(),
          allowedIds,
          options,
        )
      : null;
    if (checked) {
      if (entry.fromLegacy) promoteMigratedItem(sessionStorage, KEY, LEGACY_KEY, entry.value);
      return checked;
    }
    removeMigratedItem(sessionStorage, KEY, LEGACY_KEY);
    return null;
  } catch {
    try {
      removeMigratedItem(sessionStorage, KEY, LEGACY_KEY);
    } catch {
      // Ignore unavailable storage.
    }
    return null;
  }
}

export function forgetConnect(): void {
  try {
    removeMigratedItem(sessionStorage, KEY, LEGACY_KEY);
  } catch {
    // Nothing to forget.
  }
}
