// SPDX-License-Identifier: AGPL-3.0-only
// Signing in through the identity provider's OAuth App (issue #4704, ADR-0028 amendment 2026-11-24). The provider is a
// Supabase Auth project with its OAuth 2.1 server on; it registers one OAuth App (a public client, PKCE S256) for this
// deployment and gives the deployment its client id. Two settings follow from that:
// - AUTH_OAUTH_CLIENT_ID: the one client whose access tokens the kernel accepts (the `client_id` claim must equal it;
//   auth.ts and the /auth/v1 proxy refuse every other client's token, and the db session check every other client's
//   session). Unset: today's rule, every client's token is refused. It holds no secret: the client id is public.
// - AUTH_SIGN_IN=oauth (default `form`): the sign-in screen shows only "Continue with <AUTH_OAUTH_NAME>". The app sends the
//   browser to the provider's authorize endpoint and redeems the code at its token endpoint, both on the provider's Auth
//   URL (PUBLIC_AUTH_URL, the same address the app already signs in against), so no further address is configured.
// Boot refuses the mode when it cannot be offered whole, instead of starting with a sign-in screen that shows a form.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A Supabase Auth OAuth client's id is a UUID. Normalized to lower case, which is how the token's `client_id` claim and
// the database spell it; null for anything else.
export function parseOauthClientId(raw: string): string | null {
  const value = raw.trim();
  return UUID.test(value) ? value.toLowerCase() : null;
}

// A label, not markup or a control sequence: the app renders it as text, but the length and characters stay plain.
export function oauthName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (raw.length > 40 || [...raw].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f || c === '<' || c === '>')) return null;
  return raw;
}

export interface OauthSignInView {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  name: string | null;
}

interface OauthSettings {
  AUTH_SIGN_IN: 'form' | 'oauth';
  AUTH_OAUTH_CLIENT_ID?: string | undefined;
  AUTH_OAUTH_NAME?: string | undefined;
  PUBLIC_AUTH_URL?: string | undefined;
  AUTH_UPSTREAM_URL?: string | undefined;
  AUTH_HOSTED_LOGIN_URL?: string | undefined;
  AUTH_OAUTH_PROVIDERS: readonly string[];
}

// Why AUTH_SIGN_IN=oauth cannot start, or null (also null when the mode is off).
export function oauthSignInProblems(config: OauthSettings): string | null {
  if (config.AUTH_SIGN_IN !== 'oauth') return null;
  if (!config.AUTH_OAUTH_CLIENT_ID) return 'AUTH_SIGN_IN=oauth needs AUTH_OAUTH_CLIENT_ID, the client id of the OAuth App the identity provider registered for this deployment';
  if (!config.PUBLIC_AUTH_URL) return 'AUTH_SIGN_IN=oauth needs PUBLIC_AUTH_URL, the identity provider\'s Supabase Auth address (its authorize and token endpoints are under it)';
  let url: URL;
  try {
    url = new URL(config.PUBLIC_AUTH_URL);
  } catch {
    return 'AUTH_SIGN_IN=oauth: PUBLIC_AUTH_URL is not a URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) return 'AUTH_SIGN_IN=oauth: PUBLIC_AUTH_URL must be https (http only for localhost)';
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return 'AUTH_SIGN_IN=oauth: PUBLIC_AUTH_URL must carry no credentials, query or fragment';
  // The bundled Supabase Auth is reached through the /auth/v1 proxy, which also serves the password, sign-up and recovery paths.
  if (config.AUTH_UPSTREAM_URL) return 'AUTH_SIGN_IN=oauth cannot be combined with AUTH_UPSTREAM_URL: the bundled Supabase Auth proxy serves the password, sign-up and recovery paths';
  if (config.AUTH_HOSTED_LOGIN_URL) return 'AUTH_SIGN_IN=oauth cannot be combined with AUTH_HOSTED_LOGIN_URL: one way to sign in, not two';
  if (config.AUTH_OAUTH_PROVIDERS.length > 0) return 'AUTH_SIGN_IN=oauth cannot be combined with AUTH_OAUTH_PROVIDERS: the only button is the OAuth App\'s';
  if (config.AUTH_OAUTH_NAME !== undefined && oauthName(config.AUTH_OAUTH_NAME) === null) return 'AUTH_OAUTH_NAME is at most 40 characters, with no control characters, < or >';
  return null;
}

// What /api/config tells the app: null unless the mode is on (the settings are then whole: boot checked them).
export function oauthSignInView(config: OauthSettings): OauthSignInView | null {
  if (config.AUTH_SIGN_IN !== 'oauth' || !config.AUTH_OAUTH_CLIENT_ID || !config.PUBLIC_AUTH_URL) return null;
  const base = config.PUBLIC_AUTH_URL.replace(/\/+$/, '');
  return { clientId: config.AUTH_OAUTH_CLIENT_ID, authorizeUrl: `${base}/oauth/authorize`, tokenUrl: `${base}/oauth/token`, name: oauthName(config.AUTH_OAUTH_NAME) };
}
