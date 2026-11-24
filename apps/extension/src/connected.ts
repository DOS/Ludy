// SPDX-License-Identifier: AGPL-3.0-only
// The page the app sends the sign-in tab to (#4662, manifest `web_accessible_resources`: pages of the cloud address and localhost only). It takes the
// code out of the address first and clears the address, then lets src/signin.ts check the state and trade the code, and says the result. It asks the browser for
// nothing: closing its own tab needs no permission, and a refusal leaves the message for the member to read.
import { T } from './strings.ts';
import { completeTabSignIn, type TabSignInResult } from './signin.ts';

const root = document.getElementById('root') as HTMLElement;

function show(kind: TabSignInResult): void {
  const title = document.createElement('h1');
  const body = document.createElement('p');
  title.textContent = T.title;
  body.textContent = kind === 'connected' ? T.connectedBody : kind === 'denied' ? T.signInDenied : kind === 'failed' ? T.signInFailed : T.connectedNothing;
  if (kind !== 'connected') body.className = 'error';
  root.replaceChildren(title, body);
}

async function closeThisTab(): Promise<void> {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
}

const returned = location.href;
// The one-time code leaves the address bar and the tab's own history entry before anything else runs.
history.replaceState(null, '', location.pathname);
// Framed by another page (the page is web accessible to the app's address and localhost, and a page there could embed it): it answers nothing and trades nothing.
const result = window.top !== window ? 'nothing' : await completeTabSignIn(returned, { session: chrome.storage.session, local: chrome.storage.local, now: Date.now() });
show(result);
// Connected: the tab has done its work, so it closes itself after a moment; if the browser keeps it open, the message says the member may close it.
if (result === 'connected') setTimeout(() => void closeThisTab().catch(() => undefined), 2500);
