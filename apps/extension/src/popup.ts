// SPDX-License-Identifier: AGPL-3.0-only
// The popup: the shell (Ludy Cloud sign-in, org picker, feature tabs) and the Meetings & Notes features.
// Every string is set as text, never as markup. Nothing here reads a page in the background: tab audio or active page
// capture runs only after explicit opt-in and click.
import { ENGLISH, T } from './strings.ts';
import { activeAccount, createCaptureDraftStore, loadState, saveState, withAccount, withFeature, withoutAccount, type State } from './state.ts';
import { permissionsToRemove, visibleFeatures, FEATURES, type Me } from './features.ts';
import { AGENDA_SCOPE, agendaLine, type AgendaNext } from './agenda.ts';
import { connectUrl, deviceName, newPkce, parseConnectResult, resolveSignInScopes } from './auth.ts';
import { createClient, LudyError } from './api.ts';
import { CONSENT_METHODS, consentBlocker } from './consent.ts';
import { LOST_KEY, pendingScopeKey, readLost, readPendingScope, RECORDING_KEY, tabAddress, type LostState, type RecordingScope, type RecordingState, type StartReply, type StopReply } from './messages.ts';
import { captureActiveTab, CLIP_BODY_MAX, CLIP_TITLE_MAX, NOTES_SCOPE, parseTagsInput, WEB_CLIPPER_PERMISSIONS } from './page-capture.ts';
import { formatClock, createIndexedDbChunkStore, noticeToCopy, otherNoticeLanguage, RECORDING_NOTICE, type RecordingMeta, type RecordingNoticeLanguage } from '@ludy/meeting-recorder';
import { reportEnded, uploadSaved } from './capture-run.ts';
import { createActiveTabTracker, createPopupConcurrency } from './popup-guards.ts';
import { CONNECTED_PAGE, isExtensionPageAddress, loadNotesExcluded, PENDING_KEY, rememberNotesExcluded, tabSignInCovers, type PendingSignIn } from './signin.ts';

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
let stopping = false;
let activePanelTab: 'meetings' | 'notes' = 'meetings';
let noticeExpanded = false;
// The recording notice shown in the consent step (A1, #3159): the popup's language first, the other one a click away. The
// extension knows no meeting language before the meeting exists, so the browser's language is the default.
let noticeLang: RecordingNoticeLanguage = T === ENGLISH ? 'en' : 'vi';
let copyNote = '';
// Shown under the "Sắp họp" cards after a title was filled in from one.
let agendaNote = '';
let agendaRead: { token: string; promise: Promise<AgendaNext | null> } | null = null;
let serverModules: { apiAddress: string; promise: Promise<readonly string[] | null> } | null = null;
// Set when the org refused the method as not written (A2, #3160): the unwritten choice is then not offered for the rest of this popup.
let strictOrg = false;
const CONFIG_DISCOVERY_TIMEOUT_MS = 3_000;
const STOP_NOTICES = new Set<string>([T.uploaded, T.uploadFailed, T.stopFailed, T.recordingIdle]);
// Cache completed non-owned/invalid checks per popup open so secondary re-renders never re-query the same meetingId (#4725).
const verifiedLegacyChecked = new Set<string>();
const verifiedLegacyInFlight = new Set<string>();
const captureDrafts = createCaptureDraftStore();
const activeTab = createActiveTabTracker();
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

type ScopeMatch = 'same' | 'other' | 'unverified';

function recordingScopeMatch(
  item: { orgId?: string; address?: string; tokenId?: string },
  state: State,
  me: Me | null,
): ScopeMatch {
  const account = activeAccount(state);
  const verifiedOrgId = me?.orgId ?? account?.orgId;
  const verifiedTokenId = me?.tokenId ?? account?.tokenId;
  if (!verifiedOrgId || !account) return 'other';
  if (item.orgId && item.orgId !== verifiedOrgId) return 'other';
  if (item.address && item.address !== state.apiAddress) return 'other';
  if (!item.orgId || !item.address || !item.tokenId) return 'unverified';
  if (!verifiedTokenId) return 'unverified';
  return item.tokenId === verifiedTokenId ? 'same' : 'other';
}

function recordingBanner(recording: RecordingState, scopeMatch: ScopeMatch, onMount: Array<() => void>): Node[] {
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
  const label = scopeMatch === 'same' ? recording.title : scopeMatch === 'unverified' ? T.recordingVerifying : T.recordingOtherOrg;
  return [
    h(
      'div',
      { class: 'rec-card' },
      h('div', { class: 'rec-header' }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), clock, h('span', { class: 'rec-title' }, label)),
      ...(scopeMatch === 'same' && recording.micMissing ? [h('p', { class: 'error' }, T.micMissing)] : []),
      h('button', { class: 'danger btn-block', id: 'stop-recording', ...(stopping ? { disabled: true } : {}), onclick: () => void stopRecording() }, T.stop),
    ),
  ];
}

function noticeBanner(): Node | null {
  if (!notice) return null;
  return h('p', { class: 'alert-banner', id: 'popup-notice', role: 'alert' }, notice);
}

async function mountShellAfterStorageRead(): Promise<void> {
  const [state, rawRecording, rawLost] = await Promise.all([
    loadState(area),
    area.get(RECORDING_KEY),
    area.get(LOST_KEY),
  ]);
  const onMount: Array<() => void> = [];
  const recovery = buildRecoveryBanners(rawRecording, rawLost, state, null, onMount);
  const shell = h('div', { class: 'shell' });
  shell.append(
    h('div', { class: 'topbar' }, h('img', { class: 'topbar-logo', src: 'icons/icon-32.png', alt: '', width: '24', height: '24' }), h('h1', {}, T.title)),
    ...recovery.nodes,
  );
  const banner = noticeBanner();
  if (banner) shell.append(banner);
  clearTicker();
  root.replaceChildren(shell);
  for (const run of onMount) run();
}

