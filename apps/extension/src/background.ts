// SPDX-License-Identifier: AGPL-3.0-only
// The background worker: the only code that reads the stored token and starts a recording. It starts nothing by itself:
// a recording begins only from the popup's message after the member's click, checks the consent gate and the browser
// permissions again, and has the offscreen document capture the one tab the member clicked.
import { consentBlocker, type ConsentMethod } from './consent.ts';
import { loadState, activeAccount } from './state.ts';
import { RECORDING_KEY, type CaptureStart, type PopupMessage, type RecordingState, type StartReply, type StopReply, type Tick } from './messages.ts';
import { createClient } from './api.ts';
import { formatClock } from '@crove/meeting-recorder';

const OFFSCREEN_PATH = 'offscreen.html';

async function ensureOffscreen(): Promise<void> {
  const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (open.length > 0) return;
  await chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: ['USER_MEDIA'], justification: 'Ghi âm tab họp và micro khi người dùng bấm ghi' });
}

async function setBadge(state: RecordingState | null, elapsedMs = 0): Promise<void> {
  await chrome.action.setBadgeText({ text: state ? 'REC' : '' });
  if (state) await chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
  await chrome.action.setTitle({ title: state ? `Ludy đang ghi: ${state.title} (${formatClock(elapsedMs)})` : 'Ludy' });
}

async function start(request: Extract<PopupMessage, { type: 'start' }>): Promise<StartReply> {
  // The consent gate, again: the popup cannot skip it.
  const blocker = consentBlocker(request);
  if (blocker) return { ok: false, reason: blocker };
  if ((await chrome.storage.local.get(RECORDING_KEY))[RECORDING_KEY]) return { ok: false, reason: 'busy' };
  const state = await loadState(chrome.storage.local);
  const account = activeAccount(state);
  if (!account || state.enabled.meetings !== true) return { ok: false, reason: 'signedOut' };
  if (!(await chrome.permissions.contains({ permissions: ['tabCapture', 'offscreen'] }))) return { ok: false, reason: 'permission' };
  const client = createClient(state.address, account.token);
  const { uploads } = await client.config().catch(() => ({ uploads: 'direct' as const }));
  await ensureOffscreen();
  const message: CaptureStart = {
    target: 'offscreen',
    type: 'capture-start',
    address: state.address,
    token: account.token,
    orgId: account.orgId,
    uploads,
    title: request.title,
    consentMethod: request.consentMethod as ConsentMethod,
    consentAgreed: request.consentAgreed,
    keepVideo: request.keepVideo,
    streamId: request.streamId,
  };
  const reply = (await chrome.runtime.sendMessage(message)) as StartReply;
  if (!reply.ok) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
    return reply;
  }
  const recording: RecordingState = { meetingId: reply.meetingId, title: request.title.trim(), startedAt: reply.startedAt, keepVideo: request.keepVideo, micMissing: reply.micMissing };
  await chrome.storage.local.set({ [RECORDING_KEY]: recording });
  await setBadge(recording);
  return reply;
}

async function stop(): Promise<StopReply> {
  const reply = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'capture-stop' }).catch(() => ({ ok: false, reason: 'idle' }))) as StopReply;
  await chrome.storage.local.remove(RECORDING_KEY);
  await setBadge(null);
  await chrome.offscreen.closeDocument().catch(() => undefined);
  return reply;
}

chrome.runtime.onMessage.addListener((raw, _sender, respond) => {
  const message = raw as { type?: string };
  if (message.type === 'tick') {
    void chrome.storage.local.get(RECORDING_KEY).then((stored) => {
      const state = stored[RECORDING_KEY] as RecordingState | undefined;
      if (state) void setBadge(state, (message as Tick).elapsedMs);
    });
    return undefined;
  }
  if (message.type === 'start') {
    void start(message as Extract<PopupMessage, { type: 'start' }>).then(respond, () => respond({ ok: false, reason: 'setup' } satisfies StartReply));
    return true;
  }
  if (message.type === 'stop') {
    void stop().then(respond);
    return true;
  }
  return undefined;
});

