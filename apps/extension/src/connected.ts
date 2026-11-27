// SPDX-License-Identifier: AGPL-3.0-only
// The page the app sends the sign-in tab to (#4662, manifest `web_accessible_resources`: pinned App origin only). It takes the
// code out of the address first and clears the address, then lets src/signin.ts check the state and trade the code against the
// API origin, and shows the result.
import { T } from './strings.ts';
import { completeTabSignIn, type TabSignInResult } from './signin.ts';

const root = document.getElementById('root') as HTMLElement;

function show(kind: TabSignInResult): HTMLParagraphElement | null {
  const card = document.createElement('div');
  card.className = 'connected-card';

  const logo = document.createElement('img');
  logo.className = 'connected-logo';
  logo.src = 'icons/icon-48.png';
  logo.alt = '';
  logo.width = 48;
  logo.height = 48;

  const badge = document.createElement('span');
  badge.className = `status-badge ${kind === 'connected' ? 'badge-success' : kind === 'failed' ? 'badge-danger' : 'badge-warn'}`;
  badge.textContent = kind === 'connected' ? T.connectedStatusOk : T.connectedStatusError;

  const title = document.createElement('h1');
  title.textContent = T.title;

  const body = document.createElement('p');
  body.className = kind === 'connected' ? 'connected-body' : 'connected-body error';
  body.textContent = kind === 'connected' ? T.connectedBody : kind === 'denied' ? T.signInDenied : kind === 'failed' ? T.signInFailed : T.connectedNothing;

  card.append(logo, badge, title, body);
  let countdown: HTMLParagraphElement | null = null;
  if (kind === 'connected') {
    countdown = document.createElement('p');
    countdown.id = 'close-countdown';
    countdown.className = 'countdown';
    countdown.setAttribute('role', 'status');
    countdown.textContent = T.connectedCountdown.replace('{seconds}', '2');
    card.append(countdown);
  }
  root.replaceChildren(card);
  return countdown;
}

async function closeThisTab(): Promise<void> {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
}

const returned = location.href;
// The one-time code leaves the address bar and the tab's own history entry before anything else runs.
history.replaceState(null, '', location.pathname);
// Framed by another page: it answers nothing and trades nothing.
const result = window.top !== window ? 'nothing' : await completeTabSignIn(returned, { session: chrome.storage.session, local: chrome.storage.local, now: Date.now() });
const countdownEl = show(result);
// Connected: count down briefly and close the tab automatically; if the browser keeps it open, the message explains it may be closed.
if (result === 'connected') {
  setTimeout(() => {
    if (countdownEl) countdownEl.textContent = T.connectedCountdown.replace('{seconds}', '1');
  }, 1000);
  setTimeout(() => {
    void closeThisTab().catch(() => undefined);
  }, 2200);
}
