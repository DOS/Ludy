// SPDX-License-Identifier: AGPL-3.0-only
// The background worker: the only code that starts a recording (the popup also reads the stored token, for its own calls
// to the configured address; the offscreen document gets it from here for one recording). It starts nothing by itself:
// a recording begins only from the popup's message after the member's click, checks the consent gate and the browser
// permissions again, and has the offscreen document capture the one tab the member clicked.
import { consentBlocker, type ConsentMethod } from './consent.ts';
import { loadState, saveState, activeAccount } from './state.ts';
import { isOwnSender, LOST_KEY, parseLost, parseStartRequest, parseTick, pendingScopeKey, RECORDING_KEY, type CaptureStart, type LostState, type RecordingScope, type RecordingState, type StartReply, type StartRequest, type StopReply } from './messages.ts';
import { createClient } from './api.ts';
import { formatClock } from '@ludy/meeting-recorder';
import { T } from './strings.ts';

const OFFSCREEN_PATH = 'offscreen.html';

async function closeOffscreen(): Promise<void> {
  await chrome.offscreen?.closeDocument?.().catch(() => undefined);
}

const isNoReceiverError = (error: unknown): boolean =>
  error instanceof Error && /Receiving end does not exist|Could not establish connection/i.test(error.message);

async function ensureOffscreen(): Promise<void> {
  if (typeof chrome.runtime.getContexts === 'function') {
    const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (open.length > 0) return;
    await chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: ['USER_MEDIA'], justification: 'Ghi âm tab họp và micro khi người dùng bấm ghi' });
    return;
  }
  const hasDoc = await chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'capture-status' })
    .then((r) => Boolean(r), (err) => !isNoReceiverError(err));
  if (!hasDoc) {
    await chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: ['USER_MEDIA'], justification: 'Ghi âm tab họp và micro khi người dùng bấm ghi' });
  }
}

async function setBadge(state: RecordingState | null, elapsedMs = 0): Promise<void> {
  await chrome.action.setBadgeText({ text: state ? 'REC' : '' });
  if (state) await chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
  // Keep global badge tooltip title-free so switching accounts never exposes a recording title across members/orgs.
  await chrome.action.setTitle({ title: state ? `${T.recordingTitle} (${formatClock(elapsedMs)})` : 'Ludy' });
}

// The recording ended by itself (A1, #3159): the badge says "!" (not "REC", nothing is recording) until the member opens the popup, which
// shows when and why. No new permission: the badge and the storage the extension already uses.
async function markLost(lost: LostState): Promise<void> {
  const [storedRec, state] = await Promise.all([
    chrome.storage.local.get(RECORDING_KEY),
    loadState(chrome.storage.local),
  ]);
  const existing = storedRec[RECORDING_KEY] as RecordingState | undefined;
  const address = existing?.address ?? state.apiAddress;
  const scopedLost: LostState =
    existing && existing.meetingId === lost.meetingId
      ? {
          ...lost,
          ...(existing.orgId ? { orgId: existing.orgId } : {}),
          ...(address ? { address } : {}),
          ...(existing.tokenId ? { tokenId: existing.tokenId } : {}),
        }
      : { ...lost, ...(address ? { address } : {}) };
  await chrome.storage.local.remove(RECORDING_KEY);
  await chrome.storage.local.set({ [LOST_KEY]: scopedLost });
  if (lost.uploaded) {
    await chrome.storage.local.remove(pendingScopeKey(lost.meetingId)).catch(() => undefined);
  } else if (scopedLost.orgId && scopedLost.address) {
    await chrome.storage.local
      .set({
        [pendingScopeKey(lost.meetingId)]: {
          orgId: scopedLost.orgId,
          address: scopedLost.address,
          ...(scopedLost.tokenId ? { tokenId: scopedLost.tokenId } : {}),
        },
      })
      .catch(() => undefined);
  }
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#b54708' });
  await chrome.action.setTitle({ title: T.lostTitle });
  await closeOffscreen();
}

const stoppedRecordingIds = new Set<string>();
const START_NETWORK_TIMEOUT_MS = 3_000;