function buildRecoveryBanners(
  rawRecording: Record<string, unknown>,
  rawLost: Record<string, unknown>,
  state: State,
  me: Me | null,
  onMount: Array<() => void>,
): { nodes: Node[]; hasRecording: boolean } {
  const recording = rawRecording[RECORDING_KEY] as RecordingState | undefined;
  if (recording) {
    return {
      nodes: recordingBanner(recording, recordingScopeMatch(recording, state, me), onMount),
      hasRecording: true,
    };
  }
  const lost = readLost(rawLost[LOST_KEY]);
  if (lost) {
    return {
      nodes: lostView(lost, recordingScopeMatch(lost, state, me)),
      hasRecording: false,
    };
  }
  return { nodes: [], hasRecording: false };
}

async function renderRecoveryBanners(
  state: State,
  me: Me | null,
  onMount: Array<() => void>,
  token?: string,
): Promise<{ nodes: Node[]; hasRecording: boolean }> {
  const [rawRecording, rawLost] = await Promise.all([
    area.get(RECORDING_KEY),
    area.get(LOST_KEY),
  ]);
  const recording = rawRecording[RECORDING_KEY] as RecordingState | undefined;
  const lost = recording ? null : readLost(rawLost[LOST_KEY]);
  if (lost && !lost.tokenId && me) {
    const scopeKey = pendingScopeKey(lost.meetingId);
    const pendingScope = readPendingScope((await area.get(scopeKey))[scopeKey]);
    const wrongOrigin =
      (pendingScope && pendingScope.address !== state.apiAddress) ||
      (lost.address && lost.address !== state.apiAddress) ||
      (lost.orgId && lost.orgId !== me.orgId);
    if (!wrongOrigin && token && me.scopes.includes('meetings')) {
      const owned = await createClient(state.apiAddress, token).extensionMeetingOwned(lost.meetingId, {
        signal: AbortSignal.timeout(CONFIG_DISCOVERY_TIMEOUT_MS),
      });
      if (owned === 'owned') {
        const [latestLostRaw, latestState] = await Promise.all([area.get(LOST_KEY), loadState(area)]);
        const latestLost = readLost(latestLostRaw[LOST_KEY]);
        const latestAccount = activeAccount(latestState);
        // Never resurrect a dismissed lost notice or overwrite a newer meeting (#4725).
        if (!latestLost || latestLost.meetingId !== lost.meetingId) {
          return buildRecoveryBanners(rawRecording, latestLostRaw, latestState, me, onMount);
        }
        if (
          !latestLost.tokenId &&
          latestState.apiAddress === state.apiAddress &&
          latestAccount?.orgId === me.orgId &&
          latestAccount.token === token
        ) {
          const scopedLost: LostState = { ...latestLost, orgId: me.orgId, address: state.apiAddress, tokenId: me.tokenId };
          await area.set({ [LOST_KEY]: scopedLost }).catch(() => undefined);
          return { nodes: lostView(scopedLost, 'same'), hasRecording: false };
        }
      }
    }
    return { nodes: lostView(lost, 'other'), hasRecording: false };
  }
  return buildRecoveryBanners(rawRecording, rawLost, state, me, onMount);
}

async function render(): Promise<void> {
  await concurrency.runRender(clearTicker, async (pass) => {
    const [state, rawRecording, rawLost] = await Promise.all([
      loadState(area),
      area.get(RECORDING_KEY),
      area.get(LOST_KEY),
      activeTab.captureBaseline(chrome.permissions),
    ]).then(([s, r, l]) => [s, r, l] as const);
    if (!pass.isCurrent()) return null;
    const { changed } = captureDrafts.syncState(state);
    if (changed && notice !== T.signingIn) notice = '';
    const view = h('div', { class: 'shell' });
    const account = activeAccount(state);
    if (!account) {
      const recovery = buildRecoveryBanners(rawRecording, rawLost, state, null, pass.onMount);
      view.append(...recovery.nodes, ...signInView(state));
    } else {
      const preliminary = buildRecoveryBanners(rawRecording, rawLost, state, null, pass.onMount);
      if (preliminary.nodes.length > 0 && pass.isCurrent()) {
        const shell = h('div', { class: 'shell' });
        shell.append(
          h('div', { class: 'topbar' }, h('img', { class: 'topbar-logo', src: 'icons/icon-32.png', alt: '', width: '24', height: '24' }), h('h1', {}, T.title)),
          ...preliminary.nodes,
        );
        const banner = noticeBanner();
        if (banner) shell.append(banner);
        root.replaceChildren(shell);
        for (const run of pass.onMount.splice(0)) run();
      }
      view.append(...(await signedInView(state, pass.onMount)));
    }
    if (!pass.isCurrent()) return null;
    return () => {
      clearTicker();
      const banner = noticeBanner();
      if (banner) view.append(banner);
      root.replaceChildren(view);
    };
  });
}

