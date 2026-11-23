// SPDX-License-Identifier: AGPL-3.0-only
// The messages between the popup, the background worker and the offscreen document. The popup and the background worker
// read storage (the popup calls /api/extension/me and the upload retry with the token); the offscreen document cannot, so
// the worker hands it the token of the one org and the address for the one recording. Every receiver checks who sent a
// message and the shape of what it carries (`parseStartRequest`, `parseCaptureStart`) before acting on it.
import { isRecordingStopReason, type RecordingStopReason } from '@ludy/meeting-recorder';
import { CONSENT_METHODS, type ConsentMethod } from './consent.ts';

export interface StartRequest {
  title: string;
  consentMethod: string;
  consentAgreed: boolean;
  keepVideo: boolean;
  // "Ghi chú trực tiếp" (ADR-0052 L4a): off unless ticked for this one recording.
  liveNotes: boolean;
  // From chrome.tabCapture.getMediaStreamId in the popup, after the member's click on the tab.
  streamId: string;
  // The address of that tab when the browser gave it (ADR-0055 slice 1, #4123): the server reads which call it names and stores nothing of the address.
  joinUrl?: string;
}

// The part of a tab's address the server needs to tell which call it is: https, the host and the path, with no query and no fragment (a Zoom address carries the meeting passcode in its query, and a Teams one a long
// context). Undefined for anything else. The server reads the call from the same host and path, and is the authority on what they mean.
export function tabAddress(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    const address = `${url.origin}${url.pathname}`;
    return address.length <= 500 ? address : undefined;
  } catch {
    return undefined;
  }
}

export interface CaptureStart {
  target: 'offscreen';
  type: 'capture-start';
  address: string;
  token: string;
  orgId: string;
  uploads: 'presigned' | 'direct';
  title: string;
  consentMethod: ConsentMethod;
  consentAgreed: boolean;
  keepVideo: boolean;
  liveNotes: boolean;
  streamId: string;
  joinUrl?: string;
}

export type OffscreenMessage = CaptureStart | { target: 'offscreen'; type: 'capture-stop' };

export interface Tick {
  type: 'tick';
  elapsedMs: number;
}

// The offscreen document's once-a-second tick, or null when its time is not a finite, non-negative number: the badge clock is
// built from it, and a NaN, an Infinity, a string or a negative value must not reach `formatClock` or the toolbar title.
export function parseTick(raw: unknown): Tick | null {
  if (!isObject(raw) || raw.type !== 'tick') return null;
  const { elapsedMs } = raw;
  return typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? { type: 'tick', elapsedMs } : null;
}

// 'captureRunning': the server already has a capture of this call (ADR-0055 slice 1, #4123); the reply says which kind of client holds it and since when.
export type StartFailure = 'invalid' | 'title' | 'consentMethod' | 'consentAgreed' | 'consentPolicy' | 'permission' | 'busy' | 'signedOut' | 'device' | 'store' | 'setup' | 'captureRunning';
export interface CaptureHeld {
  kind: 'extension' | 'app';
  // An ISO time.
  since: string;
}
export type StartReply = { ok: true; meetingId: string; startedAt: number; micMissing: boolean } | { ok: false; reason: StartFailure; held?: CaptureHeld };
export type StopReply = { ok: true; uploaded: boolean; meetingId: string; message?: string } | { ok: false; reason: 'idle' };

export interface RecordingState {
  meetingId: string;
  title: string;
  startedAt: number;
  keepVideo: boolean;
  micMissing: boolean;
}
export const RECORDING_KEY = 'ludy-extension-recording';

// A recording that ended without the member's click (A1, #3159): what the popup shows as "Ghi âm đã dừng lúc ..." until the member
// says they saw it or starts another. Codes and the meeting's own title, kept in the extension's storage only.
export interface LostState {
  meetingId: string;
  title: string;
  reason: RecordingStopReason;
  at: number;
  uploaded: boolean;
}
export const LOST_KEY = 'ludy-extension-recording-lost';

// What the offscreen document tells the worker once the recording ended by itself and what was saved has been uploaded (or not).
export interface Lost {
  type: 'lost';
  reason: RecordingStopReason;
  meetingId: string;
  title: string;
  uploaded: boolean;
}

export function parseLost(raw: unknown): Lost | null {
  if (!isObject(raw) || raw.type !== 'lost') return null;
  const { reason, meetingId, title, uploaded } = raw;
  if (!isRecordingStopReason(reason) || typeof meetingId !== 'string' || meetingId === '' || typeof title !== 'string' || typeof uploaded !== 'boolean') return null;
  return { type: 'lost', reason, meetingId, title: title.slice(0, 200), uploaded };
}

export function readLost(raw: unknown): LostState | null {
  if (!isObject(raw)) return null;
  const { meetingId, title, reason, at, uploaded } = raw;
  if (typeof meetingId !== 'string' || typeof title !== 'string' || !isRecordingStopReason(reason) || typeof at !== 'number' || !Number.isFinite(at) || typeof uploaded !== 'boolean') return null;
  return { meetingId, title, reason, at, uploaded };
}

// Only this extension's own pages and worker may send it a message: an id that is not ours (another extension, a page
// that reached the runtime) is refused. `chrome.runtime.id` is passed in so the check tests without a browser.
export const isOwnSender = (sender: unknown, ownId: string | undefined): boolean =>
  typeof ownId === 'string' && ownId !== '' && typeof sender === 'object' && sender !== null && (sender as { id?: unknown }).id === ownId;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// The start request of the popup, or null when any field is not what it must be. The flags are booleans, not truthy
// values: a string "false" must not count as consent, nor as a video or live notes that were not asked for.
export function parseStartRequest(raw: unknown): StartRequest | null {
  if (!isObject(raw)) return null;
  const { title, consentMethod, consentAgreed, keepVideo, liveNotes, streamId, joinUrl } = raw;
  if (typeof title !== 'string' || typeof consentMethod !== 'string' || typeof streamId !== 'string' || streamId === '') return null;
  if (typeof consentAgreed !== 'boolean' || typeof keepVideo !== 'boolean' || typeof liveNotes !== 'boolean') return null;
  // The tab's address is a hint: anything that is not an https address is left out, never a reason to refuse the start, and only its host and path are kept.
  const address = tabAddress(joinUrl);
  return { title, consentMethod, consentAgreed, keepVideo, liveNotes, streamId, ...(address ? { joinUrl: address } : {}) };
}

// The worker's capture command for the offscreen document, or null when it is malformed.
export function parseCaptureStart(raw: unknown): CaptureStart | null {
  if (!isObject(raw) || raw.target !== 'offscreen' || raw.type !== 'capture-start') return null;
  const { address, token, orgId, uploads, title, consentMethod, consentAgreed, keepVideo, liveNotes, streamId, joinUrl } = raw;
  const request = parseStartRequest({ title, consentMethod, consentAgreed, keepVideo, liveNotes, streamId, joinUrl });
  if (!request || typeof address !== 'string' || typeof token !== 'string' || typeof orgId !== 'string') return null;
  if (uploads !== 'presigned' && uploads !== 'direct') return null;
  if (!(CONSENT_METHODS as readonly string[]).includes(request.consentMethod)) return null;
  return { target: 'offscreen', type: 'capture-start', address, token, orgId, uploads, ...request, consentMethod: request.consentMethod as ConsentMethod };
}
