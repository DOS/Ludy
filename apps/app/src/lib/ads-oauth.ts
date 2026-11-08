// SPDX-License-Identifier: AGPL-3.0-only
// Starting an ad platform's OAuth dialog from the Ads screen (ADR-0040, #2218; ADR-0043, #2294 W0b). Connecting an ad account for
// reading (`meta_ads`) and connecting it to run ads (`metawrite_ads`) are the same flow with another provider: the server makes
// the attempt, this browser remembers which org it was for, and Meta's own sign-in dialog runs in this tab and comes back to the
// callback screen (routes/social-oauth.tsx), which finishes the attempt.
import { useMutation } from '@tanstack/react-query';
import type { OAUTH_AD_PROVIDERS } from '@crove/kernel-contract';
import { client } from './api.ts';
import { rememberOAuthAttempt } from './oauth.ts';

export type AdOAuthProvider = (typeof OAUTH_AD_PROVIDERS)[number];

export function useAdOAuthStart(slug: string, provider: AdOAuthProvider) {
  return useMutation({
    mutationFn: () => client.channels.oauthStart({ provider }),
    onSuccess: (attempt) => {
      rememberOAuthAttempt(attempt.state, slug);
      window.location.assign(attempt.authorizeUrl);
    },
  });
}
