// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in providers the app offers as buttons (issue #2704): AUTH_OAUTH_PROVIDERS, a comma or space separated list of
// the provider ids the Supabase-compatible identity provider has switched on (`google`, `github`, ...). The app signs in
// with auth-js `signInWithOAuth` (PKCE) at PUBLIC_AUTH_URL, so the result is an ordinary browser session the kernel
// verifies like any other (ADR-0028); Ludy holds no provider credential. The list only decides which buttons show:
// the identity provider refuses a provider it has not enabled, and AUTH_ALLOWED_EMAILS still decides who may use the
// deployment.
const PROVIDER_ID = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_OAUTH_PROVIDERS = 12;

export function parseOauthProviders(raw: string): { providers: string[]; invalid: string[] } {
  const providers: string[] = [];
  const invalid: string[] = [];
  for (const entry of raw.split(/[\s,]+/).map((e) => e.trim()).filter(Boolean)) {
    const id = /[^\x21-\x7e]/.test(entry) ? null : entry.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (id !== null && PROVIDER_ID.test(id)) providers.push(id);
    else invalid.push(entry);
  }
  const unique = [...new Set(providers)];
  if (unique.length > MAX_OAUTH_PROVIDERS) invalid.push(...unique.slice(MAX_OAUTH_PROVIDERS));
  return { providers: unique.slice(0, MAX_OAUTH_PROVIDERS), invalid };
}
