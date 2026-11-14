// SPDX-License-Identifier: AGPL-3.0-only
// The "continue with a provider" buttons of the sign-in screen (issue #2704). The kernel sends the provider ids the
// identity provider has enabled (/api/config authProviders); the button starts auth-js signInWithOAuth (PKCE), which
// returns an ordinary session through the same one-time code the email links use (settleCallback).
const NAMES: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  gitlab: 'GitLab',
  apple: 'Apple',
  azure: 'Microsoft',
  facebook: 'Facebook',
  discord: 'Discord',
  twitter: 'X',
  x: 'X',
  twitch: 'Twitch',
  linkedin_oidc: 'LinkedIn',
  slack_oidc: 'Slack',
  spotify: 'Spotify',
  notion: 'Notion',
  bitbucket: 'Bitbucket',
  kakao: 'Kakao',
  zoom: 'Zoom',
};

const PROVIDER_ID = /^[a-z][a-z0-9_]{0,31}$/;

// The ids a screen may offer: well-formed, once each, at most 12 (the kernel enforces the same; a server of another
// version, or a hand-edited config, never makes the screen build a button from anything else).
export function offeredProviders(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((id) => PROVIDER_ID.test(id)))].slice(0, 12);
}

export function providerLabel(id: string): string {
  return NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ');
}
