// SPDX-License-Identifier: AGPL-3.0-only
// The small HTTP client of the MCP conformance tool (issue #4592): fetch with a timeout, redirects left to the caller (the OAuth flow has to see
// every hop), a cookie jar (the authorization server's interaction cookie), JSON helpers, PKCE and a JWT reader. Plain Node, no dependencies.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const REQUEST_MS = 15_000;

export class CookieJar {
  /** @type {Map<string, { value: string, path: string, origin: string }>} */
  #cookies = new Map();

  /** A cookie goes back only to the origin that set it (a redirect to another host never gets it). @param {Response} response */
  store(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq);
      const path = attributes.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      const expired = attributes.some((a) => /^max-age=0$/i.test(a)) || pair.slice(eq + 1) === '';
      if (expired) this.#cookies.delete(name);
      else this.#cookies.set(name, { value: pair.slice(eq + 1), path, origin: new URL(response.url).origin });
    }
  }

  /** @param {string} url */
  headerFor(url) {
    const { origin, pathname } = new URL(url);
    return [...this.#cookies.entries()]
      .filter(([, cookie]) => cookie.origin === origin && pathname.startsWith(cookie.path))
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join('; ');
  }
}

/**
 * One request, no redirect followed. Resolves `{ status, headers, text, json }` (json is null when the body is not JSON).
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, jar?: CookieJar }} [options]
 */
export async function request(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.jar) {
    const cookie = options.jar.headerFor(url);
    if (cookie) headers['cookie'] = cookie;
  }
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    redirect: 'manual',
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  options.jar?.store(response);
  const text = await response.text();
  /** @type {unknown} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, headers: response.headers, text, json };
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** @param {string} token @returns {{ header: Record<string, unknown>, payload: Record<string, unknown>, signed: string, signature: Buffer } | null} */
export function readJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')),
      signed: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2] ?? '', 'base64url'),
    };
  } catch {
    return null;
  }
}

/**
 * Whether an ES256 token's signature verifies against one of the keys of a JWKS (selected by `kid`).
 * @param {NonNullable<ReturnType<typeof readJwt>>} jwt @param {{ keys?: Record<string, unknown>[] }} jwks
 */
export function verifyEs256(jwt, jwks) {
  const kid = jwt.header['kid'];
  const keys = (jwks.keys ?? []).filter((key) => key['kty'] === 'EC' && (kid === undefined || key['kid'] === kid));
  return keys.some((key) => {
    try {
      return verify('sha256', Buffer.from(jwt.signed), { key: createPublicKey({ key: /** @type {any} */ (key), format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, jwt.signature);
    } catch {
      return false;
    }
  });
}
