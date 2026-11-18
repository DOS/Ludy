// SPDX-License-Identifier: AGPL-3.0-only
// The contact suggestions a person skipped in the Inbox (#3637): "Bỏ qua" is remembered per thread, so a skipped contact does not come back for it. It is a convenience
// of this person in this browser, kept in localStorage (a thread is never changed by a skip), so every read and write is guarded: private windows and blocked storage just
// forget. At most the last DISMISSED_THREADS_MAX threads are kept.
const KEY = 'ludy:dismissed-contact-matches';
export const DISMISSED_THREADS_MAX = 200;

type Store = Record<string, string[]>;

function read(): Store {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: Store = {};
    for (const [id, parties] of Object.entries(parsed)) if (Array.isArray(parties)) store[id] = parties.filter((p): p is string => typeof p === 'string');
    return store;
  } catch {
    return {};
  }
}

export function dismissedContactMatches(conversationId: string): string[] {
  return read()[conversationId] ?? [];
}

export function dismissContactMatch(conversationId: string, partyId: string): string[] {
  const store = read();
  const next = [...new Set([...(store[conversationId] ?? []), partyId])];
  // Re-insert so the newest thread is last, then keep the newest few.
  delete store[conversationId];
  store[conversationId] = next;
  const kept = Object.entries(store).slice(-DISMISSED_THREADS_MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Not remembered; the skip still holds for this view.
  }
  return next;
}
