// SPDX-License-Identifier: AGPL-3.0-only
// Is the stored token still good and which features/scopes are active? GET /api/extension/me is the one route a token
// with no scope reaches. The server answers 401 for a token that was revoked, expired, or whose member left: the shell
// signs out at once. A network failure or 5xx stays online-unknown without deleting the token.
import type { FetchLike } from './exchange.ts';
import { fetchDesktopMe, type DesktopMeResult } from './server-api.ts';

export type SessionStatus = 'valid' | 'revoked' | 'unreachable';

export async function inspectSession(fetchImpl: FetchLike, ludyUrl: string, token: string): Promise<DesktopMeResult> {
  return fetchDesktopMe(fetchImpl, ludyUrl, token);
}

export async function checkSession(fetchImpl: FetchLike, ludyUrl: string, token: string): Promise<SessionStatus> {
  const result = await fetchDesktopMe(fetchImpl, ludyUrl, token);
  return result.status;
}
