// SPDX-License-Identifier: AGPL-3.0-only
// The popup: the shell (address, sign-in, org picker, the features of this org) and the meetings feature (turn on, the
// consent step, "Ghi cả video", start and stop). Every string is set as text, never as markup. Nothing here reads a page:
// the one tab it touches is the active one the member clicked the icon on, and only to ask for its audio.
import { ENGLISH, T } from './strings.ts';
import { DEFAULT_ADDRESS, isDefaultAddress, originPattern, parseAddress, stalePattern } from './ludy-address.ts';
import { activeAccount, createCaptureDraftStore, loadState, saveState, withAccount, withAddress, withFeature, withoutAccount, type State } from './state.ts';
import { permissionsToRemove, visibleFeatures, FEATURES, type Me } from './features.ts';
import { AGENDA_SCOPE, agendaLine, type AgendaNext } from './agenda.ts';
import { connectUrl, deviceName, newPkce, parseConnectResult, resolveSignInScopes } from './auth.ts';
import { createClient, LudyError } from './api.ts';
import { CONSENT_METHODS, consentBlocker } from './consent.ts';
import { LOST_KEY, readLost, RECORDING_KEY, tabAddress, type LostState, type RecordingState, type StartReply, type StopReply } from './messages.ts';
import { captureActiveTab, CLIP_BODY_MAX, CLIP_TITLE_MAX, NOTES_SCOPE, parseTagsInput, WEB_CLIPPER_PERMISSIONS } from './page-capture.ts';
import { formatClock, createIndexedDbChunkStore, noticeToCopy, otherNoticeLanguage, RECORDING_NOTICE, type RecordingMeta, type RecordingNoticeLanguage } from '@ludy/meeting-recorder';
import { reportEnded, uploadSaved } from './capture-run.ts';
import { createPopupConcurrency } from './popup-guards.ts';

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
let draft = { title: '', consentMethod: '', consentAgreed: false, keepVideo: false, liveNotes: false };
let ticker: ReturnType<typeof setInterval> | undefined;
// The recording notice shown in the consent step (A1, #3159): the popup's language first, the other one a click away. The
// extension knows no meeting language before the meeting exists, so the browser's language is the default.
let noticeLang: RecordingNoticeLanguage = T === ENGLISH ? 'en' : 'vi';
let copyNote = '';
// Shown under the "Sắp họp" cards after a title was filled in from one.
let agendaNote = '';
let agendaRead: { token: string; promise: Promise<AgendaNext | null> } | null = null;
let serverModules: { address: string; promise: Promise<readonly string[] | null> } | null = null;
const notesExcludedOrgs = new Set<string>();
// Set when the org refused the method as not written (A2, #3160): the unwritten choice is then not offered for the rest of this popup.
let strictOrg = false;
const CONFIG_DISCOVERY_TIMEOUT_MS = 3_000;
const captureDrafts = createCaptureDraftStore();
let activeTabJustGranted = false;
const concurrency = createPopupConcurrency();

function clearTicker(): void {
  clearInterval(ticker);
  ticker = undefined;
}

async function copyNotice(): Promise<void> {
  let needsRender = false;
  await concurrency.runNoticeCopy(
    () => navigator.clipboard.writeText(noticeToCopy(noticeLang).text),
    (copied) => {
      copyNote = copied ? T.noticeCopied : T.noticeCopyFailed;
      const existing = document.getElementById('copy-note');
      if (existing) {
        existing.textContent = copyNote;
        return;
      }
      const row = document.getElementById('copy-notice')?.parentElement;
      if (row) {
        row.after(h('p', { class: 'note', id: 'copy-note', role: 'status' }, copyNote));
        return;
      }
      needsRender = true;
    },
  );
  if (needsRender) await render();
}

