// SPDX-License-Identifier: AGPL-3.0-only
// The Content-Security-Policy of a web app served apart from its API (#2261). The kernel sends one header with the app when
// it serves it (`contentSecurityPolicy` in apps/kernel/src/http.ts); a static host cannot know the API's origin in a file of
// this repository, so the origin-dependent part is built from the build's environment and put in a <meta> tag, and the part
// that needs no origin stays a header (apps/app/vercel.json). A browser applies both policies, so the result is their
// intersection; a test keeps the two together equal to the kernel's policy for the same origins.
//
// Build environment (all public addresses, never secrets); with VITE_API_URL unset nothing is injected and the kernel's own
// header governs the page:
//   VITE_API_URL          the API's origin (also read by the app, src/lib/api-base.ts)
//   VITE_AUTH_URL         Supabase Auth's URL when it is not the API's (the origin is allowed); default: the API's origin
//   VITE_STORAGE_ORIGIN   the bucket's public origin when files go to and from it by presigned URL (S3_PUBLIC_ENDPOINT)
//   VITE_TURNSTILE        true when the booking page shows Cloudflare Turnstile (TURNSTILE_SITE_KEY)
import type { Plugin } from 'vite';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

// Directives that name no origin: sent as a header by the static host. The trusted-types allowlist is in the meta policy
// (it depends on Turnstile); the header only turns the requirement on.
export const STATIC_CSP_DIRECTIVES: readonly string[] = [
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
];

export interface CspOrigins {
  apiOrigin: string;
  authOrigin?: string | undefined;
  storageOrigin?: string | undefined;
  turnstile?: boolean | undefined;
}

function originOf(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error(`${name} must be https (http only for localhost): ${raw}`);
  }
  return url.origin;
}

// The origin-dependent directives, as one policy string.
export function metaCsp(origins: CspOrigins): string {
  const connect = ["'self'", ...new Set([origins.authOrigin ?? origins.apiOrigin, origins.apiOrigin, ...(origins.storageOrigin ? [origins.storageOrigin] : [])])];
  return [
    "default-src 'self'",
    origins.turnstile ? `script-src 'self' ${TURNSTILE_ORIGIN}` : "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    `connect-src ${connect.join(' ')}`,
    ...(origins.turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    origins.turnstile ? 'trusted-types crove-sw crove-turnstile' : 'trusted-types crove-sw',
  ].join('; ');
}

// The origins from the build environment, or null when the app is not split from its API.
export function cspOriginsFromEnv(env: Record<string, string | undefined>): CspOrigins | null {
  const api = (env['VITE_API_URL'] ?? '').trim();
  if (api === '') return null;
  const auth = (env['VITE_AUTH_URL'] ?? '').trim();
  const storage = (env['VITE_STORAGE_ORIGIN'] ?? '').trim();
  return {
    apiOrigin: originOf('VITE_API_URL', api),
    authOrigin: auth === '' ? undefined : originOf('VITE_AUTH_URL', auth),
    storageOrigin: storage === '' ? undefined : originOf('VITE_STORAGE_ORIGIN', storage),
    turnstile: (env['VITE_TURNSTILE'] ?? '').trim() === 'true',
  };
}

// Adds the policy as the first thing in <head> of the built page, so it applies before any script loads.
export function cspMeta(env: Record<string, string | undefined>): Plugin {
  const origins = cspOriginsFromEnv(env);
  return {
    name: 'crove-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      if (!origins) return undefined;
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: metaCsp(origins) }, injectTo: 'head-prepend' }];
    },
  };
}
