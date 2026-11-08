// SPDX-License-Identifier: AGPL-3.0-only
// The popup: the shell (address, sign-in, org picker, the features of this org) and the meetings feature (turn on, the
// consent step, "Ghi cả video", start and stop). Every string is set as text, never as markup. Nothing here reads a page:
// the one tab it touches is the active one the member clicked the icon on, and only to ask for its audio.
import { T } from './strings.ts';
import { DEFAULT_ADDRESS, isDefaultAddress, originPattern, parseAddress } from './ludy-address.ts';
import { activeAccount, loadState, saveState, withAccount, withAddress, withFeature, withoutAccount, type State } from './state.ts';
import { visibleFeatures, FEATURES, type Me } from './features.ts';
import { connectUrl, deviceName, newPkce, parseConnectResult } from './auth.ts';
import { createClient, LudyError } from './api.ts';
import { CONSENT_METHODS, consentBlocker } from './consent.ts';
import { RECORDING_KEY, type RecordingState, type StartReply, type StopReply } from './messages.ts';
import { formatClock, createIndexedDbChunkStore, type RecordingMeta } from '@crove/meeting-recorder';
import { uploadSaved } from './capture-run.ts';

const root = document.getElementById('root') as HTMLElement;
const area = chrome.storage.local;
const store = createIndexedDbChunkStore();