function toggleNoticeLanguage(): void {
  concurrency.invalidateNoticeOp();
  noticeLang = otherNoticeLanguage(noticeLang);
  copyNote = '';
  const textEl = document.getElementById('notice-text');
  const langBtn = document.getElementById('notice-lang');
  if (textEl && langBtn) {
    textEl.lang = noticeLang;
    textEl.textContent = RECORDING_NOTICE.text[noticeLang];
    langBtn.textContent = otherNoticeLanguage(noticeLang) === 'en' ? T.noticeShowEn : T.noticeShowVi;
    document.getElementById('copy-note')?.remove();
    return;
  }
  void render();
}

async function render(): Promise<void> {
  await concurrency.runRender(clearTicker, async (pass) => {
    const state = await loadState(area);
    if (!pass.isCurrent()) return null;
    const { changed } = captureDrafts.syncState(state);
    if (changed && notice !== T.signingIn) notice = '';
    const view = h('div');
    view.append(h('h1', {}, T.title));
    const account = activeAccount(state);
    if (!account) view.append(...signInView(state));
    else view.append(...(await signedInView(state, pass.onMount)));
    if (!pass.isCurrent()) return null;
    return () => {
      if (notice) view.append(h('p', { class: 'error', role: 'alert' }, notice));
      root.replaceChildren(view);
    };
  });
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
            // A refused or failing request (the browser throws for a pattern the manifest does not list) says the same thing.
            const granted = isDefaultAddress(typed.origin) || (await chrome.permissions.request({ origins: [originPattern(typed.origin)] }).catch(() => false));
            if (granted) {
              // The state is read again here, not taken from when this popup was drawn: another popup may have moved the address in
              // between, and the permission to give back is the one of the address that is stored now, not the one this popup showed.
              const current = await loadState(area);
              const next = withAddress(current, typed.origin);
              if (next.address !== current.address) {
                captureDrafts.clearAll();
                serverModules = null;
              }
              await saveState(area, next);
              // The address moved: the browser permission for the previous self-hosted one is given back.
              const stale = stalePattern(current.address, typed.origin);
              if (stale) await chrome.permissions.remove({ origins: [stale] }).catch(() => false);
            } else notice = T.addressDenied;
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
    h('p', { class: 'note', id: 'sign-in-device-note' }, T.signInDeviceNote),
    h('button', { class: 'primary', onclick: () => void signIn(state) }, T.signIn),
  ];
}

async function signIn(state: State, withAgenda = false): Promise<void> {
  notice = T.signingIn;
  await render();
  try {
    const config = await createClient(state.address, null)
      .config({ signal: AbortSignal.timeout(CONFIG_DISCOVERY_TIMEOUT_MS) })
      .catch(() => null);
    const scopesToAsk = resolveSignInScopes(config?.modules);
    const askAgenda = withAgenda && scopesToAsk.includes('meetings');
    const pkce = await newPkce();
    const redirect = chrome.identity.getRedirectURL('connect');
    const returned = await chrome.identity.launchWebAuthFlow({
      url: connectUrl(state.address, pkce, redirect, deviceName(navigator.userAgent), askAgenda, scopesToAsk),
      interactive: true,
    });
    const result = returned ? parseConnectResult(returned, pkce, redirect) : { error: 'invalid' };
    if ('error' in result) {
      notice = result.error === 'access_denied' ? T.signInDenied : T.signInFailed;
    } else {
      const done = await createClient(state.address, null).exchangeCode(result.code, pkce.verifier);
      if (scopesToAsk.includes(NOTES_SCOPE) && !done.scopes.includes(NOTES_SCOPE)) notesExcludedOrgs.add(done.orgId);
      else notesExcludedOrgs.delete(done.orgId);
      const next = withAccount(await loadState(area), { orgId: done.orgId, orgSlug: result.org, token: done.token, expiresAt: done.expiresAt });
      captureDrafts.syncState(next);
      await saveState(area, next);
      notice = '';
    }
  } catch {
    notice = T.signInFailed;
  }
  await render();
}

