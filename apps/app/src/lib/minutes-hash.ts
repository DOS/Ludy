// SPDX-License-Identifier: AGPL-3.0-only
// The token of a shared minutes page lives after the # of its address (/-/minutes#<token>, #4822) and goes to the API in a POST body only; a hash never reaches a server log, a proxy or a Referer header.
// The page follows the hash the way the quote page does (a second link opened in the same tab does not reload it), so it reuses the same subscription.
import { MINUTES_TOKEN_PATTERN } from '@ludy/kernel-contract';

export { subscribeToHash } from './quote-hash.ts';

// The token in the address now, or null when there is none or it is not shaped like one.
export const minutesTokenOfHash = (): string | null => {
  const t = window.location.hash.replace(/^#/, '');
  return MINUTES_TOKEN_PATTERN.test(t) ? t : null;
};
