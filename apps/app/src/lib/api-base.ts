// SPDX-License-Identifier: AGPL-3.0-only
// Where the API is (#2261). Served by the kernel (self-host, `docker compose up`) the app and the API share an origin and
// every call is a same-origin path. Served from another origin (Vercel at app.<domain>, the API at api.<domain>) the
// build is given the API's origin in VITE_API_URL and every call goes there; the kernel answers CORS for the app's origin
// (CORS_ALLOWED_ORIGINS). The value is a public address baked into the bundle, never a secret.

// The origin in VITE_API_URL, without a trailing slash; '' (same origin) when unset or empty. Anything but an http(s)
// origin is a build mistake and stops the app at load rather than sending sessions to a surprise address.
export function normalizeApiBase(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VITE_API_URL is not a URL; set it to the API origin such as https://api.example.com');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value.replace(/\/+$/, '')) {
    throw new Error(`VITE_API_URL must be an origin only (scheme, host, optional port), not ${value}`);
  }
  return url.origin;
}

const base = normalizeApiBase(import.meta.env['VITE_API_URL'] as string | undefined);

// A path of the API ("/api/config") as a URL to fetch. An absolute URL (a presigned one) passes unchanged.
export function apiUrl(path: string, origin: string = base): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${origin}${path}`;
}

// The origin of what the kernel itself serves to browsers: link-in-bio pages, calendar feeds and the status page. The API's
// origin when it is separate, else this page's own.
export function serverOrigin(): string {
  return base || window.location.origin;
}