async function signedInView(state: State, onMount: Array<() => void>): Promise<Node[]> {
  const account = activeAccount(state);
  if (!account) return [];
  const out: Node[] = [];
  const orgs = Object.values(state.accounts);
  const picker = h('select', { id: 'org', 'aria-label': T.org, onchange: () => void (async () => {
    const current = await loadState(area);
    const next = { ...current, activeOrg: picker.value };
    if (next.activeOrg !== current.activeOrg) notice = '';
    captureDrafts.syncState(next);
    await saveState(area, next);
    await render();
  })() }, ...orgs.map((a) => h('option', { value: a.orgId, selected: a.orgId === account.orgId }, a.orgSlug)));
  out.push(
    h('label', { class: 'block', for: 'org' }, T.org),
    picker,
    h('div', { class: 'row' },
      h('button', { onclick: () => void signIn(state) }, T.addOrg),
      h('button', { onclick: () => void (async () => {
        const current = await loadState(area);
        captureDrafts.clearScope(current.address, account.orgId);
        notice = '';
        const next = withoutAccount(current, account.orgId);
        captureDrafts.syncState(next);
        await saveState(area, next);
        await render();
      })() }, T.signOut),
    ),
    h('p', { class: 'note' }, `${state.address} · ${T.signOutNote}`),
  );
  let me: Me | null = null;
  try {
    me = await createClient(state.address, account.token).me();
  } catch (error) {
    // A token the server no longer accepts is dropped here, so the member signs in again.
    if (error instanceof LudyError && error.status === 401) {
      captureDrafts.clearScope(state.address, account.orgId);
      const next = withoutAccount(await loadState(area), account.orgId);
      captureDrafts.syncState(next);
      await saveState(area, next);
    }
    notice = T.loadFailed;
    return out;
  }
  const features = visibleFeatures(me);
  let showNotesAsk = false;
  if (!me.scopes.includes(NOTES_SCOPE) && !notesExcludedOrgs.has(account.orgId)) {
    if (serverModules?.address !== state.address) {
      serverModules = {
        address: state.address,
        promise: createClient(state.address, null)
          .config({ signal: AbortSignal.timeout(CONFIG_DISCOVERY_TIMEOUT_MS) })
          .then((c) => c.modules ?? null)
          .catch(() => {
            if (serverModules?.address === state.address) serverModules = null;
            return null;
          }),
      };
    }
    const installed = await serverModules.promise;
    showNotesAsk = Boolean(installed?.includes(NOTES_SCOPE));
  }
  if (features.length === 0 && !showNotesAsk) out.push(h('p', {}, T.noFeatures));
  if (showNotesAsk) {
    out.push(
      h('div', { class: 'capture-box', id: 'notes-ask' },
        h('p', { class: 'note' }, T.notesAskNote),
        h('button', { id: 'notes-reconnect', onclick: () => void signIn(state, me.scopes.includes(AGENDA_SCOPE)) }, T.notesReconnect)),
    );
  }
  for (const feature of features) {
    if (feature.id === 'meetings') out.push(...(await meetingsView(state, me, account.token, onMount)));
    else if (feature.id === 'notes') out.push(...(await notesView(state, account.orgId, account.token)));
  }
  out.push(...(await pendingView(state, account.orgId, account.token)));
  return out;
}

