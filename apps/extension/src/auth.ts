// SPDX-License-Identifier: AGPL-3.0-only
// Sign-in through the app (ADR-0047 point 10, M8 #2582): the extension opens the Ludy sign-in in a browser window with
// its PKCE challenge, the member approves one org there, and the window returns to the extension's redirect address with a
// one-time code, which the extension trades for its token. The password and the app's session never reach the extension.
import { ludyUrl } from './ludy-address.ts';
import { FEATURES } from './features.ts';
import { signInScopes } from './agenda.ts';

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export async function newPkce(): Promise<Pkce> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge, state: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

// Conservative fallback for older deployments without `modules` in /api/config or stalled config discovery (#3742):
// requesting only `meetings` preserves sign-in compatibility on pre-notes servers.
export const FALLBACK_EXTENSION_SCOPES = ['meetings'] as const;

export function resolveSignInScopes(availableModules: readonly string[] | undefined | null): readonly string[] {
  if (!availableModules) return FALLBACK_EXTENSION_SCOPES;
  const matched = FEATURES.map((f) => f.scope).filter((scope) => availableModules.includes(scope));
  return matched.length > 0 ? matched : FALLBACK_EXTENSION_SCOPES;
}

// `withAgenda`: the member chose to see their next meetings (B2), so the consent page also lists the agenda scope; the plain sign-in never asks for it.
export function connectUrl(
  address: string,
  pkce: Pkce,
  redirectUri: string,
  deviceName: string,
  withAgenda = false,
  featureScopes: readonly string[] = FEATURES.map((f) => f.scope),
): string {
  const requested = featureScopes.length > 0 ? featureScopes : FALLBACK_EXTENSION_SCOPES;
  const params = new URLSearchParams({
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    state: pkce.state,
    scope: signInScopes(requested, withAgenda).join(' '),
    device: deviceName,
  });
  return `${ludyUrl(address, '/-/extension/connect')}?${params.toString()}`;
}

// The code and org slug the window came back with, or why not. A different state is another flow's answer: refused.
export function parseConnectResult(returnedUrl: string, pkce: Pkce, redirectUri: string): { code: string; org: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(returnedUrl);
  } catch {
    return { error: 'invalid' };
  }
  if (`${url.origin}${url.pathname}` !== redirectUri || url.searchParams.get('state') !== pkce.state) return { error: 'invalid' };
  const error = url.searchParams.get('error');
  if (error !== null) return { error: error === 'access_denied' ? 'access_denied' : 'invalid' };
  const code = url.searchParams.get('code');
  const org = url.searchParams.get('org');
  return code && org ? { code, org } : { error: 'invalid' };
}

export function deviceName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : 'Chrome';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'máy tính';
  return `Tiện ích Ludy, ${browser} trên ${os}`;
}
