// SPDX-License-Identifier: AGPL-3.0-only
// The token of a sent quote's public page lives after the # of its address (/-/quote#<token>) and goes to the API in a POST body only. A hash-only change in the same tab
// (a second quote link opened where the first is shown) does not reload the page, so the page follows the hash instead of reading it once (#2827).
import { QUOTE_TOKEN_PATTERN } from '@crove/kernel-contract';

// The token in the address now, or null when there is none or it is not shaped like one.
export const quoteTokenOfHash = (): string | null => {
  const t = window.location.hash.replace(/^#/, '');
  return QUOTE_TOKEN_PATTERN.test(t) ? t : null;
};

// Tells `onChange` whenever the hash changes; returns the way to stop (the shape useSyncExternalStore takes).
export function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