function signInView(state: State): Node[] {
  return [
    h(
      'div',
      { class: 'signin-card' },
      h(
        'div',
        { class: 'signin-header' },
        h('img', { class: 'signin-logo', src: 'icons/icon-48.png', alt: '', width: '48', height: '48' }),
        h('h1', { class: 'signin-title' }, T.title),
      ),
      h('p', { class: 'signin-subtitle' }, T.signInSubtitle),
      h('button', { class: 'primary btn-block btn-lg', id: 'sign-in', onclick: () => void signIn(state) }, T.signIn),
    ),
  ];
}

async function signIn(state: State, withAgenda = false): Promise<void> {
  notice = T.signingIn;
  await render();
  try {
    const config = await createClient(state.apiAddress, null)
      .config({ signal: AbortSignal.timeout(CONFIG_DISCOVERY_TIMEOUT_MS) })
      .catch(() => null);
    const scopesToAsk = resolveSignInScopes(config?.modules);
    const askAgenda = withAgenda && scopesToAsk.includes('meetings');
    const pkce = await newPkce();
    // Open /-/extension/connect on the App origin in a normal tab when covered by web_accessible_resources (#4662),
    // falling back to chrome.identity.launchWebAuthFlow otherwise; exchange the code strictly at state.apiAddress.
    const tabRedirect = chrome.runtime.getURL(CONNECTED_PAGE);
    if (tabSignInCovers(chrome.runtime.getManifest(), state.appAddress) && isExtensionPageAddress(tabRedirect)) {
      const pending: PendingSignIn = {
        verifier: pkce.verifier,
        state: pkce.state,
        appAddress: state.appAddress,
        apiAddress: state.apiAddress,
        redirect: tabRedirect,
        notesAsked: scopesToAsk.includes(NOTES_SCOPE),
        startedAt: Date.now(),
      };
      await chrome.storage.session.set({ [PENDING_KEY]: pending });
      try {
        await chrome.tabs.create({ url: connectUrl(state.appAddress, pkce, tabRedirect, deviceName(navigator.userAgent), askAgenda, scopesToAsk) });
        notice = '';
        await render();
        return;
      } catch {
        await chrome.storage.session.remove(PENDING_KEY);
      }
    }
    const redirect = chrome.identity.getRedirectURL('connect');
    const returned = await chrome.identity.launchWebAuthFlow({
      url: connectUrl(state.appAddress, pkce, redirect, deviceName(navigator.userAgent), askAgenda, scopesToAsk),
      interactive: true,
    });
    const result = returned ? parseConnectResult(returned, pkce, redirect) : { error: 'invalid' };
    if ('error' in result) {
      notice = result.error === 'access_denied' ? T.signInDenied : T.signInFailed;
    } else {
      const done = await createClient(state.apiAddress, null).exchangeCode(result.code, pkce.verifier);
      await rememberNotesExcluded(chrome.storage.session, done.orgId, scopesToAsk.includes(NOTES_SCOPE) && !done.scopes.includes(NOTES_SCOPE));
      const next = withAccount(await loadState(area), {
        orgId: done.orgId,
        orgSlug: result.org,
        token: done.token,
        expiresAt: done.expiresAt,
        ...(done.tokenId ? { tokenId: done.tokenId } : {}),
      });
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
  const picker = h('select', {
    id: 'org',
    class: 'org-select',
    'aria-label': T.org,
    onchange: () =>
      void (async () => {
        const current = await loadState(area);
        const next = { ...current, activeOrg: picker.value };
        if (next.activeOrg !== current.activeOrg) notice = '';
        captureDrafts.syncState(next);
        await saveState(area, next);
        await render();
      })(),
  }, ...orgs.map((a) => h('option', { value: a.orgId, selected: a.orgId === account.orgId }, a.orgSlug)));

  const topbar = h(
    'div',
    { class: 'topbar' },
    h('img', { class: 'topbar-logo', src: 'icons/icon-32.png', alt: '', width: '24', height: '24' }),
    picker,
    h(
      'div',
      { class: 'topbar-actions' },
      h('button', { class: 'btn-icon', id: 'add-org', title: T.addOrg, 'aria-label': T.addOrg, onclick: () => void signIn(state) }, '+'),
      h(
        'button',
        {
          class: 'btn-icon',
          id: 'sign-out',
          title: T.signOut,
          'aria-label': T.signOut,
          onclick: () =>
            void (async () => {
              const current = await loadState(area);
              captureDrafts.clearScope(current.apiAddress, account.orgId);
              notice = '';
              const next = withoutAccount(current, account.orgId);
              captureDrafts.syncState(next);
              await saveState(area, next);
              await render();
            })(),
        },
        h('span', { class: 'icon-signout', 'aria-hidden': 'true' }),
      ),
    ),
  );
  out.push(topbar);

  let me: Me | null = null;
  try {
    me = await createClient(state.apiAddress, account.token).me();
    if (me.tokenId && me.orgId === account.orgId && account.tokenId !== me.tokenId) {
      const current = await loadState(area);
      const currentAccount = current.accounts[account.orgId];
      if (current.apiAddress === state.apiAddress && currentAccount?.token === account.token && currentAccount.tokenId !== me.tokenId) {
        await saveState(area, {
          ...current,
          accounts: { ...current.accounts, [account.orgId]: { ...currentAccount, tokenId: me.tokenId } },
        }).catch(() => undefined);
      }
    }
  } catch (error) {
    // A token the server no longer accepts is dropped here, so the member signs in again; rebuild from the signed-out state immediately so stale tokenId cannot leak banners (#4725).
    if (error instanceof LudyError && error.status === 401) {
      captureDrafts.clearScope(state.apiAddress, account.orgId);
      const next = withoutAccount(await loadState(area), account.orgId);
      captureDrafts.syncState(next);
      await saveState(area, next);
      if (!STOP_NOTICES.has(notice)) notice = T.loadFailed;
      if (activeAccount(next)) return await signedInView(next, onMount);
      const recovery = await renderRecoveryBanners(next, null, onMount);
      return [...recovery.nodes, ...signInView(next)];
    }
    if (!STOP_NOTICES.has(notice)) notice = T.loadFailed;
  }
  const recovery = await renderRecoveryBanners(state, me, onMount, account.token);
  out.push(...recovery.nodes);
  if (!me) return out;
  const features = visibleFeatures(me);
  let showNotesAsk = false;
  if (!me.scopes.includes(NOTES_SCOPE) && !(await loadNotesExcluded(chrome.storage.session)).has(account.orgId)) {
    if (serverModules?.apiAddress !== state.apiAddress) {
      serverModules = {
        apiAddress: state.apiAddress,
        promise: createClient(state.apiAddress, null)
          .config({ signal: AbortSignal.timeout(CONFIG_DISCOVERY_TIMEOUT_MS) })
          .then((c) => c.modules ?? null)
          .catch(() => {
            if (serverModules?.apiAddress === state.apiAddress) serverModules = null;
            return null;
          }),
      };
    }
    const installed = await serverModules.promise;
    showNotesAsk = Boolean(installed?.includes(NOTES_SCOPE));
  }
  if (features.length === 0 && !showNotesAsk) out.push(h('div', { class: 'card' }, h('p', { class: 'note' }, T.noFeatures)));
  if (showNotesAsk) {
    out.push(
      h(
        'div',
        { class: 'card', id: 'notes-ask' },
        h('p', { class: 'note' }, T.notesAskNote),
        h('button', { class: 'btn-secondary btn-sm', id: 'notes-reconnect', onclick: () => void signIn(state, me.scopes.includes(AGENDA_SCOPE)) }, T.notesReconnect),
      ),
    );
  }

  const hasMeetings = features.some((f) => f.id === 'meetings');
  const hasNotes = features.some((f) => f.id === 'notes');
  const meetingsNodes = hasMeetings ? await meetingsView(state, me, account.token, recovery.hasRecording, hasNotes && !recovery.hasRecording) : [];
  const notesNodes = hasNotes ? await notesView(state, account.orgId, account.token, meetingsNodes.length > 0) : [];

  if (meetingsNodes.length > 0 && notesNodes.length > 0) {
    const meetingsPanel = h('div', { class: 'stack-sm', id: 'panel-meetings', role: 'tabpanel', hidden: activePanelTab !== 'meetings' }, ...meetingsNodes);
    const notesPanel = h('div', { class: 'stack-sm', id: 'panel-notes', role: 'tabpanel', hidden: activePanelTab !== 'notes' }, ...notesNodes);
    const tabMeetings = h('button', {
      id: 'tab-meetings',
      role: 'tab',
      class: activePanelTab === 'meetings' ? 'active-tab' : undefined,
      'aria-selected': activePanelTab === 'meetings' ? 'true' : 'false',
    }, T.meetingsTab);
    const tabNotes = h('button', {
      id: 'tab-notes',
      role: 'tab',
      class: activePanelTab === 'notes' ? 'active-tab' : undefined,
      'aria-selected': activePanelTab === 'notes' ? 'true' : 'false',
    }, T.notesTab);

    const selectTab = (nextTab: 'meetings' | 'notes') => {
      activePanelTab = nextTab;
      const isMeetings = nextTab === 'meetings';
      tabMeetings.className = isMeetings ? 'active-tab' : '';
      tabMeetings.setAttribute('aria-selected', isMeetings ? 'true' : 'false');
      tabNotes.className = isMeetings ? '' : 'active-tab';
      tabNotes.setAttribute('aria-selected', isMeetings ? 'false' : 'true');
      meetingsPanel.hidden = !isMeetings;
      notesPanel.hidden = isMeetings;
    };
    tabMeetings.addEventListener('click', () => selectTab('meetings'));
    tabNotes.addEventListener('click', () => selectTab('notes'));

    out.push(
      h('div', { class: 'segmented', role: 'tablist' }, tabMeetings, tabNotes),
      meetingsPanel,
      notesPanel,
    );
  } else {
    out.push(...meetingsNodes, ...notesNodes);
  }

  out.push(...(await pendingView(state, me, account.token)));
  return out;
}

async function notesView(state: State, orgId: string, token: string, hideHeading = false): Promise<Node[]> {
  const clipperGranted = await chrome.permissions.contains({ permissions: [...WEB_CLIPPER_PERMISSIONS] }).catch(() => false);
  const clipperOn = clipperGranted && state.enabled.clipper === true;
  const scopeState = captureDrafts.get(state.apiAddress, orgId);
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
      h('div', {}, h('label', { class: 'block', for: 'capture-body' }, T.captureBody), bodyInput),
      h('div', {}, h('label', { class: 'block', for: 'capture-tags' }, T.captureTags), tagsInput),
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
      h('div', {}, h('label', { class: 'block', for: 'capture-details' }, T.captureDetails), detailsInput),
      h('div', {}, h('label', { class: 'block', for: 'capture-due' }, T.captureDueOn), dueInput),
    );
  }

  const sourceChip = captureDraft.sourceUrl
    ? h(
        'div',
        { class: 'source-chip', id: 'capture-source' },
        h('span', {}, T.captureSourceLabel.replace('{url}', captureDraft.sourceUrl)),
        h(
          'button',
          {
            id: 'capture-source-clear',
            class: 'btn-ghost btn-sm',
            disabled: notesBusy,
            'aria-label': T.captureSourceClear,
            onclick: () => void ((captureDraft.sourceUrl = null), render()),
          },
          'x',
        ),
      )
    : null;

  const clipperToggle = h('input', {
    type: 'checkbox',
    id: 'clipper-toggle',
    checked: clipperOn,
    disabled: notesBusy,
  });
  clipperToggle.addEventListener('change', () => void toggleWebClipper(clipperToggle.checked, state.apiAddress, orgId));

  const clipperControls: Node[] = [
    h(
      'div',
      { class: 'clipper-box', id: 'clipper-box' },
      h('div', { class: 'check-row' }, clipperToggle, h('label', { for: 'clipper-toggle' }, T.clipperToggle)),
      h('p', { class: 'note' }, T.clipperHint),
      ...(clipperOn
        ? [
            h(
              'div',
              { class: 'clipper-actions' },
              h('button', {
                class: 'primary btn-sm',
                id: 'clip-now',
                disabled: notesBusy,
                onclick: () => void clipCurrentPage(state, orgId, token, 'save'),
              }, T.clipNowButton),
              h('button', {
                class: 'btn-secondary btn-sm',
                id: 'clip-fill',
                disabled: notesBusy,
                onclick: () => void clipCurrentPage(state, orgId, token, 'fill'),
              }, T.clipFillButton),
            ),
          ]
        : []),
    ),
  ];

  return [
    h('h2', { class: hideHeading ? 'sr-only' : undefined }, T.notesTitle),
    h(
      'div',
      { class: 'capture-box', id: 'notes-capture' },
      h('div', { class: 'tabs' }, modeNoteBtn, modeTodoBtn),
      h('p', { class: 'note', id: 'notes-privacy-hint' }, T.notesPrivacyHint),
      h('div', {}, h('label', { class: 'block', for: 'capture-title' }, isNote ? T.captureTitleNote : T.captureTitleTodo), titleInput),
      ...bodyFields,
      sourceChip,
      h('button', {
        class: 'primary btn-block',
        id: 'capture-save',
        disabled: notesBusy,
        onclick: () => void saveQuickCapture(state, orgId, token),
      }, isNote ? T.captureSaveNote : T.captureSaveTodo),
      ...clipperControls,
      notesStatus ? h('p', { class: 'note', id: 'notes-status', role: 'status' }, notesStatus) : null,
    ),
  ];
}