async function notesView(state: State, orgId: string, token: string): Promise<Node[]> {
  const clipperGranted = await chrome.permissions.contains({ permissions: [...WEB_CLIPPER_PERMISSIONS] }).catch(() => false);
  const clipperOn = clipperGranted && state.enabled.clipper === true;
  const scopeState = captureDrafts.get(state.address, orgId);
  const captureDraft = scopeState.draft;
  const notesStatus = scopeState.status;
  const notesBusy = scopeState.busy;
  const isNote = captureDraft.kind === 'note';

  const modeNoteBtn = h('button', {
    id: 'mode-note',
    class: isNote ? 'active-tab' : undefined,
    disabled: notesBusy,
    onclick: () => void ((captureDraft.kind = 'note'), (scopeState.status = ''), (notice = ''), render()),
  }, T.captureModeNote);
  const modeTodoBtn = h('button', {
    id: 'mode-todo',
    class: !isNote ? 'active-tab' : undefined,
    disabled: notesBusy,
    onclick: () => void ((captureDraft.kind = 'todo'), (scopeState.status = ''), (notice = ''), render()),
  }, T.captureModeTodo);

  const titleInput = h('input', {
    type: 'text',
    id: 'capture-title',
    value: captureDraft.title,
    maxlength: isNote ? String(CLIP_TITLE_MAX) : '300',
    disabled: notesBusy,
    placeholder: isNote ? T.captureTitleNotePlaceholder : T.captureTitleTodoPlaceholder,
  });
  titleInput.addEventListener('input', () => void (captureDraft.title = titleInput.value));

  const bodyFields: Node[] = [];
  if (isNote) {
    const bodyInput = h('textarea', {
      id: 'capture-body',
      maxlength: String(CLIP_BODY_MAX),
      disabled: notesBusy,
      placeholder: T.captureBodyPlaceholder,
    }, captureDraft.body);
    bodyInput.addEventListener('input', () => void (captureDraft.body = bodyInput.value));
    const tagsInput = h('input', {
      type: 'text',
      id: 'capture-tags',
      value: captureDraft.tags,
      disabled: notesBusy,
      placeholder: T.captureTagsPlaceholder,
    });
    tagsInput.addEventListener('input', () => void (captureDraft.tags = tagsInput.value));
    bodyFields.push(
      h('label', { class: 'block', for: 'capture-body' }, T.captureBody),
      bodyInput,
      h('label', { class: 'block', for: 'capture-tags' }, T.captureTags),
      tagsInput,
    );
  } else {
    const detailsInput = h('textarea', {
      id: 'capture-details',
      maxlength: '10000',
      disabled: notesBusy,
      placeholder: T.captureDetailsPlaceholder,
    }, captureDraft.details);
    detailsInput.addEventListener('input', () => void (captureDraft.details = detailsInput.value));
    const dueInput = h('input', {
      type: 'date',
      id: 'capture-due',
      value: captureDraft.dueOn,
      disabled: notesBusy,
    });
    dueInput.addEventListener('input', () => void (captureDraft.dueOn = dueInput.value));
    bodyFields.push(
      h('label', { class: 'block', for: 'capture-details' }, T.captureDetails),
      detailsInput,
      h('label', { class: 'block', for: 'capture-due' }, T.captureDueOn),
      dueInput,
    );
  }

  const sourceChip = captureDraft.sourceUrl
    ? h('div', { class: 'source-chip', id: 'capture-source' },
      h('span', {}, T.captureSourceLabel.replace('{url}', captureDraft.sourceUrl)),
      h('button', {
        id: 'capture-source-clear',
        disabled: notesBusy,
        'aria-label': T.captureSourceClear,
        onclick: () => void ((captureDraft.sourceUrl = null), render()),
      }, 'x'))
    : null;

  const clipperToggle = h('input', {
    type: 'checkbox',
    id: 'clipper-toggle',
    checked: clipperOn,
    disabled: notesBusy,
  });
  clipperToggle.addEventListener('change', () => void toggleWebClipper(clipperToggle.checked, state.address, orgId));

  const clipperControls: Node[] = [
    h('div', { class: 'clipper-box', id: 'clipper-box' },
      h('div', { class: 'row' }, clipperToggle, h('label', { for: 'clipper-toggle' }, T.clipperToggle)),
      h('p', { class: 'note' }, T.clipperHint),
      ...(clipperOn
        ? [
            h('div', { class: 'row' },
              h('button', {
                class: 'primary',
                id: 'clip-now',
                disabled: notesBusy,
                onclick: () => void clipCurrentPage(state, orgId, token, 'save'),
              }, T.clipNowButton),
              h('button', {
                id: 'clip-fill',
                disabled: notesBusy,
                onclick: () => void clipCurrentPage(state, orgId, token, 'fill'),
              }, T.clipFillButton)),
          ]
        : [])),
  ];

  return [
    h('h2', {}, T.notesTitle),
    h('div', { class: 'capture-box', id: 'notes-capture' },
      h('p', { class: 'note', id: 'notes-privacy-hint' }, T.notesPrivacyHint),
      h('div', { class: 'tabs' }, modeNoteBtn, modeTodoBtn),
      h('label', { class: 'block', for: 'capture-title' }, isNote ? T.captureTitleNote : T.captureTitleTodo),
      titleInput,
      ...bodyFields,
      sourceChip,
      h('div', { class: 'row' },
        h('button', {
          class: 'primary',
          id: 'capture-save',
          disabled: notesBusy,
          onclick: () => void saveQuickCapture(state, orgId, token),
        }, isNote ? T.captureSaveNote : T.captureSaveTodo)),
      ...clipperControls,
      notesStatus ? h('p', { class: 'note', id: 'notes-status', role: 'status' }, notesStatus) : null),
  ];
}

