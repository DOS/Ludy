// SPDX-License-Identifier: AGPL-3.0-only
// CORS for a split deployment (#2261): the web app is served from its own origin (Vercel at app.<domain>) and calls this
// API at api.<domain> directly. The answer is for an exact-origin allowlist from CORS_ALLOWED_ORIGINS, never `*`, and an
// origin off the list gets no CORS header at all, so the browser refuses to hand the response to that page.
//
// Credentials are bearer tokens in the Authorization header (and the one-time stream ticket in a query string), never
// cookies: the answer never sets Access-Control-Allow-Credentials, and the browser sends no cookie on these requests.
// With the list empty (the default, and every same-origin deployment) the middleware does nothing.
import type { MiddlewareHandler } from 'hono';
import { ORG_HEADER } from '@crove/kernel-contract';
import { INVITE_TOKEN_HEADER } from './auth-signup-policy.ts';

export const CORS_MAX_ORIGINS = 10;

// The request headers the web app sends cross-origin: the session and org headers, JSON bodies, the invite token of a
// sign-up (#563) and the headers Supabase's auth client adds (`apikey`, `x-client-info`, `x-supabase-api-version`).
const ALLOWED_HEADERS = ['authorization', 'content-type', ORG_HEADER, INVITE_TOKEN_HEADER, 'apikey', 'x-client-info', 'x-supabase-api-version'];
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
// The response headers a page may read: the request id for a report, Retry-After for a busy answer and a download's
// name and size.
const EXPOSED_HEADERS = ['x-request-id', 'retry-after', 'content-disposition', 'content-length'];
const PREFLIGHT_MAX_AGE_SECONDS = 600;

const isLoopback = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

// CORS_ALLOWED_ORIGINS: a comma-separated list of origins (scheme, host, optional port; no path, no trailing slash).
// https only, except a loopback address for a laptop. A wildcard, a path or another scheme stops the boot.
export function parseAllowedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  const origins: string[] = [];
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    if (entry.includes('*')) throw new Error('CORS_ALLOWED_ORIGINS lists exact origins; a wildcard is not accepted');
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`CORS_ALLOWED_ORIGINS entry "${entry}" is not an origin such as https://app.example.com`);
    }
    if (url.origin !== entry) {
      throw new Error(`CORS_ALLOWED_ORIGINS entry "${entry}" must be an origin only (scheme, host, optional port; no path or trailing slash), here ${url.origin}`);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
      throw new Error(`CORS_ALLOWED_ORIGINS entry "${entry}" must be https (http is accepted for localhost only)`);
    }
    if (!origins.includes(entry)) origins.push(entry);
  }
  if (origins.length > CORS_MAX_ORIGINS) throw new Error(`CORS_ALLOWED_ORIGINS lists at most ${CORS_MAX_ORIGINS} origins`);
  return origins;
}

// The headers a handler (the auth proxy forwards Supabase Auth's own) may have put on the answer: never ours, so they go.
const UPSTREAM_CORS = /^access-control-/i;

export function corsMiddleware(allowed: readonly string[]): MiddlewareHandler {
  if (allowed.length === 0) return async (_c, next) => next();
  const set = new Set(allowed);
  return async (c, next) => {
    const origin = c.req.header('origin');
    // Same-origin requests and non-browser clients send no Origin header: nothing to answer.
    if (origin === undefined) return next();
    const preflight = c.req.method === 'OPTIONS' && c.req.header('access-control-request-method') !== undefined;
    const permitted = set.has(origin);
    if (preflight) {
      const headers = new Headers({ vary: 'Origin' });
      // A preflight from an origin off the list ends here with no CORS header: the browser blocks the real request.
      if (permitted) {
        headers.set('access-control-allow-origin', origin);
        headers.set('access-control-allow-methods', ALLOWED_METHODS);
        headers.set('access-control-allow-headers', ALLOWED_HEADERS.join(', '));
        headers.set('access-control-max-age', String(PREFLIGHT_MAX_AGE_SECONDS));
      }
      return new Response(null, { status: 204, headers });
    }
    await next();
    // Set on the finished answer, so a handler that returns its own Response (the auth proxy) carries them too.
    for (const name of Array.from(c.res.headers.keys())) if (UPSTREAM_CORS.test(name)) c.res.headers.delete(name);
    // The answer depends on the Origin header, so a shared cache must not serve one origin's answer to another.
    c.res.headers.append('vary', 'Origin');
    if (permitted) {
      c.res.headers.set('access-control-allow-origin', origin);
      c.res.headers.set('access-control-expose-headers', EXPOSED_HEADERS.join(', '));
    }
  };
}