async function toggleWebClipper(enable: boolean, apiAddress: string, orgId: string): Promise<void> {
  notice = '';
  await activeTab.captureBaseline(chrome.permissions);
  const scopeState = captureDrafts.get(apiAddress, orgId);
  scopeState.status = '';
  if (enable) {
    // Only asks Chrome for activeTab + scripting on this explicit toggle click.
    const granted = await chrome.permissions.request({ permissions: [...WEB_CLIPPER_PERMISSIONS] }).catch(() => false);
    activeTab.onWebClipperToggled(true, granted);
    const latest = await loadState(area);
    await saveState(area, withFeature(latest, 'clipper', granted));
    if (!granted) notice = T.clipperPermissionDenied;
  } else {
    const current = await loadState(area);
    const remove = permissionsToRemove('clipper', current.enabled);
    if (remove.length > 0) await chrome.permissions.remove({ permissions: remove }).catch(() => false);
    await activeTab.onPermissionsRemoved(remove, chrome.permissions);
    activeTab.onWebClipperToggled(false, false);
    scopeState.draft.sourceUrl = null;
    await saveState(area, withFeature(await loadState(area), 'clipper', false));
  }
  await render();
}

async function clipCurrentPage(state: State, orgId: string, token: string, action: 'save' | 'fill'): Promise<void> {
  const started = captureDrafts.beginOp(state.apiAddress, orgId);
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
      activeTabJustGranted: activeTab.isJustGranted(),
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
    activeTab.onCaptureSucceeded();
    if (action === 'fill') {
      scope.draft.kind = 'note';
      scope.draft.title = captured.clip.title;
      scope.draft.body = captured.clip.body;
      scope.draft.sourceUrl = captured.clip.sourceUrl;
      scope.status = T.clipFilled;
      return;
    }
    const client = createClient(state.apiAddress, token);
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
  const scopeState = captureDrafts.get(state.apiAddress, orgId);
  if (scopeState.busy) return;
  const sent = { ...scopeState.draft };
  const title = sent.title.trim();
  if (!title) {
    scopeState.status = '';
    notice = T.captureTitleRequired;
    await render();
    return;
  }
  const started = captureDrafts.beginOp(state.apiAddress, orgId);
  if (!started) return;
  const { scope, op } = started;
  if (op.isActive()) notice = '';
  scope.status = T.captureSaving;
  try {
    await render();
    const client = createClient(state.apiAddress, token);
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

async function meetingsView(state: State, me: Me, token: string, hasActiveRecording: boolean, hideHeading = false): Promise<Node[]> {
  if (hasActiveRecording) return [];
  const feature = FEATURES.find((f) => f.id === 'meetings')!;
  const out: Node[] = [h('h2', { class: hideHeading ? 'sr-only' : undefined }, T.meetings)];
  const granted = await chrome.permissions.contains({ permissions: [...feature.permissions] }).catch(() => false);
  if (!granted || state.enabled.meetings !== true) {
    out.push(
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'note' }, T.meetingsNote),
        h('button', { class: 'primary btn-block btn-lg', onclick: () => void turnOn() }, T.meetingsOn),
      ),
    );
    return out;
  }
  out.push(...(await agendaView(state, me, token)));

  const startBtn = h('button', {
    class: 'primary btn-block btn-lg',
    id: 'start',
    disabled: consentBlocker(draft) !== null,
    onclick: () => void startRecording(),
  }, T.start);
  const syncStartDisabled = () => {
    (startBtn as HTMLButtonElement).disabled = consentBlocker(draft) !== null;
  };

  const title = h('input', { type: 'text', id: 'title', value: draft.title, maxlength: '200', placeholder: T.meetingTitlePlaceholder });
  title.addEventListener('input', () => {
    draft.title = title.value;
    syncStartDisabled();
  });
  const method = h('select', { id: 'method' },
    h('option', { value: '' }, T.consentChoose),
    ...CONSENT_METHODS.filter((m) => !(strictOrg && m === 'told_at_start')).map((m) => h('option', { value: m, selected: draft.consentMethod === m }, T.consentMethods[m])));
  method.addEventListener('change', () => {
    draft.consentMethod = method.value;
    syncStartDisabled();
  });
  const agreed = h('input', { type: 'checkbox', id: 'agreed', checked: draft.consentAgreed });
  agreed.addEventListener('change', () => {
    draft.consentAgreed = agreed.checked;
    syncStartDisabled();
  });
  // Off by default, and off again for each new recording unless ticked.
  const video = h('input', { type: 'checkbox', id: 'video', checked: draft.keepVideo });
  video.addEventListener('change', () => void (draft.keepVideo = video.checked));
  // Off by default and never remembered: ticked for one recording only.
  const liveNotes = h('input', { type: 'checkbox', id: 'live', checked: draft.liveNotes });
  liveNotes.addEventListener('change', () => void (draft.liveNotes = liveNotes.checked));

  const noticeDetails = h(
    'details',
    { class: 'notice-disclosure', ...(noticeExpanded ? { open: true } : {}) },
    h('summary', {}, T.noticeHeading),
    h('p', { class: 'notice', id: 'notice-text', lang: noticeLang }, RECORDING_NOTICE.text[noticeLang]),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn-secondary btn-sm', id: 'copy-notice', onclick: () => void copyNotice() }, T.noticeCopy),
      h('button', { class: 'btn-ghost btn-sm', id: 'notice-lang', onclick: () => toggleNoticeLanguage() }, otherNoticeLanguage(noticeLang) === 'en' ? T.noticeShowEn : T.noticeShowVi),
    ),
    copyNote ? h('p', { class: 'note', id: 'copy-note', role: 'status' }, copyNote) : null,
    h('p', { class: 'note' }, T.noticeDraft),
  );
  noticeDetails.addEventListener('toggle', () => {
    noticeExpanded = (noticeDetails as HTMLDetailsElement).open;
  });

  out.push(
    h(
      'div',
      { class: 'card' },
      h('div', {}, h('label', { class: 'block', for: 'title' }, T.meetingTitle), title),
      h(
        'div',
        { class: 'consent' },
        h('div', { class: 'consent-header' }, h('strong', {}, T.consentTitle), h('span', { class: 'badge badge-warn' }, T.consentRequired)),
        h('p', { class: 'note' }, T.consentNotice),
        noticeDetails,
        h('div', {}, h('label', { class: 'block', for: 'method' }, T.consentMethod), method),
        strictOrg ? h('p', { class: 'note', id: 'strict-note' }, T.strictNote) : null,
        h('div', { class: 'check-row' }, agreed, h('label', { for: 'agreed' }, T.consentConfirm)),
      ),
      h(
        'div',
        { class: 'stack-xs' },
        h('div', { class: 'check-row' }, video, h('label', { for: 'video' }, T.withVideo)),
        h('div', { class: 'check-row' }, liveNotes, h('label', { for: 'live' }, T.liveNotes)),
        h('p', { class: 'note' }, T.liveNotesHint),
      ),
      startBtn,
      h('button', { class: 'btn-outline btn-block btn-sm', onclick: () => void turnOff() }, T.meetingsOff),
    ),
  );
  return out;
}

