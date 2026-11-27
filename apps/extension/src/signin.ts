// SPDX-License-Identifier: AGPL-3.0-only
// Sign-in in a normal browser tab (#4662). The popup closes when a new tab takes focus, so the answer cannot come back to
// it: the extension keeps the PKCE verifier and the state of the flow in chrome.storage.session, opens the App origin's
// /-/extension/connect page in a tab, and the App sends that tab to connected.html with the one-time code. That page
// verifies the state and exchanges the code against the API origin (apiAddress).
import { createClient } from './api.ts';
import { parseConnectResult } from './auth.ts';
import { NOTES_SCOPE } from './page-capture.ts';
import { loadState, saveState, withAccount, type StorageArea } from './state.ts';

export const CONNECTED_PAGE = 'connected.html';
export const PENDING_KEY = 'ludy-pending-signin';
export const NOTES_EXCLUDED_KEY = 'ludy-notes-excluded-orgs';
// Long enough to sign in and pass a second factor; the app keeps its own half of the request for the same time (apps/app/src/lib/extension-connect.ts).
export const PENDING_TTL_MS = 10 * 60 * 1000;

export interface PendingSignIn {
  verifier: string;
  state: string;
  appAddress: string;
  apiAddress: string;
  // The address the app sends the tab to: this extension's connected page.
  redirect: string;
  // The sign-in asked for the notes scope: an org that does not give it is remembered, so the popup does not ask again.
  notesAsked: boolean;
  startedAt: number;
}

// What the storage holds is checked, not trusted: anything else, or an old record, is no pending sign-in.
export function readPending(raw: unknown, now: number): PendingSignIn | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<PendingSignIn>;
  if (
    typeof r.verifier !== 'string' ||
    typeof r.state !== 'string' ||
    typeof r.appAddress !== 'string' ||
    r.appAddress === '' ||
    typeof r.apiAddress !== 'string' ||
    r.apiAddress === '' ||
    typeof r.redirect !== 'string'
  ) {
    return null;
  }
  if (typeof r.notesAsked !== 'boolean' || typeof r.startedAt !== 'number') return null;
  if (r.startedAt > now || now - r.startedAt >= PENDING_TTL_MS) return null;
  return {
    verifier: r.verifier,
    state: r.state,
    appAddress: r.appAddress,
    apiAddress: r.apiAddress,
    redirect: r.redirect,
    notesAsked: r.notesAsked,
    startedAt: r.startedAt,
  };
}

// Whether the manifest lets pages of `appAddress` reach connected.html: one of the `matches` of the entry that lists it
// covers the address (scheme and host; a match pattern ignores the port).
export function tabSignInCovers(manifest: { web_accessible_resources?: Array<{ resources?: string[]; matches?: string[] }> }, appAddress: string): boolean {
  let url: URL;
  try {
    url = new URL(appAddress);
  } catch {
    return false;
  }
  for (const entry of manifest.web_accessible_resources ?? []) {
    if (!entry.resources?.includes(CONNECTED_PAGE)) continue;
    for (const pattern of entry.matches ?? []) {
      const parts = /^(https?):\/\/([^/*]+)\/\*$/.exec(pattern);
      if (parts && `${parts[1]}:` === url.protocol && parts[2] === url.hostname) return true;
    }
  }
  return false;
}

// The address of this extension's landing page as the browser gives it (chrome.runtime.getURL): the one form the app accepts as a redirect for the tab sign-in. A browser that
// gives another form (another scheme) would have the app refuse the request, so the sign-in then uses the browser window instead.
export const isExtensionPageAddress = (url: string): boolean => /^chrome-extension:\/\/[a-p]{32}\/connected\.html$/.test(url);

export type TabSignInResult = 'connected' | 'denied' | 'failed' | 'nothing';

type Exchange = (apiAddress: string, code: string, verifier: string) => Promise<{ token: string; tokenId?: string; orgId: string; scopes: string[]; expiresAt: string }>;
const exchangeWithKernel: Exchange = (apiAddress, code, verifier) => createClient(apiAddress, null).exchangeCode(code, verifier);

// The orgs whose sign-in asked for the notes scope and did not get it (the org has no Notes), kept for this browser session.
export async function loadNotesExcluded(session: StorageArea): Promise<Set<string>> {
  const raw = (await session.get(NOTES_EXCLUDED_KEY))[NOTES_EXCLUDED_KEY];
  return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
}

export async function rememberNotesExcluded(session: StorageArea, orgId: string, excluded: boolean): Promise<void> {
  const set = await loadNotesExcluded(session);
  if (excluded) set.add(orgId);
  else set.delete(orgId);
  await session.set({ [NOTES_EXCLUDED_KEY]: [...set] });
}

// The connected page's work: the address the app sent the tab back to, checked against the pending sign-in. A tab whose state is not the pending one is no answer to
// this flow (a stale or foreign page): it does not use up the pending sign-in, so the flow in progress still finishes. Once the state matches, the pending record is
// used up (a reload of the page or a second tab finds nothing) and the answer is read exactly as the window flow reads it (parseConnectResult).
export async function completeTabSignIn(
  returnedUrl: string,
  deps: { session: StorageArea; local: StorageArea; now: number; exchange?: Exchange },
): Promise<TabSignInResult> {
  try {
    const pending = readPending((await deps.session.get(PENDING_KEY))[PENDING_KEY], deps.now);
    if (!pending) return 'nothing';
    let returnedState: string | null;
    try {
      returnedState = new URL(returnedUrl).searchParams.get('state');
    } catch {
      return 'nothing';
    }
    if (returnedState !== pending.state) return 'nothing';
    await deps.session.remove(PENDING_KEY);
    const result = parseConnectResult(returnedUrl, { verifier: pending.verifier, challenge: '', state: pending.state }, pending.redirect);
    if ('error' in result) return result.error === 'access_denied' ? 'denied' : 'failed';
    const state = await loadState(deps.local);
    // The built-in origins changed while the tab was open: a token for the old origins must not become an account of the new ones.
    if (state.appAddress !== pending.appAddress || state.apiAddress !== pending.apiAddress) return 'failed';
    const done = await (deps.exchange ?? exchangeWithKernel)(pending.apiAddress, result.code, pending.verifier);
    await rememberNotesExcluded(deps.session, done.orgId, pending.notesAsked && !done.scopes.includes(NOTES_SCOPE));
    await saveState(
      deps.local,
      withAccount(await loadState(deps.local), {
        orgId: done.orgId,
        orgSlug: result.org,
        token: done.token,
        expiresAt: done.expiresAt,
        ...(done.tokenId ? { tokenId: done.tokenId } : {}),
      }),
    );
    return 'connected';
  } catch {
    // A storage or network failure is a failed sign-in the page can say so about, not a blank page.
    return 'failed';
  }
}
