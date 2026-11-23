// SPDX-License-Identifier: AGPL-3.0-only
// Is the stored token still good? GET /api/extension/me is the one route a token with no scope reaches. The server answers 401 for a
// token that was revoked (from "thiết bị đã kết nối"), expired, or whose member left: the shell then signs out at once. A network
// failure or a server error says nothing about the token, so the shell stays signed in and tries again later.
import type { FetchLike } from './exchange.ts';

export type SessionStatus = 'valid' | 'revoked' | 'unreachable';

const REQUEST_TIMEOUT_MS = 15_000;

export async function checkSession(fetchImpl: FetchLike, ludyUrl: string, token: string): Promise<SessionStatus> {
  try {
    const response = await fetchImpl(`${ludyUrl}/api/extension/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 200) return 'valid';
    if (response.status === 401) return 'revoked';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}
