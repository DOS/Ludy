// SPDX-License-Identifier: AGPL-3.0-only
// The text another screen hands to a conversation's reply box while the Inbox is still opening (meetings integrations B5, #3169). The reply box only listens for REPLY_INSERT_EVENT
// while its thread is on screen, so a screen that has to navigate to the thread first leaves the text here and the box takes it once on mount. It lives in sessionStorage (this tab
// only), is keyed by the conversation, is taken once, is dropped when it is older than a few minutes or when another thread's box opens, and is never put in the address (a URL
// reaches logs and history). Nothing is sent from here: the person reads the text in the box, edits it and presses Send. No React imports, so it is unit tested.
const KEY = 'ludy:reply-handoff';
export const REPLY_HANDOFF_MAX_AGE_MS = 5 * 60_000;

interface Handoff {
  conversationId: string;
  text: string;
  at: number;
}

const store = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

/** Leaves the text for the reply box of this conversation. Returns false when the browser keeps nothing (the caller then opens the thread without a text). */
export function putReplyHandoff(conversationId: string, text: string, now: number = Date.now()): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(KEY, JSON.stringify({ conversationId, text, at: now } satisfies Handoff));
    return true;
  } catch {
    return false;
  }
}

/** What waits for this conversation's box, once: it is removed whatever it holds (taken, too old, or left for another thread), so it can never reach a later box. */
export function takeReplyHandoff(conversationId: string, now: number = Date.now()): string | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (raw === null) return null;
    s.removeItem(KEY);
    const v = JSON.parse(raw) as Partial<Handoff> | null;
    if (!v || typeof v.conversationId !== 'string' || typeof v.text !== 'string' || typeof v.at !== 'number') return null;
    if (v.conversationId !== conversationId) return null;
    if (now - v.at > REPLY_HANDOFF_MAX_AGE_MS || now < v.at) return null;
    return v.text;
  } catch {
    return null;
  }
}
