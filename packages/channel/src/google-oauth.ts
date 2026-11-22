// SPDX-License-Identifier: AGPL-3.0-only
// Shared Google OAuth token revocation helper for the Google Calendar and Google Meet adapters.
import { requestSignal, type Fetch } from './oauth.ts';

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const BEST_EFFORT_REVOKE_TIMEOUT_MS = 5_000;
const DISCONNECT_REVOKE_TIMEOUT_MS = 30_000;

function postGoogleRevoke(fetch: Fetch, token: string, signal: AbortSignal): Promise<Response> {
  return fetch(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ token }).toString(),
    signal,
  });
}

// Best-effort revocation when a connect is refused after Google already issued tokens: sends only the token
// (refresh token if present, else access token) with a 5 s timeout, never parses or logs the response body,
// skips or aborts when the caller's signal is aborted, and never throws or masks the original refusal error.
export async function revokeGoogleGrantBestEffort(fetch: Fetch, token: string, signal?: AbortSignal): Promise<void> {
  const own = AbortSignal.timeout(BEST_EFFORT_REVOKE_TIMEOUT_MS);
  const combined = requestSignal(signal ? AbortSignal.any([own, signal]) : own);
  if (combined.aborted) return;
  try {
    const response = await postGoogleRevoke(fetch, token, combined);
    await response.body?.cancel?.().catch(() => undefined);
  } catch {
    // Best effort: never mask the original refusal.
  }
}

// Explicit disconnect revocation: Google answers 200 when it revoked the grant, and 400 invalid_token when the token
// is already gone (revoked or removed in the member's Google Account), so both count as revoked.
export async function revokeGoogleGrant(fetch: Fetch, token: string, timeoutMs = DISCONNECT_REVOKE_TIMEOUT_MS): Promise<{ revoked: true } | { failed: string }> {
  try {
    const response = await postGoogleRevoke(fetch, token, AbortSignal.timeout(timeoutMs));
    if (response.ok) {
      await response.body?.cancel?.().catch(() => undefined);
      return { revoked: true };
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 400 && body?.error === 'invalid_token') return { revoked: true };
    return { failed: typeof body?.error === 'string' ? body.error : String(response.status) };
  } catch {
    return { failed: 'NETWORK' };
  }
}