async function toggleWebClipper(enable: boolean, address: string, orgId: string): Promise<void> {
  notice = '';
  const scopeState = captureDrafts.get(address, orgId);
  scopeState.status = '';
  if (enable) {
    const hadActiveTab = await chrome.permissions.contains({ permissions: ['activeTab'] }).catch(() => false);
    // Only asks Chrome for activeTab + scripting on this explicit toggle click.
    const granted = await chrome.permissions.request({ permissions: [...WEB_CLIPPER_PERMISSIONS] }).catch(() => false);
    activeTabJustGranted = granted && !hadActiveTab;
    const latest = await loadState(area);
    await saveState(area, withFeature(latest, 'clipper', granted));
    if (!granted) notice = T.clipperPermissionDenied;
  } else {
    activeTabJustGranted = false;
    const latest = await loadState(area);
    const remove = permissionsToRemove('clipper', latest.enabled);
    if (remove.length > 0) await chrome.permissions.remove({ permissions: remove }).catch(() => false);
    scopeState.draft.sourceUrl = null;
    await saveState(area, withFeature(latest, 'clipper', false));
  }
  await render();
}

async function clipCurrentPage(state: State, orgId: string, token: string, action: 'save' | 'fill'): Promise<void> {
  const started = captureDrafts.beginOp(state.address, orgId);
  if (!started) return;
  const { scope, op } = started;
  if (op.isActive()) notice = '';
  scope.status = T.clipping;
  try {
    await render();
    const captured = await captureActiveTab({
      permissions: chrome.permissions,
      tabs: chrome.tabs,
      scripting: chrome.scripting,
      clicked: true,
      activeTabJustGranted,
    });
    if (!op.isLive()) return;
    if (!captured.ok) {
      scope.status = '';
      if (op.isActive()) {
        notice =
          captured.reason === 'permission'
            ? T.clipperPermissionDenied
            : captured.reason === 'reopenNeeded'
              ? T.clipReopenRequired
              : captured.reason === 'unsupportedUrl'
                ? T.clipUnsupportedUrl
                : T.clipFailed;
      }
      return;
    }
    activeTabJustGranted = false;
    if (action === 'fill') {
      scope.draft.kind = 'note';
      scope.draft.title = captured.clip.title;
      scope.draft.body = captured.clip.body;
      scope.draft.sourceUrl = captured.clip.sourceUrl;
      scope.status = T.clipFilled;
      return;
    }
    const client = createClient(state.address, token);
    await client.clipNote({
      title: captured.clip.title,
      body: captured.clip.body,
      sourceUrl: captured.clip.sourceUrl,
    });
    if (!op.isLive()) return;
    scope.status = T.captureSavedNote;
  } catch (error) {
    if (!op.isLive()) return;
    scope.status = '';
    if (op.isActive()) notice = error instanceof LudyError ? error.message : T.captureSaveFailed;
  } finally {
    op.end();
    await render();
  }
}

