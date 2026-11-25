// SPDX-License-Identifier: AGPL-3.0-only
// The browser-side parts of the shared minutes link (#4822), kept apart from the components so they can be tested without a DOM: the public page's request, the robots tag the page carries while it is
// open, the full address of a new link and the copy to the clipboard.
import type { MinutesPage } from '@ludy/kernel-contract';
import { apiUrl } from './api-base.ts';
import { apiErrorFromResponse } from './errors.ts';

// The page of a token. The token goes in a JSON body and never in the address; no cookie goes out and no Referer. null is the one answer for a link that does not open (a 404 of the server).
export async function loadMinutesPage(token: string, doFetch: typeof fetch = fetch): Promise<MinutesPage | null> {
  const res = await doFetch(apiUrl('/api/minutes/view'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json()) as MinutesPage;
}

// The part of a document the robots tag needs.
export interface RobotsDocument {
  createElement(tag: 'meta'): { name: string; content: string; remove(): void };
  head: { appendChild(node: unknown): unknown };
}

// Adds <meta name="robots" content="noindex,nofollow"> and returns the way to take it out again (the server also says it in a header, this covers a page opened from a cached shell).
export function addNoindexMeta(doc: RobotsDocument): () => void {
  const meta = doc.createElement('meta');
  meta.name = 'robots';
  meta.content = 'noindex,nofollow';
  doc.head.appendChild(meta);
  return () => meta.remove();
}

// The address a person sends: where the app is served plus the path the command answered (it holds the token after the #).
export const minutesShareUrl = (origin: string, path: string): string => `${origin.replace(/\/+$/, '')}${path}`;

export interface CopyEnv {
  clipboard?: { writeText(text: string): Promise<void> } | undefined;
  // The old way, for a browser or a frame that has no clipboard API: copies what an input has selected.
  execCopy?: (() => boolean) | undefined;
}

// Copies `text`; true when it worked. The clipboard API first, then the selected text of the field, and false (the person copies by hand) when neither does.
export async function copyText(text: string, env: CopyEnv): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the field
    }
  }
  try {
    return env.execCopy?.() === true;
  } catch {
    return false;
  }
}
