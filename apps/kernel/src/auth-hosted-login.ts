// SPDX-License-Identifier: AGPL-3.0-only
// The hosted login page (issue #2704, docs/contracts/hosted-login.md): an identity provider's own sign-in page that the
// app sends the browser to and that returns a one-time code, which the app redeems at the provider's token endpoint for
// a standard Supabase Auth session (PKCE, S256). AUTH_HOSTED_LOGIN_URL is the page, AUTH_HOSTED_LOGIN_TOKEN_URL the
// endpoint, AUTH_HOSTED_LOGIN_NAME the words on the button. Ludy holds no secret for it and trusts nothing it returns:
// the session is verified like any other (ADR-0028), AUTH_ALLOWED_EMAILS still decides who may use the deployment.
// Both URLs are public addresses the browser opens or calls, so they must be https (http only on localhost), carry no
// credentials and no fragment; the token endpoint's origin joins the app's connect-src.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function checkHostedLoginUrl(name: string, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${name} is not a URL`;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) return `${name} must be https (http only for localhost)`;
  if (url.username !== '' || url.password !== '') return `${name} must not carry credentials`;
  if (url.hash !== '') return `${name} must not carry a fragment`;
  return null;
}

export function hostedLoginName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  // A label, not markup or a control sequence: the app renders it as text, but the length and characters stay plain.
  if (raw.length > 40 || /[\u0000-\u001F\u007F<>]/.test(raw)) return null;
  return raw;
}

export interface HostedLoginView {
  url: string;
  tokenUrl: string;
  name: string | null;
}

export function hostedLoginView(config: { AUTH_HOSTED_LOGIN_URL?: string | undefined; AUTH_HOSTED_LOGIN_TOKEN_URL?: string | undefined; AUTH_HOSTED_LOGIN_NAME?: string | undefined }): HostedLoginView | null {
  if (!config.AUTH_HOSTED_LOGIN_URL || !config.AUTH_HOSTED_LOGIN_TOKEN_URL) return null;
  return { url: config.AUTH_HOSTED_LOGIN_URL, tokenUrl: config.AUTH_HOSTED_LOGIN_TOKEN_URL, name: hostedLoginName(config.AUTH_HOSTED_LOGIN_NAME) };
}

// The origin the app's connect-src must allow for the token endpoint, or null when the feature is off.
export function hostedLoginTokenOrigin(config: { AUTH_HOSTED_LOGIN_TOKEN_URL?: string | undefined }): string | null {
  return config.AUTH_HOSTED_LOGIN_TOKEN_URL ? new URL(config.AUTH_HOSTED_LOGIN_TOKEN_URL).origin : null;
}