async function saveQuickCapture(state: State, orgId: string, token: string): Promise<void> {
  const scopeState = captureDrafts.get(state.address, orgId);
  if (scopeState.busy) return;
  const sent = { ...scopeState.draft };
  const title = sent.title.trim();
  if (!title) {
    scopeState.status = '';
    notice = T.captureTitleRequired;
    await render();
    return;
  }
  const started = captureDrafts.beginOp(state.address, orgId);
  if (!started) return;
  const { scope, op } = started;
  if (op.isActive()) notice = '';
  scope.status = T.captureSaving;
  try {
    await render();
    const client = createClient(state.address, token);
    if (sent.kind === 'note') {
      await client.clipNote({
        title,
        body: sent.body,
        tags: parseTagsInput(sent.tags),
        sourceUrl: sent.sourceUrl,
      });
      if (!op.isLive()) return;
      if (scope.draft.title === sent.title) scope.draft.title = '';
      if (scope.draft.body === sent.body) scope.draft.body = '';
      if (scope.draft.tags === sent.tags) scope.draft.tags = '';
      if (scope.draft.sourceUrl === sent.sourceUrl) scope.draft.sourceUrl = null;
      scope.status = T.captureSavedNote;
    } else {
      await client.quickCaptureTodo({
        title,
        details: sent.details,
        dueOn: sent.dueOn || null,
        sourceUrl: sent.sourceUrl,
      });
      if (!op.isLive()) return;
      if (scope.draft.title === sent.title) scope.draft.title = '';
      if (scope.draft.details === sent.details) scope.draft.details = '';
      if (scope.draft.dueOn === sent.dueOn) scope.draft.dueOn = '';
      if (scope.draft.sourceUrl === sent.sourceUrl) scope.draft.sourceUrl = null;
      scope.status = T.captureSavedTodo;
    }
  } catch (error) {
    if (!op.isLive()) return;
    scope.status = '';
    if (op.isActive()) notice = error instanceof LudyError ? error.message : T.captureSaveFailed;
  } finally {
    op.end();
    await render();
  }
}

async function meetingsView(state: State, me: Me, token: string, onMount: Array<() => void>): Promise<Node[]> {
  const feature = FEATURES.find((f) => f.id === 'meetings')!;
  const out: Node[] = [h('h2', {}, T.meetings)];
  const granted = await chrome.permissions.contains({ permissions: [...feature.permissions] });
  if (!granted || state.enabled.meetings !== true) {
    out.push(
      h('p', { class: 'note' }, T.meetingsNote),
      h('button', { class: 'primary', onclick: () => void turnOn() }, T.meetingsOn),
    );
    return out;
  }
  const recording = (await area.get(RECORDING_KEY))[RECORDING_KEY] as RecordingState | undefined;
  // A recording that ended by itself (A1, #3159): when, why, and whether what was saved is already uploaded. Shown until dismissed.
  const lost = readLost((await area.get(LOST_KEY))[LOST_KEY]);
  if (lost && !recording) out.push(...lostView(lost));
  if (recording) {
    const clock = h('span', { class: 'rec' });
    const updateClock = () => void (clock.textContent = `REC ${formatClock(Date.now() - recording.startedAt)}`);
    updateClock();
    onMount.push(() => {
      clearTicker();
      const id = setInterval(() => {
        if (!clock.isConnected) clearInterval(id);
        else updateClock();
      }, 1000);
      ticker = id;
    });
    out.push(
      h('p', {}, clock, ` · ${recording.title}`),
      ...(recording.micMissing ? [h('p', { class: 'error' }, T.micMissing)] : []),
      h('button', { class: 'danger', onclick: () => void stopRecording() }, T.stop),
    );
    return out;
  }
  out.push(...(await agendaView(state, me, token)));
  const title = h('input', { type: 'text', id: 'title', value: draft.title, maxlength: '200' });
  title.addEventListener('input', () => void (draft.title = title.value));
  const method = h('select', { id: 'method' },
    h('option', { value: '' }, T.consentChoose),
    ...CONSENT_METHODS.filter((m) => !(strictOrg && m === 'told_at_start')).map((m) => h('option', { value: m, selected: draft.consentMethod === m }, T.consentMethods[m])));
  method.addEventListener('change', () => void (draft.consentMethod = method.value));
  const agreed = h('input', { type: 'checkbox', id: 'agreed', checked: draft.consentAgreed });
  agreed.addEventListener('change', () => void (draft.consentAgreed = agreed.checked));
  // Off by default, and off again for each new recording unless ticked.
  const video = h('input', { type: 'checkbox', id: 'video', checked: draft.keepVideo });
  video.addEventListener('change', () => void (draft.keepVideo = video.checked));
  // Off by default and never remembered: ticked for one recording only.
  const liveNotes = h('input', { type: 'checkbox', id: 'live', checked: draft.liveNotes });
  liveNotes.addEventListener('change', () => void (draft.liveNotes = liveNotes.checked));
  out.push(
    h('label', { class: 'block', for: 'title' }, T.meetingTitle),
    title,
    h('div', { class: 'consent' },
      h('strong', {}, T.consentTitle),
      h('p', { class: 'note' }, T.consentNotice),
      h('strong', { class: 'note' }, T.noticeHeading),
      h('p', { class: 'notice', id: 'notice-text', lang: noticeLang }, RECORDING_NOTICE.text[noticeLang]),
      h('div', { class: 'row' },
        h('button', { id: 'copy-notice', onclick: () => void copyNotice() }, T.noticeCopy),
        h('button', { id: 'notice-lang', onclick: () => toggleNoticeLanguage() }, otherNoticeLanguage(noticeLang) === 'en' ? T.noticeShowEn : T.noticeShowVi)),
      copyNote ? h('p', { class: 'note', id: 'copy-note', role: 'status' }, copyNote) : null,
      h('p', { class: 'note' }, T.noticeDraft),
      h('label', { class: 'block', for: 'method' }, T.consentMethod),
      method,
      strictOrg ? h('p', { class: 'note', id: 'strict-note' }, T.strictNote) : null,
      h('div', { class: 'row' }, agreed, h('label', { for: 'agreed' }, T.consentConfirm)),
    ),
    h('div', { class: 'row' }, video, h('label', { for: 'video' }, T.withVideo)),
    h('div', { class: 'row' }, liveNotes, h('label', { for: 'live' }, T.liveNotes)),
    h('p', { class: 'note' }, T.liveNotesHint),
    h('button', { class: 'primary', id: 'start', onclick: () => void startRecording() }, T.start),
    h('button', { onclick: () => void turnOff() }, T.meetingsOff),
  );
  return out;
}