// The "Sắp họp" cards (B2, #3166): the member's next meetings, when the token holds the agenda scope; one button to ask for it when it does not. A click on "Ghi cuộc họp này" only fills the
// title below; the consent step, the confirmations and "Bắt đầu ghi" are the member's, as always. A failing read (an old server, a refused scope) draws nothing.
async function agendaView(state: State, me: Me, token: string): Promise<Node[]> {
  if (!me.scopes.includes(AGENDA_SCOPE)) {
    return [
      h(
        'div',
        { class: 'agenda', id: 'agenda-ask' },
        h('p', { class: 'note' }, T.agendaNote),
        h('button', { class: 'btn-secondary btn-sm', id: 'agenda-on', onclick: () => void signIn(state, true) }, T.agendaOn),
      ),
    ];
  }
  if (me.features.agenda !== true) return [];
  // Read once for each token while this popup is open: a redraw (a language toggle, a copied notice, a filled title) does not ask the server again, and each read is an audit row there.
  if (agendaRead?.token !== token) agendaRead = { token, promise: createClient(state.apiAddress, token).agendaNext().catch(() => null) };
  const next: AgendaNext | null = await agendaRead.promise;
  if (!next) return [];
  if (!next.enabled) return [h('p', { class: 'note', id: 'agenda-off' }, T.agendaOff)];
  if (next.events.length === 0) return [];
  return [
    h(
      'div',
      { class: 'agenda', id: 'agenda' },
      h('strong', {}, T.agendaTitle),
      ...next.events.map((event) =>
        h(
          'div',
          { class: 'agenda-event' },
          h('span', {}, agendaLine(T.agendaLine, T.agendaUntitled, event)),
          h('button', { class: 'agenda-record btn-secondary btn-sm', onclick: () => void fillTitle(event.title) }, T.agendaRecord),
        ),
      ),
      ...(agendaNote ? [h('p', { class: 'note', id: 'agenda-filled', role: 'status' }, agendaNote)] : []),
    ),
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

function lostView(lost: LostState, scopeMatch: ScopeMatch): Node[] {
  const time = new Date(lost.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isUnscopedLegacy = !lost.orgId && !lost.tokenId;
  const details =
    scopeMatch === 'same'
      ? [
          h('p', {}, `${lost.title}: ${T.lostReasons[lost.reason]}`),
          h('p', { class: 'note' }, lost.uploaded ? T.lostUploaded : T.lostKept),
          h('button', { class: 'btn-secondary btn-sm', id: 'lost-dismiss', onclick: () => void dismissLost() }, T.lostDismiss),
        ]
      : [
          h('p', {}, scopeMatch === 'unverified' ? T.lostVerifying : T.lostOtherOrg),
          ...(isUnscopedLegacy ? [h('button', { class: 'btn-secondary btn-sm', id: 'lost-dismiss', onclick: () => void dismissLost() }, T.lostDismiss)] : []),
        ];
  return [
    h(
      'div',
      { class: 'lost', id: 'lost', role: 'alert' },
      h('strong', {}, T.lostLine.replace('{time}', time)),
      ...details,
    ),
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
  await activeTab.captureBaseline(chrome.permissions);
  const feature = FEATURES.find((f) => f.id === 'meetings')!;
  // The browser asks for tab capture, offscreen, and activeTab (to read the active meeting tab URL on click) on this click, and nothing is asked before it.
  const granted = await chrome.permissions.request({ permissions: [...feature.permissions] }).catch(() => false);
  activeTab.onMeetingsEnabled(granted);
  if (!granted) {
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
  notice = '';
  await activeTab.captureBaseline(chrome.permissions);
  const current = await loadState(area);
  const remove = permissionsToRemove('meetings', current.enabled);
  if (remove.length > 0) await chrome.permissions.remove({ permissions: remove }).catch(() => false);
  await activeTab.onPermissionsRemoved(remove, chrome.permissions);
  await saveState(area, withFeature(await loadState(area), 'meetings', false));
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
  if (stopping) return;
  stopping = true;
  notice = T.uploading;
  const stopBtn = document.getElementById('stop-recording') as HTMLButtonElement | null;
  if (stopBtn) stopBtn.disabled = true;
  const existingNotice = document.getElementById('popup-notice');
  if (existingNotice) existingNotice.replaceChildren(notice);
  else root.append(h('p', { class: 'alert-banner', id: 'popup-notice', role: 'alert' }, notice));
  let reply: StopReply | null = null;
  try {
    reply = (await chrome.runtime.sendMessage({ type: 'stop' })) as StopReply;
  } catch {
    reply = null;
  } finally {
    stopping = false;
  }
  notice =
    !reply || (!reply.ok && reply.reason === 'error')
      ? T.stopFailed
      : !reply.ok
        ? T.recordingIdle
        : reply.uploaded
          ? T.uploaded
          : T.uploadFailed;
  if (reply?.ok) {
    const staleRec = (await area.get(RECORDING_KEY).catch(() => ({}) as Record<string, unknown>))[RECORDING_KEY] as RecordingState | undefined;
    if (staleRec?.meetingId === reply.meetingId) {
      await area.remove(RECORDING_KEY).catch(() => undefined);
    }
  }
  // Reflect stop result (or retained Stop on error) immediately without waiting for slow/hung /me (#4725).
  await mountShellAfterStorageRead();
  await render();
}

const legacyKey = (address: string, orgId: string, tokenId: string, meetingId: string): string =>
  `${address}\0${orgId}\0${tokenId}\0${meetingId}`;

async function verifyLegacyPending(candidates: RecordingMeta[], state: State, me: Me, token: string): Promise<void> {
  const toCheck = candidates.filter((m) => {
    const key = legacyKey(state.apiAddress, me.orgId, me.tokenId, m.meetingId);
    return !verifiedLegacyChecked.has(key) && !verifiedLegacyInFlight.has(key);
  });
  if (toCheck.length === 0) return;
  for (const m of toCheck) verifiedLegacyInFlight.add(legacyKey(state.apiAddress, me.orgId, me.tokenId, m.meetingId));
  const client = createClient(state.apiAddress, token);
  const queue = [...toCheck];
  const pendingOwned: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushChain: Promise<void> = Promise.resolve();

  const runFlush = async (): Promise<void> => {
    const batch = pendingOwned.splice(0, pendingOwned.length);
    if (batch.length === 0) return;
    // Re-check store rows, RECORDING_KEY, scope keys, and active account once per batch rather than per item (#4725).
    const [currentState, currentLeft, rawRec, rawExistingScopes] = await Promise.all([
      loadState(area),
      store.list(me.orgId).catch(() => [] as RecordingMeta[]),
      area.get(RECORDING_KEY),
      area.get(batch.map(pendingScopeKey)),
    ]);
    const currentAccount = activeAccount(currentState);
    if (currentState.apiAddress !== state.apiAddress || currentAccount?.orgId !== me.orgId || currentAccount.token !== token) return;
    const liveIds = new Set(currentLeft.map((row) => row.meetingId));
    const activeRec = rawRec[RECORDING_KEY] as RecordingState | undefined;
    const recoveredScopes: Record<string, RecordingScope> = {};
    for (const meetingId of batch) {
      if (!liveIds.has(meetingId)) continue;
      if (activeRec && activeRec.meetingId === meetingId) continue;
      const scopeKey = pendingScopeKey(meetingId);
      const existingScope = readPendingScope(rawExistingScopes[scopeKey]);
      if (existingScope && recordingScopeMatch(existingScope, currentState, me) !== 'unverified') continue;
      recoveredScopes[scopeKey] = { orgId: me.orgId, address: state.apiAddress, tokenId: me.tokenId };
    }
    if (Object.keys(recoveredScopes).length > 0) {
      const saved = await area.set(recoveredScopes).then(() => true, () => false);
      if (saved) void render();
    }
  };

  const enqueueFlush = (): Promise<void> => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    flushChain = flushChain.then(runFlush, runFlush);
    return flushChain;
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void enqueueFlush();
    }, 0);
  };

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const m = queue.shift();
      if (!m) break;
      const key = legacyKey(state.apiAddress, me.orgId, me.tokenId, m.meetingId);
      try {
        const status = await client.extensionMeetingOwned(m.meetingId, {
          signal: AbortSignal.timeout(CONFIG_DISCOVERY_TIMEOUT_MS),
        });
        if (status === 'not_owned' || status === 'unknown') verifiedLegacyChecked.add(key);
        else if (status === 'owned') {
          pendingOwned.push(m.meetingId);
          scheduleFlush();
        }
      } finally {
        verifiedLegacyInFlight.delete(key);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(5, toCheck.length) }, worker));
  await enqueueFlush();
}

