// SPDX-License-Identifier: AGPL-3.0-only
// Ends this phone's session on the server (issue #4880), the way the web app's sign-out does (apps/app/src/lib/session-actions.ts):
// the kernel's own user id from `me.get` (not the token's `sub`: a revoke names the Ludy user, #184), the session id from the
// access token, and a call WITHOUT the org header, so an org that refused this session cannot swallow its revoke (#247).
import { createLudyClient, requestHeaders } from '@ludy/client';
import { jwtClaims } from './oauth.ts';

export async function revokeCurrentSession(serverUrl: string, accessToken: string): Promise<void> {
  const sessionId = jwtClaims(accessToken)?.['session_id'];
  if (typeof sessionId !== 'string') throw new Error('the access token names no session');
  // No org header on either call.
  const client = createLudyClient({ origin: serverUrl, headers: () => requestHeaders(accessToken, null) });
  const me = await client.me.get();
  await client.sessions.revoke({ userId: me.userId, sessionId });
}