// The "Sắp họp" cards (B2, #3166): the member's next meetings, when the token holds the agenda scope; one button to ask for it when it does not. A click on "Ghi cuộc họp này" only fills the
// title below; the consent step, the confirmations and "Bắt đầu ghi" are the member's, as always. A failing read (an old server, a refused scope) draws nothing.
async function agendaView(state: State, me: Me, token: string): Promise<Node[]> {
  if (!me.scopes.includes(AGENDA_SCOPE)) {
    return [h('div', { class: 'agenda', id: 'agenda-ask' }, h('p', { class: 'note' }, T.agendaNote), h('button', { id: 'agenda-on', onclick: () => void signIn(state, true) }, T.agendaOn))];
  }
  if (me.features.agenda !== true) return [];
  // Read once for each token while this popup is open: a redraw (a language toggle, a copied notice, a filled title) does not ask the server again, and each read is an audit row there.
  if (agendaRead?.token !== token) agendaRead = { token, promise: createClient(state.address, token).agendaNext().catch(() => null) };
  const next: AgendaNext | null = await agendaRead.promise;
  if (!next) return [];
  if (!next.enabled) return [h('p', { class: 'note', id: 'agenda-off' }, T.agendaOff)];
  if (next.events.length === 0) return [];
  return [
    h('div', { class: 'agenda', id: 'agenda' },
      h('strong', {}, T.agendaTitle),
      ...next.events.map((event) =>
        h('div', { class: 'row agenda-event' },
          h('span', {}, agendaLine(T.agendaLine, T.agendaUntitled, event)),
          h('button', { class: 'agenda-record', onclick: () => void fillTitle(event.title) }, T.agendaRecord))),
      ...(agendaNote ? [h('p', { class: 'note', id: 'agenda-filled', role: 'status' }, agendaNote)] : [])),
  ];
}