async function pendingView(state: State, me: Me, token: string): Promise<Node[]> {
  const left = await store.list(me.orgId).catch(() => [] as RecordingMeta[]);
  if (left.length === 0) return [];
  const scopeKeys = left.map((m) => pendingScopeKey(m.meetingId));
  // Confirm rows remain in store after reading RECORDING_KEY/scopeKeys so a concurrent upload cleanup cannot misclassify a deleted row (#4725).
  const [rawRecording, rawScopes, confirmedLeft] = await Promise.all([
    area.get(RECORDING_KEY),
    area.get(scopeKeys),
    store.list(me.orgId).catch(() => [] as RecordingMeta[]),
  ]);
  const confirmedIds = new Set(confirmedLeft.map((m) => m.meetingId));
  const recording = rawRecording[RECORDING_KEY] as RecordingState | undefined;
  const client = createClient(state.apiAddress, token);
  const canVerifyLegacy = me.scopes.includes('meetings');
  const idle: RecordingMeta[] = [];
  const unscoped: RecordingMeta[] = [];
  // Scoped entries stay isolated by server+tokenId; unscoped or tokenId-less entries verify asynchronously via extensionStatus (#4725).
  for (const m of left) {
    if (!confirmedIds.has(m.meetingId)) continue;
    if (recording && recording.meetingId === m.meetingId) continue;
    const localScope = readPendingScope(rawScopes[pendingScopeKey(m.meetingId)]);
    if (localScope) {
      const scopeMatch = recordingScopeMatch(localScope, state, me);
      if (scopeMatch === 'same') {
        idle.push(m);
        continue;
      }
      if (scopeMatch === 'other') continue;
    }
    if (canVerifyLegacy && !verifiedLegacyChecked.has(legacyKey(state.apiAddress, me.orgId, me.tokenId, m.meetingId))) {
      unscoped.push(m);
    }
  }
  if (unscoped.length > 0) void verifyLegacyPending(unscoped, state, me, token);
  idle.sort((a, b) => a.startedAt - b.startedAt);
  if (idle.length === 0) return [];
  return [
    h(
      'div',
      { class: 'card' },
      h('h2', {}, T.pending),
      ...idle.map((meta) =>
        h(
          'div',
          { class: 'pending-row' },
          h('span', {}, `${meta.title} (${formatClock(meta.elapsedMs)})`),
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                class: 'btn-secondary btn-sm',
                onclick: () =>
                  void (async () => {
                    const { uploads } = await client.config({ signal: AbortSignal.timeout(CONFIG_DISCOVERY_TIMEOUT_MS) }).catch(() => ({ uploads: 'direct' as const }));
                    const done = await uploadSaved({ store }, client, uploads, meta);
                    if (done.ok) await area.remove(pendingScopeKey(meta.meetingId)).catch(() => undefined);
                    notice = done.ok ? T.uploaded : T.uploadFailed;
                    await render();
                  })(),
              },
              T.retry,
            ),
            // Discarding a left-over copy ends that meeting's recording too (best effort), so the app's recording chip lets go (#3196).
            h(
              'button',
              {
                class: 'btn-outline btn-sm',
                onclick: () =>
                  void reportEnded(client, meta)
                    .then(() => store.remove(meta.id))
                    .then(() => area.remove(pendingScopeKey(meta.meetingId)).catch(() => undefined))
                    .then(render),
              },
              T.discard,
            ),
          ),
        ),
      ),
    ),
  ];
}

void render();