function recordStoppedRecordingId(meetingId: string): void {
  stoppedRecordingIds.add(meetingId);
  if (stoppedRecordingIds.size > 32) {
    const oldest = stoppedRecordingIds.values().next().value;
    if (oldest !== undefined) stoppedRecordingIds.delete(oldest);
  }
}

async function removeRecordingKeyWithRetry(): Promise<boolean> {
  const first = await chrome.storage.local.remove(RECORDING_KEY).then(() => true, () => false);
  if (first) return true;
  return chrome.storage.local.remove(RECORDING_KEY).then(() => true, () => false);
}

async function isOffscreenCaptureLive(): Promise<boolean> {
  const offscreenOpen = await isOffscreenOpen();
  if (offscreenOpen === false) return false;
  try {
    const status = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'capture-status' })) as { active?: unknown } | undefined;
    if (status && typeof status.active === 'boolean') return status.active;
    return true;
  } catch (error) {
    if (offscreenOpen === 'unknown' && isNoReceiverError(error)) return false;
    return true;
  }
}

async function reconcileStaleRecording(): Promise<'none' | 'cleared' | 'live' | 'remove_failed'> {
  const stored = (await chrome.storage.local.get(RECORDING_KEY))[RECORDING_KEY] as RecordingState | undefined;
  if (!stored) return 'none';
  if (!stoppedRecordingIds.has(stored.meetingId) && (await isOffscreenCaptureLive())) return 'live';
  const removed = await removeRecordingKeyWithRetry();
  if (!removed) return 'remove_failed';
  await setBadge(null).catch(() => undefined);
  await closeOffscreen().catch(() => undefined);
  return 'cleared';
}

async function start(request: StartRequest): Promise<StartReply> {
  // The consent gate, again: the popup cannot skip it.
  const blocker = consentBlocker(request);
  if (blocker) return { ok: false, reason: blocker };
  const liveState = await reconcileStaleRecording();
  if (liveState === 'live' || liveState === 'remove_failed') return { ok: false, reason: 'busy' };
  const state = await loadState(chrome.storage.local);
  const account = activeAccount(state);
  if (!account || state.enabled.meetings !== true) return { ok: false, reason: 'signedOut' };
  if (!(await chrome.permissions.contains({ permissions: ['tabCapture', 'offscreen'] }))) return { ok: false, reason: 'permission' };
  const client = createClient(state.apiAddress, account.token);
  const [{ uploads }, me] = await Promise.all([
    client.config({ signal: AbortSignal.timeout(START_NETWORK_TIMEOUT_MS) }).catch(() => ({ uploads: 'direct' as const })),
    client.me({ signal: AbortSignal.timeout(START_NETWORK_TIMEOUT_MS) }).catch(() => null),
  ]);
  // Never start an unrecoverable recording without a verified owner tokenId (#4725).
  if (!me?.tokenId || me.orgId !== account.orgId) return { ok: false, reason: 'setup' };
  if (account.tokenId !== me.tokenId) {
    const currentState = await loadState(chrome.storage.local);
    const currentAccount = currentState.accounts[account.orgId];
    if (currentAccount?.token === account.token && currentAccount.tokenId !== me.tokenId) {
      await saveState(chrome.storage.local, {
        ...currentState,
        accounts: { ...currentState.accounts, [account.orgId]: { ...currentAccount, tokenId: me.tokenId } },
      }).catch(() => undefined);
    }
  }
  await ensureOffscreen();
  const message: CaptureStart = {
    target: 'offscreen',
    type: 'capture-start',
    address: state.apiAddress,
    token: account.token,
    orgId: account.orgId,
    uploads,
    title: request.title,
    consentMethod: request.consentMethod as ConsentMethod,
    consentAgreed: request.consentAgreed,
    keepVideo: request.keepVideo,
    liveNotes: request.liveNotes,
    streamId: request.streamId,
    ...(request.joinUrl ? { joinUrl: request.joinUrl } : {}),
  };
  const reply = (await chrome.runtime.sendMessage(message)) as StartReply;
  if (!reply.ok) {
    await closeOffscreen();
    return reply;
  }
  await chrome.storage.local.remove(LOST_KEY);
  const scope: RecordingScope = {
    orgId: account.orgId,
    address: state.apiAddress,
    tokenId: me.tokenId,
  };
  const recording: RecordingState = {
    meetingId: reply.meetingId,
    title: request.title.trim(),
    startedAt: reply.startedAt,
    keepVideo: request.keepVideo,
    micMissing: reply.micMissing,
    ...scope,
  };
  await chrome.storage.local.set({
    [RECORDING_KEY]: recording,
    [pendingScopeKey(reply.meetingId)]: scope,
  });
  await setBadge(recording);
  return reply;
}

