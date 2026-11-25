// SPDX-License-Identifier: AGPL-3.0-only
// What the app is built with, and which server it may talk to (issue #4880). Nothing here is a secret: the redirect URI, the
// scope and the Cloud address are public values. The OAuth client id and the provider's endpoints are never built in: the app
// reads them from the server's own `/api/config` (the same document the web app signs in with), so a self-hoster's phone signs
// in to the self-hoster's DOS ID App and the bundle holds no per-deployment value.

// The one address the identity provider sends the browser back to, registered on the deployment's OAuth App (the runbook, step
// "register the redirect URI"). A private-use URI scheme named after the product's domain reversed (RFC 8252 section 7.1,
// ludy.vn). It is compared as one exact string: no prefix, no case folding, no other scheme or host.
export const APP_SCHEME = 'vn.ludy.app';
export const REDIRECT_URI = `${APP_SCHEME}://oauth-login/callback`;
export const OAUTH_SCOPE = 'openid email profile';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// An https origin, or http for a machine of the developer's own (localhost, 127.0.0.1, [::1]); nothing else. No credentials, path,
// query or fragment: the address is where the API is, and a token is only ever sent to it. Returns the origin without a
// trailing slash, or null.
export function normalizeServerUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || value.length > 200) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname) || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) return null;
  if (value.includes('?') || value.includes('#')) return null;
  return url.origin;
}

// The Ludy Cloud address of this build (EXPO_PUBLIC_LUDY_URL, inlined by Expo when the app is built), or null for a build that
// asks for the server address (a self-hoster's). With one, the server field is hidden.
export function cloudServerUrl(raw: string | undefined): string | null {
  return raw === undefined || raw.trim() === '' ? null : normalizeServerUrl(raw);
}
