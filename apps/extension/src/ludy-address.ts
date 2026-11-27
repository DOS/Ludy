// SPDX-License-Identifier: AGPL-3.0-only
// The two Ludy origins the extension talks to (ADR-0047 point 10; plan section 5.7): the App origin for browser consent
// (/-/extension/connect) and the API origin for every network/RPC/token call. `scripts/build.mjs` can stamp custom origins
// at build time for self-hosted or test builds. Nothing here reaches the network: every URL is pinned before a request.

export const DEFAULT_APP_ADDRESS = 'https://app.ludy.vn';
export const DEFAULT_API_ADDRESS = 'https://api.ludy.vn';

// Plain-http `localhost` for local `docker compose up` stacks; `127.0.0.1` is accepted only when `allowLoopbackIp` is set for build-time test targets.
export const isLocalhost = (hostname: string) => hostname === 'localhost';
const isLoopbackIp = (hostname: string) => hostname === '127.0.0.1';

export type AddressProblem = 'empty' | 'invalid' | 'insecure' | 'credentials';

// Normalizes an origin URL (https only, except plain http on localhost, or 127.0.0.1 when `allowLoopbackIp` is enabled).
// Drops any path, query, or fragment and rejects embedded credentials.
export function parseAddress(input: string, options?: { allowLoopbackIp?: boolean }): { origin: string } | { problem: AddressProblem } {
  const text = input.trim();
  if (text === '') return { problem: 'empty' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { problem: 'invalid' };
  }
  if (url.username !== '' || url.password !== '') return { problem: 'credentials' };
  const localHttpOk = url.protocol === 'http:' && (isLocalhost(url.hostname) || (options?.allowLoopbackIp === true && isLoopbackIp(url.hostname)));
  if (url.protocol !== 'https:' && !localHttpOk) return { problem: url.protocol === 'http:' ? 'insecure' : 'invalid' };
  if (url.hostname === '') return { problem: 'invalid' };
  return { origin: url.origin };
}

// The match pattern the browser grants for an origin (host permissions and web_accessible_resources ignore ports).
export function originPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

// The URL of `path` on the configured origin, refusing anything that would land elsewhere: an absolute URL, a
// protocol-relative one, a backslash trick, or a path that does not start with a single slash.
export function ludyUrl(origin: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error(`Refused: ${path} is not a path on the Ludy address`);
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error(`Refused: ${url.origin} is not the configured Ludy address`);
  return url.toString();
}
