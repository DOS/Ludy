// SPDX-License-Identifier: AGPL-3.0-only
// The consent page of an MCP client (ADR-0051 decision 2, ADR-0032, issue #2975). An MCP client sends the person to the authorization server, which
// redirects the browser to /oauth/interaction/<uid>, a page of this app on the API's own origin. The person signs in as usual (the uid is kept in this tab while
// they do), chooses the org and answers; the page asks the server for the client's details and sends the answer, and the server says where the browser goes
// next (the client's redirect address with its one-time code, or the refusal).
// The provider's interaction ids: 43 URL-safe characters; kept loose enough to follow a library change, tight enough to be a path segment.
const UID = /^[A-Za-z0-9_-]{16,128}$/;
const KEY = 'crove-pending-oauth-interaction';
// An interaction lives ten minutes at the server; the page forgets it then too.
export const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;

export const wellFormedUid = (value: string): boolean => UID.test(value);

interface Stored {
  uid: string;
  savedAt: number;
}

export function rememberInteraction(uid: string, now: number = Date.now()): void {
  if (!wellFormedUid(uid)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ uid, savedAt: now } satisfies Stored));
  } catch {
    // Storage may be unavailable (private mode): the person starts the connection again from the client after signing in.
  }
}

export function pendingInteraction(now: number = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as Partial<Stored> | null;
    const fresh = typeof stored?.savedAt === 'number' && stored.savedAt <= now && now - stored.savedAt < PENDING_OAUTH_TTL_MS;
    if (fresh && typeof stored?.uid === 'string' && wellFormedUid(stored.uid)) return stored.uid;
    sessionStorage.removeItem(KEY);
    return null;
  } catch {
    return null;
  }
}

export function forgetInteraction(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}

// What the server tells the consent page about the request.
export interface ConsentDetails {
  client: { id: string; name: string; logoUri: string | null; redirectHost: string; selfDeclared: boolean };
  scopes: string[];
  expiresInDays: number;
  orgs: Array<{ orgId: string; slug: string; name: string; role: string }>;
}

// Where the browser may be sent after an answer: the server's resume address on this origin. Anything else is refused.
export function safeResume(redirectTo: string, origin: string): string | null {
  try {
    const url = new URL(redirectTo, origin);
    return url.origin === origin && url.pathname.startsWith('/oauth/authorize/') ? url.toString() : null;
  } catch {
    return null;
  }
}
