// SPDX-License-Identifier: AGPL-3.0-only
// The app and the API ship together (#2261): a bundle served from another origin (Vercel) is built from the release
// commit, the API reports the commit it runs on GET /version, and a page whose bundle is older or newer than the API asks
// for a reload instead of calling an API it does not match.
import { apiUrl } from './api-base.ts';

// The commit this bundle was built from; '' for a bundle the kernel serves itself (it always matches its API).
export const BUILD: string = (import.meta.env['VITE_BUILD'] as string | undefined) ?? '';

// How often a visible page asks, and the least time between two asks (a tab coming back to the front asks at once).
export const VERSION_POLL_MS = 5 * 60_000;
export const VERSION_MIN_GAP_MS = 60_000;

// True when both sides name a build and they differ. A bundle with no build, an API with no build or a local one
// ('dev'), or an answer that is not a build id never counts: only a clear mismatch asks for a reload.
export function isStaleBuild(mine: string, server: unknown): boolean {
  if (mine === '' || typeof server !== 'string') return false;
  if (server === '' || server === 'dev') return false;
  return server !== mine;
}

// The API's build from /version. A 503 (database down) still names the build; anything else, or a failure, is null.
export async function fetchServerBuild(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchFn(apiUrl('/version'), { credentials: 'omit' });
    const body = (await response.json()) as { build?: unknown };
    return typeof body.build === 'string' ? body.build : null;
  } catch {
    return null;
  }
}