// Puts the event's title in the recording form and nothing else: no consent is ticked, nothing starts.
async function fillTitle(title: string): Promise<void> {
  draft.title = title.slice(0, 200);
  // A new meeting is a new notice: the member confirms it again, whatever they ticked for an earlier one.
  draft.consentAgreed = false;
  agendaNote = T.agendaFilled;
  await render();
  document.getElementById('title')?.focus();
}

function lostView(lost: LostState): Node[] {
  const time = new Date(lost.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return [
    h('div', { class: 'lost', id: 'lost', role: 'alert' },
      h('strong', {}, T.lostLine.replace('{time}', time)),
      h('p', {}, `${lost.title}: ${T.lostReasons[lost.reason]}`),
      h('p', { class: 'note' }, lost.uploaded ? T.lostUploaded : T.lostKept),
      h('button', { id: 'lost-dismiss', onclick: () => void dismissLost() }, T.lostDismiss)),
  ];
}

async function dismissLost(): Promise<void> {
  await area.remove(LOST_KEY);
  // The "!" of the badge goes with it; nothing is recording.
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'Ludy' });
  await render();
}

async function turnOn(): Promise<void> {
  notice = '';
  const feature = FEATURES.find((f) => f.id === 'meetings')!;
  // The browser asks for tab capture, offscreen, and activeTab (to read the active meeting tab URL on click) on this click, and nothing is asked before it.
  if (!(await chrome.permissions.request({ permissions: [...feature.permissions] }))) {
    notice = T.permissionDenied;
  } else {
    await saveState(area, withFeature(await loadState(area), 'meetings', true));
    // The microphone prompt cannot show in an offscreen document: the member answers it once on a page of the extension.
    const mic = await navigator.permissions.query({ name: 'microphone' as PermissionName }).catch(() => null);
    if (mic?.state !== 'granted') await chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
  }
  await render();
}

async function turnOff(): Promise<void> {
  const latest = await loadState(area);
  const remove = permissionsToRemove('meetings', latest.enabled);
  if (remove.length > 0) await chrome.permissions.remove({ permissions: remove });
  await saveState(area, withFeature(latest, 'meetings', false));
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
    // The tab's address, when the browser gave it, so the server can tell a second capture of the same call; nothing of it is kept.
    const joinUrl = tabAddress(tab.url);
    const reply = (await chrome.runtime.sendMessage({ type: 'start', ...draft, streamId, ...(joinUrl ? { joinUrl } : {}) })) as StartReply;
    if (reply.ok) {
      draft = { title: '', consentMethod: '', consentAgreed: false, keepVideo: false, liveNotes: false };
      agendaNote = '';
    } else {
      notice = T.blockers[reply.reason];
      // Another capture of this call exists: which kind of client and since when, in words (ADR-0055 slice 1, #4123).
      if (reply.reason === 'captureRunning') {
        const since = reply.held ? new Date(reply.held.since) : null;
        notice =
          reply.held && since && !Number.isNaN(since.getTime())
            ? T.blockers.captureRunning.replace('{kind}', T.captureKinds[reply.held.kind]).replace('{time}', since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
            : T.blockers.captureRunningUnknown;
      }
      if (reply.reason === 'consentPolicy') {
        strictOrg = true;
        if (draft.consentMethod === 'told_at_start') draft.consentMethod = '';
      }
    }
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
          const { uploads } = await client.config({ signal: AbortSignal.timeout(CONFIG_DISCOVERY_TIMEOUT_MS) }).catch(() => ({ uploads: 'direct' as const }));
          const done = await uploadSaved({ store }, client, uploads, meta);
          notice = done.ok ? T.uploaded : T.uploadFailed;
          await render();
        })() }, T.retry),
        // Discarding a left-over copy ends that meeting's recording too (best effort), so the app's recording chip lets go (#3196).
        h('button', { onclick: () => void reportEnded(client, meta).then(() => store.remove(meta.id)).then(render) }, T.discard),
      )),
  ];
}

void render();
