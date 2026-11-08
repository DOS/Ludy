// SPDX-License-Identifier: AGPL-3.0-only
// The one Ludy address the extension talks to (ADR-0047 point 10; plan section 5.7). Nothing here reaches the network:
// it decides which address is acceptable and checks every URL against the configured one before a request is made.

export const DEFAULT_ADDRESS = 'https://app.ludy.vn';

const isLoopback = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

export type AddressProblem = 'empty' | 'invalid' | 'insecure' | 'credentials';

// The origin a member typed, or why it is refused. https only, except a loopback address; no user info; any path, query
// or fragment is dropped (the app and the API share one origin).
export function parseAddress(input: string): { origin: string } | { problem: AddressProblem } {
  const text = input.trim();
  if (text === '') return { problem: 'empty' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { problem: 'invalid' };
  }
  if (url.username !== '' || url.password !== '') return { problem: 'credentials' };
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) return { problem: url.protocol === 'http:' ? 'insecure' : 'invalid' };
  if (url.hostname === '') return { problem: 'invalid' };
  return { origin: url.origin };
}

// The match pattern the browser is asked for to reach that origin (host permissions ignore the port in the pattern).
export function originPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

// True when the pattern is already in the install (the default address), so no request is needed.
export const isDefaultAddress = (origin: string): boolean => origin === DEFAULT_ADDRESS;

// The URL of `path` on the configured address, refusing anything that would land elsewhere: an absolute URL, a
// protocol-relative one, a backslash trick or a path that does not start with a single slash.
export function ludyUrl(origin: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error(`Refused: ${path} is not a path on the Ludy address`);
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error(`Refused: ${url.origin} is not the configured Ludy address`);
  return url.toString();
}