type Child = Node | string | null | false;
type Props = Record<string, string | boolean | (() => unknown) | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') (el as unknown as Record<string, unknown>)[k] = v;
    else if (v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

let notice = '';
let draft = { title: '', consentMethod: '', consentAgreed: false, keepVideo: false };
let ticker: ReturnType<typeof setInterval> | undefined;

async function render(): Promise<void> {
  clearInterval(ticker);
  const state = await loadState(area);
  const view = h('div');
  view.append(h('h1', {}, T.title));
  const account = activeAccount(state);
  if (!account) view.append(...signInView(state));
  else view.append(...(await signedInView(state)));
  if (notice) view.append(h('p', { class: 'error', role: 'alert' }, notice));
  root.replaceChildren(view);
}

function addressForm(state: State): Node[] {
  const self = !isDefaultAddress(state.address);
  const input = h('input', { type: 'text', id: 'address', placeholder: T.addressPlaceholder, value: self ? state.address : '', 'aria-label': T.selfHosted });
  const cloud = h('input', { type: 'radio', name: 'where', id: 'where-cloud', checked: !self });
  const own = h('input', { type: 'radio', name: 'where', id: 'where-own', checked: self });
  return [
    h('div', { class: 'row' }, cloud, h('label', { for: 'where-cloud' }, T.cloud)),
    h('div', { class: 'row' }, own, h('label', { for: 'where-own' }, T.selfHosted)),
    input,
    h('button', {
      onclick: () =>
        void (async () => {
          notice = '';
          const typed = (own as HTMLInputElement).checked ? parseAddress(input.value) : { origin: DEFAULT_ADDRESS };
          if ('problem' in typed) {
            notice = typed.problem === 'insecure' ? T.addressInsecure : T.addressInvalid;
          } else {
            // The browser asks for this one address only, on this click; the default address is in the install.
            const granted = isDefaultAddress(typed.origin) || (await chrome.permissions.request({ origins: [originPattern(typed.origin)] }));
            if (granted) await saveState(area, withAddress(state, typed.origin));
            else notice = T.addressDenied;
          }
          await render();
        })(),
    }, T.save),
  ];
}

function signInView(state: State): Node[] {
  return [
    h('h2', {}, T.setupTitle),
    ...addressForm(state),
    h('p', { class: 'note' }, state.address),
    h('button', { class: 'primary', onclick: () => void signIn(state) }, T.signIn),
  ];
}

async function signIn(state: State): Promise<void> {
  notice = T.signingIn;
  await render();
  try {
    const pkce = await newPkce();
    const redirect = chrome.identity.getRedirectURL('connect');
    const returned = await chrome.identity.launchWebAuthFlow({ url: connectUrl(state.address, pkce, redirect, deviceName(navigator.userAgent)), interactive: true });
    const result = returned ? parseConnectResult(returned, pkce, redirect) : { error: 'invalid' };
    if ('error' in result) {
      notice = result.error === 'access_denied' ? T.signInDenied : T.signInFailed;
    } else {
      const done = await createClient(state.address, null).exchangeCode(result.code, pkce.verifier);
      await saveState(area, withAccount(await loadState(area), { orgId: done.orgId, orgSlug: result.org, token: done.token, expiresAt: done.expiresAt }));
      notice = '';
    }
  } catch {
    notice = T.signInFailed;
  }
  await render();
}

async function signedInView(state: State): Promise<Node[]> {
  const account = activeAccount(state);
  if (!account) return [];
  const out: Node[] = [];
  const orgs = Object.values(state.accounts);
  const picker = h('select', { id: 'org', 'aria-label': T.org, onchange: () => void (async () => {
    const next = { ...(await loadState(area)), activeOrg: picker.value };
    await saveState(area, next);
    await render();
  })() }, ...orgs.map((a) => h('option', { value: a.orgId, selected: a.orgId === account.orgId }, a.orgSlug)));
  out.push(
    h('label', { class: 'block', for: 'org' }, T.org),
    picker,
    h('div', { class: 'row' },
      h('button', { onclick: () => void signIn(state) }, T.addOrg),
      h('button', { onclick: () => void (async () => { await saveState(area, withoutAccount(await loadState(area), account.orgId)); await render(); })() }, T.signOut),
    ),
    h('p', { class: 'note' }, `${state.address} · ${T.signOutNote}`),
  );
  let me: Me | null = null;
  try {
    me = await createClient(state.address, account.token).me();
  } catch (error) {
    // A token the server no longer accepts is dropped here, so the member signs in again.
    if (error instanceof LudyError && error.status === 401) await saveState(area, withoutAccount(await loadState(area), account.orgId));
    notice = T.loadFailed;
    return out;
  }
  const features = visibleFeatures(me);
  if (features.length === 0) out.push(h('p', {}, T.noFeatures));
  for (const feature of features) if (feature.id === 'meetings') out.push(...(await meetingsView(state)));
  out.push(...(await pendingView(state, account.orgId, account.token)));
  return out;
}

async function meetingsView(state: State): Promise<Node[]> {
  const feature = FEATURES[0]!;
  const out: Node[] = [h('h2', {}, T.meetings)];
  const granted = await chrome.permissions.contains({ permissions: [...feature.permissions] });
  if (!granted || state.enabled.meetings !== true) {
    out.push(
      h('p', { class: 'note' }, T.meetingsNote),
      h('button', { class: 'primary', onclick: () => void turnOn(state) }, T.meetingsOn),
    );
    return out;
  }
  const recording = (await area.get(RECORDING_KEY))[RECORDING_KEY] as RecordingState | undefined;
  if (recording) {
    const clock = h('span', { class: 'rec' });
    const tick = () => void (clock.textContent = `REC ${formatClock(Date.now() - recording.startedAt)}`);
    tick();
    ticker = setInterval(tick, 1000);
    out.push(
      h('p', {}, clock, ` · ${recording.title}`),
      ...(recording.micMissing ? [h('p', { class: 'error' }, T.micMissing)] : []),
      h('button', { class: 'danger', onclick: () => void stopRecording() }, T.stop),
    );
    return out;
  }
  const title = h('input', { type: 'text', id: 'title', value: draft.title, maxlength: '200' });
  title.addEventListener('input', () => void (draft.title = title.value));
  const method = h('select', { id: 'method' },
    h('option', { value: '' }, T.consentChoose),
    ...CONSENT_METHODS.map((m) => h('option', { value: m, selected: draft.consentMethod === m }, T.consentMethods[m])));
  method.addEventListener('change', () => void (draft.consentMethod = method.value));
  const agreed = h('input', { type: 'checkbox', id: 'agreed', checked: draft.consentAgreed });
  agreed.addEventListener('change', () => void (draft.consentAgreed = agreed.checked));
  // Off by default, and off again for each new recording unless ticked.
  const video = h('input', { type: 'checkbox', id: 'video', checked: draft.keepVideo });
  video.addEventListener('change', () => void (draft.keepVideo = video.checked));
  out.push(
    h('label', { class: 'block', for: 'title' }, T.meetingTitle),
    title,
    h('div', { class: 'consent' },
      h('strong', {}, T.consentTitle),
      h('p', { class: 'note' }, T.consentNotice),
      h('p', { class: 'note' }, T.consentSpoken),
      h('label', { class: 'block', for: 'method' }, T.consentMethod),
      method,
      h('div', { class: 'row' }, agreed, h('label', { for: 'agreed' }, T.consentConfirm)),
    ),
    h('div', { class: 'row' }, video, h('label', { for: 'video' }, T.withVideo)),
    h('button', { class: 'primary', id: 'start', onclick: () => void startRecording() }, T.start),
    h('button', { onclick: () => void turnOff(state) }, T.meetingsOff),
  );
  return out;
}

async function turnOn(state: State): Promise<void> {
  notice = '';
  const feature = FEATURES[0]!;
  // The browser asks for tab capture and the offscreen document on this click, and nothing is asked before it.
  if (!(await chrome.permissions.request({ permissions: [...feature.permissions] }))) {
    notice = T.permissionDenied;
  } else {
    await saveState(area, withFeature(state, 'meetings', true));
    // The microphone prompt cannot show in an offscreen document: the member answers it once on a page of the extension.
    const mic = await navigator.permissions.query({ name: 'microphone' as PermissionName }).catch(() => null);
    if (mic?.state !== 'granted') await chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
  }
  await render();
}

async function turnOff(state: State): Promise<void> {
  await chrome.permissions.remove({ permissions: [...FEATURES[0]!.permissions] });
  await saveState(area, withFeature(state, 'meetings', false));
  await render();
}

async function startRecording(): Promise<void> {
  notice = '';
  const blocker = consentBlocker(draft);
  if (blocker) {
    notice = T.blockers[blocker];
    await render();
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('no tab');
    // Only after the member's click here, and only for the tab they are on.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const reply = (await chrome.runtime.sendMessage({ type: 'start', ...draft, streamId })) as StartReply;
    if (reply.ok) draft = { title: '', consentMethod: '', consentAgreed: false, keepVideo: false };
    else notice = T.blockers[reply.reason];
  } catch {
    notice = T.blockers.device;
  }
  await render();
}

async function stopRecording(): Promise<void> {
  notice = T.uploading;
  await render();
  const reply = (await chrome.runtime.sendMessage({ type: 'stop' })) as StopReply;
  notice = reply.ok && reply.uploaded ? T.uploaded : T.uploadFailed;
  await render();
}

async function pendingView(state: State, orgId: string, token: string): Promise<Node[]> {
  const left = await store.list(orgId).catch(() => [] as RecordingMeta[]);
  const recording = (await area.get(RECORDING_KEY))[RECORDING_KEY];
  // A recording still being written is not "left over".
  const idle = left.filter((m) => !recording || (recording as RecordingState).meetingId !== m.meetingId);
  if (idle.length === 0) return [];
  const client = createClient(state.address, token);
  return [
    h('h2', {}, T.pending),
    ...idle.map((meta) =>
      h('div', { class: 'row' },
        h('span', {}, `${meta.title} (${formatClock(meta.elapsedMs)})`),
        h('button', { onclick: () => void (async () => {
          const { uploads } = await client.config().catch(() => ({ uploads: 'direct' as const }));
          const done = await uploadSaved({ store }, client, uploads, meta);
          notice = done.ok ? T.uploaded : T.uploadFailed;
          await render();
        })() }, T.retry),
        h('button', { onclick: () => void store.remove(meta.id).then(render) }, T.discard),
      )),
  ];
}

void render();
