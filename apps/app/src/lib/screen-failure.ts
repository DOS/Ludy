// SPDX-License-Identifier: AGPL-3.0-only
// What the sign-in, sign-up and reset screens keep of a failure, worded at render so a language switch rewords it (#215):
// a network failure (no answer from the server, #3593 AU-2), or what Supabase Auth said (lib/auth.ts).
import type { Translate } from '../i18n/runtime.ts';
import { authErrorText, authFailure, type AuthFailure } from './auth.ts';
import { isNetworkFailure } from './network-error.ts';

export type ScreenFailure = AuthFailure | { network: true };

// The error a Supabase Auth call returned.
export function screenFailure(error: { code?: string | undefined; message: string }): ScreenFailure {
  return isNetworkFailure(error) ? { network: true } : authFailure(error);
}

// An error a call threw: a network failure, or a generic code. Never its text, which may name an address or a token.
export function thrownFailure(error: unknown): ScreenFailure {
  return isNetworkFailure(error) ? { network: true } : authFailure({ code: 'unexpected_failure', message: '' });
}

export function screenFailureText(failure: ScreenFailure, t: Translate): string {
  return 'network' in failure ? t('common.networkError') : authErrorText(failure, t);
}
