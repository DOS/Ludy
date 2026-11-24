// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in address the system browser opens: the app's /-/extension/connect page in desktop mode. The member signs in as usual,
// picks the org and approves; the page then sends the browser back to the loopback address with a one-time code (RFC 8252). No
// `scope` is asked for: this slice has no feature, so the token holds none and reaches /api/extension/me alone.
export const CONNECT_PATH = '/-/extension/connect';

export function buildConnectUrl(ludyUrl: string, request: { challenge: string; state: string; redirectUri: string; deviceName: string }): string {
  const params = new URLSearchParams({
    client: 'desktop',
    code_challenge: request.challenge,
    code_challenge_method: 'S256',
    redirect_uri: request.redirectUri,
    state: request.state,
    device: request.deviceName,
  });
  return `${ludyUrl}${CONNECT_PATH}?${params.toString()}`;
}

// What the member sees in the "thiết bị đã kết nối" list: at most 80 characters, no control characters.
export function deviceNameFor(hostname: string): string {
  const clean = hostname.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40);
  return `Ludy Desktop, Windows${clean ? `, ${clean}` : ''}`;
}
