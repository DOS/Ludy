// SPDX-License-Identifier: AGPL-3.0-only
// A request that never got an answer (the server is down, the network dropped, the address is wrong) fails in the browser
// with its own English text: "Failed to fetch" (Chrome), "Load failed" (Safari), "NetworkError when attempting to fetch
// resource." (Firefox). The screens never show that text; they show the catalog's `common.networkError` (#3593, AU-2).

const BROWSER_TEXTS = new Set(['failed to fetch', 'load failed', 'networkerror when attempting to fetch resource.', 'fetch failed']);

// A thrown TypeError with one of the browsers' texts, or the error auth-js returns when its request got no answer
// (AuthRetryableFetchError with status 0; a gateway's 502, 503 or 504 did get one, so it is not matched).
export function isNetworkFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const e = error as { name?: unknown; message?: unknown; status?: unknown };
  if (e.name === 'AuthRetryableFetchError') return e.status === 0;
  return error instanceof TypeError && typeof e.message === 'string' && BROWSER_TEXTS.has(e.message.trim().toLowerCase());
}
