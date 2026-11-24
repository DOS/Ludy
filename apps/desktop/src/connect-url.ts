// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in address the system browser opens: the app's /-/extension/connect page in desktop mode. The member signs in as usual,
// picks the org and approves; the page then sends the browser back to the loopback address with a one-time code (RFC 8252).
// When the deployment has desktop capture off, `scopes` is empty/omitted (zero-scope sign-in only, slice 2). When enabled, requests
// `meetings` (and optional `agenda`).
export const CONNECT_PATH = '/-/extension/connect';

export function buildConnectUrl(
  ludyUrl: string,
  request: { challenge: string; state: string; redirectUri: string; deviceName: string; scopes?: readonly string[] },
): string {
  const params = new URLSearchParams({
    client: 'desktop',
    code_challenge: request.challenge,
    code_challenge_method: 'S256',
    redirect_uri: request.redirectUri,
    state: request.state,
    device: request.deviceName,
  });
  if (request.scopes && request.scopes.length > 0) {
    params.set('scope', request.scopes.join(' '));
  }
  return `${ludyUrl}${CONNECT_PATH}?${params.toString()}`;
}

// What the member sees in the "thiết bị đã kết nối" list: at most 80 characters, no control characters.
export function deviceNameFor(hostname: string): string {
  const clean = hostname.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40);
  return `Ludy Desktop, Windows${clean ? `, ${clean}` : ''}`;
}