async function isOffscreenOpen(): Promise<boolean | 'unknown'> {
  if (!chrome.offscreen) return false;
  if (typeof chrome.runtime.getContexts !== 'function') return 'unknown';
  try {
    const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return open.length > 0;
  } catch {
    return 'unknown';
  }
}

let stopInFlight: Promise<StopReply> | null = null;

function stop(): Promise<StopReply> {
  if (!stopInFlight) {
    stopInFlight = runStop().finally(() => {
      stopInFlight = null;
    });
  }
  return stopInFlight;
}

async function runStop(): Promise<StopReply> {
  const existing = (await chrome.storage.local.get(RECORDING_KEY).catch(() => ({}) as Record<string, unknown>))[RECORDING_KEY] as RecordingState | undefined;
  if (existing && stoppedRecordingIds.has(existing.meetingId)) {
    const removed = await removeRecordingKeyWithRetry();
    await setBadge(null).catch(() => undefined);
    await closeOffscreen().catch(() => undefined);
    return removed ? { ok: false, reason: 'idle' } : { ok: false, reason: 'error' };
  }
  let reply: StopReply | null = null;
  try {
    const raw = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'capture-stop' })) as StopReply | undefined;
    if (raw && typeof raw.ok === 'boolean') reply = raw;
  } catch {
    reply = null;
  }
  // Keep RECORDING_KEY and offscreen intact until stop/idle is confirmed or no offscreen document exists.
  if (reply === null || (!reply.ok && reply.reason === 'error')) {
    const offscreenOpen = reply === null ? await isOffscreenOpen() : 'unknown';
    if (offscreenOpen === false) {
      const removed = await removeRecordingKeyWithRetry();
      await setBadge(null).catch(() => undefined);
      return removed ? { ok: false, reason: 'idle' } : { ok: false, reason: 'error' };
    }
    return { ok: false, reason: 'error' };
  }
  if (reply.ok) recordStoppedRecordingId(reply.meetingId);
  const [removeResult] = await Promise.allSettled([
    removeRecordingKeyWithRetry(),
    setBadge(null),
    closeOffscreen(),
    ...(reply.ok && reply.uploaded ? [chrome.storage.local.remove(pendingScopeKey(reply.meetingId))] : []),
  ]);
  if (reply.ok) return reply;
  return removeResult.status === 'fulfilled' && removeResult.value ? reply : { ok: false, reason: 'error' };
}

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  // Only this extension's own pages and the offscreen document speak to the worker.
  if (!isOwnSender(sender, chrome.runtime.id)) return undefined;
  const message = raw as { type?: string };
  if (message.type === 'tick') {
    // A tick whose time is not a finite number is dropped: the badge keeps its last value.
    const tick = parseTick(raw);
    if (!tick) return undefined;
    void chrome.storage.local.get(RECORDING_KEY).then((stored) => {
      const state = stored[RECORDING_KEY] as RecordingState | undefined;
      if (state) void setBadge(state, tick.elapsedMs);
    });
    return undefined;
  }
  if (message.type === 'lost') {
    const lost = parseLost(raw);
    if (!lost) return undefined;
    // Works even if the member clicked Stop while the saved part was uploading: the notice is about the recording that ended by itself.
    void markLost({ meetingId: lost.meetingId, title: lost.title, reason: lost.reason, at: Date.now(), uploaded: lost.uploaded });
    return undefined;
  }
  if (message.type === 'start') {
    const request = parseStartRequest(raw);
    if (!request) {
      respond({ ok: false, reason: 'invalid' } satisfies StartReply);
      return undefined;
    }
    void start(request).then(respond, () => respond({ ok: false, reason: 'setup' } satisfies StartReply));
    return true;
  }
  if (message.type === 'stop') {
    void stop().then(respond, () => respond({ ok: false, reason: 'error' } satisfies StopReply));
    return true;
  }
  return undefined;
});

